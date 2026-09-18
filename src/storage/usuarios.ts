import { normalizePhone } from '@/src/domain/phone';
import { type Db, enTransaccion, registrarEvento } from '@/src/storage/turso';

/**
 * Quien es quien del lado del sistema: tesorero, administrador y cobrador.
 *
 * El telefono autorizado para mandar el extracto del banco vive aqui y no en
 * una variable de entorno ni en el codigo. Tres razones:
 *
 * - este repositorio es publico y un numero es un dato personal;
 * - cambiar de tesorero no puede necesitar un despliegue;
 * - el alta y la baja quedan en `eventos`, que es donde se mira cuando hay que
 *   explicar por que un extracto entro.
 */

export type RolUsuario = 'ADMIN' | 'TESORERO' | 'COBRADOR';

export interface Usuario {
  id: string;
  nombre: string;
  rol: RolUsuario;
  activo: boolean;
}

export interface UsuarioInput {
  id: string;
  nombre: string;
  rol: RolUsuario;
  email?: string;
  telefono?: string;
}

/** Normaliza el telefono al guardarlo: si no, la busqueda nunca coincide. */
export async function crearUsuario(db: Db, usuario: UsuarioInput, actor: string, creadoEn: string): Promise<void> {
  const telefono = usuario.telefono === undefined ? null : normalizePhone(usuario.telefono);

  await enTransaccion(db, async (tx) => {
    await tx.execute({
      sql: 'INSERT INTO usuarios (id, nombre, email, telefono, rol, activo) VALUES (?, ?, ?, ?, ?, 1)',
      args: [usuario.id, usuario.nombre, usuario.email ?? null, telefono, usuario.rol],
    });
    // Sin el telefono ni el correo: el evento dice que hubo un alta y con que
    // rol, que es lo que hace falta para auditar (invariante 12).
    await registrarEvento(tx, {
      entidad: 'usuarios', entidadId: usuario.id, accion: 'CREAR',
      despues: { rol: usuario.rol, activo: true }, actor,
    }, creadoEn);
  });
}

/**
 * Busca por telefono. Devuelve `undefined` si no esta o si esta dado de baja:
 * un usuario inactivo no es un usuario.
 */
export async function usuarioPorTelefono(db: Db, telefono: string): Promise<Usuario | undefined> {
  let normalizado: string;
  try {
    normalizado = normalizePhone(telefono);
  } catch {
    return undefined;
  }

  const { rows } = await db.execute({
    sql: 'SELECT id, nombre, rol, activo FROM usuarios WHERE telefono = ?',
    args: [normalizado],
  });

  const fila = rows[0];
  if (!fila || Number(fila.activo) !== 1) return undefined;
  return {
    id: String(fila.id),
    nombre: String(fila.nombre),
    rol: String(fila.rol) as RolUsuario,
    activo: true,
  };
}

/**
 * Quien puede mandar el extracto del banco y confirmarlo. El cobrador no: cobra
 * efectivo, no concilia la cuenta, y darle esto seria darle la llave entera.
 */
export function puedeConciliar(usuario: Usuario | undefined): usuario is Usuario {
  return usuario !== undefined && (usuario.rol === 'ADMIN' || usuario.rol === 'TESORERO');
}
