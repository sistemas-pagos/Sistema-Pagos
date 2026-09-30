import Link from 'next/link';
import { redirect } from 'next/navigation';
import '../cobros.css';
import { ROLES_DE_COBROS, sesionActual, tieneRol } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { formatoRecibo } from '@/src/domain/recibo';
import { cobrosSinEntregar, type CobroSinEntregar } from '@/src/storage/cierre-caja';
import { getTursoClient } from '@/src/storage/turso-client';

/**
 * La hoja de entrega del cobrador.
 *
 * El cobrador **no cierra su propia caja**: la recibe el tesorero, y el esquema
 * lo impide desde la 001 (`cobrador_id <> tesorero_id`). Esta pantalla es de
 * lectura a proposito — es lo que el pone sobre la mesa para contar la plata.
 *
 * Lleva el numero de recibo de cada cobro porque es lo que el tiene anotado en
 * su talonario: la entrega es papel contra pantalla, linea por linea.
 */
export const dynamic = 'force-dynamic';

const money = (centavos: number) =>
  `L${(centavos / 100).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function EntregarPage() {
  if (!(await tieneRol(...ROLES_DE_COBROS))) redirect('/login');

  const sesion = await sesionActual();
  const cobros = isDemoMode() || !sesion ? [] : await cobrosSinEntregar(await getTursoClient(), sesion.uid);
  const total = cobros.reduce((suma, cobro) => suma + cobro.montoCentavos, 0);
  const enRevision = cobros.filter((cobro) => cobro.estado === 'EN_REVISION');

  return (
    <main className="cob">
      <header className="cob__head">
        <div>
          <p className="cob__eyebrow">Hoja de entrega</p>
          <h1 className="cob__title">{money(total)}</h1>
          <p className="cob__quien">
            {cobros.length} {cobros.length === 1 ? 'cobro' : 'cobros'} sin entregar
          </p>
        </div>
        <Link className="cob__boton cob__boton--plano" href="/cobros">Volver</Link>
      </header>

      {cobros.length === 0 ? (
        <div className="cob__nota">No llevás nada sin entregar.</div>
      ) : (
        <>
          <div className="cob__nota">
            Mostrale esta pantalla al tesorero y contá la plata junto con él. La caja la cierra él,
            no vos: el sistema no deja que la misma persona entregue y reciba.
          </div>

          {enRevision.length > 0 && (
            <div className="cob__nota cob__nota--aviso">
              {enRevision.length === 1 ? 'Uno de estos cobros quedó' : `${enRevision.length} de estos cobros quedaron`}{' '}
              <strong>en revisión</strong> y sin número de recibo. Esa plata se entrega igual.
            </div>
          )}

          <ul className="cob__lista">
            {cobros.map((cobro) => <Fila key={cobro.pagoId} cobro={cobro} />)}
          </ul>

          <div className="cob__total">
            <span>Total a entregar</span>
            <strong>{money(total)}</strong>
          </div>
        </>
      )}
    </main>
  );
}

function Fila({ cobro }: { cobro: CobroSinEntregar }) {
  return (
    <li>
      <div className="cob__casa">
        <span className="cob__datos">
          <span className="cob__codigo">{cobro.vivienda}</span>
          <span className="cob__meta">
            {cobro.reciboNumero ? formatoRecibo(cobro.reciboNumero) : 'Sin recibo · en revisión'}
            {cobro.fechaPago ? ` · ${cobro.fechaPago}` : ''}
          </span>
        </span>
        <span className="cob__precio">{money(cobro.montoCentavos)}</span>
      </div>
    </li>
  );
}
