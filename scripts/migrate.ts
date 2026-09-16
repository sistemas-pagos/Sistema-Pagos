/**
 * Aplica las migraciones pendientes a la base de Turso configurada en el
 * entorno. Lo ejecuta .github/workflows/migraciones.yml de forma manual.
 *
 * No imprime datos ni secretos: solo el nombre de las migraciones aplicadas.
 */
import { applyPendingMigrations } from '../src/storage/migrations.ts';
import { createTursoClient, tursoConfigFromEnv } from '../src/storage/turso-client.ts';

async function main(): Promise<void> {
  const client = await createTursoClient(tursoConfigFromEnv());

  try {
    const aplicadas = await applyPendingMigrations(client);

    if (aplicadas.length === 0) {
      console.log('Sin migraciones pendientes.');
      return;
    }

    console.log(`Migraciones aplicadas: ${aplicadas.length}`);
    for (const nombre of aplicadas) console.log(`  ${nombre}`);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Fallo la migracion.');
  process.exitCode = 1;
});
