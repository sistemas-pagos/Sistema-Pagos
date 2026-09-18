/**
 * Da de alta a una persona del sistema (tesorero, admin o cobrador). Lo ejecuta
 * .github/workflows/usuarios.yml de forma manual.
 *
 * El nombre y el telefono llegan por **secretos del Environment**, no por
 * inputs del workflow: los valores de un `workflow_dispatch` quedan a la vista
 * en la pagina de la corrida, y este repositorio es publico (invariante 12).
 * Los secretos, ademas, los enmascara Actions si alguien los imprimiera.
 *
 * Por eso este script no imprime ni el nombre ni el telefono: solo el rol y si
 * hubo alta o no.
 */
import { normalizePhone } from '../src/domain/phone.ts';
import { createTursoClient, tursoConfigFromEnv } from '../src/storage/turso-client.ts';
import { crearUsuario, usuarioPorTelefono, type RolUsuario } from '../src/storage/usuarios.ts';

const ROLES: readonly RolUsuario[] = ['ADMIN', 'TESORERO', 'COBRADOR'];
const ACTOR = 'workflow:usuarios';

function requerido(nombre: string): string {
  const valor = process.env[nombre]?.trim();
  if (!valor) throw new Error(`Falta ${nombre}.`);
  return valor;
}

async function main(): Promise<void> {
  const client = await createTursoClient(tursoConfigFromEnv());

  try {
    const id = requerido('PAGOS_USUARIO_ID');
    const nombre = requerido('PAGOS_USUARIO_NOMBRE');
    const rol = requerido('PAGOS_USUARIO_ROL').toUpperCase() as RolUsuario;
    const telefono = normalizePhone(requerido('PAGOS_USUARIO_TELEFONO'));

    if (!ROLES.includes(rol)) throw new Error(`Rol no valido. Usa uno de: ${ROLES.join(', ')}.`);

    if (await usuarioPorTelefono(client, telefono)) {
      console.log('Ese telefono ya esta dado de alta. No se cambio nada.');
      return;
    }

    await crearUsuario(client, { id, nombre, rol, telefono }, ACTOR, new Date().toISOString());
    console.log(`Alta registrada con rol ${rol}.`);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  // Sin volcar el error entero: un fallo de UNIQUE de libSQL incluye la fila.
  console.error(error instanceof Error ? error.message.slice(0, 200) : 'Fallo el alta.');
  process.exitCode = 1;
});
