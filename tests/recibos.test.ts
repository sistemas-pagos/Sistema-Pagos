import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, CUOTA_CENTAVOS, PLANTILLA, contar, nuevaBaseDePrueba, sembrar } from './helpers/turso-test-db';
import {
  fechaLegible, formatoRecibo, listaDeMeses, montoEnLempiras, parametrosDePlantilla,
} from '@/src/domain/recibo';
import {
  crearPago, crearVivienda, enviosPendientes, marcarEnvioEnviado,
  marcarEnvioFallido, reemitirRecibo, reservarMeses, verificarPagoConMovimiento,
} from '@/src/storage/turso';

const ALTA = '2026-09-01T00:00:00.000Z';
const TELEFONO = '+50433330000';

let db: Client;

beforeEach(async () => { db = await nuevaBaseDePrueba(); await sembrar(db); });
afterEach(() => { db.close(); });

async function viviendaConPago(
  pagoId: string,
  opciones: { telefono?: string; periodos?: string[]; referencia?: string } = {},
): Promise<void> {
  const { rows } = await db.execute("SELECT id FROM viviendas WHERE id = 'v1'");
  if (rows.length === 0) {
    await crearVivienda(db, {
      id: 'v1', etapa: '1', bloque: '4', casa: '18', estado: 'ACTIVA', fechaAlta: ALTA,
    }, ACTOR);
  }

  const periodos = opciones.periodos ?? ['2026-09'];
  await crearPago(db, {
    id: pagoId,
    metodo: 'TRANSFERENCIA',
    viviendaId: 'v1',
    montoCentavos: CUOTA_CENTAVOS * periodos.length,
    estado: 'PENDIENTE_VERIFICACION',
    telefonoContacto: opciones.telefono,
    referencia: opciones.referencia,
    creadoEn: ALTA,
  }, ACTOR);
  await reservarMeses(db, {
    pagoId,
    viviendaId: 'v1',
    meses: periodos.map((periodo) => ({ periodo, montoCentavos: CUOTA_CENTAVOS })),
    actor: ACTOR,
    creadoEn: ALTA,
  });
}

describe('el recibo se emite con la verificacion', () => {
  it('verificar deja el pago verificado, el recibo emitido y el envio encolado', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });

    const numero = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    expect(formatoRecibo(numero)).toBe('REC-000001');
    const recibo = await db.execute({ sql: 'SELECT pago_id, estado FROM recibos WHERE numero = ?', args: [numero] });
    expect(recibo.rows[0]).toMatchObject({ pago_id: 'p1', estado: 'EMITIDO' });
    const envio = await db.execute({ sql: 'SELECT telefono, estado, intentos FROM envios WHERE recibo_numero = ?', args: [numero] });
    expect(envio.rows[0]).toMatchObject({ telefono: TELEFONO, estado: 'PENDIENTE', intentos: 0 });
  });

  /**
   * Lo que se prueba no es el mensaje de error, sino que no quede nada a medias:
   * un movimiento ya usado hace fallar la verificacion, y con ella tiene que
   * caerse tambien el recibo. Un recibo huerfano seria un comprobante de un pago
   * que nadie confirmo.
   */
  it('si la verificacion falla no queda ni recibo ni envio', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    await crearPago(db, {
      id: 'p2', metodo: 'TRANSFERENCIA', viviendaId: 'v1', montoCentavos: CUOTA_CENTAVOS,
      estado: 'PENDIENTE_VERIFICACION', telefonoContacto: TELEFONO, creadoEn: ALTA,
    }, ACTOR);

    await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    // mov1 ya verifico p1: `pagos.movimiento_id` es UNIQUE (invariante 3).
    await expect(verificarPagoConMovimiento(db, {
      pagoId: 'p2', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR)).rejects.toThrow(/UNIQUE/i);

    expect(await contar(db, 'recibos')).toBe(1);
    expect(await contar(db, 'envios')).toBe(1);
    const pago = await db.execute("SELECT estado FROM pagos WHERE id = 'p2'");
    expect(pago.rows[0].estado).toBe('PENDIENTE_VERIFICACION');
  });

  it('un pago sin telefono emite recibo pero no encola envio', async () => {
    await viviendaConPago('p1');

    const numero = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    expect(numero).toBe(1);
    expect(await contar(db, 'envios')).toBe(0);
  });

  it('dos pagos nunca comparten numero de recibo', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO, periodos: ['2026-09'] });
    await viviendaConPago('p2', { telefono: TELEFONO, periodos: ['2026-10'] });

    const primero = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);
    const segundo = await verificarPagoConMovimiento(db, {
      pagoId: 'p2', movimientoId: 'mov2', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    expect(primero).not.toBe(segundo);
    const { rows } = await db.execute('SELECT count(DISTINCT numero) AS n FROM recibos');
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe('anulacion y reemision', () => {
  it('anula con motivo, emite otro numero y los encadena', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    const original = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    const nuevo = await reemitirRecibo(db, {
      numero: original, motivo: 'monto mal digitado', actor: ACTOR, en: ALTA, plantilla: PLANTILLA,
    });

    expect(nuevo).toBeGreaterThan(original);
    const { rows } = await db.execute('SELECT numero, estado, motivo_anulacion, reemplaza_a FROM recibos ORDER BY numero');
    expect(rows[0]).toMatchObject({ numero: original, estado: 'ANULADO', motivo_anulacion: 'monto mal digitado' });
    expect(rows[1]).toMatchObject({ numero: nuevo, estado: 'EMITIDO', reemplaza_a: original });
  });

  /** El numero anulado no se reutiliza: la secuencia sigue de largo. */
  it('el numero anulado no vuelve a usarse', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    const original = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);
    const nuevo = await reemitirRecibo(db, {
      numero: original, motivo: 'error', actor: ACTOR, en: ALTA, plantilla: PLANTILLA,
    });

    await viviendaConPago('p2', { telefono: TELEFONO, periodos: ['2026-10'] });
    const tercero = await verificarPagoConMovimiento(db, {
      pagoId: 'p2', movimientoId: 'mov2', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    expect([original, nuevo, tercero]).toEqual([1, 2, 3]);
  });

  it('el envio pendiente del recibo anulado no sale', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    const original = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);
    const nuevo = await reemitirRecibo(db, {
      numero: original, motivo: 'error', actor: ACTOR, en: ALTA, plantilla: PLANTILLA,
    });

    const pendientes = await enviosPendientes(db);
    expect(pendientes.map((envio) => envio.reciboNumero)).toEqual([nuevo]);
  });

  it('no se puede anular dos veces el mismo recibo', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    const original = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);
    await reemitirRecibo(db, { numero: original, motivo: 'error', actor: ACTOR, en: ALTA, plantilla: PLANTILLA });

    await expect(reemitirRecibo(db, {
      numero: original, motivo: 'otra vez', actor: ACTOR, en: ALTA, plantilla: PLANTILLA,
    })).rejects.toThrow('recibo_no_emitido');
  });

  it('anular y reemitir queda en eventos', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    const original = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);
    await reemitirRecibo(db, { numero: original, motivo: 'monto mal digitado', actor: ACTOR, en: ALTA, plantilla: PLANTILLA });

    const { rows } = await db.execute(
      "SELECT accion, motivo FROM eventos WHERE entidad = 'recibos' ORDER BY id",
    );
    expect(rows.map((row) => row.accion)).toEqual(['EMITIR', 'ANULAR', 'EMITIR']);
    expect(rows[1].motivo).toBe('monto mal digitado');
  });

  it('un recibo anulado sin motivo no cabe en la tabla', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    const numero = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    await expect(db.execute({
      sql: "UPDATE recibos SET estado = 'ANULADO' WHERE numero = ?",
      args: [numero],
    })).rejects.toThrow(/CHECK/i);
  });
});

describe('cola de envios', () => {
  it('un reenvio usa el mismo numero de recibo', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    const numero = await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    const [primerIntento] = await enviosPendientes(db);
    await marcarEnvioFallido(db, { id: primerIntento.id, error: 'whatsapp_template_failed:500', en: ALTA });

    const [segundoIntento] = await enviosPendientes(db);
    expect(segundoIntento.reciboNumero).toBe(numero);
    expect(segundoIntento.id).toBe(primerIntento.id);
    expect(segundoIntento.intentos).toBe(1);
    expect(await contar(db, 'recibos')).toBe(1);
  });

  it('al agotar los intentos el envio deja de salir en la cola', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    const [envio] = await enviosPendientes(db);
    for (let intento = 0; intento < 5; intento += 1) {
      await marcarEnvioFallido(db, { id: envio.id, error: 'whatsapp_template_failed:500', en: ALTA });
    }

    expect(await enviosPendientes(db)).toEqual([]);
    const { rows } = await db.execute('SELECT estado, intentos FROM envios');
    expect(rows[0]).toMatchObject({ estado: 'FALLIDO', intentos: 5 });
  });

  it('un envio marcado como enviado sale de la cola y guarda el id de Meta', async () => {
    await viviendaConPago('p1', { telefono: TELEFONO });
    await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    const [envio] = await enviosPendientes(db);
    await marcarEnvioEnviado(db, { id: envio.id, waMessageId: 'wamid.ABC', en: ALTA });

    expect(await enviosPendientes(db)).toEqual([]);
    const { rows } = await db.execute('SELECT estado, wa_message_id FROM envios');
    expect(rows[0]).toMatchObject({ estado: 'ENVIADO', wa_message_id: 'wamid.ABC' });
  });

  it('la cola trae los datos que el mensaje necesita', async () => {
    await viviendaConPago('p1', {
      telefono: TELEFONO, periodos: ['2026-09', '2026-10'], referencia: '987654321',
    });
    await verificarPagoConMovimiento(db, {
      pagoId: 'p1', movimientoId: 'mov1', verificadoPor: 'u1', verificadoEn: ALTA, plantilla: PLANTILLA,
    }, ACTOR);

    const [envio] = await enviosPendientes(db);
    expect(envio).toMatchObject({
      vivienda: 'E1B4C18',
      periodos: ['2026-09', '2026-10'],
      montoCentavos: CUOTA_CENTAVOS * 2,
      metodo: 'TRANSFERENCIA',
      referencia: '987654321',
      plantilla: PLANTILLA,
    });
  });
});

describe('contenido del recibo', () => {
  it('arma los ocho parametros en el orden de la plantilla', () => {
    expect(parametrosDePlantilla({
      numero: 12,
      vivienda: 'E1B4C18',
      periodos: ['2026-09'],
      montoCentavos: 15_000,
      metodo: 'TRANSFERENCIA',
      referencia: '987654321',
      fechaPago: '2026-09-05',
      verificadoEn: '2026-09-06T14:03:00.000Z',
    })).toEqual([
      'REC-000012',
      'E1B4C18',
      'septiembre de 2026',
      'L150.00',
      'Transferencia',
      '*****4321',
      '05/09/2026',
      '06/09/2026',
    ]);
  });

  /**
   * El mensaje se puede reenviar a cualquier chat, asi que la referencia va
   * enmascarada: alcanza para que el vecino reconozca su deposito y no lleva el
   * numero completo.
   */
  it('nunca lleva la referencia completa', () => {
    const [, , , , , referencia] = parametrosDePlantilla({
      numero: 1, vivienda: 'E1B4C18', periodos: ['2026-09'], montoCentavos: 15_000,
      metodo: 'TRANSFERENCIA', referencia: '987654321', verificadoEn: ALTA,
    });
    expect(referencia).not.toContain('98765');
    expect(referencia).toMatch(/4321$/);
  });

  it('nombra todos los meses cuando el pago cubre varios', () => {
    expect(listaDeMeses(['2026-09'])).toBe('septiembre de 2026');
    expect(listaDeMeses(['2026-09', '2026-10'])).toBe('septiembre de 2026 y octubre de 2026');
    expect(listaDeMeses(['2026-08', '2026-09', '2026-10']))
      .toBe('agosto de 2026, septiembre de 2026 y octubre de 2026');
  });

  it('el monto sale de centavos enteros y conserva los dos decimales', () => {
    expect(montoEnLempiras(15_000)).toBe('L150.00');
    expect(montoEnLempiras(1)).toBe('L0.01');
    expect(montoEnLempiras(123_456)).toBe('L1,234.56');
  });

  it('muestra un guion cuando falta el dato en vez de una fecha vacia', () => {
    expect(fechaLegible(undefined)).toBe('—');
    const [, , , , , referencia, fechaPago] = parametrosDePlantilla({
      numero: 1, vivienda: 'E1B4C18', periodos: ['2026-09'], montoCentavos: 15_000,
      metodo: 'EFECTIVO', verificadoEn: ALTA,
    });
    expect(referencia).toBe('—');
    expect(fechaPago).toBe('—');
  });
});
