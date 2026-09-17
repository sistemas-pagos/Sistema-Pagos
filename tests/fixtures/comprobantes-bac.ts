/**
 * Los tres formatos de comprobante del BAC que llegan de verdad, con la
 * estructura calcada de comprobantes reales y **todos los valores inventados**.
 *
 * Este repositorio es publico: ningun nombre, telefono, cuenta o referencia de
 * aqui corresponde a una persona. Lo que se conserva del original es solo la
 * forma — que etiquetas usa, en que orden, donde parte las lineas y como
 * escribe fechas y montos —, que es lo unico que el parser necesita acertar.
 *
 * La cuenta de destino termina en 2920 en los tres, como en la realidad: es el
 * dato contra el que se comprueba que el dinero entro a la cuenta correcta.
 */

/** Notificacion compartible de la app. Es la que mas llega. */
export function notificacion(opciones: {
  detalle?: string[];
  fecha?: string;
  hora?: string;
  monto?: string;
  referencia?: string;
  /** Un banner del sistema puede tapar el logo en la captura. */
  sinLogo?: boolean;
} = {}): string {
  const detalle = opciones.detalle ?? ['Pago mes de septiembre'];
  return [
    opciones.sinLogo ? 'Favorito guardado exitosamente' : 'BAC',
    'Notificación de transferencia',
    'Hola,',
    'Le informamos que PERSONA QUE DEPOSITA realizó una transferencia a la cuenta',
    'bancaria Nº 790582920 a nombre de TITULAR DE PRUEBA.',
    `Fecha ${opciones.fecha ?? '16 septiembre 2026'}`,
    `Hora ${opciones.hora ?? '2:45 PM'}`,
    `Monto ${opciones.monto ?? 'L150.00'}`,
    ...detalle.map((linea, indice) => (indice === 0 ? `Detalle ${linea}` : `        ${linea}`)),
    `Referencia ${opciones.referencia ?? '400000001'}`,
  ].join('\n');
}

/**
 * Pantalla de resultado dentro de la app, la que se captura con el celular.
 *
 * No escribe "BAC" en ninguna parte, escribe la fecha sin anio y llama
 * "N° comprobante" a la referencia.
 */
export const PANTALLA_RESULTADO = [
  'Transferencias',
  'Resultado de transferencia',
  'Cuenta origen',
  'PERSONA QUE DEPOSITA',
  '745374361',
  'Cuenta destino',
  'TITULAR DE PRUEBA',
  '790582920',
  'Descripción',
  'Basura',
  'Fecha 14 septiembre',
  'Monto debitado L150.00',
  'N° comprobante 400000002',
  'Monto L150.00',
].join('\n');

/**
 * Comprobante de agente bancario, impreso en papel y fotografiado.
 *
 * Trae dos numeros que compiten por ser la referencia, corta el nombre del
 * titular a la mitad de una palabra y su `Detalle` es un codigo del agente, no
 * algo que el vecino haya escrito.
 */
export const AGENTE = [
  'BAC',
  '*** COPIA DEL CLIENTE ***',
  'Pulperia de prueba',
  'Resid de prueba bloque 23',
  'Fecha: 15/09/26    Hora: 14:53:52',
  'Terminal:              0004',
  'Lote:                  0057',
  'Referencia:          004217',
  'Autorización:      400000003',
  'Tipo de Transacción:  Depósito',
  'Número de Cuenta:   *****2920',
  'Cliente:   TITULAR DE PRUE',
  'BA',
  'Detalle:   DEP.RAPIBAC 010925',
  'Monto Pagado:        L 150.00',
  'Tipo de Cambio:     No aplica',
  'Monto de Transacción: L 150.00',
  'BAC Credomatic es responsable por las operaciones y servicios prestados por',
  'medio del CNB Honduras.',
].join('\n');
