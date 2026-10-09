import type { SeedEndpoints } from './api.ts';
import { pollUntilDeadline } from '../../qa/readiness.ts';

// Aspire's executable health can precede the Account HTTP listener. Probe
// only reads, before any fixture mutation, under one shared startup deadline.
export async function waitForSeedApis(endpoints: SeedEndpoints,
  options: { fetch?: (url: string, init: RequestInit) => Promise<Response>;
    timeoutMs?: number; retryMs?: number } = {}): Promise<void> {
  const transport = options.fetch ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const retryMs = options.retryMs ?? 500;
  await Promise.all([
    `${endpoints.accountService ?? endpoints.account}/api/auth/get-session`,
    `${endpoints.main}/health/ready`,
    `${endpoints.mailpit}/api/v1/messages?limit=1`,
  ].map(async url => {
    const ready = await pollUntilDeadline(async remaining => {
      try {
        return await transport(url, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, remaining))),
        });
      } catch { return false; }
    }, deadline, retryMs);
    if (!ready) throw new Error(`Seed API did not become ready within the startup deadline: ${url}`);
  }));
}
