export function workerTestEnv(): Record<string, string>;
export function workerTestEnv(overrides: Record<string, string>): Record<string, string>;
export function workerTestEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined>;
export function workerTestEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  // A module that adds a required worker variable adds its fixture here in the same task.
  return {
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 41).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 42).toString('base64url')}`,
    KERNEL_RECEIPT_KEYS: `1:${Buffer.alloc(32, 17).toString('base64url')}`,
    KERNEL_RATING_COUNTER_SECRET: Buffer.alloc(32, 43).toString('base64url'),
    AUTH_ISSUER: 'https://auth.worker.test',
    AUTH_AUDIENCE: 'https://kernel.worker.test',
    AUTH_JWKS_URL: 'https://auth.worker.test/.well-known/jwks.json',
    CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    CONTENT_R2_BUCKET: 'content-media',
    CONTENT_R2_ACCESS_KEY_ID: 'worker-fixture-access',
    CONTENT_R2_SECRET_ACCESS_KEY: 'worker-fixture-secret',
    CONTENT_SOURCE_HOSTS: 'images.example.org',
    KERNEL_AUTH_CONSENT_URL: 'https://consent.worker.test/internal/v1/consents:read',
    CF_ACCESS_CLIENT_ID: 'worker-fixture-client',
    CF_ACCESS_CLIENT_SECRET: 'worker-fixture-client-secret',
    ...overrides,
  };
}
