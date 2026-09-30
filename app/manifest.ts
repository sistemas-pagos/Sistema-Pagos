import type { MetadataRoute } from 'next';

/**
 * El manifiesto que vuelve instalable la pagina de cobros.
 *
 * El cobrador anda en la calle: agregarla a la pantalla de inicio le evita
 * buscar una URL cada vez, y `standalone` la abre sin la barra del navegador,
 * que en un telefono son ~90 px de pantalla recuperados.
 *
 * `start_url` apunta a `/cobros` y no a la raiz a proposito: quien instala
 * esto es el cobrador, y la raiz es la pagina publica de demostracion.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cobros — Tren de aseo',
    short_name: 'Cobros',
    description: 'Registrar cobros en efectivo del tren de aseo residencial.',
    start_url: '/cobros',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#08120f',
    theme_color: '#08120f',
    lang: 'es',
    icons: [
      { src: '/icono.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icono-mascara.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
