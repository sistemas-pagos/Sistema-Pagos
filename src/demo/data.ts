import type { HomeRecord, PaymentRecord } from '@/src/domain/types';

export const DEMO_PERIOD = '2026-09';

export const DEMO_HOMES: HomeRecord[] = [
  { id: 'home-e1-b1-c1', stage: 1, block: 1, house: 1, responsible: 'Persona Demo A', monthlyFee: 150, active: true },
  { id: 'home-e1-b1-c2', stage: 1, block: 1, house: 2, responsible: 'Persona Demo B', monthlyFee: 150, active: true },
  { id: 'home-e1-b1-c3', stage: 1, block: 1, house: 3, responsible: 'Persona Demo C', monthlyFee: 150, active: true },
  { id: 'home-e1-b1-c4', stage: 1, block: 1, house: 4, responsible: 'Persona Demo D', monthlyFee: 150, active: true },
  { id: 'home-e1-b2-c1', stage: 1, block: 2, house: 1, responsible: 'Persona Demo E', monthlyFee: 150, active: true },
  { id: 'home-e1-b2-c2', stage: 1, block: 2, house: 2, responsible: 'Persona Demo F', monthlyFee: 150, active: true },
  { id: 'home-e2-b2-c3', stage: 2, block: 2, house: 3, responsible: 'Persona Demo G', monthlyFee: 150, active: true },
  { id: 'home-e2-b2-c4', stage: 2, block: 2, house: 4, responsible: 'Persona Demo H', monthlyFee: 150, active: true },
  { id: 'home-e1-b4-c17', stage: 1, block: 4, house: 17, responsible: 'Persona Demo I', monthlyFee: 150, active: true },
  { id: 'home-e1-b4-c18', stage: 1, block: 4, house: 18, responsible: 'Persona Demo J', monthlyFee: 150, active: true },
  { id: 'home-e1-b4-c19', stage: 1, block: 4, house: 19, responsible: 'Persona Demo K', monthlyFee: 150, active: true },
  { id: 'home-e1-b4-c20', stage: 1, block: 4, house: 20, responsible: 'Persona Demo L', monthlyFee: 150, active: true },
];

const base = {
  period: DEMO_PERIOD,
  bank: 'BAC Honduras',
  amount: 150,
} as const;

export const DEMO_PAYMENTS: PaymentRecord[] = [
  {
    ...base, id: 'pay-demo-001', createdAt: '2026-09-07T14:12:00.000Z', updatedAt: '2026-09-07T14:14:00.000Z', sourceMessageId: 'wamid.demo.001', phone: '+50400000010',
    depositor: 'JUAN PÉREZ DEMO', transactionDate: '2026-09-07', transactionTime: '08:12', detail: 'E1 B4 C18', reference: 'DEMO-REF-0001', beneficiary: 'RESIDENCIAL DEMO',
    destinationAccountMasked: '••••0001', stage: 1, block: 4, house: 18, status: 'VERIFICADO', fileHash: 'demo-hash-001', verificationSource: 'demo-bank-movement', verifiedAt: '2026-09-07T14:14:00.000Z', bankMovementId: 'demo-movement-001',
  },
  {
    ...base, id: 'pay-demo-002', createdAt: '2026-09-06T16:30:00.000Z', updatedAt: '2026-09-06T16:30:00.000Z', sourceMessageId: 'wamid.demo.002', phone: '+50400000001',
    depositor: 'MARÍA DEMO', transactionDate: '2026-09-06', transactionTime: '10:30', detail: 'Etapa 1 Bloque 1 Casa 1', reference: 'DEMO-REF-0002', beneficiary: 'RESIDENCIAL DEMO',
    destinationAccountMasked: '••••0001', stage: 1, block: 1, house: 1, status: 'PENDIENTE_VERIFICACION', fileHash: 'demo-hash-002',
  },
  {
    ...base, id: 'pay-demo-003', createdAt: '2026-09-05T18:20:00.000Z', updatedAt: '2026-09-05T18:20:00.000Z', sourceMessageId: 'wamid.demo.003', phone: '+50400000005',
    depositor: 'CARLOS DEMO', transactionDate: '2026-09-05', transactionTime: '12:20', detail: 'E1-B2-C1', reference: 'DEMO-REF-0003', beneficiary: 'RESIDENCIAL DEMO',
    destinationAccountMasked: '••••0001', stage: 1, block: 2, house: 1, status: 'VERIFICADO', fileHash: 'demo-hash-003', verificationSource: 'demo-bank-movement', verifiedAt: '2026-09-05T18:25:00.000Z', bankMovementId: 'demo-movement-003',
  },
  {
    ...base, id: 'pay-demo-004', createdAt: '2026-09-04T20:05:00.000Z', updatedAt: '2026-09-04T20:05:00.000Z', sourceMessageId: 'wamid.demo.004', phone: '+50400000999',
    depositor: 'TERCERO DEMO', transactionDate: '2026-09-04', transactionTime: '14:05', detail: 'Cuota septiembre', reference: 'DEMO-REF-0004', beneficiary: 'RESIDENCIAL DEMO',
    destinationAccountMasked: '••••0001', status: 'ESPERANDO_RESPUESTA', fileHash: 'demo-hash-004',
  },
  {
    ...base, amount: 175, id: 'pay-demo-005', createdAt: '2026-09-03T15:40:00.000Z', updatedAt: '2026-09-03T15:40:00.000Z', sourceMessageId: 'wamid.demo.005', phone: '+50400000006',
    depositor: 'PERSONA DEMO', transactionDate: '2026-09-03', transactionTime: '09:40', detail: 'E1 B2 C2', reference: 'DEMO-REF-0005', beneficiary: 'RESIDENCIAL DEMO',
    destinationAccountMasked: '••••0001', stage: 1, block: 2, house: 2, status: 'EN_REVISION', fileHash: 'demo-hash-005', reviewReason: 'amount_above_expected',
  },
  {
    ...base, id: 'pay-demo-006', createdAt: '2026-09-03T15:45:00.000Z', updatedAt: '2026-09-03T15:45:00.000Z', sourceMessageId: 'wamid.demo.006', phone: '+50400000001',
    depositor: 'MARÍA DEMO', transactionDate: '2026-09-06', transactionTime: '10:30', detail: 'Etapa 1 Bloque 1 Casa 1', reference: 'DEMO-REF-0002', beneficiary: 'RESIDENCIAL DEMO',
    destinationAccountMasked: '••••0001', stage: 1, block: 1, house: 1, status: 'DUPLICADO', fileHash: 'demo-hash-006', duplicateOf: 'pay-demo-002', duplicateReason: 'file_hash',
  },
];

export const SYNTHETIC_BAC_RECEIPTS = {
  valid: `BAC\nTransferencia realizada\nRemitente: JUAN PÉREZ DEMO\nFecha: 07/09/2026\nHora: 08:12 AM\nMonto: L150.00\nDetalle: E1 B4 C18\nReferencia: DEMOREF000001\nBeneficiario: RESIDENCIAL DEMO\nCuenta destino: 000000000001`,
  missingHome: `BAC\nTransferencia realizada\nRemitente: ANA DEMO\nFecha: 08/09/2026\nHora: 09:05 AM\nMonto: L150.00\nDetalle: Cuota mensual\nReferencia: DEMOREF000002\nBeneficiario: RESIDENCIAL DEMO\nCuenta destino: 000000000001`,
  amountMismatch: `BAC\nTransferencia realizada\nRemitente: PERSONA DEMO\nFecha: 09/09/2026\nHora: 11:10 AM\nMonto: L175.00\nDetalle: E1 B2 C2\nReferencia: DEMOREF000175\nBeneficiario: RESIDENCIAL DEMO\nCuenta destino: 000000000001`,
  editedConflict: `BAC\nTransferencia realizada\nRemitente: PERSONA DEMO\nFecha: 07/09/2026\nHora: 08:12 AM\nMonto: L900.00\nDetalle: E1 B2 C2\nReferencia: DEMOREF000001\nBeneficiario: RESIDENCIAL DEMO\nCuenta destino: 000000000001`,
} as const;
