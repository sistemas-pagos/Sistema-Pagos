import Link from 'next/link';
import { redirect } from 'next/navigation';
/*
 * La hoja de estilos del cobrador, reutilizada tal cual.
 *
 * No es casualidad que sirva: esta pantalla tiene el mismo problema —una mano,
 * un telefono, y una decision que no admite leer letra chica. Copiarla a un
 * archivo propio seria tener dos verdades sobre cuanto mide una zona tocable.
 */
import '../../cobros/cobros.css';
import './extracto.css';
import { ROLES_DEL_PANEL, sesionActual, tieneRol } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { montoEnLempiras } from '@/src/domain/recibo';
import type { ResumenConciliacion } from '@/src/domain/resumen-conciliacion';
import { importacionPendienteDe } from '@/src/storage/conciliacion';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * La carga del extracto del banco, desde el telefono del tesorero.
 *
 * Antes el extracto entraba por WhatsApp y se confirmaba con un «SI». Funciona,
 * pero el archivo del banco trae **todos** los movimientos de la cuenta, y
 * mandarlo por WhatsApp es entregarselo a Meta para verificar unos pagos. Por
 * aca el archivo va del telefono a la base y a nadie mas.
 *
 * Lo que decide sigue siendo el mismo codigo que el del worker: esta pantalla
 * solo muestra el resumen y pone los dos botones.
 */
export const dynamic = 'force-dynamic';

/** Lo que la pantalla dice segun lo que acabo de pasar. */
const AVISOS: Record<string, string> = {
  sin_archivo: 'No elegiste ningún archivo. Buscá el que bajaste del banco.',
  demasiado_grande: 'Ese archivo es demasiado grande para ser un extracto. Revisá que sea el del banco.',
  no_es_extracto: 'Ese archivo no parece un extracto del banco. Bajalo de nuevo, sin abrirlo ni guardarlo desde Excel.',
  no_cuadra: 'Ese archivo no cuadra: los saldos no suman. Volvé a descargarlo del banco sin modificarlo.',
  otra_cuenta: 'Ese extracto no es de la cuenta de cobro. Revisá que sea la cuenta correcta.',
  ya_estaba: 'Ese archivo ya lo habías cargado antes. Si sigue pendiente, lo ves acá abajo.',
  nada_esperando: 'No había ningún extracto esperando confirmación.',
  ya_no_vale: 'Esa confirmación ya venció o el extracto ya se aplicó. Cargá el archivo de nuevo.',
  cancelada: 'Descartado. No se aplicó nada.',
};

/**
 * `resumen_json` sale de la base como `unknown`: lo escribio una corrida
 * anterior y el esquema no lo valida. Si no tiene la forma esperada, la
 * pantalla prefiere no mostrar numeros antes que mostrar `NaN` al lado de un
 * boton que verifica pagos.
 */
function esResumen(valor: unknown): valor is ResumenConciliacion {
  if (typeof valor !== 'object' || valor === null) return false;
  const campos = ['depositos', 'depositosCentavos', 'verificaria', 'verificariaCentavos', 'sinComprobante', 'sinComprobanteCentavos', 'sinDeposito', 'aRevision'];
  return campos.every((campo) => typeof (valor as Record<string, unknown>)[campo] === 'number');
}

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Tegucigalpa' });

const plural = (cantidad: number, singular: string) => (cantidad === 1 ? singular : `${singular}s`);

interface Params {
  aviso?: string;
  v?: string;
  r?: string;
  s?: string;
  x?: string;
}

export default async function ExtractoPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await tieneRol(...ROLES_DEL_PANEL))) redirect('/login');

  const params = await searchParams;
  const demo = isDemoMode();
  const sesion = await sesionActual();

  const pendiente = demo || !sesion
    ? undefined
    : await importacionPendienteDe(await getTursoClient(), sesion.uid, new Date().toISOString());
  const resumen = esResumen(pendiente?.resumen) ? pendiente.resumen : undefined;

  const numero = (valor: string | undefined) => {
    const leido = Number.parseInt(valor ?? '', 10);
    return Number.isInteger(leido) && leido >= 0 ? leido : 0;
  };
  const aplicada = params.aviso === 'aplicada';

  return (
    <main className="cob">
      <header className="cob__head">
        <div>
          <p className="cob__eyebrow">Tesorería</p>
          <h1 className="cob__title">Extracto del banco</h1>
        </div>
        <Link className="cob__boton cob__boton--plano" href="/admin">Volver</Link>
      </header>

      {demo && (
        <p className="cob__nota cob__nota--aviso">
          Esta es la demostración y no tiene base de datos. La conciliación funciona solo en producción.
        </p>
      )}

      {aplicada && (
        <div className="cob__card">
          <p className="cob__eyebrow">Aplicado</p>
          <p className="ext__linea">
            <span>Pagos verificados</span><strong>{numero(params.v)}</strong>
          </p>
          <p className="ext__linea">
            <span>Recibos emitidos</span><strong>{numero(params.r)}</strong>
          </p>
          <p className="ext__linea">
            <span>Sin respaldo del banco</span><strong>{numero(params.s)}</strong>
          </p>
          <p className="ext__linea">
            <span>Quedaron en revisión</span><strong>{numero(params.x)}</strong>
          </p>
          <p className="cob__conteo">
            Los recibos salen por WhatsApp solos. Los que no tengan teléfono quedan en «Recibos no entregados».
          </p>
        </div>
      )}

      {params.aviso && Object.hasOwn(AVISOS, params.aviso) && (
        <p className="cob__nota cob__nota--aviso">{AVISOS[params.aviso]}</p>
      )}

      {resumen && pendiente && (
        <section className="cob__card">
          <p className="cob__eyebrow">Esperando que confirmes</p>
          <h2 className="ext__titulo">Esto es lo que haría</h2>

          <p className="ext__linea">
            <span>Depósitos en el extracto</span>
            <strong>{resumen.depositos} · {montoEnLempiras(resumen.depositosCentavos)}</strong>
          </p>
          <p className="ext__linea ext__linea--fuerte">
            <span>Se verificarían</span>
            <strong>{resumen.verificaria} · {montoEnLempiras(resumen.verificariaCentavos)}</strong>
          </p>
          <p className="ext__linea">
            <span>Depósitos sin comprobante</span>
            <strong>{resumen.sinComprobante} · {montoEnLempiras(resumen.sinComprobanteCentavos)}</strong>
          </p>
          <p className="ext__linea">
            <span>Comprobantes sin depósito</span>
            <strong>{resumen.sinDeposito}</strong>
          </p>
          <p className="ext__linea">
            <span>A revisión</span>
            <strong>{resumen.aRevision}</strong>
          </p>

          <p className="cob__conteo">
            Después de las {hora(pendiente.expiraEn)} hay que cargar el archivo otra vez: un extracto de
            hace horas se aplicaría contra pagos que ya cambiaron.
          </p>

          <form className="ext__acciones" method="post" action="/api/admin/extracto">
            <button className="cob__boton" type="submit" name="accion" value="confirmar">
              Aplicar: verificar {resumen.verificaria} {plural(resumen.verificaria, 'pago')}
            </button>
            <button className="cob__boton cob__boton--plano" type="submit" name="accion" value="descartar">
              Descartar
            </button>
          </form>
        </section>
      )}

      {pendiente && !resumen && (
        <p className="cob__nota cob__nota--aviso">
          Hay un extracto esperando confirmación pero no se puede leer su resumen. Descartalo y cargá el
          archivo de nuevo.
        </p>
      )}

      {!pendiente && (
        <form className="cob__card ext__carga" method="post" action="/api/admin/extracto" encType="multipart/form-data">
          <label className="cob__eyebrow" htmlFor="archivo">El archivo del banco</label>
          <input id="archivo" name="archivo" type="file" accept=".csv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
          <button className="cob__boton" type="submit">Leer el extracto</button>
          <p className="cob__conteo">
            Bajalo de la banca en línea y subilo tal como está. Abrirlo y guardarlo desde Excel le cambia
            el formato y deja de leerse.
          </p>
          <p className="cob__conteo">
            Leerlo no verifica nada: primero se muestra el resumen y vos decidís.
          </p>
        </form>
      )}
    </main>
  );
}
