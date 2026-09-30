import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROLES_DEL_PANEL, tieneRol } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { notasAbiertas, type NotaAbierta } from '@/src/storage/notas';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * La bandeja de lo que el cobrador quiso decir.
 *
 * El cobrador no edita pagos: cuando algo no cuadra, lo unico que puede hacer es
 * dejarlo escrito. Si nadie mira esta pantalla, esa separacion de permisos lo
 * deja mudo — que era justo lo que habia que evitar.
 *
 * Una nota no es un estado del pago. `EN_REVISION` significa que el sistema no
 * supo que hacer; una nota es una persona contando algo.
 */
export const dynamic = 'force-dynamic';

const money = (centavos: number) =>
  `L${(centavos / 100).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ESTADO_LEGIBLE: Record<string, string> = {
  VERIFICADO: '✅ Verificado',
  EFECTIVO_COBRADO: '💵 Cobrado en efectivo',
  PENDIENTE_VERIFICACION: '⏳ Por verificar',
  EN_REVISION: '⚠ En revisión',
  NO_ENCONTRADO: '✕ No encontrado',
  RECHAZADO: '✕ Rechazado',
  ANULADO: '✕ Anulado',
  DUPLICADO: '✕ Duplicado',
  ESPERANDO_RESPUESTA: '… Esperando respuesta',
};

export default async function NotasPage({ searchParams }: { searchParams: Promise<{ resuelta?: string }> }) {
  if (!(await tieneRol(...ROLES_DEL_PANEL))) redirect('/login');

  const params = await searchParams;
  const demo = isDemoMode();
  const notas = demo ? [] : await notasAbiertas(await getTursoClient());

  return (
    <main className="shell">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Efectivo</p>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Notas del cobrador</h1>
          <p className="lead">
            Lo que el cobrador vio en la puerta y no puede corregir él mismo. Resolverla la saca de
            la bandeja y conserva el texto: es lo que va a explicar por qué el pago quedó como quedó.
          </p>
        </div>
        <Link className="primary-button" href="/admin">Volver al panel</Link>
      </header>

      {params.resuelta && <div className="notice">Nota resuelta. El texto queda guardado.</div>}

      {demo && (
        <div className="notice">
          Esta es la demostración y no tiene base de datos. Las notas funcionan solo en producción.
        </div>
      )}

      {!demo && notas.length === 0 && <div className="notice">No hay notas esperando decisión.</div>}

      {notas.map((nota) => <Nota key={nota.id} nota={nota} />)}
    </main>
  );
}

function Nota({ nota }: { nota: NotaAbierta }) {
  return (
    <section className="notice" style={{ marginTop: 20, display: 'grid', gap: 10 }}>
      <p style={{ margin: 0, fontSize: '.85rem', color: 'var(--muted)' }}>
        {nota.vivienda} · {ESTADO_LEGIBLE[nota.estadoDelPago] ?? nota.estadoDelPago} ·{' '}
        {money(nota.montoCentavos)} · {nota.creadaEn.slice(0, 10)} · {nota.autorId}
      </p>
      <p style={{ margin: 0 }}>{nota.texto}</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Link href={`/admin?period=${nota.creadaEn.slice(0, 7)}`}>Ver el mes en el panel</Link>
        <form method="post" action="/api/admin/notas">
          <input type="hidden" name="id" value={nota.id} />
          <button className="scenario-button" type="submit">Marcar resuelta</button>
        </form>
      </div>
    </section>
  );
}
