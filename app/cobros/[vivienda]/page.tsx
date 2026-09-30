import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import '../cobros.css';
import { ROLES_DE_COBROS, tieneRol } from '@/src/auth/guard';
import { periodLabel } from '@/src/domain/periods';
import { homeCode } from '@/src/domain/housing';
import { formatoRecibo } from '@/src/domain/recibo';
import { mesesCobrables } from '@/src/services/cobro-efectivo';
import type { PaymentRecord } from '@/src/domain/types';
import { getPaymentStore } from '@/src/storage';

/**
 * Cobrarle a una casa.
 *
 * El monto **no se escribe**: se marcan meses y el total sale de la cuota
 * vigente de cada uno. Es lo que hace imposible un cobro incompleto, que es la
 * regla que puso Eduardo — todo o nada por mes.
 *
 * Antes de cualquier campo se dice el estado de la casa. Esa es la primera
 * defensa contra cobrar dos veces: que el cobrador lo vea **antes** de pedir
 * la plata, no despues.
 */
export const dynamic = 'force-dynamic';

/** Los que ya no cuentan: sobre un pago liberado no hay nada que contar. */
const LIBERAN = new Set<PaymentRecord['status']>(['NO_ENCONTRADO', 'RECHAZADO', 'DUPLICADO', 'ANULADO']);

const ESTADO_CORTO: Partial<Record<PaymentRecord['status'], string>> = {
  VERIFICADO: 'verificado',
  EFECTIVO_COBRADO: 'cobrado en efectivo',
  PENDIENTE_VERIFICACION: 'por verificar',
  EN_REVISION: 'en revisión',
  ESPERANDO_RESPUESTA: 'esperando respuesta',
};

const money = (centavos: number) =>
  `L${(centavos / 100).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Params {
  params: Promise<{ vivienda: string }>;
  searchParams: Promise<{ mes?: string; error?: string; recibo?: string; revision?: string; nota?: string }>;
}

export default async function CobrarCasaPage({ params, searchParams }: Params) {
  if (!(await tieneRol(...ROLES_DE_COBROS))) redirect('/login');

  const { vivienda: viviendaId } = await params;
  const query = await searchParams;

  const store = await getPaymentStore();
  const [homes, pagos] = await Promise.all([store.listHomes(), store.listPayments()]);
  const home = homes.find((candidata) => candidata.id === viviendaId);
  if (!home || !home.active) notFound();

  const suyos = pagos.filter(
    (pago) => pago.stage === home.stage && pago.block === home.block && pago.house === home.house,
  );
  const cobrables = mesesCobrables(home, suyos, new Date());
  const debe = cobrables.filter((mes) => !mes.yaPagado);
  const pagados = cobrables.filter((mes) => mes.yaPagado);

  // Se emitio el recibo: lo unico que importa en pantalla es el numero, porque
  // el cobrador lo anota en su talonario delante del vecino.
  if (query.recibo) {
    return (
      <main className="cob">
        <header className="cob__head">
          <div>
            <p className="cob__eyebrow">Cobrado</p>
            <h1 className="cob__title">{homeCode(home)}</h1>
          </div>
        </header>
        <div className="cob__recibo">
          <p className="cob__quien" style={{ margin: 0 }}>Anotá este número en tu recibo</p>
          <b>{formatoRecibo(Number(query.recibo))}</b>
        </div>
        <div className="cob__nota">El recibo va en camino al WhatsApp del vecino.</div>
        <Link className="cob__boton" href="/cobros">Cobrar otra casa</Link>
      </main>
    );
  }

  // Ya habia pagado y el cobrador igual recibio la plata: queda para el admin.
  if (query.revision) {
    return (
      <main className="cob">
        <header className="cob__head">
          <div>
            <p className="cob__eyebrow">En revisión</p>
            <h1 className="cob__title">{homeCode(home)}</h1>
          </div>
        </header>
        <div className="cob__nota cob__nota--aviso">
          Quedó registrado para que lo revise el administrador. <strong>No se emitió recibo</strong>, así que
          no hay número que anotar, y al vecino no se le mandó ningún mensaje.
        </div>
        <div className="cob__nota">Esa plata igual cuenta en lo que tenés que entregar.</div>
        <Link className="cob__boton" href="/cobros">Cobrar otra casa</Link>
      </main>
    );
  }

  return (
    <main className="cob">
      <header className="cob__head">
        <div>
          <p className="cob__eyebrow">Registrar cobro</p>
          <h1 className="cob__title">{homeCode(home)}</h1>
          <p className="cob__quien">Etapa {home.stage} · Bloque {home.block} · Casa {home.house}</p>
        </div>
        <Link className="cob__boton cob__boton--plano" href="/cobros">Volver</Link>
      </header>

      {query.error && <p className="cob__error" role="alert">{query.error}</p>}

      {query.nota && (
        <div className="cob__nota">
          Tu nota quedó guardada. El administrador la ve en su bandeja; el pago no cambió de estado.
        </div>
      )}

      {pagados.length > 0 && (
        <div className="cob__nota cob__nota--aviso">
          <strong>Ya pagó {pagados.map((mes) => periodLabel(mes.periodo)).join(', ')}.</strong>{' '}
          Si el vecino insiste en que no le aparece, mostrale esto antes de cobrarle de nuevo.
        </div>
      )}

      {debe.length === 0 ? (
        <>
          <div className="cob__nota">Esta casa está al día. No hay nada que cobrar.</div>
          <RegistroEnRevision viviendaId={home.id} />
        </>
      ) : (
        <form className="cob__card" method="post" action={`/api/cobros/${home.id}`}>
          <p className="cob__eyebrow" style={{ marginBottom: 10 }}>Meses que paga</p>

          {debe.map((mes, indice) => (
            <div className="cob__mes" key={mes.periodo} style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                id={`mes-${mes.periodo}`}
                name="meses"
                value={mes.periodo}
                defaultChecked={indice === 0}
              />
              <label htmlFor={`mes-${mes.periodo}`}>{periodLabel(mes.periodo)}</label>
              <span className="cob__precio">{money(mes.montoCentavos)}</span>
            </div>
          ))}

          <p className="cob__quien" style={{ marginTop: 0 }}>
            Marcá todos los meses que paga. No se cobran meses incompletos: es todo o nada.
          </p>

          <div className="cob__campo" style={{ marginTop: 14 }}>
            <label htmlFor="telefono">Teléfono del vecino · opcional</label>
            <input id="telefono" name="telefono" type="tel" inputMode="tel" placeholder="9999-9999" maxLength={20} />
          </div>

          <div className="cob__consiente">
            <input type="checkbox" id="consiente" name="consiente" defaultChecked />
            <label htmlFor="consiente">Acepta recibir su recibo por WhatsApp</label>
          </div>

          <p className="cob__quien">
            Sin teléfono el cobro se registra igual, pero el recibo queda sin entregar.
          </p>

          <div className="cob__acciones">
            <button className="cob__boton" type="submit">Registrar cobro</button>
          </div>
        </form>
      )}

      <Notas viviendaId={home.id} pagos={suyos} />
    </main>
  );
}

/**
 * Lo que el cobrador puede decir sobre un pago que no puede tocar.
 *
 * No muestra monto ni depositante: el cobrador necesita identificar **cual** de
 * los pagos de esta casa le llama la atencion, y para eso alcanzan el mes y el
 * estado (invariante 12).
 */
function Notas({ viviendaId, pagos }: { viviendaId: string; pagos: readonly PaymentRecord[] }) {
  const recientes = [...pagos]
    .filter((pago) => !LIBERAN.has(pago.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  if (recientes.length === 0) return null;

  return (
    <form className="cob__card" method="post" action={`/api/cobros/${viviendaId}/nota`}>
      <p className="cob__eyebrow" style={{ marginBottom: 10 }}>¿Algo no cuadra con un pago?</p>

      {recientes.map((pago, indice) => (
        <div className="cob__mes" key={pago.id} style={{ marginBottom: 10 }}>
          <input type="radio" id={`nota-${pago.id}`} name="pagoId" value={pago.id} defaultChecked={indice === 0} />
          <label htmlFor={`nota-${pago.id}`}>
            {periodLabel(pago.period)} · {ESTADO_CORTO[pago.status] ?? pago.status}
          </label>
        </div>
      ))}

      <div className="cob__campo">
        <label htmlFor="texto">Contale al administrador</label>
        <textarea id="texto" name="texto" required maxLength={500} placeholder="Ej.: el vecino dice que su hijo ya transfirió desde otra cuenta." />
      </div>

      <p className="cob__quien">
        La nota no cambia el pago ni el estado de la casa. Vos no podés corregir un pago: dejás escrito
        lo que viste y el administrador decide.
      </p>

      <div className="cob__acciones">
        <button className="cob__boton cob__boton--plano" type="submit">Guardar nota</button>
      </div>
    </form>
  );
}

/**
 * La salida cuando la casa ya pago y el cobrador igual tiene la plata. Pide el
 * comentario: cerrar un caso sin decir por que es perder la unica explicacion
 * que iba a quedar de el.
 */
function RegistroEnRevision({ viviendaId }: { viviendaId: string }) {
  return (
    <form className="cob__card" method="post" action={`/api/cobros/${viviendaId}`}>
      <input type="hidden" name="enRevision" value="1" />
      <p className="cob__eyebrow" style={{ marginBottom: 10 }}>¿Ya le recibiste la plata?</p>
      <div className="cob__campo">
        <label htmlFor="motivo">Contá qué pasó</label>
        <textarea id="motivo" name="motivo" required maxLength={200} placeholder="Ej.: me dio los L150 en la puerta antes de que yo revisara." />
      </div>
      <div className="cob__acciones">
        <button className="cob__boton cob__boton--aviso" type="submit">Registrar para revisión</button>
      </div>
    </form>
  );
}
