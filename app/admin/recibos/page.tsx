import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAdminAuthenticated } from '@/src/auth/guard';
import { isDemoMode } from '@/src/config/env';
import { recibosNoEntregados, type ReciboNoEntregado } from '@/src/storage/envios';
import { getTursoClient } from '@/src/storage/turso-client';
import { formatoRecibo } from '@/src/domain/recibo';

/**
 * Los recibos que el vecino no recibio.
 *
 * Un pago verificado que no avisa a nadie es el peor estado del sistema: la
 * plata quedo contada, el tablero se ve perfecto y la persona que pago no tiene
 * nada en la mano. La fila siempre existio en `envios`; lo que faltaba era una
 * pantalla que la mirara, y sin ella el unico que se enteraba era el vecino.
 */
export const dynamic = 'force-dynamic';

const MOTIVO_LABEL: Record<ReciboNoEntregado['motivo'], string> = {
  FALLIDO: '✕ No entregado',
  ATASCADO: '⚠ Sin salir',
};

/**
 * El error de WhatsApp viaja como codigo (`whatsapp_template_failed:400`).
 * Al tesorero no le dice nada, y lo que necesita saber es que hacer.
 */
function queSignifica(fila: ReciboNoEntregado): string {
  if (fila.motivo === 'ATASCADO') return 'La cola no está avanzando. Revisá que el workflow «Enviar recibos» esté corriendo.';
  const error = fila.error ?? '';
  if (error.includes(':400')) return 'WhatsApp rechazó el mensaje. Suele ser la plantilla sin aprobar o con otro nombre.';
  if (error.includes(':401') || error.includes(':403')) return 'El token de WhatsApp no tiene permiso o venció.';
  if (error.includes(':404')) return 'La plantilla no existe con ese nombre o ese idioma.';
  if (error.includes(':429')) return 'Meta limitó el envío por volumen. Se puede reintentar.';
  return 'Revisá el número del vecino: es el motivo más común.';
}

const horas = (desde: string, ahora: Date): number =>
  Math.max(0, Math.floor((ahora.getTime() - new Date(desde).getTime()) / 3_600_000));

export default async function RecibosPage() {
  if (!(await isAdminAuthenticated())) redirect('/login');

  const demo = isDemoMode();
  const ahora = new Date();
  const filas = demo ? [] : await recibosNoEntregados(await getTursoClient(), ahora);
  const fallidos = filas.filter((fila) => fila.motivo === 'FALLIDO').length;
  const atascados = filas.length - fallidos;

  return (
    <main className="shell">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Control</p>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3.6rem)' }}>Recibos no entregados</h1>
          <p className="lead">
            Pagos verificados cuyo recibo no le llegó al vecino. La plata está bien contada;
            lo que falta es el aviso — y el vecino no tiene cómo saber que su pago quedó registrado.
          </p>
        </div>
        <Link className="primary-button" href="/admin">Volver al panel</Link>
      </header>

      {demo && (
        <div className="notice">
          Esta es la demostración y no tiene base de datos. El control de envíos funciona solo en producción.
        </div>
      )}

      {!demo && (
        <section className="kpis" style={{ marginTop: 28 }}>
          <div className="kpi">
            <span>No entregados</span><strong>{fallidos}</strong><small>Agotaron los 5 intentos</small>
          </div>
          <div className="kpi">
            <span>Sin salir</span><strong>{atascados}</strong><small>Llevan horas en cola</small>
          </div>
        </section>
      )}

      {!demo && filas.length === 0 && (
        <div className="notice">
          Todos los recibos emitidos llegaron. Nada que revisar.
        </div>
      )}

      {filas.length > 0 && (
        <>
          <div className="section-head">
            <div><p className="eyebrow">Revisar</p><h2>Qué pasó con cada uno</h2></div>
            <p>El recibo ya está emitido y su número no se reutiliza: se reintenta el envío, no se emite otro.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recibo</th><th>Vivienda</th><th>Teléfono WhatsApp</th>
                  <th>Estado</th><th>Intentos</th><th>Sin llegar</th><th>Qué revisar</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((fila) => (
                  <tr key={fila.envioId}>
                    <td>{formatoRecibo(fila.reciboNumero)}</td>
                    <td>{fila.vivienda}</td>
                    <td>{fila.telefono}</td>
                    <td>{MOTIVO_LABEL[fila.motivo]}</td>
                    <td>{fila.intentos}</td>
                    <td>{horas(fila.actualizadoEn, ahora)} h</td>
                    <td>{queSignifica(fila)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
