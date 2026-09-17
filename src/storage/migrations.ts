import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '@libsql/client';

export const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: string;
  nombre: string;
  sql: string;
  sha256: string;
}

/** Lee `migrations/NNN_*.sql` en orden de version. */
export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => MIGRATION_FILE.test(name)).sort();

  return Promise.all(files.map(async (nombre) => {
    const sql = await readFile(path.join(dir, nombre), 'utf8');
    return {
      version: MIGRATION_FILE.exec(nombre)![1],
      nombre,
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    };
  }));
}

/**
 * `PRAGMA` es un ajuste de conexion y dentro de una transaccion SQLite lo
 * ignora en silencio, asi que las del encabezado se ejecutan por separado.
 * Solo se separan las que estan antes de la primera sentencia real.
 */
export function splitLeadingPragmas(sql: string): { pragmas: string[]; body: string } {
  const lines = sql.split('\n');
  const pragmas: string[] = [];
  const body = [...lines];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('--')) continue;
    if (/^PRAGMA\b/i.test(line) && line.endsWith(';')) {
      pragmas.push(line);
      body[i] = '';
      continue;
    }
    break;
  }

  return { pragmas, body: body.join('\n') };
}

async function ensureRegistry(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  aplicada_en TEXT NOT NULL
)`);
}

async function appliedMigrations(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.execute('SELECT version, sha256 FROM schema_migrations');
  return new Map(rows.map((row) => [String(row.version), String(row.sha256)]));
}

/**
 * Aplica solo las migraciones que faltan. Cada una corre dentro de una
 * transaccion junto con su registro, de modo que una migracion fallida no deja
 * el esquema a medias. Devuelve los nombres aplicados en esta corrida.
 */
export async function applyPendingMigrations(
  client: Client,
  dir: string = MIGRATIONS_DIR,
  now: () => Date = () => new Date(),
): Promise<string[]> {
  await ensureRegistry(client);

  const migrations = await readMigrations(dir);
  const applied = await appliedMigrations(client);
  const aplicadas: string[] = [];

  for (const migration of migrations) {
    const previo = applied.get(migration.version);
    if (previo !== undefined) {
      if (previo !== migration.sha256) {
        throw new Error(
          `La migracion ${migration.nombre} cambio despues de aplicarse. `
          + 'Las migraciones aplicadas son inmutables: cree una nueva.',
        );
      }
      continue;
    }

    const { pragmas, body } = splitLeadingPragmas(migration.sql);
    for (const pragma of pragmas) await client.execute(pragma);

    const tx = await client.transaction('write');
    try {
      await tx.executeMultiple(body);
      await tx.execute({
        sql: 'INSERT INTO schema_migrations (version, nombre, sha256, aplicada_en) VALUES (?, ?, ?, ?)',
        args: [migration.version, migration.nombre, migration.sha256, now().toISOString()],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }

    // Una migracion que reconstruye una tabla tiene que apagar las claves
    // foraneas para poder borrar la vieja, y eso es un ajuste de conexion: sin
    // esto quedaria apagado para todo lo que venga despues, en la misma corrida
    // y en el resto de la vida del cliente.
    await client.execute('PRAGMA foreign_keys = ON');

    aplicadas.push(migration.nombre);
  }

  return aplicadas;
}
