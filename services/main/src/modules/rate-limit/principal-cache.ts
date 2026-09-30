import { createHash } from 'node:crypto';
import type { VerifiedAccountAssertion } from '../account/verify-assertion.ts';
import type { PrincipalClass } from './budgets.ts';

interface Attribution { identity: string; principalClass: PrincipalClass; expiresAt: number }
interface Entry { expiresAt: number; principal: Promise<VerifiedAccountAssertion>; attribution?: Promise<Attribution> }
/** This caches budget attribution, never owner authorization. Every protected
 * handler still checks current Account/Access authority. Keys are token hashes;
 * storage and eviction are bounded, with no full-cache sweep on a request. */
export class PrincipalBudgetCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly maximum = 4096, private readonly now = Date.now) {}

  private entry(token: string, verify: () => Promise<VerifiedAccountAssertion>): Entry {
    const key = createHash('sha256').update(token).digest('hex');
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now()) return existing;
    this.entries.delete(key);
    if (this.entries.size >= this.maximum) this.entries.delete(this.entries.keys().next().value!);
    // Coalesce simultaneous first requests too. No attribution survives the
    // verified token's expiry (or the resource profile's 300-second ceiling).
    const entry: Entry = { expiresAt: this.now() + 300_000,
      principal: Promise.resolve(null as unknown as VerifiedAccountAssertion) };
    entry.principal = (async () => {
      try {
        const principal = await verify();
        entry.expiresAt = Math.min(entry.expiresAt, (principal.accountExpiresAt ?? this.now() / 1000) * 1000);
        return principal;
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }
    })();
    this.entries.set(key, entry);
    return entry;
  }

  verified(token: string, verify: () => Promise<VerifiedAccountAssertion>): Promise<VerifiedAccountAssertion> {
    return this.entry(token, verify).principal;
  }

  async resolve(token: string, verify: () => Promise<VerifiedAccountAssertion>,
    classify: (principal: VerifiedAccountAssertion) => Promise<PrincipalClass>): Promise<Attribution> {
    const entry = this.entry(token, verify);
    return entry.attribution ??= (async () => {
      const principal = await entry.principal;
      try {
        return { identity: JSON.stringify([principal.issuer, principal.subject]),
          principalClass: await classify(principal), expiresAt: entry.expiresAt };
      } catch (error) { entry.attribution = undefined; throw error; }
    })();
  }
}
