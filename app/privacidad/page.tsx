import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * Meta exige una politica de privacidad publica para pasar la app de WhatsApp a
 * modo activo, y sin eso no entrega ningun mensaje real.
 *
 * El contenido describe el servicio de produccion, no esta demo: que dato entra,
 * cual no se guarda y quien lo procesa, siguiendo las invariantes de
 * docs/PLAN.md seccion 3. Si una invariante cambia, este texto cambia con ella.
 *
 * El nombre del responsable tiene que ser el mismo que el del portafolio
 * comercial de Meta: un revisor compara las dos cosas.
 */
export const metadata: Metadata = {
  title: 'Política de privacidad | Tren de Aseo',
  description:
    'Qué datos trata el sistema de cobro de la cuota del tren de aseo por WhatsApp, con qué finalidad, con quién se comparten y cuánto se conservan.',
};

const RESPONSABLE = 'Tren de Aseo';
const ACTUALIZADO = '17 de septiembre de 2026';

export default function PrivacidadPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">{RESPONSABLE.toUpperCase()}</div>
        <Link className="admin-link" href="/">← Volver al inicio</Link>
      </header>

      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Última actualización: {ACTUALIZADO}</p>
          <h1>Política de privacidad</h1>
          <p className="lead">
            Este documento explica qué datos personales trata el sistema de cobro de la cuota del tren de aseo por WhatsApp,
            para qué se usan, con quién se comparten y cuánto tiempo se conservan.
          </p>
        </div>
      </section>

      <div className="notice">
        La página de inicio de este sitio es una <strong>demostración técnica con datos inventados</strong>: ninguna vivienda,
        teléfono, monto ni comprobante que aparece ahí corresponde a una persona real. Esta política se refiere al servicio en
        producción, el que atiende los mensajes de WhatsApp de los residentes.
      </div>

      <article className="legal">
        <h2>Quién trata los datos</h2>
        <p>
          Los datos los trata <strong>{RESPONSABLE}</strong>, el servicio de recolección que cobra la cuota y opera este
          sistema, como responsable. El software es una herramienta interna del servicio; no se vende, no se cede y no se usa
          con fines publicitarios.
        </p>

        <h2>Qué datos se recogen</h2>
        <p>Solo lo necesario para registrar y verificar el pago de la cuota mensual del tren de aseo:</p>
        <ul>
          <li><strong>Número de teléfono de WhatsApp</strong> desde el que se envía el comprobante, para poder responder y enviar el recibo.</li>
          <li><strong>Identificación de la vivienda</strong>: etapa, bloque y casa. La indica el propio residente; el sistema nunca la deduce del número de teléfono ni del nombre del depositante.</li>
          <li><strong>Datos del comprobante bancario</strong>: fecha, hora, monto, referencia, banco, nombre del depositante, nombre del beneficiario y los últimos cuatro dígitos de la cuenta de destino.</li>
          <li><strong>Datos del movimiento bancario</strong> del estado de cuenta del servicio, que es contra lo que se verifica cada transferencia.</li>
          <li>En los cobros en efectivo, el <strong>número de recibo de talonario</strong> y el cobrador que lo recibió.</li>
        </ul>

        <h2>Qué no se guarda</h2>
        <ul>
          <li>
            <strong>Las imágenes de los comprobantes no se conservan.</strong> El identificador temporal que entrega WhatsApp se
            usa para leer la imagen una sola vez y se borra en cuanto el mensaje queda procesado. No se archiva ninguna foto ni
            captura de pantalla.
          </li>
          <li>No se recoge ubicación, contactos, fotos ajenas al comprobante ni ningún otro contenido del teléfono.</li>
          <li>No se usan cookies de seguimiento ni perfilado publicitario.</li>
        </ul>

        <h2>Para qué se usan</h2>
        <p>
          Únicamente para la gestión del cobro: identificar a qué vivienda y a qué mes corresponde el pago, comprobarlo contra
          el movimiento del banco, emitir el recibo, avisar al residente y mantener el estado de cuenta del servicio. No se
          toman decisiones automatizadas con efecto legal: cuando algo no cuadra, el caso queda en revisión para que lo mire una
          persona.
        </p>

        <h2>Base del tratamiento</h2>
        <p>
          El residente envía su comprobante de forma voluntaria para que se le acredite el pago; ese envío es el consentimiento.
          Los avisos por WhatsApp fuera de la ventana de 24 horas se hacen con plantillas aprobadas por Meta, y el residente
          puede pedir que se dejen de enviar en cualquier momento.
        </p>

        <h2>Con quién se comparten</h2>
        <p>
          No se venden ni se ceden a terceros. Los datos pasan por los proveedores que hacen funcionar el servicio, y solo para
          eso:
        </p>
        <ul>
          <li><strong>Meta (WhatsApp Business Platform)</strong>: entrega y recepción de los mensajes.</li>
          <li><strong>Vercel</strong>: alojamiento del punto de entrada que recibe los mensajes.</li>
          <li><strong>Turso</strong>: base de datos donde se guarda el registro de pagos.</li>
          <li><strong>GitHub Actions</strong>: procesamiento de los comprobantes.</li>
          <li><strong>Google (Sheets)</strong>: hojas de consulta para quien administra el cobro.</li>
        </ul>
        <p>
          También se comparten con quien la ley obligue, por ejemplo ante un requerimiento judicial.
        </p>

        <h2>Cuánto se conservan</h2>
        <p>
          El registro de pagos, recibos y cierres se conserva mientras la vivienda esté dentro del servicio y después durante el
          plazo que exija la normativa contable, porque es el respaldo de lo que cada casa pagó. El registro de correcciones es
          inmutable por diseño: no se puede editar ni borrar, para que siempre se sepa quién cambió qué y por qué. Las imágenes
          de los comprobantes, como se indica arriba, no se conservan en ningún momento.
        </p>

        <h2>Seguridad</h2>
        <p>
          Los mensajes entrantes se aceptan solo si vienen firmados por Meta. Las credenciales viven en entornos protegidos,
          nunca en el código, que es público. Los registros de ejecución no muestran teléfonos, viviendas, montos por casa,
          referencias ni nombres.
        </p>

        <h2>Derechos del residente</h2>
        <p>
          Cualquier residente puede pedir que se le muestre qué datos suyos hay, que se corrija un dato equivocado o que se
          elimine lo que no sea necesario conservar como respaldo contable. También puede pedir que se deje de usar WhatsApp
          para avisarle y recibir sus recibos por otro medio.
        </p>
        <p>
          Las solicitudes se hacen ante {RESPONSABLE}, por los mismos canales de siempre o escribiendo al número de WhatsApp del
          sistema.
        </p>

        <h2>Cambios</h2>
        <p>
          Si cambia lo que el sistema hace con los datos, esta página se actualiza y cambia la fecha del encabezado.
        </p>
      </article>

      <footer className="footer">
        <span>{RESPONSABLE} · cobro de la cuota por WhatsApp</span>
        <Link className="admin-link" href="/">Inicio</Link>
      </footer>
    </main>
  );
}
