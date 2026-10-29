import type { FilterDocument, FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { OperationalTransaction } from '../command/operational.ts';
import type { Access, Actor } from '../request/access.ts';
import type { WorkClient } from '../work/client.ts';

/** Internal admitted meaning, never an HTTP DTO or an execution/disclosure certificate. */
export type PreparationDefinition = Readonly<{
  filter: FilterDocument;
  sort: 'id';
  release: Readonly<{ digest: string; value: FilterRelease }>;
}>;
export type PreparationLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  episodeId: string;
}>;
export type PreparationIntent = Readonly<{
  queue: 'workflows';
  workflowName: 'library.membersPreparation';
  workflowId: string;
  input: Readonly<{
    accounts: readonly [string];
    route: number;
    episodes: readonly Readonly<{ collectionId: string; episodeId: string }>[];
    cleanup: readonly Readonly<{ collectionId: string; episodeId: string }>[];
  }>;
}>;
export type PreparingEpisode = Readonly<{
  state: 'preparing';
  locator: PreparationLocator;
  workflowId: string;
}>;
export interface MembersPreparation {
  /** One Collection's distinct definitions, bounded by the common-page read authority. */
  reserve(
    actor: Actor,
    collectionId: string,
    definitions: readonly PreparationDefinition[],
    options?: { deadline?: number },
  ): Promise<Readonly<{ episodes: readonly PreparingEpisode[]; intent: PreparationIntent | null }>>;
  /** Only the admitted reader calls this after an actual read; duplicate preparation does not touch LRU. */
  touch(actor: Actor, locator: PreparationLocator, options?: { deadline?: number }): Promise<boolean>;
  /** Called inside the registered step's fenced operational transaction; locks survive to its commit. */
  admitStep(tx: OperationalTransaction, locator: PreparationLocator): Promise<boolean>;
}

/** Specification only. Construction succeeds; each independently exercisable operation fails literally. */
export function createMembersPreparation(_config: {
  pool: Pool;
  workClient: WorkClient;
  access: Access;
  clock?: KernelClock;
}): MembersPreparation {
  return {
    async reserve() {
      throw new Error('Unimplemented: Library members preparation reserve');
    },
    async touch() {
      throw new Error('Unimplemented: Library members preparation touch');
    },
    async admitStep() {
      throw new Error('Unimplemented: Library members preparation admitStep');
    },
  };
}
