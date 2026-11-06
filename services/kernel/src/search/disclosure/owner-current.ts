import { isDeepStrictEqual } from 'node:util';
import type {
  DiscoveryOwnerKind,
  DiscoveryOwnerMetadataSummary,
  DiscoveryOwnerRegistry,
  DiscoveryReadContext,
} from '../discovery.ts';

/**
 * Re-read owner current rows after nested hydration I/O. A withheld row drops the candidate;
 * any other change restarts so the page is one observation. Disclosure does not import HTTP
 * problems; Search HTTP maps `OwnerCurrentRestartRequired` to `search_restart_required`.
 *
 * Cost
 * - Touches: one `readCurrent` per owner kind for the accepted identities of that kind,
 *   after Account/Subject nested hydrations have completed.
 * - Bound: the same 100-identity batches the hydrator already uses; at most three kinds
 *   and 200 accepted candidates. No engine read.
 * - Growth check: `test/search/owner-current-disclosure.test.ts` covers public-to-private
 *   withdrawal, unchanged rows and a changed revision during nested hydration.
 */
export type OwnerCurrentAccepted<Candidate> = Readonly<{
  candidate: Candidate;
  kind: DiscoveryOwnerKind;
  id: string;
  value: DiscoveryOwnerMetadataSummary;
}>;

/** Owner rows changed during nested hydration; the page is not one observation. */
export class OwnerCurrentRestartRequired extends Error {
  readonly code = 'search_restart_required' as const;

  constructor() {
    super('search_restart_required');
    this.name = 'OwnerCurrentRestartRequired';
  }
}

export function ownerSummaryUnchanged(
  kind: DiscoveryOwnerKind,
  before: DiscoveryOwnerMetadataSummary,
  after: DiscoveryOwnerMetadataSummary | undefined,
): boolean {
  if (!after) return false;
  return isDeepStrictEqual(before, after);
}

export async function revalidateOwnerCurrentSummaries<Candidate>(
  registry: DiscoveryOwnerRegistry,
  accepted: readonly (OwnerCurrentAccepted<Candidate> | undefined)[],
  context: DiscoveryReadContext,
): Promise<readonly (OwnerCurrentAccepted<Candidate> | undefined)[]> {
  const idsByKind = new Map<DiscoveryOwnerKind, string[]>();
  for (const entry of accepted) {
    if (!entry) continue;
    const ids = idsByKind.get(entry.kind) ?? [];
    ids.push(entry.id);
    idsByKind.set(entry.kind, ids);
  }
  const current = new Map<string, DiscoveryOwnerMetadataSummary>();
  for (const [kind, ids] of idsByKind) {
    const adapter = registry.getOwnerAdapter(kind);
    const summaries = await adapter.readCurrent(ids, context);
    if (!summaries || typeof summaries.get !== 'function' || typeof summaries[Symbol.iterator] !== 'function')
      throw new TypeError('Owner discovery adapter returned an invalid current summary set');
    const requested = new Set(ids);
    for (const [id, summary] of summaries) {
      if (!requested.has(id)) throw new TypeError('Owner discovery adapter returned a foreign current summary');
      current.set(`${kind}:${id}`, summary);
    }
  }
  return accepted.map((entry) => {
    if (!entry) return undefined;
    const after = current.get(`${entry.kind}:${entry.id}`);
    if (!after) return undefined;
    if (!ownerSummaryUnchanged(entry.kind, entry.value, after)) throw new OwnerCurrentRestartRequired();
    return entry;
  });
}
