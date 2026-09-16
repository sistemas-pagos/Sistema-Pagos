import { describe, expect, it } from 'vitest';
import type { PaymentRecord } from '@/src/domain/types';
import { BASE_PERIOD, assignServicePeriod, depositServicePeriod } from '@/src/services/period-assignment';

const home = { stage: '1', block: '4', house: '18' };

function payment(period: string, id = `pay-${period}`, status: PaymentRecord['status'] = 'VERIFICADO'): PaymentRecord {
  return {
    id, createdAt: `${period}-01T00:00:00.000Z`, updatedAt: `${period}-01T00:00:00.000Z`, sourceMessageId: `msg-${id}`,
    phone: '+50400000000', bank: 'BAC Honduras', amount: 150, stage: '1', block: '4', house: '18',
    period, status, fileHash: `hash-${id}`,
  };
}

describe('asignación de mes de servicio', () => {
  it('el primer mes del sistema es septiembre de 2026', () => {
    expect(BASE_PERIOD).toBe('2026-09');
    // Un depósito anterior al arranque no crea meses viejos: la deuda previa
    // entra como saldo inicial, no como cuotas.
    expect(depositServicePeriod('2026-07-15')).toBe('2026-09');
    expect(assignServicePeriod(home, '2026-07-15', [])).toBe('2026-09');
  });

  it('el primer pago va al primer mes de servicio', () => {
    expect(assignServicePeriod(home, '2026-09-01', [])).toBe('2026-09');
  });

  it('un pago pendiente reserva su mes y el siguiente avanza', () => {
    // Antes los dos caían en el mismo mes y el segundo iba a revisión.
    const pendiente = payment('2026-09', 'pendiente-sep', 'PENDIENTE_VERIFICACION');
    expect(assignServicePeriod(home, '2026-10-01', [pendiente])).toBe('2026-10');
  });

  it('un pago verificado también reserva su mes', () => {
    expect(assignServicePeriod(home, '2026-10-01', [payment('2026-09')])).toBe('2026-10');
  });

  it('avanza al mes más antiguo que quede libre', () => {
    expect(assignServicePeriod(home, '2026-12-20', [payment('2026-09'), payment('2026-10')])).toBe('2026-11');
  });

  it('NO_ENCONTRADO, RECHAZADO y DUPLICADO liberan el mes', () => {
    for (const estado of ['NO_ENCONTRADO', 'RECHAZADO', 'DUPLICADO'] as const) {
      const liberado = payment('2026-09', `liberado-${estado}`, estado);
      expect(assignServicePeriod(home, '2026-09-20', [liberado])).toBe('2026-09');
    }
  });

  it('EN_REVISION y ESPERANDO_RESPUESTA mantienen el mes ocupado', () => {
    for (const estado of ['EN_REVISION', 'ESPERANDO_RESPUESTA'] as const) {
      const ocupado = payment('2026-09', `ocupado-${estado}`, estado);
      expect(assignServicePeriod(home, '2026-10-20', [ocupado])).toBe('2026-10');
    }
  });

  it('nunca adelanta más allá del mes del depósito', () => {
    // Con todos los meses ocupados se queda en el del depósito, y el conflicto
    // lo manda a revisión en vez de pagar un mes futuro.
    expect(assignServicePeriod(home, '2026-10-20', [payment('2026-09'), payment('2026-10')])).toBe('2026-10');
  });

  it('respeta la fecha de alta de la vivienda', () => {
    // Una casa dada de alta en noviembre no debe septiembre ni octubre.
    const tardia = { ...home, startDate: '2026-11-05' };
    expect(assignServicePeriod(tardia, '2026-11-20', [])).toBe('2026-11');
    expect(assignServicePeriod(tardia, '2026-12-20', [])).toBe('2026-11');
  });

  it('una fecha de alta anterior al arranque no crea meses previos', () => {
    const vieja = { ...home, startDate: '2024-01-01' };
    expect(assignServicePeriod(vieja, '2026-09-20', [])).toBe('2026-09');
  });

  it('excluye el propio pago al reasignarlo', () => {
    const propio = payment('2026-09', 'propio', 'EN_REVISION');
    expect(assignServicePeriod(home, '2026-09-20', [propio], new Date(), 'propio')).toBe('2026-09');
  });
});
