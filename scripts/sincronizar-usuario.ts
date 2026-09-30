/**
 * Pone la base de acuerdo con el telefono autorizado que guarda el Environment.
 * Lo ejecuta .github/workflows/usuarios.yml de forma manual.
 *
 * La fuente de verdad es el secreto; esta corrida sincroniza la fila de
 * `usuarios`. Asi el numero no vive en dos lugares con igual autoridad: se
 * cambia el secreto, se corre esto, y no hay forma de que la base diga una cosa
 * y el Environment otra.
 *
 * Pide un solo dato — el telefono —, porque es el unico que el sistema no puede
 * deducir. El rol tiene valor por defecto y el identificador sale del rol. El
 * nombre es opcional: no hace falta para nada y es un dato personal menos
 * dando vueltas.
 *
 * No imprime ni el nombre ni el telefono: solo el rol y que cambio.
 */
import { normalizePhone } from '../src/domain/phone.ts';
import { createTursoClient, tursoConfigFromEnv } from '../src/storage/turso-client.ts';
import { fijarCredenciales, sincronizarUsuario, type RolUsuario } from '../src/storage/usuarios.ts';
import { hashDeClave, LARGO_MINIMO_CLAVE } from '../src/auth/claves.ts';

const ROLES: readonly RolUsuario[] = ['ADMIN', 'TESORERO', 'COBRADOR'];
const ACTOR = 'workflow:usuarios';

function opcional(nombre: string): string | undefined {
  return process.env[nombre]?.trim() || undefined;
}

async function main(): Promise<void> {
  const client = await createTursoClient(tursoConfigFromEnv());

  try {
    const crudo = opcional('PAGOS_USUARIO_TELEFONO');
    if (!crudo) throw new Error('Falta PAGOS_USUARIO_TELEFONO.');
    const telefono = normalizePhone(crudo);

    const rol = (opcional('PAGOS_USUARIO_ROL') ?? 'TESORERO').toUpperCase() as RolUsuario;
    if (!ROLES.includes(rol)) throw new Error(`Rol no valido. Usa uno de: ${ROLES.join(', ')}.`);

    const id = opcional('PAGOS_USUARIO_ID') ?? `u-${rol.toLowerCase()}`;
    const nombre = opcional('PAGOS_USUARIO_NOMBRE') ?? id;

    const en = new Date().toISOString();
    const resultado = await sincronizarUsuario(client, { id, nombre, rol, telefono }, ACTOR, en);

    const dicho = {
      creado: `Alta registrada con rol ${rol}.`,
      actualizado: `Actualizado el usuario con rol ${rol}.`,
      sin_cambios: 'Ya estaba asi. No se cambio nada.',
    };
    console.log(dicho[resultado]);

    // El usuario y la clave con que esta persona entra al panel. Van juntos o no
    // van: media credencial no sirve para nada. Son opcionales porque un usuario
    // puede existir solo para mandar el extracto por WhatsApp, sin entrar nunca.
    const login = opcional('PAGOS_USUARIO_LOGIN');
    const clave = opcional('PAGOS_USUARIO_CLAVE');

    if (login && !clave) throw new Error('Falta PAGOS_USUARIO_CLAVE.');
    if (clave && !login) throw new Error('Falta PAGOS_USUARIO_LOGIN.');

    if (login && clave) {
      if (clave.length < LARGO_MINIMO_CLAVE) {
        throw new Error(`La clave necesita al menos ${LARGO_MINIMO_CLAVE} caracteres.`);
      }
      await fijarCredenciales(client, { id, login, claveHash: await hashDeClave(clave) }, ACTOR, en);
      // Ni el usuario ni la clave: solo que ya puede entrar (invariante 12).
      console.log(`Credencial configurada. Ya puede entrar al panel con rol ${rol}.`);
    }
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  // Sin volcar el error entero: un fallo de UNIQUE de libSQL incluye la fila.
  console.error(error instanceof Error ? error.message.slice(0, 200) : 'Fallo la sincronizacion.');
  process.exitCode = 1;
});
