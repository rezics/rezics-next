import type { SeedEndpoints } from './api.ts';

// Aspire's executable health can precede the Account HTTP listener. Probe
// only reads, before any fixture mutation, under one shared startup deadline.
export async function waitForSeedApis(endpoints: SeedEndpoints,
  options: { fetch?: (url: string, init: RequestInit) => Promise<Response>;
    timeoutMs?: number; retryMs?: number } = {}): Promise<void> {
  const transport = options.fetch ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  await Promise.all([
    `${endpoints.accountService ?? endpoints.account}/api/auth/get-session`,
    `${endpoints.main}/health/ready`,
    `${endpoints.mailpit}/api/v1/messages?limit=1`,
  ].map(async url => {
    while (Date.now() < deadline) {
      try {
        const response = await transport(url, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, deadline - Date.now()))),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* A starting listener can refuse connections. */ }
      const remaining = deadline - Date.now();
      if (remaining > 0) await Bun.sleep(Math.min(options.retryMs ?? 500, remaining));
    }
    throw new Error(`Seed API did not become ready within the startup deadline: ${url}`);
  }));
}
