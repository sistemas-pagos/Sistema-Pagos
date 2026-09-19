/**
 * Cuadra y bloquea un mes de servicio. Lo ejecuta
 * .github/workflows/cierre-mes.yml de forma manual.
 *
 * Cerrar un mes es irreversible por diseño: despues, ningun pago de ese mes se
 * puede modificar (invariante 9). Las correcciones entran como un ajuste en el
 * mes siguiente, que es la unica forma de que un cuadre siga cuadrando.
 *
 * Solo imprime cuentas y totales del mes: ninguna casa, ningun monto por
 * vivienda (invariante 12).
 */
import { calcularCierre } from '../src/services/cierre-mes.ts';
import { cerrarMes } from '../src/storage/cierre-mes.ts';
import { createTursoClient, tursoConfigFromEnv } from '../src/storage/turso-client.ts';
import { TursoPaymentStore } from '../src/storage/turso-store.ts';

const ACTOR = 'workflow:cierre-mes';
const PERIODO = /^\d{4}-\d{2}$/;

function lempiras(valorEnCentavos: number): string {
  return `L${(valorEnCentavos / 100).toFixed(2)}`;
}

async function main(): Promise<void> {
  // La conexion se abre primero para que la falta de credenciales se note antes
  // que cualquier otra cosa. El almacen se arma sobre este mismo cliente en vez
  // de pedirlo a `getPaymentStore()`: un cierre manual nunca debe caer en el
  // almacen de demostracion por un APP_MODE mal puesto.
  const client = await createTursoClient(tursoConfigFromEnv());

  try {
    const periodo = process.env.PAGOS_PERIODO?.trim() ?? '';
    if (!PERIODO.test(periodo)) throw new Error('PAGOS_PERIODO tiene que ser un mes con formato AAAA-MM.');

    const cerradoPor = process.env.PAGOS_USUARIO_ID?.trim() || 'u-tesorero';
    const resumen = await calcularCierre(new TursoPaymentStore(client), periodo);

    const cerrado = await cerrarMes(client, {
      periodo, cerradoPor, cerradoEn: new Date().toISOString(), resumen,
    }, ACTOR);

    if (!cerrado) {
      console.log(`El mes ${periodo} ya estaba cerrado. No se cambio nada.`);
      return;
    }

    console.log(`Mes ${periodo} cerrado.`);
    console.log(`  Viviendas activas: ${resumen.viviendasActivas}`);
    console.log(`  Pagadas: ${resumen.pagadas}  Por verificar: ${resumen.porVerificar}`);
    console.log(`  En revision: ${resumen.enRevision}  Pendientes: ${resumen.pendientes}`);
    console.log(`  Cobrado: ${lempiras(resumen.cobradoCentavos)} de ${lempiras(resumen.esperadoCentavos)}`);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.slice(0, 200) : 'Fallo el cierre.');
  process.exitCode = 1;
});
