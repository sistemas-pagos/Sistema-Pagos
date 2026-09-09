import { z } from 'zod';

const optionalString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);
const optionalLast4 = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().regex(/^\d{4}$/).optional(),
);

const envSchema = z.object({
  APP_MODE: z.enum(['demo', 'production']).default('demo'),
  APP_BASE_URL: optionalString,
  MAX_RECEIPT_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(8 * 1024 * 1024),
  PENDING_CONTEXT_MINUTES: z.coerce.number().int().positive().max(24 * 60).default(30),
  EXPECTED_PAYMENT_AMOUNT: z.coerce.number().positive().default(150),
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
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().regex(/^v\d+\.\d+$/).default('v26.0'),
  ),
  EXPECTED_BENEFICIARY: optionalString,
  EXPECTED_ACCOUNT_LAST4: optionalLast4,
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
