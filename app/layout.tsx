import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  // Para que iOS la abra sin la barra del navegador al agregarla a inicio:
  // Safari todavia no lee `display: standalone` del manifiesto.
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Cobros' },
  title: 'Pagos residenciales por WhatsApp | Demo',
  description: 'Automatización de cobros residenciales con WhatsApp, OCR, validación, conciliación y control de cartera.',
};

/**
 * Sin esto un telefono renderiza la pagina como si fuera de escritorio y la
 * encoge: todo diminuto y hay que hacer zoom. Faltaba desde el principio, asi
 * que los dos media queries de `globals.css` nunca se habian activado.
 *
 * `maximumScale` queda sin tocar a proposito: limitar el zoom le quita a quien
 * no ve bien la unica forma de leer la pantalla.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#08120f',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
