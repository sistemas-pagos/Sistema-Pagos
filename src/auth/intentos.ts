import { createHmac } from 'node:crypto';
import { requireProductionEnv } from '@/src/config/env';
import { type Db, enTransaccion, registrarEvento } from '@/src/storage/turso';

/**
 * Limite de intentos de acceso al panel (docs/PLAN.md, fase 7).
 *
 * El panel se abre con una sola clave compartida. Sin limite, esa clave vale lo
 * que tarde en adivinarse, y una clave que una persona escribe de memoria se
 * adivina. El limite es lo que la hace servir.
 *
 * Se cuenta por origen, no por usuario: no hay usuario que contar todavia, solo
 * una clave. Y del origen se guarda una huella, nunca la IP (invariante 12).
 */

/** Cinco intentos seguidos fallidos. Nadie se equivoca cinco veces al hilo. */
export const MAX_INTENTOS = 5;
/** Cuanto dura el bloqueo, y tambien cuanto vive la cuenta de fallos. */
export const BLOQUEO_MINUTOS = 15;

const MS_POR_MINUTO = 60_000;

/**
 * HMAC con el secreto de sesion, no un hash a secas: el espacio de direcciones
 * IPv4 tiene cuatro mil millones de valores y una tabla lo invierte entero en
 * minutos. Con llave, la columna no dice de quien es.
 */
export function huellaDeOrigen(origen: string): string {
  const secreto = requireProductionEnv('AUTH_SESSION_SECRET').AUTH_SESSION_SECRET;
  return createHmac('sha256', secreto).update(origen).digest('base64url');
}

/**
 * De donde viene el intento. En Vercel la conexion llega por el proxy, asi que
 * la direccion real esta en el encabezado; el primer valor es el cliente.
 *
 * Sin encabezado se devuelve una huella fija: prefiero que todos esos intentos
 * compartan una cuenta a no contarlos.
 */
export function origenDeLaPeticion(request: Request): string {
  const reenviado = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return reenviado || request.headers.get('x-real-ip')?.trim() || 'sin-origen';
}

export interface EstadoDelOrigen {
  bloqueado: boolean;
  /** Cuantos minutos faltan para poder volver a intentar. */
  minutosRestantes: number;
}

export async function estadoDelOrigen(db: Db, huella: string, ahora: Date): Promise<EstadoDelOrigen> {
  const { rows } = await db.execute({
    sql: 'SELECT bloqueado_hasta FROM intentos_login WHERE huella = ?',
    args: [huella],
  });

  const hasta = rows[0]?.bloqueado_hasta;
  if (!hasta) return { bloqueado: false, minutosRestantes: 0 };

  const restante = new Date(String(hasta)).getTime() - ahora.getTime();
  if (restante <= 0) return { bloqueado: false, minutosRestantes: 0 };

  return { bloqueado: true, minutosRestantes: Math.ceil(restante / MS_POR_MINUTO) };
}

/**
 * Cuenta un fallo y bloquea al llegar al limite. Devuelve `true` si este
 * intento fue el que bloqueo.
 *
 * La cuenta se reinicia sola: fallos de hace mas de `BLOQUEO_MINUTOS` ya no
 * suman. Si no se reiniciara, cinco errores repartidos en un año bloquearian a
 * quien nada mas tiene mala memoria.
 */
export async function registrarFallo(db: Db, huella: string, ahora: Date, actor: string): Promise<boolean> {
  const ahoraIso = ahora.toISOString();
  const desde = new Date(ahora.getTime() - BLOQUEO_MINUTOS * MS_POR_MINUTO).toISOString();

  return enTransaccion(db, async (tx) => {
    const { rows } = await tx.execute({
      sql: 'SELECT intentos, primer_intento_en, bloqueado_hasta FROM intentos_login WHERE huella = ?',
      args: [huella],
    });

    const previo = rows[0];
    const vigente = previo !== undefined && String(previo.primer_intento_en) > desde;
    const intentos = (vigente ? Number(previo.intentos) : 0) + 1;
    const primero = vigente ? String(previo.primer_intento_en) : ahoraIso;

    const bloquea = intentos >= MAX_INTENTOS;
    const bloqueadoHasta = bloquea
      ? new Date(ahora.getTime() + BLOQUEO_MINUTOS * MS_POR_MINUTO).toISOString()
      : null;

    await tx.execute({
      sql: `INSERT INTO intentos_login (huella, intentos, bloqueado_hasta, primer_intento_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (huella) DO UPDATE SET
              intentos = excluded.intentos,
              bloqueado_hasta = excluded.bloqueado_hasta,
              primer_intento_en = excluded.primer_intento_en,
              actualizado_en = excluded.actualizado_en`,
      args: [huella, intentos, bloqueadoHasta, primero, ahoraIso],
    });

    // Solo el bloqueo deja evento, no cada fallo: un evento por intento seria
    // una forma de llenar `eventos` desde afuera, y `eventos` no se puede
    // borrar (invariante 8). El evento guarda la huella, nunca la IP.
    const yaEstaba = Boolean(previo?.bloqueado_hasta) && String(previo?.bloqueado_hasta) > ahoraIso;
    if (bloquea && !yaEstaba) {
      await registrarEvento(tx, {
        entidad: 'intentos_login', entidadId: huella, accion: 'BLOQUEAR',
        despues: { intentos, bloqueadoHasta }, motivo: 'max_intentos_login', actor,
      }, ahoraIso);
      return true;
    }

    return false;
  });
}

/** Entro bien: la cuenta vuelve a cero. */
export async function limpiarIntentos(db: Db, huella: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM intentos_login WHERE huella = ?', args: [huella] });
}

/** Barrido: lo que ya no bloquea a nadie no tiene por que seguir guardado. */
export async function expirarIntentos(db: Db, ahora: Date): Promise<number> {
  const desde = new Date(ahora.getTime() - BLOQUEO_MINUTOS * MS_POR_MINUTO).toISOString();
  const { rowsAffected } = await db.execute({
    sql: 'DELETE FROM intentos_login WHERE actualizado_en < ?',
    args: [desde],
  });
  return rowsAffected;
}
