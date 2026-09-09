import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isAdminAuthenticated } from '@/src/auth/guard';
import { periodLabel } from '@/src/domain/periods';
import { getHouseHistory } from '@/src/services/house-history';
import { getPaymentStore } from '@/src/storage';

export const dynamic = 'force-dynamic';

const money = (value: number) => `L${value.toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function HousePage({ params }: { params: Promise<{ stage: string; block: string; house: string }> }) {
  if (!(await isAdminAuthenticated())) redirect('/login');
  const raw = await params;
  const stage = Number.parseInt(raw.stage, 10);
  const block = Number.parseInt(raw.block, 10);
  const house = Number.parseInt(raw.house, 10);
  if (!Number.isInteger(stage) || !Number.isInteger(block) || !Number.isInteger(house) || stage <= 0 || block <= 0 || house <= 0) notFound();

  const store = await getPaymentStore();
  const history = await getHouseHistory(store, stage, block, house);
  const homeRecord = history.home;
  if (!homeRecord) notFound();

  const accepted = history.payments.filter((payment) => payment.status !== 'DUPLICADO' && payment.status !== 'RECHAZADO');
  const verifiedPeriods = new Set(accepted.filter((payment) => payment.status === 'VERIFICADO').map((payment) => payment.period));
  const receiptPeriods = new Set(accepted.map((payment) => payment.period));

  return (
    <main className="shell">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Historial por vivienda</p>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Etapa {stage} · Bloque {block} · Casa {house}</h1>
          <p className="lead">{homeRecord.responsible ?? 'Responsable no registrado'} · Cuota mensual {money(homeRecord.monthlyFee)}</p>
        </div>
        <Link className="primary-button" href="/admin">Volver al panel</Link>
      </header>

      <section className="kpis">
        <div className="kpi"><span>Períodos con comprobante</span><strong>{receiptPeriods.size}</strong><small>Sin duplicados ni rechazados</small></div>
        <div className="kpi"><span>Períodos verificados</span><strong>{verifiedPeriods.size}</strong><small>Confirmados por revisión bancaria</small></div>
        <div className="kpi"><span>Registros trazables</span><strong>{history.payments.length}</strong><small>Incluye duplicados y revisión</small></div>
        <div className="kpi"><span>Estado vivienda</span><strong>{homeRecord.active ? 'Activa' : 'Inactiva'}</strong><small>ID operativo E{stage}-B{block}-C{house}</small></div>
      </section>

      <div className="section-head">
        <div><p className="eyebrow">Historial</p><h2>Pagos y comprobantes</h2></div>
        <p>El teléfono es el remitente de WhatsApp y nunca identifica la vivienda. Pagada significa verificada. Las imágenes no se conservan.</p>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Mes pagado</th><th>Fecha depósito</th><th>Depositante</th><th>Teléfono WhatsApp</th><th>Cuota</th><th>Monto depósito</th><th>Banco</th><th>Referencia</th><th>Estado</th><th>Verificación</th></tr></thead>
          <tbody>
            {history.payments.length === 0 && <tr><td colSpan={10}>Esta vivienda todavía no tiene pagos registrados.</td></tr>}
            {history.payments.map((payment) => (
              <tr key={payment.id}>
                <td>{periodLabel(payment.period)}</td>
                <td>{payment.transactionDate ?? '—'}</td>
                <td>{payment.depositor ?? '—'}</td>
                <td>{payment.phone || '—'}</td>
                <td>{money(homeRecord.monthlyFee)}</td>
                <td>{money(payment.amount)}</td>
                <td>{payment.bank}</td>
                <td>{payment.reference ?? '—'}</td>
                <td><span className={`status-chip status-chip--${payment.status.toLowerCase()}`}>{payment.status.replaceAll('_', ' ')}</span></td>
                <td>{payment.verifiedAt ? `✅ ${new Date(payment.verifiedAt).toLocaleDateString('es-HN')}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
