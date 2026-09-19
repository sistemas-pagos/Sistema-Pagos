import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAdminAuthenticated } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { compareHomes } from '@/src/domain/housing';
import { getPaymentStore } from '@/src/storage';
import { viviendasConSaldoInicial } from '@/src/storage/ajustes';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * La carga del saldo inicial de cada vivienda (docs/PLAN.md, seccion 1).
 *
 * La deuda anterior a septiembre de 2026 entra una sola vez, como un numero por
 * casa, y no como meses. Por eso la pantalla insiste en que se carga una vez:
 * volver a pegar el archivo no duplica nada, pero conviene que quien lo hace lo
 * sepa antes y no despues.
 */
export const dynamic = 'force-dynamic';

const EJEMPLO = 'etapa,bloque,casa,monto\n1,4,18,450\n1,4,19,1200';

export default async function SaldosPage({ searchParams }: { searchParams: Promise<{ cargados?: string; repetidos?: string }> }) {
  if (!(await isAdminAuthenticated())) redirect('/login');
  const params = await searchParams;
  const cargados = Number.parseInt(params.cargados ?? '', 10);
  const repetidos = Number.parseInt(params.repetidos ?? '', 10);

  const demo = isDemoMode();
  const homes = demo ? [] : (await (await getPaymentStore()).listHomes()).sort(compareHomes);
  const conSaldo = demo ? new Set<string>() : await viviendasConSaldoInicial(await getTursoClient());
  const activas = homes.filter((home) => home.active);
  const faltan = activas.filter((home) => !conSaldo.has(home.id));

  return (
    <main className="shell">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Carga única</p>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Saldos iniciales</h1>
          <p className="lead">
            La deuda anterior al primer mes de servicio entra una sola vez, como un número por vivienda.
            No se reparte en meses: repartirla obligaría a inventar en qué mes cae cada lempira.
          </p>
        </div>
        <Link className="primary-button" href="/admin/homes">Volver a viviendas</Link>
      </header>

      {demo && (
        <div className="notice">
          Esta es la demostración y no tiene base de datos. La carga de saldos funciona solo en producción.
        </div>
      )}

      {!demo && (
        <section className="kpis" style={{ marginTop: 28 }}>
          <div className="kpi"><span>Viviendas activas</span><strong>{activas.length}</strong><small>En el padrón</small></div>
          <div className="kpi"><span>Con saldo cargado</span><strong>{conSaldo.size}</strong><small>Ya no se vuelven a tocar</small></div>
          <div className="kpi"><span>Sin saldo</span><strong>{faltan.length}</strong><small>Quedan por cargar</small></div>
        </section>
      )}

      {Number.isInteger(cargados) && cargados > 0 && (
        <div className="notice">
          Se cargaron {cargados} saldos iniciales.
          {Number.isInteger(repetidos) && repetidos > 0 && ` Otras ${repetidos} viviendas ya tenían saldo y no se tocaron.`}
        </div>
      )}
      {Number.isInteger(cargados) && cargados === 0 && Number.isInteger(repetidos) && repetidos > 0 && (
        <div className="notice">Todas las viviendas del archivo ya tenían saldo inicial. No se cargó nada.</div>
      )}

      <div className="section-head">
        <div><p className="eyebrow">Importar</p><h2>Cargar los saldos</h2></div>
        <p>Pega desde Excel o Sheets. Si una fila falla, no se carga ninguna.</p>
      </div>

      <form className="home-import-form" method="post" action="/api/admin/saldos/import">
        <label htmlFor="saldos-import">Saldos por vivienda</label>
        <textarea id="saldos-import" name="data" required rows={9} spellCheck={false} placeholder={EJEMPLO} />
        <p>
          Encabezados mínimos: <strong>etapa, bloque, casa, monto</strong>. También se aceptan saldo, saldo_inicial o deuda,
          y una columna <strong>motivo</strong> opcional. El monto va en lempiras: <code>450</code>, <code>L1,200.00</code> o <code>1200.50</code>.
        </p>
        <p>
          Una vivienda que ya tiene saldo inicial <strong>no se vuelve a cargar</strong>. Podés pegar el archivo otra vez sin
          miedo a duplicar la deuda: las repetidas se informan y se dejan como están.
        </p>
        <button className="primary-button" type="submit">Validar y cargar</button>
      </form>

      {!demo && faltan.length > 0 && (
        <>
          <div className="section-head">
            <div><p className="eyebrow">Pendientes</p><h2>Viviendas sin saldo inicial</h2></div>
            <p>Si una casa no debe nada de antes, no hace falta cargarla.</p>
          </div>
          <div className="table-wrap homes-table">
            <table>
              <thead><tr><th>Vivienda</th><th>Responsable</th></tr></thead>
              <tbody>
                {faltan.map((home) => (
                  <tr key={home.id}>
                    <td>E{home.stage} · B{home.block} · C{home.house}</td>
                    <td>{home.responsible ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
