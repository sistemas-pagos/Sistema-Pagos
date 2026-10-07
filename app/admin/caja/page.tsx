import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROLES_DEL_PANEL, sesionActual, tieneRol } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { formatoRecibo } from '@/src/domain/recibo';
import { UID_CLAVE_COMPARTIDA } from '@/src/auth/session';
import { cajasPendientes, cobrosSinEntregar, type CajaPendiente } from '@/src/storage/cierre-caja';
import { getTursoClient } from '@/src/storage/turso-client';
import { Tabla } from '@/app/tabla';

/**
 * Recibir la plata del cobrador.
 *
 * Registrar un cobro es la mitad del ciclo; esta pantalla es la otra mitad. Sin
 * ella el sistema solo sabe que el cobrador **dijo** que cobro, que es el
 * riesgo numero uno del efectivo.
 *
 * El monto esperado no se escribe ni viaja en el formulario: lo calcula el
 * servidor sumando lo que ese cobrador tiene sin entregar. Lo unico que se
 * teclea es lo que de verdad se conto sobre la mesa.
 */
export const dynamic = 'force-dynamic';

const money = (centavos: number) =>
  `L${(centavos / 100).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dias = (desde: string, ahora: Date): number =>
  Math.max(0, Math.floor((ahora.getTime() - new Date(desde).getTime()) / 86_400_000));

interface Params {
  searchParams: Promise<{ cobrador?: string; error?: string; cerrado?: string; diferencia?: string }>;
}

export default async function CajaPage({ searchParams }: Params) {
  if (!(await tieneRol(...ROLES_DEL_PANEL))) redirect('/login');

  const params = await searchParams;
  const sesion = await sesionActual();
  const demo = isDemoMode();
  const db = demo ? undefined : await getTursoClient();
  const cajas = db ? await cajasPendientes(db) : [];
  const elegida = cajas.find((caja) => caja.cobradorId === params.cobrador);
  const detalle = db && elegida ? await cobrosSinEntregar(db, elegida.cobradorId) : [];
  const ahora = new Date();

  // La base exige `cobrador_id <> tesorero_id` desde la 001, asi que la clave
  // compartida no puede recibir nada: no es una persona.
  const sinPersona = !sesion || sesion.uid === UID_CLAVE_COMPARTIDA;

  return (
    <main className="shell">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Efectivo</p>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Cierre de caja</h1>
          <p className="lead">
            Lo que los cobradores llevan cobrado y todavía no entregaron. Se cuenta la plata,
            se anota lo que se recibió y los cobros quedan verificados.
          </p>
        </div>
        <Link className="primary-button" href="/admin">Volver al panel</Link>
      </header>

      {params.error && <div className="notice" role="alert">{params.error}</div>}

      {params.cerrado && (
        <div className="notice">
          Caja cerrada: {params.cerrado} {Number(params.cerrado) === 1 ? 'cobro' : 'cobros'}.{' '}
          {params.diferencia && Number(params.diferencia) !== 0
            ? `Quedó una diferencia de ${money(Number(params.diferencia))}, guardada tal cual.`
            : 'Cuadró exacto.'}
        </div>
      )}

      {demo && (
        <div className="notice">
          Esta es la demostración y no tiene base de datos. El cierre de caja funciona solo en producción.
        </div>
      )}

      {!demo && sinPersona && (
        <div className="notice">
          Entrá con tu propio usuario para recibir una caja. Con la clave compartida el sistema no
          sabría quién recibió la plata, y esa firma es justamente el punto del cierre.
        </div>
      )}

      {!demo && cajas.length === 0 && (
        <div className="notice">Ningún cobrador tiene efectivo sin entregar.</div>
      )}

      {cajas.length > 0 && (
        <>
          <div className="section-head">
            <div><p className="eyebrow">Sin entregar</p><h2>Quién lleva plata encima</h2></div>
            <p>Lo más viejo primero: lo que mide el riesgo del efectivo es el tiempo en la calle, no el monto.</p>
          </div>
          <Tabla columnas={['Cobrador', 'Cobros', 'Total', 'En revisión', 'Más viejo', '']}>
            {cajas.map((caja) => (
              <tr key={caja.cobradorId}>
                <td>{caja.nombre}</td>
                <td>{caja.cobros}</td>
                <td>{money(caja.totalCentavos)}</td>
                <td>{caja.enRevisionCentavos > 0 ? money(caja.enRevisionCentavos) : '—'}</td>
                <td>{dias(caja.desde, ahora)} {dias(caja.desde, ahora) === 1 ? 'día' : 'días'}</td>
                <td>
                  <Link href={`/admin/caja?cobrador=${encodeURIComponent(caja.cobradorId)}`}>
                    {elegida?.cobradorId === caja.cobradorId ? 'Viendo' : 'Recibir'}
                  </Link>
                </td>
              </tr>
            ))}
          </Tabla>
        </>
      )}

      {elegida && (
        <>
          <div className="section-head">
            <div><p className="eyebrow">Contar</p><h2>{elegida.nombre}</h2></div>
            <p>Compará línea por línea con el talonario del cobrador: el número de recibo es el mismo.</p>
          </div>
          <Tabla columnas={['Recibo', 'Vivienda', 'Fecha', 'Estado', 'Monto']}>
            {detalle.map((cobro) => (
              <tr key={cobro.pagoId}>
                <td>{cobro.reciboNumero ? formatoRecibo(cobro.reciboNumero) : '—'}</td>
                <td>{cobro.vivienda}</td>
                <td>{cobro.fechaPago || '—'}</td>
                <td>{cobro.estado === 'EN_REVISION' ? '⚠ En revisión' : '✓ Cobrado'}</td>
                <td>{money(cobro.montoCentavos)}</td>
              </tr>
            ))}
          </Tabla>

          {!sinPersona && <Recibir caja={elegida} />}
        </>
      )}
    </main>
  );
}

/**
 * El formulario de entrega. Solo se escribe lo entregado: si tambien se
 * escribiera lo esperado, un faltante se podria tapar tecleando el mismo numero
 * dos veces.
 */
function Recibir({ caja }: { caja: CajaPendiente }) {
  return (
    <form className="notice" method="post" action="/api/admin/caja" style={{ display: 'grid', gap: 12, marginTop: 20 }}>
      <input type="hidden" name="cobrador" value={caja.cobradorId} />
      <p style={{ margin: 0 }}>
        Esperado: <strong>{money(caja.totalCentavos)}</strong> en {caja.cobros}{' '}
        {caja.cobros === 1 ? 'cobro' : 'cobros'}.
        {caja.enRevisionCentavos > 0 && (
          <> Incluye {money(caja.enRevisionCentavos)} en revisión, que se entrega pero no queda verificado.</>
        )}
      </p>
      <label style={{ display: 'grid', gap: 4, fontSize: '.85rem', color: 'var(--muted)' }}>
        Lempiras recibidas
        <input
          name="entregado"
          type="text"
          inputMode="decimal"
          required
          placeholder={(caja.totalCentavos / 100).toFixed(2)}
          style={{ border: '1px solid var(--line)', background: '#07110f', color: 'var(--text)', borderRadius: 10, padding: '10px 12px' }}
        />
      </label>
      <p style={{ margin: 0, fontSize: '.85rem', color: 'var(--muted)' }}>
        Si falta o sobra, se guarda la diferencia tal cual. Un faltante que se corrige al guardarlo
        no es un faltante: es un dato perdido.
      </p>
      <button className="primary-button" type="submit" style={{ justifySelf: 'start' }}>
        Recibir y cerrar la caja
      </button>
    </form>
  );
}
