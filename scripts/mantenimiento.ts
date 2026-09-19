/**
 * Los barridos diarios: cierra lo que quedo esperando y no va a resolverse
 * solo. Lo ejecuta .github/workflows/mantenimiento.yml.
 *
 * No manda mensajes a nadie. Un aviso fuera de la ventana de 24 horas necesita
 * una plantilla aprobada (invariante 13) y la unica que hay es la del recibo.
 * Lo que este script hace es que el caso aparezca donde una persona lo vea.
 *
 * Solo imprime cuentas: ni telefonos, ni viviendas, ni montos (invariante 12).
 */
import { expirarIntentos } from '../src/auth/intentos.ts';
import { createTursoClient, tursoConfigFromEnv } from '../src/storage/turso-client.ts';
import { expirarImportaciones } from '../src/storage/conciliacion.ts';
import { expirarContextos } from '../src/storage/mantenimiento.ts';

const ACTOR = 'workflow:mantenimiento';

async function main(): Promise<void> {
  const client = await createTursoClient(tursoConfigFromEnv());

  try {
    const ahora = new Date().toISOString();

    const contextos = await expirarContextos(client, ahora, ACTOR);
    const importaciones = await expirarImportaciones(client, ahora, ACTOR);
    const intentos = await expirarIntentos(client, new Date(ahora));

    console.log(`Contextos vencidos: ${contextos.contextos}`);
    console.log(`Pagos que pasaron a revision: ${contextos.pagos}`);
    console.log(`Confirmaciones de extracto vencidas: ${importaciones}`);
    console.log(`Bloqueos de acceso vencidos: ${intentos}`);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.slice(0, 200) : 'Fallo el mantenimiento.');
  process.exitCode = 1;
});
