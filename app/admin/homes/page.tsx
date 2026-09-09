import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAdminAuthenticated } from '@/src/auth/guard';
import { getPaymentStore } from '@/src/storage';

export const dynamic = 'force-dynamic';

const money = (value: number) => `L${value.toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function HomesAdminPage({ searchParams }: { searchParams: Promise<{ imported?: string }> }) {
  if (!(await isAdminAuthenticated())) redirect('/login');
  const params = await searchParams;
  const imported = Number.parseInt(params.imported ?? '', 10);
  const store = await getPaymentStore();
  const homes = (await store.listHomes()).sort((a, b) => a.stage - b.stage || a.block - b.block || a.house - b.house);
  const active = homes.filter((home) => home.active);
  const expected = active.reduce((total, home) => total + home.monthlyFee, 0);
  const stages = new Set(active.map((home) => home.stage));

  return (
    <main className="shell">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Base maestra</p>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Viviendas</h1>
          <p className="lead">Etapa + bloque + casa es el identificador operativo. Ningún teléfono se usa para asignar una vivienda.</p>
        </div>
        <Link className="primary-button" href="/admin">Volver al panel</Link>
      </header>

      <section className="kpis" style={{ marginTop: 28 }}>
        <div className="kpi"><span>Viviendas registradas</span><strong>{homes.length}</strong><small>{active.length} activas</small></div>
        <div className="kpi"><span>Etapas activas</span><strong>{stages.size}</strong><small>Con viviendas vigentes</small></div>
        <div className="kpi"><span>Cuota esperada activa</span><strong>{money(expected)}</strong><small>Según cuota de cada vivienda</small></div>
      </section>

      {Number.isInteger(imported) && imported > 0 && <div className="notice">Se importaron {imported} viviendas. La carga fue validada completa antes de escribirse.</div>}

      <div className="section-head">
        <div><p className="eyebrow">Carga inicial</p><h2>Importar varias viviendas</h2></div>
        <p>Pega directamente desde Excel/Sheets o usa CSV. Si omites cuota, se usa L150.</p>
      </div>
      <form className="home-import-form" method="post" action="/api/admin/homes/import">
        <label htmlFor="housing-import">Datos de viviendas</label>
        <textarea
          id="housing-import"
          name="data"
          required
          rows={9}
          spellCheck={false}
          placeholder={'etapa,bloque,casa,cuota,responsable,activa,fecha_alta\n1,1,1,150,Persona Demo A,si,2026-08-01\n1,1,2,150,Persona Demo B,si,2026-08-01'}
        />
        <p>Encabezados mínimos: <strong>etapa, bloque, casa</strong>. También se aceptan stage/block/house, cuota/monthly_fee, responsable, activa y fechas YYYY-MM-DD. Si cualquier fila falla, no se importa ninguna.</p>
        <button className="primary-button" type="submit">Validar e importar</button>
      </form>

      <div className="section-head"><div><p className="eyebrow">Nueva vivienda</p><h2>Agregar una vivienda</h2></div><p>La identidad E/B/C queda fija para proteger el historial.</p></div>
      <form className="home-form" method="post" action="/api/admin/homes">
        <label>Etapa<input name="stage" inputMode="numeric" min="1" type="number" required /></label>
        <label>Bloque<input name="block" inputMode="numeric" min="1" type="number" required /></label>
        <label>Casa<input name="house" inputMode="numeric" min="1" type="number" required /></label>
        <label>Responsable opcional<input name="responsible" maxLength={160} /></label>
        <label>Cuota mensual<input name="monthlyFee" min="0.01" step="0.01" type="number" required /></label>
        <label>Fecha de alta<input name="startDate" type="date" /></label>
        <button className="primary-button" type="submit">Agregar vivienda</button>
      </form>

      <div className="section-head"><div><p className="eyebrow">Inventario</p><h2>Editar viviendas</h2></div><p>Etapa, bloque y casa permanecen fijos para no romper el historial.</p></div>
      <div className="table-wrap homes-table">
        <table>
          <thead><tr><th>Vivienda</th><th>Responsable</th><th>Cuota</th><th>Alta</th><th>Baja</th><th>Activa</th><th>Guardar</th></tr></thead>
          <tbody>
            {homes.length === 0 && <tr><td colSpan={7}>No hay viviendas registradas.</td></tr>}
            {homes.map((home) => (
              <tr key={home.id}>
                <td><Link className="admin-link" href={`/admin/homes/${home.stage}/${home.block}/${home.house}`}>E{home.stage} · B{home.block} · C{home.house}</Link></td>
                <td colSpan={6} style={{ padding: 0 }}>
                  <form className="home-row-form" method="post" action={`/api/admin/homes/${encodeURIComponent(home.id)}`}>
                    <input aria-label={`Responsable E${home.stage} B${home.block} C${home.house}`} name="responsible" defaultValue={home.responsible ?? ''} maxLength={160} />
                    <input aria-label={`Cuota E${home.stage} B${home.block} C${home.house}`} name="monthlyFee" defaultValue={home.monthlyFee} min="0.01" step="0.01" type="number" required />
                    <input aria-label={`Alta E${home.stage} B${home.block} C${home.house}`} name="startDate" defaultValue={home.startDate ?? ''} type="date" />
                    <input aria-label={`Baja E${home.stage} B${home.block} C${home.house}`} name="endDate" defaultValue={home.endDate ?? ''} type="date" />
                    <label className="checkbox-cell"><input name="active" type="checkbox" defaultChecked={home.active} /><span>Activa</span></label>
                    <button type="submit">Guardar</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
