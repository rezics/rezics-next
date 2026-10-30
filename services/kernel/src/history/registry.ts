import { createHash } from 'node:crypto';
import type { CommandTransaction } from '../command/command.ts';
import type { AccountReference, HistoryLocator } from './locator.ts';
import { historyArtifact, type HistoryArtifactType } from './contracts.ts';

export type HistoryBarrier = Readonly<{ accountId: string; accountRoute: number; version: number; at: string }>;
export type HistoryArtifact = Readonly<{
  partition: number;
  locator: HistoryLocator;
  accounts: readonly AccountReference[];
}>;
export type HistoryReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; gap: string }>;
export type HistoryOwner = Readonly<{
  name: string;
  artifactType: HistoryArtifactType;
  version: 1;
  /** Reads exact native consumer obligations in the source transaction. Never a workflow-status test. */
  readiness(tx: CommandTransaction, artifact: HistoryArtifact, barrier: HistoryBarrier): Promise<HistoryReadiness>;
}>;

/** Required producer families, independently of which ones happen to have artifacts today. */
export const HISTORY_PRODUCER_FAMILIES = Object.freeze([
  'access', 'commerce', 'community', 'content', 'library', 'rating', 'semantic', 'zones', 'imports',
] as const);
export type HistoryProducerFamily = (typeof HISTORY_PRODUCER_FAMILIES)[number];

/** A registration is an owner declaration of conversion, never an absence proof. Local sealed
 * prefixes, native consumers and Auth completion are checked separately by the receiving runtime. */
export class HistoryRegistry {
  private readonly owners = new Map<string, HistoryOwner>();
  private readonly coverage = new Map<string, ReadonlySet<HistoryArtifactType>>();
  private closed = false;

  registerOwner(owner: HistoryOwner): void {
    if (this.closed || !/^[a-z][a-z0-9_.-]{0,95}$/.test(owner.name)) throw new TypeError('Invalid history owner');
    historyArtifact(owner.artifactType, owner.version);
    const key = `${owner.artifactType}:${owner.name}`;
    if (this.owners.has(key)) throw new TypeError('Duplicate history owner');
    this.owners.set(key, Object.freeze({ ...owner }));
  }

  registerCoverage(family: HistoryProducerFamily, types: readonly HistoryArtifactType[]): void {
    if (this.closed || !HISTORY_PRODUCER_FAMILIES.includes(family) || this.coverage.has(family))
      throw new TypeError('Invalid history producer coverage');
    for (const type of types) historyArtifact(type);
    this.coverage.set(family, new Set(types));
  }

  owner(type: HistoryArtifactType, name: string): HistoryOwner | undefined {
    return this.owners.get(`${type}:${name}`);
  }

  gaps(): readonly string[] {
    return HISTORY_PRODUCER_FAMILIES.flatMap((family) => this.familyGaps(family));
  }

  familyGaps(family: HistoryProducerFamily): readonly string[] {
    if (!HISTORY_PRODUCER_FAMILIES.includes(family)) throw new TypeError('Unknown history producer family');
    return (
      (['command-receipt/v1', 'outbox-event/v1', 'durable-work/v1'] as const)
        .filter((type) => !this.coverage.get(family)?.has(type))
        .map((type) => `${family}:${type}`)
    );
  }

  /** Stable across registration order; a changed owner/version/coverage invalidates old progress. */
  digest(): string {
    return createHash('sha256').update(JSON.stringify({
      owners: [...this.owners.values()].map(({ name, artifactType, version }) =>
        [artifactType, name, version]).sort(),
      coverage: [...this.coverage].map(([family, types]) => [family, [...types].sort()]).sort(),
    })).digest('hex');
  }

  seal(): void { this.closed = true; }
}
