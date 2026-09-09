import type { PaymentStatus } from './types';

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  COMPROBANTE_RECIBIDO: ['PROCESANDO', 'RECHAZADO'],
  PROCESANDO: ['EXTRAIDO', 'EN_REVISION', 'RECHAZADO'],
  EXTRAIDO: ['SIN_IDENTIFICAR', 'PENDIENTE_VERIFICACION', 'DUPLICADO', 'EN_REVISION'],
  SIN_IDENTIFICAR: ['ESPERANDO_RESPUESTA', 'EN_REVISION', 'RECHAZADO'],
  ESPERANDO_RESPUESTA: ['PENDIENTE_VERIFICACION', 'EN_REVISION', 'RECHAZADO'],
  PENDIENTE_VERIFICACION: ['VERIFICADO', 'NO_ENCONTRADO', 'EN_REVISION', 'DUPLICADO', 'RECHAZADO'],
  VERIFICADO: ['EN_REVISION'],
  DUPLICADO: ['EN_REVISION'],
  NO_ENCONTRADO: ['VERIFICADO', 'EN_REVISION', 'RECHAZADO'],
  EN_REVISION: ['PENDIENTE_VERIFICACION', 'VERIFICADO', 'NO_ENCONTRADO', 'RECHAZADO'],
  RECHAZADO: ['EN_REVISION'],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid payment state transition: ${from} -> ${to}`);
  }
}
