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
import { sincronizarUsuario, type RolUsuario } from '../src/storage/usuarios.ts';

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

    const resultado = await sincronizarUsuario(client, { id, nombre, rol, telefono }, ACTOR, new Date().toISOString());

    const dicho = {
      creado: `Alta registrada con rol ${rol}.`,
      actualizado: `Actualizado el usuario con rol ${rol}.`,
      sin_cambios: 'Ya estaba asi. No se cambio nada.',
    };
    console.log(dicho[resultado]);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  // Sin volcar el error entero: un fallo de UNIQUE de libSQL incluye la fila.
  console.error(error instanceof Error ? error.message.slice(0, 200) : 'Fallo la sincronizacion.');
  process.exitCode = 1;
});
