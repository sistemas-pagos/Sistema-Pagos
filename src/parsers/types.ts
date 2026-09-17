import type { ReceiptExtraction } from '@/src/domain/types';

export interface ReceiptParser {
  id: string;
  detect(text: string): number;
  /**
   * `hoy` solo lo usan los comprobantes que escriben la fecha sin anio. Va como
   * parametro y no como `new Date()` adentro para que la prueba pueda fijarlo:
   * si no, el resultado cambiaria con el dia en que se corren las pruebas.
   */
  parse(text: string, hoy?: Date): ReceiptExtraction;
}
