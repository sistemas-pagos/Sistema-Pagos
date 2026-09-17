import { z } from 'zod';

/**
 * Una variable declarada pero vacia es una variable sin configurar.
 *
 * Los paneles de despliegue (Vercel, entre otros) crean la variable con valor
 * vacio cuando uno la deja en blanco, y sin esto una cadena vacia llega al
 * esquema: `z.coerce.number()` la convierte en 0 y el arranque falla con un
 * mensaje que no explica nada. `.default()` no alcanza, porque solo cubre el
 * caso `undefined`.
 */
const enBlancoEsAusente = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(
  enBlancoEsAusente,
  z.string().trim().min(1).optional(),
);
const optionalLast4 = z.preprocess(
  enBlancoEsAusente,
  z.string().trim().regex(/^\d{4}$/).optional(),
);

const envSchema = z.object({
  APP_MODE: z.preprocess(enBlancoEsAusente, z.enum(['demo', 'production']).default('demo')),
  APP_BASE_URL: optionalString,
  MAX_RECEIPT_BYTES: z.preprocess(enBlancoEsAusente, z.coerce.number().int().positive().max(20 * 1024 * 1024).default(8 * 1024 * 1024)),
  PENDING_CONTEXT_MINUTES: z.preprocess(enBlancoEsAusente, z.coerce.number().int().positive().max(24 * 60).default(30)),
  EXPECTED_PAYMENT_AMOUNT: z.preprocess(enBlancoEsAusente, z.coerce.number().positive().default(150)),
  ADMIN_ACCESS_KEY: optionalString,
  AUTH_SESSION_SECRET: optionalString,
  GOOGLE_SHEET_ID: optionalString,
  GOOGLE_CLIENT_EMAIL: optionalString,
  GOOGLE_PRIVATE_KEY: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  META_APP_SECRET: optionalString,
  WHATSAPP_GRAPH_VERSION: z.preprocess(
    enBlancoEsAusente,
    z.string().trim().regex(/^v\d+\.\d+$/).default('v26.0'),
  ),
  // Plantilla aprobada en Meta con la que sale el recibo (invariante 13). El
  // nombre tiene que coincidir con el aprobado; si no, Meta rechaza el envio.
  WHATSAPP_TEMPLATE_RECIBO: z.preprocess(enBlancoEsAusente, z.string().trim().min(1).default('recibo_pago')),
  WHATSAPP_TEMPLATE_IDIOMA: z.preprocess(enBlancoEsAusente, z.string().trim().min(2).default('es')),
  EXPECTED_BENEFICIARY: optionalString,
  EXPECTED_ACCOUNT_LAST4: optionalLast4,
  // Turso: fuente de verdad del registro de mensajes (fase 1 en adelante).
  PAGOS_TURSO_URL: optionalString,
  PAGOS_TURSO_TOKEN: optionalString,
  // repository_dispatch hacia GitHub Actions, que hace el trabajo pesado.
  PAGOS_GITHUB_REPO: optionalString,
  PAGOS_DISPATCH_TOKEN: optionalString,
});

export type AppEnv = z.infer<typeof envSchema>;
let cached: AppEnv | undefined;

export function env(): AppEnv {
  if (!cached) cached = envSchema.parse(process.env);
  return cached;
}

export function isDemoMode(): boolean {
  return env().APP_MODE !== 'production';
}

export function requireProductionEnv<K extends keyof AppEnv>(...keys: K[]): Required<Pick<AppEnv, K>> {
  const current = env();
  const missing = keys.filter((key) => !current[key]);
  if (missing.length) throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  return Object.fromEntries(keys.map((key) => [key, current[key]])) as Required<Pick<AppEnv, K>>;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
