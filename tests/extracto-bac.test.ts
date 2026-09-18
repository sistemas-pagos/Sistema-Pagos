import { describe, expect, it } from 'vitest';
import { CREDITOS, DEBITOS, MOVIMIENTOS, extractoBac, textoExtracto } from './fixtures/extracto-bac';
import {
  ExtractoInvalidoError,
  depositosRecibidos,
  huellaDelArchivo,
  leerExtractoBac,
  ultimos4DeLaCuenta,
} from '@/src/bank/bac-csv';
import { reconcilePendingPayments } from '@/src/services/reconciliation';
import { MemoryPaymentStore } from '@/src/storage/memory';
import type { PaymentRecord } from '@/src/domain/types';

describe('las tres secciones del archivo', () => {
  /**
   * El extracto no es una tabla: son tres pegadas, con 17, 7 y 5 columnas.
   * Abrirlo como una sola da basura en las tres.
   */
  it('lee la cuenta de la cabecera', () => {
    const { cuenta } = leerExtractoBac(extractoBac());

    expect(cuenta.cuenta).toBe('900112233');
    expect(cuenta.titular).toBe('TITULAR DE PRUEBA');
    expect(cuenta.moneda).toBe('HNL');
    expect(cuenta.saldoInicialCentavos).toBe(100000);
  });

  it('lee los movimientos del detalle', () => {
    expect(leerExtractoBac(extractoBac()).movimientos).toHaveLength(MOVIMIENTOS.length);
  });

  /** La seccion de totales tiene 5 columnas y una fila por codigo: no son movimientos. */
  it('no toma los totales por codigo como movimientos', () => {
    const conTotales = leerExtractoBac(extractoBac()).movimientos;
    const sinTotales = leerExtractoBac(extractoBac({ sinTotales: true })).movimientos;

    expect(conTotales).toEqual(sinTotales);
  });

  it('rechaza un archivo que no trae el detalle', () => {
    expect(() => leerExtractoBac(extractoBac({ sinDetalle: true })))
      .toThrow(expect.objectContaining({ motivo: 'sin_detalle_de_movimientos' }));
  });

  it('rechaza cualquier otro archivo en vez de devolver cero movimientos', () => {
    expect(() => leerExtractoBac(Buffer.from('nombre,monto\nalguien,150\n', 'utf8')))
      .toThrow(ExtractoInvalidoError);
  });
});

describe('codificacion', () => {
  /**
   * El banco lo descarga en Windows-1252. Leido como UTF-8, `Descripción` y
   * `Crédito` llegan rotos y no se reconoce ni el encabezado del detalle.
   */
  it('lee el archivo tal como lo descarga el banco', () => {
    const bytes = extractoBac();
    expect(bytes.includes(0xf3)).toBe(true);
    expect(leerExtractoBac(bytes).movimientos).toHaveLength(MOVIMIENTOS.length);
  });

  /** Si alguien lo reabre y lo guarda desde Excel, puede llegar en UTF-8. */
  it('lee tambien una copia guardada en UTF-8', () => {
    const enUtf8 = leerExtractoBac(Buffer.from(textoExtracto(), 'utf8'));
    expect(enUtf8).toEqual(leerExtractoBac(extractoBac()));
  });
});

describe('montos', () => {
  /**
   * `parseFloat('150.00') * 100` es la cuenta que produce 14999 donde tiene que
   * haber 15000. Los centavos se arman con enteros (invariante 7).
   */
  it('los guarda en centavos enteros', () => {
    const [transferencia] = leerExtractoBac(extractoBac()).movimientos;

    expect(transferencia.creditoCentavos).toBe(15000);
    expect(transferencia.debitoCentavos).toBe(0);
    expect(Number.isInteger(transferencia.balanceCentavos)).toBe(true);
  });

  it('acepta el separador de miles cuando viene entrecomillado', () => {
    const [movimiento] = leerExtractoBac(extractoBac({
      movimientos: [{ ...CREDITOS[0], credito: '"1,234.56"' }],
    })).movimientos;

    expect(movimiento.creditoCentavos).toBe(123456);
    expect(movimiento.balanceCentavos).toBe(223456);
  });

  it('se niega a adivinar un monto que no entiende', () => {
    expect(() => leerExtractoBac(extractoBac({ movimientos: [{ ...CREDITOS[0], credito: 'L 150.00' }] })))
      .toThrow(expect.objectContaining({ motivo: 'monto_invalido' }));
  });

  it('lee la fecha dd/mm/aaaa y rechaza la que no existe', () => {
    expect(leerExtractoBac(extractoBac()).movimientos[0].fecha).toBe('2026-09-02');
    expect(() => leerExtractoBac(extractoBac({ movimientos: [{ ...CREDITOS[0], fecha: '31/02/2026' }] })))
      .toThrow(expect.objectContaining({ motivo: 'fecha_invalida' }));
  });
});

describe('que cuenta como deposito recibido', () => {
  /**
   * Se filtra por credito y no por codigo de transaccion. Un deposito en
   * agente, uno en ventanilla y una transferencia llegan con codigos
   * distintos, y el dia que el banco agregue uno nuevo un filtro por codigo
   * dejaria de ver pagos sin avisar a nadie.
   */
  it('toma los creditos y deja fuera las compras del titular', () => {
    const recibidos = depositosRecibidos(leerExtractoBac(extractoBac()));

    expect(recibidos).toHaveLength(CREDITOS.length);
    expect(recibidos.map((movimiento) => movimiento.reference))
      .toEqual(CREDITOS.map((credito) => credito.referencia));
  });

  it('no deja fuera un codigo de transaccion que no conocemos', () => {
    const nuevo = { ...CREDITOS[0], codigo: 'ZZ', referencia: '412000099' };
    const recibidos = depositosRecibidos(leerExtractoBac(extractoBac({ movimientos: [nuevo, ...DEBITOS] })));

    expect(recibidos).toHaveLength(1);
    expect(recibidos[0].reference).toBe('412000099');
  });

  it('los entrega con el banco y el monto que espera la conciliacion', () => {
    const [primero] = depositosRecibidos(leerExtractoBac(extractoBac()));

    expect(primero.bank).toBe('BAC Honduras');
    expect(primero.amount).toBe(150);
    expect(primero.transactionDate).toBe('2026-09-02');
  });
});

describe('huella del movimiento', () => {
  /**
   * La invariante 3 exige que un movimiento verifique un solo pago, y eso se
   * sostiene en la UNIQUE de `movimientos_banco`. Si la huella cambiara entre
   * descargas, dos exportaciones que se solapan meterian el mismo deposito dos
   * veces y verificarian dos pagos.
   */
  it('es la misma para el mismo movimiento en dos descargas', () => {
    const primera = leerExtractoBac(extractoBac()).movimientos;
    // Una descarga posterior arranca donde quedo la anterior.
    const segunda = leerExtractoBac(extractoBac({
      movimientos: MOVIMIENTOS.slice(1), saldoInicial: '1150.00',
    })).movimientos;

    expect(segunda[0].huella).toBe(primera[1].huella);
  });

  /**
   * En un mes real hay diez referencias repetidas: el contador de las compras
   * con tarjeta se reinicia. Una huella hecha solo con la referencia uniria
   * movimientos distintos.
   */
  it('distingue dos movimientos que comparten la referencia', () => {
    const movimientos = leerExtractoBac(extractoBac({
      movimientos: [
        { ...CREDITOS[0], referencia: '000111', credito: '150.00' },
        { ...CREDITOS[0], referencia: '000111', credito: '150.00' },
      ],
    })).movimientos;

    expect(movimientos[0].huella).not.toBe(movimientos[1].huella);
  });

  it('el archivo entero tiene su propia huella, para no importarlo dos veces', () => {
    expect(huellaDelArchivo(extractoBac())).toBe(huellaDelArchivo(extractoBac()));
    expect(huellaDelArchivo(extractoBac())).not.toBe(huellaDelArchivo(extractoBac({ cuenta: '790500000' })));
  });
});

describe('la cadena de balances', () => {
  /**
   * El balance de cada fila es el saldo despues de esa transaccion, asi que el
   * archivo forma una cadena que arranca en el `Saldo Inicial` de la cabecera.
   * Cuadra al centavo en las sesenta y una filas del extracto real que sirvio
   * de modelo, y comprobarla ataja lo que ninguna otra validacion ve.
   */
  it('rechaza un archivo cuyas filas no suman', () => {
    expect(() => leerExtractoBac(extractoBac({
      movimientos: [{ ...CREDITOS[0], balance: '9999.00' }],
    }))).toThrow(expect.objectContaining({ motivo: 'balance_no_cuadra' }));
  });

  /**
   * Nadie manda un extracto editado a mano por error. Es justo por donde se
   * colaria un deposito que nunca existio, y la invariante 3 se apoya entera
   * en que este archivo sea el del banco.
   */
  it('rechaza un deposito agregado a mano al archivo', () => {
    const lineas = textoExtracto().split('\r\n');
    const detalle = lineas.findIndex((linea) => linea.startsWith('Fecha de Transacción'));
    const inventado = `07/09/2026, 412000777, TF, ${'TEF DE:NO EXISTE'.padEnd(30, ' ')}, 0.00, 150.00, 1000.00 `;
    lineas.splice(detalle + 1, 0, inventado);

    expect(() => leerExtractoBac(Buffer.from(lineas.join('\r\n'), 'latin1')))
      .toThrow(expect.objectContaining({ motivo: 'balance_no_cuadra' }));
  });

  /** Una coma dentro de la descripcion corre las columnas una posicion. */
  it('no se desalinea con una descripcion que trae coma', () => {
    const [movimiento] = leerExtractoBac(extractoBac({
      movimientos: [{ ...CREDITOS[0], descripcion: 'TEF DE:PRUEBA, SOCIEDAD' }],
    })).movimientos;

    expect(movimiento.descripcion).toBe('TEF DE:PRUEBA, SOCIEDAD');
    expect(movimiento.creditoCentavos).toBe(15000);
  });

  /**
   * El caso que la cadena de balances existe para atajar: con la coma dentro
   * del monto, las columnas corridas siguen siendo numeros validos y
   * plausibles. Sin comprobar la suma se leeria 2.35 donde hay 1234.56.
   */
  it('no lee mal en silencio un monto con coma sin entrecomillar', () => {
    expect(() => leerExtractoBac(extractoBac({
      movimientos: [{ ...CREDITOS[0], credito: '1,234.56' }],
    }))).toThrow(expect.objectContaining({ motivo: 'balance_no_cuadra' }));
  });
});

describe('la cuenta del extracto', () => {
  /**
   * Un extracto de otra cuenta verificaria pagos contra depositos que nunca
   * entraron a la cuenta de cobro. Es la invariante 4 del lado del banco.
   */
  it('deja comprobar que el extracto es el de la cuenta de cobro', () => {
    expect(ultimos4DeLaCuenta(leerExtractoBac(extractoBac()))).toBe('2233');
    expect(ultimos4DeLaCuenta(leerExtractoBac(extractoBac({ cuenta: '745374361' })))).toBe('4361');
  });
});

describe('el extracto verificando pagos de verdad', () => {
  function pago(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
    return {
      id: 'pay-1', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
      sourceMessageId: 'msg-1', phone: '+50400000001', bank: 'BAC Honduras', amount: 150,
      transactionDate: '2026-09-02', reference: '412000001', stage: '1', block: '4', house: '18',
      period: '2026-09', status: 'PENDIENTE_VERIFICACION', fileHash: 'hash-1', ...overrides,
    };
  }

  it('verifica el pago cuyo comprobante coincide con un deposito del extracto', async () => {
    const store = new MemoryPaymentStore({ payments: [pago()] });
    const movimientos = depositosRecibidos(leerExtractoBac(extractoBac()));

    const resumen = await reconcilePendingPayments(store, movimientos, 'extracto-bac', new Date('2026-09-16T12:00:00.000Z'));

    expect(resumen.verified).toBe(1);
    expect((await store.getPayment('pay-1'))?.status).toBe('VERIFICADO');
  });

  /** Un comprobante cuyo deposito no esta en el extracto no se verifica (invariante 2). */
  it('no verifica un comprobante que el banco no respalda', async () => {
    const store = new MemoryPaymentStore({ payments: [pago({ reference: '999999999' })] });
    const movimientos = depositosRecibidos(leerExtractoBac(extractoBac()));

    const resumen = await reconcilePendingPayments(store, movimientos, 'extracto-bac');

    expect(resumen.verified).toBe(0);
    expect((await store.getPayment('pay-1'))?.status).toBe('NO_ENCONTRADO');
  });
});
