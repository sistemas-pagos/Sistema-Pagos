import { describe, expect, it } from 'vitest';
import { AGENTE, PANTALLA_RESULTADO, notificacion } from './fixtures/comprobantes-bac';
import { parseHomeReference } from '@/src/domain/housing';
import { bacParser } from '@/src/parsers/bac';
import { detectAndParseReceipt } from '@/src/parsers';

/**
 * Lo que sabe el parser salio de mirar dieciseis comprobantes reales, y cada
 * prueba de aqui corresponde a un fallo que esos comprobantes destaparon.
 * `npm run lint`, `typecheck`, `test` y `build` pasaban los cuatro mientras el
 * parser leia mal ocho cosas distintas, porque las pruebas de antes usaban un
 * comprobante inventado con el formato que suponiamos.
 */
const HOY = new Date('2026-09-17T12:00:00Z');

describe('el banco se reconoce por varias senales', () => {
  it('reconoce la notificacion con logo', () => {
    expect(bacParser.detect(notificacion())).toBeGreaterThanOrEqual(0.5);
  });

  /**
   * Una captura con el banner de "Favorito guardado" encima pierde el logo. El
   * comprobante sigue siendo legible entero, asi que rechazarlo por eso era
   * tirar un pago que estaba perfecto.
   */
  it('reconoce la notificacion aunque el banner tape el logo', () => {
    const texto = notificacion({ sinLogo: true });
    expect(texto).not.toContain('BAC');
    expect(bacParser.detect(texto)).toBeGreaterThanOrEqual(0.5);
  });

  it('reconoce la pantalla de resultado, que nunca escribe BAC', () => {
    expect(PANTALLA_RESULTADO).not.toContain('BAC');
    expect(bacParser.detect(PANTALLA_RESULTADO)).toBeGreaterThanOrEqual(0.5);
  });

  it('reconoce el comprobante de agente', () => {
    expect(bacParser.detect(AGENTE)).toBeGreaterThanOrEqual(0.5);
  });

  /**
   * El umbral pide dos senales. Con una sola, un comprobante de otro banco que
   * casualmente use las mismas etiquetas entraria como BAC y se leeria con las
   * reglas equivocadas.
   */
  it('no le alcanza con las etiquetas sueltas', () => {
    const otroBanco = ['Fecha 16 septiembre 2026', 'Hora 2:45 PM', 'Monto L150.00', 'Referencia 1'].join('\n');
    expect(bacParser.detect(otroBanco)).toBeLessThan(0.5);
  });

  it('no le alcanza con la marca sola', () => {
    expect(bacParser.detect('BAC Credomatic')).toBeLessThan(0.5);
  });
});

describe('la vivienda se lee como la escriben los vecinos', () => {
  it('lee el ordinal abreviado con almohadillas', () => {
    const extraccion = detectAndParseReceipt(
      notificacion({ detalle: ['Nombre/Sept/4ta etapa, b#55,', 'C#10'] }), HOY,
    );
    expect(extraccion.home).toEqual({ stage: '4', block: '55', house: '10' });
  });

  it('lee el ordinal en palabras repartido en dos lineas', () => {
    const extraccion = detectAndParseReceipt(
      notificacion({ detalle: ['Pago Septiembre, Tercera etapa,', 'bloque 45,casa 5'] }), HOY,
    );
    expect(extraccion.home).toEqual({ stage: '3', block: '45', house: '5' });
  });

  /**
   * El fallo mas peligroso de todos: `E(?:TAPA)?` enganchaba la "e" de "etapa" y
   * devolvia la etapa "TAPA", con confianza 1 y sin una sola advertencia. Un
   * fallo ruidoso manda el pago a revision; este lo asignaba a una vivienda
   * inexistente y nadie se enteraba.
   */
  it('nunca devuelve "TAPA" como etapa', () => {
    expect(parseHomeReference('4ta etapa, b#55, C#10')?.stage).toBe('4');
    expect(parseHomeReference('etapa 4')).toBeUndefined();
  });

  /** La "C" de "Condominio" se llevaba "ONDOM" como numero de casa. */
  it('no confunde "Condominio" con una casa', () => {
    expect(parseHomeReference('Pago de tren de Aseo septiembre Condominio G-04')).toBeUndefined();
    expect(parseHomeReference('Tren de Aseo, Condominios K-09')).toBeUndefined();
  });

  it('sigue leyendo el codigo compacto que el sistema pide', () => {
    expect(parseHomeReference('E1B4C18')).toEqual({ stage: '1', block: '4', house: '18' });
    expect(parseHomeReference('E1BAC18')).toEqual({ stage: '1', block: 'A', house: '18' });
    expect(parseHomeReference('Etapa1Bloque4Casa18')).toEqual({ stage: '1', block: '4', house: '18' });
  });

  it('avisa cuando el detalle no dice la vivienda, en vez de inventarla', () => {
    const extraccion = detectAndParseReceipt(notificacion({ detalle: ['Pago mes de septiembre'] }), HOY);
    expect(extraccion.home).toBeUndefined();
    expect(extraccion.warnings).toContain('home_missing');
  });
});

describe('beneficiario y cuenta de destino', () => {
  /**
   * El BAC no escribe "Beneficiario" en ninguno de los tres formatos. Sin leer
   * estos dos campos, la invariante 4 manda todos los comprobantes a revision y
   * el sistema no verifica un solo pago solo.
   */
  it('los saca de la frase de la notificacion', () => {
    const extraccion = detectAndParseReceipt(notificacion(), HOY);
    expect(extraccion.beneficiary).toBe('TITULAR DE PRUEBA');
    expect(extraccion.destinationAccountMasked).toBe('••••2233');
  });

  it('los saca del bloque "Cuenta destino" de la pantalla', () => {
    const extraccion = detectAndParseReceipt(PANTALLA_RESULTADO, HOY);
    expect(extraccion.beneficiary).toBe('TITULAR DE PRUEBA');
    expect(extraccion.destinationAccountMasked).toBe('••••2233');
  });

  /** En el papel el nombre se corta a la mitad de una palabra y sigue abajo. */
  it('reune el nombre partido en dos lineas del comprobante de agente', () => {
    const extraccion = detectAndParseReceipt(AGENTE, HOY);
    expect(extraccion.beneficiary).toBe('TITULAR DE PRUEBA');
    expect(extraccion.destinationAccountMasked).toBe('••••2233');
  });
});

describe('referencia', () => {
  /**
   * En el comprobante de agente conviven dos numeros. La `Referencia` de seis
   * digitos es el contador interno de la pulperia, que se reinicia y se repite
   * entre agentes distintos: dos pagos de pulperias distintas pareceria el
   * mismo. La `Autorizacion` es la que asigna el banco.
   */
  it('prefiere la autorizacion sobre el contador del agente', () => {
    expect(detectAndParseReceipt(AGENTE, HOY).reference).toBe('400000003');
  });

  it('usa "N° comprobante" en la pantalla de resultado', () => {
    expect(detectAndParseReceipt(PANTALLA_RESULTADO, HOY).reference).toBe('400000002');
  });
});

describe('fecha, hora, monto y detalle', () => {
  /** "Hora 2:45 PM" se partia en "45 PM" al cortar por el primer ':' de la linea. */
  it('lee la hora de 12 horas sin dos puntos en la etiqueta', () => {
    expect(detectAndParseReceipt(notificacion({ hora: '2:45 PM' }), HOY).transactionTime).toBe('14:45');
    expect(detectAndParseReceipt(notificacion({ hora: '9:39 AM' }), HOY).transactionTime).toBe('09:39');
    expect(detectAndParseReceipt(notificacion({ hora: '12:05 AM' }), HOY).transactionTime).toBe('00:05');
  });

  it('lee la hora de 24 horas con segundos del comprobante de agente', () => {
    expect(detectAndParseReceipt(AGENTE, HOY).transactionTime).toBe('14:53');
  });

  it('lee la fecha en palabras y la de barras', () => {
    expect(detectAndParseReceipt(notificacion({ fecha: '16 septiembre 2026' }), HOY).transactionDate).toBe('2026-09-16');
    expect(detectAndParseReceipt(AGENTE, HOY).transactionDate).toBe('2026-09-15');
  });

  /**
   * La pantalla de resultado no escribe el anio. Se toma el mas reciente que no
   * deje la fecha en el futuro, porque un comprobante es siempre de un pago ya
   * hecho.
   */
  it('completa el anio que la pantalla no escribe', () => {
    expect(detectAndParseReceipt(PANTALLA_RESULTADO, HOY).transactionDate).toBe('2026-09-14');
  });

  it('un dia por delante de hoy es del anio pasado', () => {
    const enero = new Date('2027-01-05T12:00:00Z');
    expect(detectAndParseReceipt(PANTALLA_RESULTADO, enero).transactionDate).toBe('2026-09-14');
  });

  it('"(Sin detalle)" es la ausencia de detalle, no un detalle', () => {
    expect(detectAndParseReceipt(notificacion({ detalle: ['(Sin detalle)'] }), HOY).detail).toBeUndefined();
  });

  it('lee el monto con y sin espacio despues de la L', () => {
    expect(detectAndParseReceipt(notificacion({ monto: 'L150.00' }), HOY).amount).toBe(150);
    expect(detectAndParseReceipt(notificacion({ monto: 'L300.00' }), HOY).amount).toBe(300);
    expect(detectAndParseReceipt(AGENTE, HOY).amount).toBe(150);
  });
});
