import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pagos residenciales por WhatsApp | Demo',
  description: 'Automatización de cobros residenciales con WhatsApp, OCR, validación, conciliación y control de cartera.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
