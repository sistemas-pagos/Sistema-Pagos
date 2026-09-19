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

export type ResultadoSincronizacion = 'creado' | 'actualizado' | 'sin_cambios';

/**
 * Pone la base de acuerdo con el telefono autorizado que se le pasa.
 *
 * Existe para que el dato no viva en dos lugares con igual autoridad. El
 * secreto del Environment es la fuente; esta fila es una copia que se sincroniza
 * corriendo el workflow. Sin esto, cambiar de tesorero dejaba el secreto
 * diciendo una cosa y la base otra — o, peor, creaba un segundo usuario y
 * quedaban **dos numeros autorizados** a la vez.
 *
 * Reactiva al usuario si estaba dado de baja: correr la sincronizacion es decir
 * "este es el autorizado", y quedarse inactivo contradiria eso en silencio.
 */
export async function sincronizarUsuario(
  db: Db,
  usuario: UsuarioInput & { telefono: string },
  actor: string,
  ahora: string,
): Promise<ResultadoSincronizacion> {
  const telefono = normalizePhone(usuario.telefono);

  return enTransaccion(db, async (tx) => {
    const ajeno = await tx.execute({
      sql: 'SELECT id FROM usuarios WHERE telefono = ? AND id <> ?',
      args: [telefono, usuario.id],
    });
    if (ajeno.rows.length > 0) {
      // Dos filas con el mismo telefono no pueden existir (UNIQUE), y elegir
      // por nuestra cuenta cual gana seria decidir a quien se le quita el
      // acceso sin que nadie lo pida.
      throw new Error(`Ese telefono ya pertenece al usuario ${String(ajeno.rows[0].id)}. Dalo de baja primero.`);
    }

    const actual = await tx.execute({
      sql: 'SELECT telefono, rol, activo FROM usuarios WHERE id = ?',
      args: [usuario.id],
    });

    if (actual.rows.length === 0) {
      await tx.execute({
        sql: 'INSERT INTO usuarios (id, nombre, email, telefono, rol, activo) VALUES (?, ?, ?, ?, ?, 1)',
        args: [usuario.id, usuario.nombre, usuario.email ?? null, telefono, usuario.rol],
      });
      await registrarEvento(tx, {
        entidad: 'usuarios', entidadId: usuario.id, accion: 'CREAR',
        despues: { rol: usuario.rol, activo: true }, actor,
      }, ahora);
      return 'creado';
    }

    const fila = actual.rows[0];
    const mismoTelefono = String(fila.telefono ?? '') === telefono;
    const mismoRol = String(fila.rol) === usuario.rol;
    const estabaActivo = Number(fila.activo) === 1;
    if (mismoTelefono && mismoRol && estabaActivo) return 'sin_cambios';

    await tx.execute({
      sql: 'UPDATE usuarios SET telefono = ?, rol = ?, nombre = ?, activo = 1 WHERE id = ?',
      args: [telefono, usuario.rol, usuario.nombre, usuario.id],
    });
    // El telefono no entra al evento; si que cambio, si.
    await registrarEvento(tx, {
      entidad: 'usuarios', entidadId: usuario.id, accion: 'ACTUALIZAR',
      antes: { rol: String(fila.rol), activo: estabaActivo },
      despues: { rol: usuario.rol, activo: true, telefonoCambio: !mismoTelefono },
      actor,
    }, ahora);
    return 'actualizado';
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

/**
 * Un usuario al que atribuirle lo que se hace desde el panel.
 *
 * El panel todavia entra con una clave compartida, asi que no sabe quien es la
 * persona (eso es lo que falta de la fase 7). Pero `ajustes.creado_por` es una
 * clave foranea a `usuarios`, y dejar ese campo apuntando a alguien que existe
 * es mejor que inventar un id: cuando el panel tenga usuario por persona, lo
 * unico que cambia es de donde sale este valor.
 *
 * Prefiere ADMIN sobre TESORERO y no devuelve cobradores: un cobrador no carga
 * saldos.
 */
export async function usuarioResponsable(db: Db): Promise<Usuario | undefined> {
  const { rows } = await db.execute(`
    SELECT id, nombre, rol FROM usuarios
    WHERE activo = 1 AND rol IN ('ADMIN', 'TESORERO')
    ORDER BY CASE rol WHEN 'ADMIN' THEN 0 ELSE 1 END, id
    LIMIT 1`);

  const fila = rows[0];
  if (!fila) return undefined;
  return { id: String(fila.id), nombre: String(fila.nombre), rol: String(fila.rol) as RolUsuario, activo: true };
}
