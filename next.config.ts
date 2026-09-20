import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['sharp', 'tesseract.js', '@tesseract.js-data/spa', 'googleapis'],
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        // `same-origin` y no `no-referrer`: con `no-referrer` el navegador manda
        // literalmente `Origin: null` en los POST de formulario (Fetch, "append a
        // request Origin header"), y eso dejaba las siete rutas del panel
        // devolviendo 403 en todos los navegadores. Sigue sin filtrar nuestras
        // URLs a terceros, que es lo que la cabecera venia a cuidar.
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ],
    }];
  },
};

export default nextConfig;
