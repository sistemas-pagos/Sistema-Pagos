import { createClient, type Client, type Config } from '@libsql/client';

/**
 * Conexion a Turso. `foreign_keys` es un ajuste por conexion y no vive en el
 * archivo de la base, asi que hay que activarlo cada vez que se abre una.
 */
export interface TursoConfig {
  url: string;
  authToken?: string;
}

/**
 * Lee la configuracion de las variables del entorno `pagos-produccion`.
 * Los mensajes de error nombran la variable que falta y nunca su valor.
 */
export function tursoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TursoConfig {
  const url = env.PAGOS_TURSO_URL?.trim();
  if (!url) throw new Error('Falta la variable PAGOS_TURSO_URL');

  const authToken = env.PAGOS_TURSO_TOKEN?.trim();
  // Una base local (`:memory:` o `file:`) no lleva token; una remota si.
  const isLocal = url === ':memory:' || url.startsWith('file:');
  if (!isLocal && !authToken) throw new Error('Falta la variable PAGOS_TURSO_TOKEN');

  return authToken ? { url, authToken } : { url };
}

export async function createTursoClient(config: TursoConfig): Promise<Client> {
  const client = createClient(config as Config);
  await client.execute('PRAGMA foreign_keys = ON');
  return client;
}

/** Cliente en memoria para pruebas; no toca ninguna base remota. */
export function createInMemoryClient(): Promise<Client> {
  return createTursoClient({ url: ':memory:' });
}

let cached: Promise<Client> | undefined;

/**
 * Cliente compartido para el webhook. La funcion serverless se reutiliza entre
 * invocaciones, asi que conviene no abrir una conexion por request.
 */
export function getTursoClient(): Promise<Client> {
  cached ??= createTursoClient(tursoConfigFromEnv());
  return cached;
}

/** Solo para pruebas: olvida el cliente compartido. */
export function resetTursoClientForTests(): void {
  cached = undefined;
}
