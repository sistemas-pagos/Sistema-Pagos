import { env } from '@/src/config/env';
import { safeLog } from '@/src/security/logging';

const EVENT_TYPE = 'procesar-comprobantes';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * Avisa a GitHub Actions que hay mensajes por procesar (docs/PLAN.md, seccion 2).
 *
 * El aviso es una optimizacion, no la garantia: el workflow tambien corre por
 * cron, asi que un dispatch fallido solo retrasa el procesamiento. Por eso esta
 * funcion nunca lanza — el webhook debe responder 200 igual (invariante 14).
 *
 * No manda nada del mensaje en el payload: el worker lee la cola de `mensajes`
 * en la base. Asi ningun dato del vecino pasa por la API de GitHub ni queda en
 * el historial de corridas (invariante 12).
 */
export async function requestReceiptProcessing(): Promise<boolean> {
  const config = env();
  const repo = config.PAGOS_GITHUB_REPO;
  const token = config.PAGOS_DISPATCH_TOKEN;

  if (!repo || !token) {
    safeLog('warn', 'dispatch_not_configured');
    return false;
  }

  if (!REPO_PATTERN.test(repo)) {
    safeLog('warn', 'dispatch_repo_invalid');
    return false;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: EVENT_TYPE }),
      cache: 'no-store',
    });

    if (!response.ok) {
      safeLog('warn', 'dispatch_failed', { status: response.status });
      return false;
    }

    return true;
  } catch (error) {
    safeLog('warn', 'dispatch_failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return false;
  }
}
