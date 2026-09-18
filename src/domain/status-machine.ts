import type { PaymentStatus } from './types';

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  ESPERANDO_RESPUESTA: ['PENDIENTE_VERIFICACION', 'EN_REVISION', 'RECHAZADO'],
  PENDIENTE_VERIFICACION: ['VERIFICADO', 'NO_ENCONTRADO', 'EN_REVISION', 'DUPLICADO', 'RECHAZADO'],
  VERIFICADO: ['EN_REVISION', 'ANULADO'],
  // El cierre de caja convierte el efectivo cobrado en verificado, sin recibo
  // nuevo (docs/PLAN.md, fase 6).
  EFECTIVO_COBRADO: ['VERIFICADO', 'EN_REVISION', 'ANULADO'],
  EN_REVISION: ['PENDIENTE_VERIFICACION', 'VERIFICADO', 'NO_ENCONTRADO', 'RECHAZADO'],
  NO_ENCONTRADO: ['VERIFICADO', 'EN_REVISION', 'RECHAZADO'],
  DUPLICADO: ['EN_REVISION'],
  RECHAZADO: ['EN_REVISION'],
  // Un pago anulado no vuelve. La correccion entra como un pago nuevo, y el
  // recibo se reemplaza por otro numero (invariante 10).
  ANULADO: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid payment state transition: ${from} -> ${to}`);
  }
}
