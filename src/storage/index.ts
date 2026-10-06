import { isDemoMode } from '@/src/config/env';
import { DEMO_HOMES, DEMO_PAYMENTS } from '@/src/demo/data';
import { MemoryPaymentStore } from './memory';
import { getTursoClient } from './turso-client';
import { TursoPaymentStore } from './turso-store';
import type { PaymentStore } from './types';

/**
 * En produccion los pagos viven en Turso, que es la unica fuente de verdad
 * (docs/PLAN.md, seccion 1).
 *
 * Antes vivian en Google Sheets, y por eso el recibo no se emitia nunca: el
 * talonario estaba en Turso y el pago en la hoja. Sheets no vuelve: Eduardo lo
 * descarto en todo punto, y las vistas que iba a servir ya estan en el panel.
 */
let demoStore: MemoryPaymentStore | undefined;
let productionStore: TursoPaymentStore | undefined;

export async function getPaymentStore(): Promise<PaymentStore> {
  if (isDemoMode()) {
    demoStore ??= new MemoryPaymentStore({ homes: DEMO_HOMES, payments: DEMO_PAYMENTS });
    return demoStore;
  }

  productionStore ??= new TursoPaymentStore(await getTursoClient());
  return productionStore;
}
