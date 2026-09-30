import type { Client } from '@libsql/client';
import { credencialPorLogin } from '@/src/storage/usuarios';
import { verificarClave } from './claves';
import { claveCompartidaConfigurada, verifyAdminAccessKey, UID_CLAVE_COMPARTIDA, type Sesion } from './session';

/**
 * Decide si alguien entra, y como quien.
 *
 * Todas las salidas negativas son la misma: `undefined`. Distinguir "ese
 * usuario no existe" de "la clave esta mal" le regala la mitad del trabajo a
 * quien prueba claves, y distinguir "esta de baja" le confirma que la persona
 * existe. Quien no entra, no se entera de por que.
 *
 * Por lo mismo se verifica la clave **aunque el usuario no exista o este
 * inactivo**: sin eso, un usuario inexistente responderia al instante y uno
 * real tardaria los ~100 ms de scrypt, y esa diferencia se mide desde afuera.
 */
export async function credencialValida(
  db: Client,
  login: string,
  clave: string,
): Promise<Sesion | undefined> {
  const encontrado = await credencialPorLogin(db, login);

  // Un hash imposible de acertar: hace el mismo trabajo que uno real para que
  // el tiempo de respuesta no cuente nada.
  const hashSenuelo = 'scrypt:32768:8:1:c2VudWVsbw==:c2VudWVsbw==';
  const coincide = await verificarClave(clave, encontrado?.claveHash ?? hashSenuelo);

  if (!encontrado || !encontrado.activo || !encontrado.claveHash || !coincide) return undefined;
  return { uid: encontrado.id, rol: encontrado.rol };
}

/**
 * El respaldo mientras dura la transicion: la clave compartida de
 * `ADMIN_ACCESS_KEY` sigue abriendo el panel como ADMIN.
 *
 * Existe **solo mientras la variable este puesta en Vercel**. En cuanto se
 * borra, este camino desaparece sin tocar una linea de codigo — que es
 * justamente lo que lo hace una transicion y no una puerta trasera.
 *
 * La sesion que crea se identifica como `panel`, no como una persona: la clave
 * es compartida y decir un nombre seria inventar quien fue.
 */
export function claveCompartidaValida(clave: string): Sesion | undefined {
  if (!claveCompartidaConfigurada()) return undefined;
  if (!verifyAdminAccessKey(clave)) return undefined;
  return { uid: UID_CLAVE_COMPARTIDA, rol: 'ADMIN' };
}
