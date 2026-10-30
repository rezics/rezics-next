import type { DiscoveryHit } from './discovery.ts';
import type { SearchSortValue } from './cursor.ts';
import type { DiscoveryCandidate } from './discovery-query.ts';
import { SearchUnavailableError } from './opensearch.ts';

/** Request-local consumed head. This is not an observation, a count certificate or a public response. */
export class DiscoveryFrontier {
  readonly hits: DiscoveryHit[] = [];
  readonly witnesses = new Map<string, number>();
  after: readonly SearchSortValue[] | undefined;
  exhausted = false;
  private readonly emitted = new Set<string>();
  private rounds = 0;
  private requested = 0;

  constructor(
    readonly limit: number,
    after?: readonly SearchSortValue[],
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid discovery page limit');
    this.after = after;
  }

  /** One allowance across all kinds. Ask for lookahead even when just one slot remains. */
  nextSize(): number {
    if (this.exhausted || this.rounds === 3 || this.hits.length === this.limit) return 0;
    this.rounds++;
    return (this.requested = Math.min(200, 2 * (this.limit - this.hits.length) + 1));
  }

  consume(candidates: readonly DiscoveryCandidate[], current: ReadonlyMap<DiscoveryCandidate, DiscoveryHit>): void {
    if (this.requested === 0 || candidates.length > this.requested)
      throw new SearchUnavailableError('Discovery enumeration exceeded its shared allowance');
    let consumed = 0;
    for (const candidate of candidates) {
      const identity = `${candidate.key.kind}:${candidate.key.id}`;
      const hit = this.emitted.has(identity) ? undefined : current.get(candidate);
      // A valid lookahead remains unconsumed; rejected heads after the last visible hit may advance.
      if (this.hits.length === this.limit && hit) break;
      this.after = candidate.sort;
      consumed++;
      if (hit) {
        if (
          hit.key.owner !== candidate.key.owner ||
          hit.key.kind !== candidate.key.kind ||
          hit.key.route !== candidate.key.route ||
          hit.key.id !== candidate.key.id ||
          hit.summary.value.id !== candidate.key.id
        )
          throw new SearchUnavailableError('Discovery current projection disagrees with its native head');
        this.emitted.add(identity);
        this.hits.push(hit);
        this.witnesses.set(hit.key.kind, (this.witnesses.get(hit.key.kind) ?? 0) + 1);
      }
    }
    this.exhausted = candidates.length < this.requested && consumed === candidates.length;
    this.requested = 0;
  }

  /** Partial output without proved exhaustion is readiness, never a successful empty cursor chain. */
  requireUsefulPage(): void {
    if (this.requested !== 0 || (!this.exhausted && this.hits.length < this.limit))
      throw new SearchUnavailableError('Discovery needs preparation to fill or exhaust the page');
  }
}
