import type { Client } from '@libsql/client';
import { applyPendingMigrations } from '@/src/storage/migrations';
import { createInMemoryClient } from '@/src/storage/turso-client';

/**
 * Base SQLite en memoria con las migraciones reales de `migrations/` aplicadas.
 * Las pruebas corren contra el mismo archivo que se despliega, no contra una
 * copia del esquema.
 */
export async function nuevaBaseDePrueba(): Promise<Client> {
  const client = await createInMemoryClient();
  await applyPendingMigrations(client);
  return client;
}

export const ACTOR = 'prueba';
/** Nombre de la plantilla aprobada; en las pruebas solo viaja como texto. */
export const PLANTILLA = 'recibo_pago';
export const CUOTA_CENTAVOS = 15_000;

/** Un usuario, una importacion de CSV y dos movimientos de banco para las pruebas. */
export async function sembrar(client: Client): Promise<void> {
  await client.execute({
    sql: "INSERT INTO usuarios (id, nombre, rol) VALUES (?, ?, 'TESORERO')",
    args: ['u1', 'Tesorero'],
  });
  await client.execute({
    sql: `INSERT INTO importaciones_csv (id, subido_por, archivo_sha256, estado, expira_en, creado_en)
          VALUES (?, 'u1', ?, 'APLICADA', ?, ?)`,
    args: ['imp1', 'sha-csv', '2026-09-30T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
  });

  for (const id of ['mov1', 'mov2']) {
    await client.execute({
      sql: `INSERT INTO movimientos_banco (id, importacion_id, fecha, referencia, monto_centavos, huella)
            VALUES (?, 'imp1', '2026-09-05', ?, ?, ?)`,
      args: [id, `REF-${id}`, CUOTA_CENTAVOS, `huella-${id}`],
    });
  }
}

export async function contar(client: Client, tabla: string): Promise<number> {
  const { rows } = await client.execute(`SELECT count(*) AS c FROM ${tabla}`);
  return Number(rows[0].c);
}
