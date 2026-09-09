import { redirect } from 'next/navigation';
import { isDemoMode } from '@/src/config/env';
import { isAdminAuthenticated } from '@/src/auth/guard';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (isDemoMode()) redirect('/');
  if (await isAdminAuthenticated()) redirect('/admin');
  const params = await searchParams;

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Panel privado</p>
        <h1>Acceso administrativo</h1>
        <p>El panel de producción no es público. Utiliza la clave configurada para este ambiente.</p>
        {params.error && <p role="alert">La clave no es válida.</p>}
        <form method="post" action="/api/admin/login">
          <label htmlFor="access-key">Clave de acceso</label>
          <input id="access-key" name="accessKey" type="password" autoComplete="current-password" required maxLength={256} />
          <button className="primary-button" type="submit">Entrar</button>
        </form>
      </section>
    </main>
  );
}
