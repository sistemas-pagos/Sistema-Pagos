import Link from 'next/link';
import { redirect } from 'next/navigation';
import './cobros.css';
import { ROLES_DE_COBROS, sesionActual, tieneRol } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { periodFromDate, periodLabel, isPeriod } from '@/src/domain/periods';
import { normalizeHomePart } from '@/src/domain/housing';
import { filasDeCobro, opcionesDeFiltro, type EstadoDeCasa, type FilaDeCobro } from '@/src/services/listado-cobros';
import { getPaymentStore } from '@/src/storage';
import { cobradoSinEntregar } from '@/src/storage/efectivo';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * La pantalla del cobrador: buscar la casa y cobrarla.
 *
 * Lo que se ve es **estado, no datos**: ni nombres, ni telefonos ajenos, ni
 * montos de otras casas. El cobrador necesita saber a que puerta tocar y si
 * esa casa ya pago — nada mas (invariante 12).
 */
export const dynamic = 'force-dynamic';

const ETIQUETA: Record<EstadoDeCasa, string> = {
  PENDIENTE: 'Pendiente',
  PAGADO: 'Pagado',
  POR_VERIFICAR: 'Por verificar',
  EN_REVISION: 'En revisión',
};

const CLASE: Record<EstadoDeCasa, string> = {
  PENDIENTE: 'cob__chip--pendiente',
  PAGADO: 'cob__chip--pagado',
  POR_VERIFICAR: 'cob__chip--verificar',
  EN_REVISION: 'cob__chip--revision',
};

const money = (centavos: number) =>
  `L${(centavos / 100).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Los filtros llegan por la URL: se normalizan antes de usarlos. */
const filtro = (valor: string | undefined): string | undefined => {
  const limpio = valor ? normalizeHomePart(valor) : '';
  return limpio && limpio !== '0' ? limpio : undefined;
};

const esEstado = (valor: string | undefined): EstadoDeCasa | undefined =>
  valor && valor in ETIQUETA ? (valor as EstadoDeCasa) : undefined;

interface Params {
  etapa?: string;
  bloque?: string;
  casa?: string;
  estado?: string;
  metodo?: string;
  q?: string;
  mes?: string;
}

export default async function CobrosPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await tieneRol(...ROLES_DE_COBROS))) redirect('/login');

  const params = await searchParams;
  const sesion = await sesionActual();
  const periodo = isPeriod(params.mes ?? '') ? params.mes! : periodFromDate(new Date());

  const store = await getPaymentStore();
  const [homes, pagos] = await Promise.all([store.listHomes(), store.listPayments()]);

  const filas = filasDeCobro(homes, pagos, periodo, {
    stage: filtro(params.etapa),
    block: filtro(params.bloque),
    house: filtro(params.casa),
    estado: esEstado(params.estado),
    metodo: params.metodo === 'EFECTIVO' || params.metodo === 'TRANSFERENCIA' ? params.metodo : undefined,
    busqueda: params.q,
  });

  const opciones = opcionesDeFiltro(homes);
  const porEntregar = isDemoMode() || !sesion
    ? { totalCentavos: 0, cobros: 0, enRevisionCentavos: 0 }
    : await cobradoSinEntregar(await getTursoClient(), sesion.uid);

  // Tres meses hacia atras alcanzan: antes de septiembre de 2026 no hay meses,
  // hay saldo inicial.
  const meses = [0, 1, 2]
    .map((atras) => {
      const fecha = new Date();
      fecha.setUTCMonth(fecha.getUTCMonth() - atras);
      return periodFromDate(fecha);
    })
    .filter((mes) => mes >= '2026-09');

  return (
    <main className="cob">
      <header className="cob__head">
        <div>
          <p className="cob__eyebrow">Cobros en efectivo</p>
          <h1 className="cob__title">{periodLabel(periodo)}</h1>
          <p className="cob__quien">{sesion?.uid}</p>
        </div>
        <form method="post" action="/api/admin/logout">
          <button className="cob__boton cob__boton--plano" type="submit">Salir</button>
        </form>
      </header>

      {porEntregar.cobros > 0 && (
        <div className="cob__nota">
          Llevás <strong>{money(porEntregar.totalCentavos)}</strong> en {porEntregar.cobros}{' '}
          {porEntregar.cobros === 1 ? 'cobro' : 'cobros'} sin entregar.
          {porEntregar.enRevisionCentavos > 0 && (
            <> Incluye {money(porEntregar.enRevisionCentavos)} en revisión, que también tenés vos.</>
          )}{' '}
          <Link href="/cobros/entregar">Ver la hoja de entrega</Link>
        </div>
      )}

      <form className="cob__card" method="get">
        <div className="cob__filtros">
          <div className="cob__campo">
            <label htmlFor="mes">Mes</label>
            <select id="mes" name="mes" defaultValue={periodo}>
              {meses.map((mes) => <option key={mes} value={mes}>{periodLabel(mes)}</option>)}
            </select>
          </div>
          <div className="cob__campo">
            <label htmlFor="etapa">Etapa</label>
            <select id="etapa" name="etapa" defaultValue={params.etapa ?? ''}>
              <option value="">Todas</option>
              {opciones.etapas.map((etapa) => <option key={etapa} value={etapa}>{etapa}</option>)}
            </select>
          </div>
          <div className="cob__campo">
            <label htmlFor="bloque">Bloque</label>
            <select id="bloque" name="bloque" defaultValue={params.bloque ?? ''}>
              <option value="">Todos</option>
              {opciones.bloques.map((bloque) => <option key={bloque} value={bloque}>{bloque}</option>)}
            </select>
          </div>
          <div className="cob__campo">
            <label htmlFor="casa">Casa</label>
            <select id="casa" name="casa" defaultValue={params.casa ?? ''}>
              <option value="">Todas</option>
              {opciones.casas.map((casa) => <option key={casa} value={casa}>{casa}</option>)}
            </select>
          </div>
          <div className="cob__campo">
            <label htmlFor="estado">Estado</label>
            <select id="estado" name="estado" defaultValue={params.estado ?? ''}>
              <option value="">Todos</option>
              {Object.entries(ETIQUETA).map(([valor, texto]) => (
                <option key={valor} value={valor}>{texto}</option>
              ))}
            </select>
          </div>
          <div className="cob__campo">
            <label htmlFor="metodo">Método</label>
            <select id="metodo" name="metodo" defaultValue={params.metodo ?? ''}>
              <option value="">Todos</option>
              <option value="EFECTIVO">Efectivo</option>
              <option value="TRANSFERENCIA">Transferencia</option>
            </select>
          </div>
          <div className="cob__campo cob__campo--ancho">
            <label htmlFor="q">Referencia o vivienda</label>
            <input
              id="q"
              name="q"
              type="search"
              inputMode="numeric"
              defaultValue={params.q ?? ''}
              placeholder="Últimos dígitos de la referencia"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>
        </div>
        <div className="cob__acciones">
          <button className="cob__boton" type="submit">Buscar</button>
          <Link className="cob__boton cob__boton--plano" href="/cobros">Limpiar</Link>
        </div>
      </form>

      <p className="cob__conteo">
        {filas.length === 0 ? 'Ninguna vivienda con esos filtros.' : `${filas.length} ${filas.length === 1 ? 'vivienda' : 'viviendas'}`}
      </p>

      <ul className="cob__lista">
        {filas.map((fila) => <Casa key={fila.viviendaId} fila={fila} periodo={periodo} />)}
      </ul>
    </main>
  );
}

function Casa({ fila, periodo }: { fila: FilaDeCobro; periodo: string }) {
  return (
    <li>
      <Link className="cob__casa" href={`/cobros/${fila.viviendaId}?mes=${periodo}`}>
        <span className="cob__datos">
          <span className="cob__codigo">{fila.codigo}</span>
          <span className="cob__meta">
            {fila.estado === 'PENDIENTE'
              ? 'Sin pago este mes'
              : `${fila.metodo === 'EFECTIVO' ? 'Efectivo' : 'Transferencia'}${fila.fechaPago ? ` · ${fila.fechaPago}` : ''}`}
          </span>
        </span>
        <span className={`cob__chip ${CLASE[fila.estado]}`}>{ETIQUETA[fila.estado]}</span>
      </Link>
    </li>
  );
}
