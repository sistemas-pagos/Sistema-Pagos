import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nuevaBaseDePrueba } from './helpers/turso-test-db';
import { resetEnvForTests } from '@/src/config/env';
import type { HomeRecord, PaymentRecord } from '@/src/domain/types';
import { TursoPaymentStore } from '@/src/storage/turso-store';

/**
 * El almacen que reemplaza a Google Sheets. Lo que se prueba aca no es que
 * hable con SQLite: es que **no pierda nada** al guardar y releer, porque lo que
 * se pierda en silencio es plata de un vecino que ya pago.
 */
let db: Client;
let store: TursoPaymentStore;

const CASA: HomeRecord = {
  id: 'v1', stage: '1', block: '4', house: '18', monthlyFee: 150, active: true, startDate: '2026-09-01',
};

/**
 * El pago referencia al mensaje que lo trajo, y esa clave foranea sostiene la
 * invariante 14: un reintento de Meta con el mismo `message_id` no puede crear
 * un segundo pago. En produccion el webhook inserta el mensaje antes que nada,
 * asi que la prueba tiene que hacer lo mismo.
 */
async function mensajeRecibido(messageId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO mensajes (message_id, telefono, tipo, estado, recibido_en, actualizado_en)
          VALUES (?, '50400000001', 'image', 'RECIBIDO', ?, ?)`,
    args: [messageId, '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'],
  });
}

async function guardar(store: TursoPaymentStore, registro: PaymentRecord): Promise<void> {
  if (registro.sourceMessageId) await mensajeRecibido(registro.sourceMessageId);
  await store.savePayment(registro);
}

function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-1', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
    sourceMessageId: 'msg-1', phone: '50400000001', bank: 'BAC Honduras', depositor: 'QUIEN DEPOSITA',
    transactionDate: '2026-09-02', transactionTime: '14:45', amount: 150, detail: 'Pago septiembre',
    reference: '412000001', beneficiary: 'TITULAR', destinationAccountMasked: '••••2233',
    stage: '1', block: '4', house: '18', period: '2026-09', status: 'PENDIENTE_VERIFICACION',
    fileHash: 'sha-1', ...overrides,
  };
}

beforeEach(async () => {
  process.env.APP_MODE = 'demo';
  resetEnvForTests();
  db = await nuevaBaseDePrueba();
  store = new TursoPaymentStore(db);
  await store.saveHomes([CASA]);
});

afterEach(() => {
  db.close();
  delete process.env.APP_MODE;
  resetEnvForTests();
});

describe('guardar y releer un pago', () => {
  it('lo devuelve con todos sus campos, sin perder ninguno', async () => {
    const original = pago();
    await guardar(store, original);

    expect(await store.getPayment('pay-1')).toEqual(original);
  });

  /**
   * `parseFloat(...) * 100` es la cuenta que produce 14999 donde tiene que
   * haber 15000. El dinero se guarda en centavos enteros (invariante 7).
   */
  it('guarda el monto en centavos enteros', async () => {
    await guardar(store, pago({ amount: 1234.56 }));

    const { rows } = await db.execute("SELECT monto_centavos FROM pagos WHERE id = 'pay-1'");
    expect(rows[0].monto_centavos).toBe(123456);
    expect((await store.getPayment('pay-1'))?.amount).toBe(1234.56);
  });

  /** La cuenta destino se guarda en cuatro digitos; la mascara es presentacion. */
  it('guarda los cuatro digitos de la cuenta y devuelve la mascara', async () => {
    await guardar(store, pago());

    const { rows } = await db.execute("SELECT cuenta_ultimos4 FROM pagos WHERE id = 'pay-1'");
    expect(rows[0].cuenta_ultimos4).toBe('2233');
    expect((await store.getPayment('pay-1'))?.destinationAccountMasked).toBe('••••2233');
  });

  it('no deja guardar dos veces el mismo pago', async () => {
    await guardar(store, pago());

    await expect(store.savePayment(pago())).rejects.toThrow('payment_already_exists');
  });

  it('actualiza el estado y el motivo sin tocar el resto', async () => {
    await guardar(store, pago());
    const verificado = { ...pago(), status: 'VERIFICADO' as const, verifiedAt: '2026-09-16T12:00:00.000Z', verificationSource: 'extracto-bac', updatedAt: '2026-09-16T12:00:00.000Z' };

    await store.updatePayment(verificado, { actor: 'prueba', motivo: 'verificado a mano' });

    expect(await store.getPayment('pay-1')).toEqual(verificado);
  });

  it('se queja si el pago que se actualiza no existe', async () => {
    await expect(store.updatePayment(pago({ id: 'no-existe' }), { actor: 'prueba' })).rejects.toThrow('payment_not_found');
  });

  /** Un pago llega antes de saber de que casa es (ESPERANDO_RESPUESTA). */
  it('acepta un pago que todavia no dice de que casa es', async () => {
    const sinCasa = pago({ stage: undefined, block: undefined, house: undefined, status: 'ESPERANDO_RESPUESTA' });
    await guardar(store, sinCasa);

    const leido = await store.getPayment('pay-1');
    expect(leido?.stage).toBeUndefined();
    expect(leido?.status).toBe('ESPERANDO_RESPUESTA');
  });

  it('no inventa una vivienda que no esta en el padron', async () => {
    await mensajeRecibido('msg-1');
    await expect(store.savePayment(pago({ house: '99' }))).rejects.toThrow('home_not_found');
  });

  /**
   * Los estados del codigo tienen que pasar el CHECK de la tabla. Si alguno no
   * pasara, el pago se perderia en produccion con el comprobante ya recibido.
   */
  it('acepta todos los estados del dominio', async () => {
    const estados = ['ESPERANDO_RESPUESTA', 'PENDIENTE_VERIFICACION', 'VERIFICADO', 'EFECTIVO_COBRADO',
      'EN_REVISION', 'NO_ENCONTRADO', 'DUPLICADO', 'RECHAZADO', 'ANULADO'] as const;

    for (const [indice, estado] of estados.entries()) {
      await guardar(store, pago({ id: `p-${indice}`, sourceMessageId: `m-${indice}`, status: estado }));
    }

    expect(await store.listPayments()).toHaveLength(estados.length);
  });
});

describe('la cuota', () => {
  /** Subirla no puede obligar a editar casa por casa. */
  it('sale de la tabla cuotas, no de la vivienda', async () => {
    await db.execute("INSERT INTO cuotas (monto_centavos, vigente_desde) VALUES (20000, '2026-09')");

    expect((await store.listHomes())[0].monthlyFee).toBe(200);
  });

  it('mientras cuotas este vacia usa la del entorno', async () => {
    expect((await store.listHomes())[0].monthlyFee).toBe(150);
  });

  it('toma la mas reciente cuando hay varias', async () => {
    await db.execute("INSERT INTO cuotas (monto_centavos, vigente_desde) VALUES (15000, '2026-09')");
    await db.execute("INSERT INTO cuotas (monto_centavos, vigente_desde) VALUES (20000, '2027-01')");

    expect((await store.listHomes())[0].monthlyFee).toBe(200);
  });
});

describe('viviendas', () => {
  it('guarda etapa, bloque y casa con su codigo compacto', async () => {
    const { rows } = await db.execute("SELECT codigo FROM viviendas WHERE id = 'v1'");
    expect(rows[0].codigo).toBe('E1B4C18');
  });

  it('no deja dos viviendas en la misma direccion', async () => {
    await expect(store.saveHomes([{ ...CASA, id: 'v2' }])).rejects.toThrow('home_address_already_exists');
  });

  /** Una importacion no se aplica a medias. */
  it('no guarda ninguna si una del lote choca', async () => {
    const lote = [
      { ...CASA, id: 'v3', house: '20' },
      { ...CASA, id: 'v4', house: '18' },
    ];

    await expect(store.saveHomes(lote)).rejects.toThrow();
    expect(await store.listHomes()).toHaveLength(1);
  });

  /**
   * `VACIA` y `EXONERADA` no se pueden expresar en el modelo y la seccion 7 del
   * plan todavia no dice que hacer con ellas. Aplastarlas a BAJA seria decidir
   * por nuestra cuenta.
   */
  it('conserva un estado que el modelo no sabe nombrar', async () => {
    await db.execute("UPDATE viviendas SET estado = 'EXONERADA' WHERE id = 'v1'");

    await store.updateHome({ ...CASA, active: false });

    const { rows } = await db.execute("SELECT estado FROM viviendas WHERE id = 'v1'");
    expect(rows[0].estado).toBe('EXONERADA');
  });
});

describe('el contexto de la conversacion', () => {
  const contexto = {
    id: 'ctx-1', phone: '50400000001', paymentId: 'pay-1',
    createdAt: '2026-09-02T10:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', attempts: 0,
  };

  beforeEach(async () => { await guardar(store, pago()); });

  it('lo guarda y lo devuelve con su contador de intentos', async () => {
    await store.savePending({ ...contexto, attempts: 2 });

    expect(await store.getPendingByPhone('50400000001')).toEqual({ ...contexto, attempts: 2 });
  });

  /** Sin el contador, quien no sabe su etapa recibe la misma pregunta para siempre. */
  it('guarda el contador al actualizarlo, no lo reinicia', async () => {
    await store.savePending(contexto);
    await store.savePending({ ...contexto, attempts: 1 });

    expect((await store.getPendingByPhone('50400000001'))?.attempts).toBe(1);
  });

  it('un contexto vencido es como si no estuviera', async () => {
    await store.savePending({ ...contexto, expiresAt: '2020-01-01T00:00:00.000Z' });

    expect(await store.getPendingByPhone('50400000001')).toBeUndefined();
  });

  /** El contexto es parte de lo que paso con ese pago: se cierra, no se borra. */
  it('al cerrarlo deja la fila con su historia', async () => {
    await store.savePending(contexto);
    await store.clearPending('50400000001');

    expect(await store.getPendingByPhone('50400000001')).toBeUndefined();
    const { rows } = await db.execute("SELECT estado FROM contextos WHERE pago_id = 'pay-1'");
    expect(rows[0].estado).toBe('RESUELTO');
  });

  it('no deja que dos pagos distintos abran contexto con el mismo telefono', async () => {
    await guardar(store, pago({ id: 'pay-2', sourceMessageId: 'msg-2', fileHash: 'sha-2' }));
    await store.savePending(contexto);

    await expect(store.savePending({ ...contexto, id: 'ctx-2', paymentId: 'pay-2' }))
      .rejects.toThrow('pending_context_conflict');
  });
});

describe('mensajes ya procesados', () => {
  /** Un reintento de Meta con el mismo message_id no puede crear un segundo pago. */
  it('reconoce el que ya se cerro', async () => {
    await store.saveProcessedMessage({ messageId: 'msg-9', receivedAt: '2026-09-02T10:00:00.000Z', kind: 'image', outcome: 'processed' });

    expect(await store.hasProcessedMessage('msg-9')).toBe(true);
    expect(await store.hasProcessedMessage('msg-otro')).toBe(false);
  });

  /**
   * El `media_id` y el cuerpo viven lo que dura el procesamiento y nada mas
   * (invariante 11).
   */
  it('borra el media_id y el cuerpo al cerrar el mensaje', async () => {
    await db.execute({
      sql: `INSERT INTO mensajes (message_id, telefono, tipo, media_id, cuerpo, estado, recibido_en, actualizado_en)
            VALUES ('msg-8', '50400000001', 'image', 'media-abc', 'E1 B4 C18', 'RECIBIDO', ?, ?)`,
      args: ['2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'],
    });

    await store.saveProcessedMessage({ messageId: 'msg-8', receivedAt: '2026-09-02T10:00:00.000Z', kind: 'image', outcome: 'processed' });

    const { rows } = await db.execute("SELECT media_id, cuerpo, estado FROM mensajes WHERE message_id = 'msg-8'");
    expect(rows[0]).toMatchObject({ media_id: null, cuerpo: null, estado: 'PROCESADO' });
  });
});

describe('el rastro de cada cambio', () => {
  /**
   * Invariante 8: nada se sobrescribe sin evento. Antes, ni las acciones del
   * panel ni la conciliacion dejaban rastro — el motivo que una persona
   * escribia al rechazar un pago vivia en una columna que la siguiente
   * verificacion borraba, y despues no habia forma de explicar nada.
   */
  it('escribe quien y por que en eventos', async () => {
    await guardar(store, pago());

    await store.updatePayment(
      { ...pago(), status: 'RECHAZADO', updatedAt: '2026-09-16T12:00:00.000Z' },
      { actor: 'panel', motivo: 'Pagó dos meses; se registra aparte' },
    );

    const { rows } = await db.execute("SELECT actor, motivo, antes_json, despues_json FROM eventos WHERE accion = 'ACTUALIZAR'");
    expect(rows[0]).toMatchObject({ actor: 'panel', motivo: 'Pagó dos meses; se registra aparte' });
    expect(JSON.parse(String(rows[0].antes_json))).toEqual({ estado: 'PENDIENTE_VERIFICACION' });
    expect(JSON.parse(String(rows[0].despues_json))).toEqual({ estado: 'RECHAZADO' });
  });

  /** El evento dice que cambio, no los datos del vecino (invariante 12). */
  it('no guarda telefonos ni viviendas en el evento', async () => {
    await guardar(store, pago());

    await store.updatePayment({ ...pago(), status: 'EN_REVISION' }, { actor: 'panel' });

    const { rows } = await db.execute("SELECT antes_json, despues_json FROM eventos WHERE accion = 'ACTUALIZAR'");
    const texto = `${String(rows[0].antes_json)}${String(rows[0].despues_json)}`;
    expect(texto).not.toContain('504');
    expect(texto).not.toContain('E1B4C18');
  });

  /**
   * El UPDATE y su evento van juntos. Si el evento fallara y el cambio quedara,
   * `eventos` dejaria de ser el registro de lo que paso — que es lo unico que
   * lo hace servir para algo.
   */
  it('no cambia el pago si no puede dejar constancia', async () => {
    await guardar(store, pago());
    await db.execute('DROP TABLE eventos');

    await expect(store.updatePayment({ ...pago(), status: 'RECHAZADO' }, { actor: 'panel' })).rejects.toThrow();

    const { rows } = await db.execute("SELECT estado FROM pagos WHERE id = 'pay-1'");
    expect(rows[0].estado).toBe('PENDIENTE_VERIFICACION');
  });
});
