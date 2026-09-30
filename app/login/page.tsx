import { redirect } from 'next/navigation';
import { isDemoMode } from '@/src/config/env';
import { sesionActual } from '@/src/auth/guard';
import { BLOQUEO_MINUTOS } from '@/src/auth/intentos';

/** El parametro viene de la URL, asi que se valida antes de mostrarlo. */
function espera(minutos: string | undefined): string {
  const valor = Number(minutos);
  const restante = Number.isInteger(valor) && valor > 0 && valor <= BLOQUEO_MINUTOS ? valor : BLOQUEO_MINUTOS;
  return restante === 1 ? 'un minuto' : `${restante} minutos`;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; minutos?: string }> }) {
  if (isDemoMode()) redirect('/');
  const sesion = await sesionActual();
  if (sesion) redirect(sesion.rol === 'COBRADOR' ? '/cobros' : '/admin');
  const params = await searchParams;

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Panel privado</p>
        <h1>Acceso administrativo</h1>
        <p>Entrá con tu usuario y tu clave. Cada persona tiene las suyas.</p>
        {params.error === 'bloqueado' && (
          <p role="alert">
            Demasiados intentos fallidos. Vuelve a intentar en {espera(params.minutos)}.
          </p>
        )}
        {/* Un solo mensaje para usuario inexistente y clave mala: decir cual
            de los dos falló le confirma a quien prueba que el usuario existe. */}
        {params.error && params.error !== 'bloqueado' && <p role="alert">Usuario o clave incorrectos.</p>}
        <form method="post" action="/api/admin/login">
          <label htmlFor="usuario">Usuario</label>
          <input
            id="usuario"
            name="usuario"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={64}
          />
          <label htmlFor="access-key">Clave</label>
          <input id="access-key" name="accessKey" type="password" autoComplete="current-password" required maxLength={256} />
          <button className="primary-button" type="submit">Entrar</button>
        </form>
      </section>
    </main>
  );
}
