import { env } from '@/src/config/env';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    ok: true,
    service: 'pagos-whatsapp-residencial',
    mode: env().APP_MODE,
    timestamp: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
