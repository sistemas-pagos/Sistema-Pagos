import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAdminAuthenticated } from '@/src/auth/guard';
import { periodFromDate, isPeriod, periodLabel } from '@/src/domain/periods';
import type { MonthlyCollectionStatus } from '@/src/domain/types';
import { buildDashboardSnapshot } from '@/src/services/dashboard';
import { buildHouseHistoryGrid, type HousePeriodState } from '@/src/services/house-history';
import { canManuallyVerify } from '@/src/services/manual-verification';
import { getPaymentStore } from '@/src/storage';

export const dynamic = 'force-dynamic';

const money = (value: number) => `L${value.toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (value: number) => `${Math.round(value * 100)}%`;
const positiveInt = (value: string | undefined): number | undefined => {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};
const HOUSE_STATE_LABEL: Record<HousePeriodState, string> = {
  VERIFICADO: '✅ Verificado',
  RECIBIDO: '✓ Recibido',
  EN_REVISION: '⚠ Revisión',
  NO_ENCONTRADO: '✕ No encontrado',
  PENDIENTE: '— Pendiente',
};
const MONTHLY_STATE_LABEL: Record<MonthlyCollectionStatus, string> = {
  PAGADO: '✅ Pagado',
  POR_VERIFICAR: '⏳ Por verificar',
  EN_REVISION: '⚠ En revisión',
  PENDIENTE: '— Pendiente',
};
const MONTHLY_STATE_CLASS: Record<MonthlyCollectionStatus, string> = {
  PAGADO: 'verificado',
  POR_VERIFICAR: 'pendiente_verificacion',
  EN_REVISION: 'en_revision',
  PENDIENTE: 'pendiente',
};
const filterLabelStyle = { display: 'grid', gap: 4, color: 'var(--muted)', fontSize: '.8rem' } as const;
const filterControlStyle = { border: '1px solid var(--line)', background: '#07110f', color: 'var(--text)', borderRadius: 10, padding: '10px 12px' } as const;
const DUPLICATE_REASON_LABEL: Record<string, string> = {
  file_hash: 'Archivo idéntico',
  exact_file_other_sender: 'Archivo idéntico desde otro remitente',
  bank_reference_reused: 'Referencia bancaria repetida; requiere revisión',
  bank_reference_home_conflict: 'Referencia repetida con otra vivienda',
  bank_reference_data_conflict: 'Referencia repetida con monto o fecha diferente',
  weak_signature: 'Banco, monto y fecha coinciden con otro pago',
  service_period_already_has_payment: 'La vivienda ya tiene un pago asignado a ese mes',
  amount_below_expected: 'Monto menor a la cuota esperada de L150.00',
  amount_above_expected: 'Monto mayor a la cuota esperada de L150.00',
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; stage?: string; block?: string }>;
}) {
  if (!(await isAdminAuthenticated())) redirect('/login');
  const params = await searchParams;
  const period = params.period && isPeriod(params.period) ? params.period : periodFromDate();
  const stageFilter = positiveInt(params.stage);
  const blockFilter = positiveInt(params.block);
  const store = await getPaymentStore();
  const [snapshot, houseGrid] = await Promise.all([
    buildDashboardSnapshot(store, period),
    buildHouseHistoryGrid(store, period, 4),
  ]);
  const stageOptions = Array.from(new Set(snapshot.monthlyStatus.map((row) => row.stage))).sort((a, b) => a - b);
  const blockOptions = Array.from(new Set(snapshot.monthlyStatus
    .filter((row) => stageFilter == null || row.stage === stageFilter)
    .map((row) => row.block))).sort((a, b) => a - b);
  const monthlyRows = snapshot.monthlyStatus.filter((row) =>
    (stageFilter == null || row.stage === stageFilter)
    && (blockFilter == null || row.block === blockFilter),
  );

  return (
    <main className="shell">
      <header className="admin-head">
        <div><p className="eyebrow">Panel administrativo</p><h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Cobranza residencial</h1></div>
        <div className="admin-head-actions">
          <Link className="primary-button" href="/admin/homes">Gestionar viviendas</Link>
          <form method="post" action="/api/admin/logout"><button className="scenario-button" type="submit">Cerrar sesión</button></form>
        </div>
      </header>

      <div className="section-head">
        <div><h2>{periodLabel(period)}</h2><p>Datos operativos privados · las imágenes de comprobantes se procesan temporalmente y no se conservan.</p></div>
        <form method="get" action="/admin" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <label htmlFor="period" style={filterLabelStyle}>Mes
            <input id="period" name="period" type="month" defaultValue={period} style={filterControlStyle} />
          </label>
          <label htmlFor="stage" style={filterLabelStyle}>Etapa
            <select id="stage" name="stage" defaultValue={stageFilter?.toString() ?? ''} style={filterControlStyle}>
              <option value="">Todas</option>
              {stageOptions.map((stage) => <option key={stage} value={stage}>Etapa {stage}</option>)}
            </select>
          </label>
          <label htmlFor="block" style={filterLabelStyle}>Bloque
            <select id="block" name="block" defaultValue={blockFilter?.toString() ?? ''} style={filterControlStyle}>
              <option value="">Todos</option>
              {blockOptions.map((block) => <option key={block} value={block}>Bloque {block}</option>)}
            </select>
          </label>
          <button className="primary-button" type="submit">Ver</button>
        </form>
      </div>

      <section className="kpis">
        <div className="kpi"><span>Viviendas activas</span><strong>{snapshot.totalHomes}</strong><small>Base maestra vigente en el período</small></div>
        <div className="kpi"><span>Pagadas</span><strong>{snapshot.paidHomes}</strong><small>Pago confirmado en el banco</small></div>
        <div className="kpi"><span>Pendientes</span><strong>{snapshot.pendingHomes}</strong><small>Sin comprobante utilizable para el mes</small></div>
        <div className="kpi"><span>Por verificar</span><strong>{snapshot.verifyingHomes}</strong><small>Comprobante recibido; falta confirmar en banco</small></div>
        <div className="kpi"><span>En revisión</span><strong>{snapshot.reviewHomes}</strong><small>{snapshot.review.length} comprobantes requieren decisión humana</small></div>
        <div className="kpi"><span>Cobranza</span><strong>{pct(snapshot.collectionRate)}</strong><small>Por vivienda verificada</small></div>
        <div className="kpi"><span>Esperado</span><strong>{money(snapshot.expectedAmount)}</strong><small>No verificado {money(snapshot.pendingAmount)}</small></div>
        <div className="kpi"><span>Recibido</span><strong>{money(snapshot.receivedAmount)}</strong><small>Incluye comprobantes aún no verificados</small></div>
        <div className="kpi"><span>Sin identificar</span><strong>{money(snapshot.unidentifiedAmount)}</strong><small>{snapshot.unidentified.length} casos</small></div>
        <div className="kpi"><span>Duplicados</span><strong>{snapshot.duplicates.length}</strong><small>No suman dos veces</small></div>
        <div className="kpi"><span>Verificado</span><strong>{money(snapshot.verifiedAmount)}</strong><small>Confirmado revisando el banco</small></div>
      </section>

      <div className="section-head"><div><p className="eyebrow">Por etapa y bloque</p><h2>Estado de cobranza</h2></div></div>
      <section className="blocks">
        {snapshot.blocks.map((group) => (
          <article className="block-card" key={`${group.stage}-${group.block}`}>
            <div className="block-card__top"><strong>Etapa {group.stage} · Bloque {group.block}</strong><span>{group.paidHomes}/{group.totalHomes} pagadas</span></div>
            <div className="progress"><span style={{ width: `${group.collectionRate * 100}%` }} /></div>
            <p className="lead">{group.pendingHomes} pendientes · {group.verifyingHomes} por verificar · {group.reviewHomes} en revisión · {money(group.collected)} verificado</p>
          </article>
        ))}
      </section>

      <div className="section-head">
        <div><p className="eyebrow">Estado mensual</p><h2>Casa por casa</h2></div>
        <p>{monthlyRows.length} viviendas en el filtro · esta vista se deriva de Viviendas + Pagos y no se edita manualmente.</p>
      </div>
      <div className="table-wrap monthly-status-table">
        <table>
          <thead><tr><th>Etapa</th><th>Bloque</th><th>Casa</th><th>Cuota</th><th>Estado</th><th>Monto recibido</th><th>Comprobantes</th><th>Fecha depósito</th></tr></thead>
          <tbody>
            {monthlyRows.length === 0 && <tr><td colSpan={8}>No hay viviendas para el filtro seleccionado.</td></tr>}
            {monthlyRows.map((row) => (
              <tr key={`${row.period}-${row.homeId}`}>
                <td>{row.stage}</td>
                <td>{row.block}</td>
                <td><Link className="admin-link" href={`/admin/homes/${row.stage}/${row.block}/${row.house}`}>C{row.house}</Link></td>
                <td>{money(row.monthlyFee)}</td>
                <td><span className={`status-chip status-chip--${MONTHLY_STATE_CLASS[row.status]}`}>{MONTHLY_STATE_LABEL[row.status]}</span></td>
                <td>{row.receivedAmount > 0 ? money(row.receivedAmount) : '—'}</td>
                <td>{row.paymentCount || '—'}</td>
                <td>{row.paymentDate ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head">
        <div><p className="eyebrow">Por vivienda</p><h2>Historial de los últimos 4 períodos</h2></div>
        <p>La vivienda se identifica exclusivamente por Etapa + Bloque + Casa.</p>
      </div>
      <div className="table-wrap house-history-table">
        <table>
          <thead><tr><th>Vivienda</th>{houseGrid.periods.map((item) => <th key={item}>{periodLabel(item)}</th>)}</tr></thead>
          <tbody>
            {houseGrid.rows.map((row) => (
              <tr key={row.home.id}>
                <td><Link className="admin-link" href={`/admin/homes/${row.home.stage}/${row.home.block}/${row.home.house}`}>E{row.home.stage} · B{row.home.block} · C{row.home.house}</Link></td>
                {row.periods.map((cell) => (
                  <td key={cell.period}>
                    <span className={`status-chip status-chip--${cell.state.toLowerCase()}`}>{HOUSE_STATE_LABEL[cell.state]}</span>
                    {cell.amount != null && <small className="status-amount">{money(cell.amount)}</small>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head"><div><p className="eyebrow">Sin identificar</p><h2>Asignación de vivienda</h2></div><p>Si falta etapa, bloque o casa, se piden los tres por WhatsApp. Esta asignación no repite OCR.</p></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Fecha depósito</th><th>Depositante</th><th>Teléfono WhatsApp</th><th>Monto</th><th>Referencia</th><th>Asignar E/B/C</th></tr></thead>
          <tbody>
            {snapshot.unidentified.length === 0 && <tr><td colSpan={6}>No hay comprobantes sin identificar para este período.</td></tr>}
            {snapshot.unidentified.map((payment) => (
              <tr key={payment.id}>
                <td>{payment.transactionDate ?? '—'}</td><td>{payment.depositor ?? '—'}</td><td>{payment.phone}</td><td>{money(payment.amount)}</td><td>{payment.reference ?? '—'}</td>
                <td>
                  <form method="post" action={`/api/admin/payments/${payment.id}`}>
                    <input type="hidden" name="action" value="assign-home" />
                    <input type="hidden" name="period" value={period} />
                    <input aria-label="Etapa" name="stage" inputMode="numeric" placeholder="Etapa" required style={{ width: 70 }} />{' '}
                    <input aria-label="Bloque" name="block" inputMode="numeric" placeholder="Bloque" required style={{ width: 70 }} />{' '}
                    <input aria-label="Casa" name="house" inputMode="numeric" placeholder="Casa" required style={{ width: 70 }} />{' '}
                    <button className="primary-button" type="submit">Asignar</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head"><div><p className="eyebrow">Pagos</p><h2>Historial del período</h2></div><p>Fecha depósito viene del comprobante; Mes pagado sigue el histórico desde agosto 2026.</p></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Fecha depósito</th><th>Vivienda</th><th>Depositante</th><th>Teléfono WhatsApp</th><th>Banco</th><th>Cuota esperada</th><th>Monto depósito</th><th>Referencia</th><th>Estado</th><th>Mes pagado</th><th>Verificación</th></tr></thead>
          <tbody>
            {snapshot.payments.map((payment) => (
              <tr key={payment.id}>
                <td>{payment.transactionDate ?? '—'}</td><td>{payment.homeLabel}</td><td>{payment.depositor ?? '—'}</td><td>{payment.phone || '—'}</td><td>{payment.bank || '—'}</td><td>{payment.monthlyFee != null ? money(payment.monthlyFee) : '—'}</td><td>{money(payment.amount)}</td><td>{payment.reference ?? '—'}</td><td>{payment.status.replaceAll('_', ' ')}</td>
                <td>
                  <form method="post" action={`/api/admin/payments/${payment.id}`}>
                    <input type="hidden" name="action" value="set-period" />
                    <input type="month" name="newPeriod" defaultValue={payment.period} required />{' '}
                    <input type="hidden" name="period" value={period} />
                    <button type="submit">Guardar</button>
                  </form>
                </td>
                <td>
                  {canManuallyVerify(payment) ? (
                    <form method="post" action={`/api/admin/payments/${payment.id}`}>
                      <input type="hidden" name="action" value="verify-manually" />
                      <input type="hidden" name="period" value={period} />
                      <button className="primary-button" type="submit">Verificar</button>
                    </form>
                  ) : payment.status === 'VERIFICADO' ? (
                    <span>✅ Verificado{payment.verifiedAt ? ` · ${new Date(payment.verifiedAt).toLocaleDateString('es-HN')}` : ''}</span>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head"><div><p className="eyebrow">Duplicados confirmados</p><h2>Comprobantes repetidos</h2></div><p>Sólo se marcan automáticamente por reintento técnico o archivo idéntico; una referencia repetida por sí sola no es duplicado.</p></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Fecha</th><th>Vivienda</th><th>Teléfono WhatsApp</th><th>Monto</th><th>Referencia</th><th>Motivo</th><th>Original relacionado</th></tr></thead>
          <tbody>
            {snapshot.duplicates.length === 0 && <tr><td colSpan={7}>No hay duplicados confirmados en este período.</td></tr>}
            {snapshot.duplicates.map((payment) => (
              <tr key={payment.id}>
                <td>{payment.transactionDate ?? '—'}</td><td>{payment.homeLabel}</td><td>{payment.phone || '—'}</td><td>{money(payment.amount)}</td><td>{payment.reference ?? '—'}</td>
                <td>{DUPLICATE_REASON_LABEL[payment.duplicateReason ?? ''] ?? payment.duplicateReason ?? 'Coincidencia detectada'}</td><td>{payment.duplicateOf ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head"><div><p className="eyebrow">Revisión humana</p><h2>Casos que requieren decisión</h2></div><p>El encargado compara los datos extraídos con el movimiento bancario. La referencia es una señal, no una prueba única. Un monto distinto de L150 permanece en revisión.</p></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Fecha</th><th>Vivienda</th><th>Teléfono WhatsApp</th><th>Banco</th><th>Cuota</th><th>Monto</th><th>Referencia</th><th>Motivo</th><th>Acciones</th></tr></thead>
          <tbody>
            {snapshot.review.length === 0 && <tr><td colSpan={9}>No hay casos en revisión para este período.</td></tr>}
            {snapshot.review.map((payment) => (
              <tr key={payment.id}>
                <td>{payment.transactionDate ?? '—'}</td><td>{payment.homeLabel}</td><td>{payment.phone || '—'}</td><td>{payment.bank || '—'}</td><td>{payment.monthlyFee != null ? money(payment.monthlyFee) : '—'}</td><td>{money(payment.amount)}</td><td>{payment.reference ?? '—'}</td>
                <td>{DUPLICATE_REASON_LABEL[payment.reviewReason ?? ''] ?? payment.reviewReason ?? 'Revisión pendiente'}</td>
                <td>
                  {canManuallyVerify(payment, true) && (
                    <form method="post" action={`/api/admin/payments/${payment.id}`} style={{ display: 'inline' }}>
                      <input type="hidden" name="action" value="verify-reviewed" /><input type="hidden" name="period" value={period} />
                      <button className="primary-button" type="submit">Verifiqué en banco</button>{' '}
                    </form>
                  )}
                  {(payment.reviewReason === 'amount_below_expected' || payment.reviewReason === 'amount_above_expected') && <span>⚠ Revisar monto</span>}
                  {payment.duplicateOf && (
                    <form method="post" action={`/api/admin/payments/${payment.id}`} style={{ display: 'inline' }}>
                      <input type="hidden" name="action" value="mark-duplicate" /><input type="hidden" name="period" value={period} />
                      <button type="submit">Marcar duplicado</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head"><div><p className="eyebrow">Excepciones</p><h2>Resumen operativo</h2></div></div>
      <section className="queues">
        <article className="queue"><h3>Duplicados</h3><p>Archivo idéntico o decisión humana confirmada.</p><strong>{snapshot.duplicates.length}</strong></article>
        <article className="queue"><h3>En revisión</h3><p>Referencias repetidas, montos distintos de L150, conflictos o datos dudosos.</p><strong>{snapshot.review.length}</strong></article>
        <article className="queue"><h3>Sin identificar</h3><p>Esperando E/B/C por WhatsApp o asignación manual.</p><strong>{snapshot.unidentified.length}</strong></article>
      </section>
    </main>
  );
}
