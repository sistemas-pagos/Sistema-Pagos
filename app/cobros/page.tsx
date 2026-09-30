import { redirect } from 'next/navigation';
import { ROLES_DE_COBROS, sesionActual, tieneRol } from '@/src/auth/guard';

/**
 * El destino del cobrador. Todavia vacia: la pantalla de cobros llega en su
 * propio PR.
 *
 * Existe desde ya porque sin ella el cobrador entraba, lo mandaban a `/admin`,
 * el panel lo rebotaba por rol y volvia al login — un bucle. Una pagina que
 * dice la verdad es mejor que un rebote que no explica nada.
 */
export const dynamic = 'force-dynamic';

export default async function CobrosPage() {
  if (!(await tieneRol(...ROLES_DE_COBROS))) redirect('/login');
  const sesion = await sesionActual();

  return (
    <main className="shell">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Cobros en efectivo</p>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Hola, {sesion?.uid}</h1>
          <p className="lead">
            Ya podés entrar con tu propio usuario. La pantalla para registrar cobros
            se habilita en la siguiente entrega.
          </p>
        </div>
        <form method="post" action="/api/admin/logout">
          <button className="scenario-button" type="submit">Cerrar sesión</button>
        </form>
      </header>
    </main>
  );
}
