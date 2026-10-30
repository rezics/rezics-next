import type { FilterDocument, FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import type { KernelClock } from '../clock.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import type { Access, Actor } from '../request/access.ts';
import type { WorkClient } from '../work/client.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { CollectionSourceObservation } from './collection-source.ts';

/** Internal admitted meaning, never an HTTP DTO or an execution/disclosure certificate. */
export type PreparationDefinition = Readonly<{
  filter: FilterDocument;
  sort: 'id' | 'ordinal';
  release: Readonly<{ digest: string; value: FilterRelease }>;
}>;
export type PreparationLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  episodeId: string;
}>;
/** Exact retained native episode inputs. Data only; never admission or disclosure authority. */
export type MembersPreparationWorkDefinition = Readonly<{
  definition: PreparationDefinition;
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
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
  /** Read-only on the SAME live admitted Core client; null for an obsolete or unbound episode. */
  readWorkDefinition(
    tx: OperationalTransaction,
    locator: PreparationLocator,
  ): Promise<MembersPreparationWorkDefinition | null>;
}

/** Specification only. Construction succeeds; each independently exercisable operation fails literally. */
export function createMembersPreparation(_config: {
  pool: Pool;
  workClient: WorkClient;
  access: Access;
  clock?: KernelClock;
}): MembersPreparation {
  const service: MembersPreparation = {
    async reserve() {
      throw new ProblemError('dependency_unavailable');
    },
    async touch() {
      throw new ProblemError('dependency_unavailable');
    },
    async admitStep() {
      throw new ProblemError('dependency_unavailable');
    },
    async readWorkDefinition(tx, locator) {
      if (!hasLiveOperationalTransaction(tx)) return null;
      const resources = currentOperationalResources(tx);
      if (
        resources.pool !== _config.pool ||
        resources.workClient !== _config.workClient ||
        resources.mode !== 'work-step'
      )
        return null;
      if ((await service.admitStep(tx, locator)) !== true) return null;
      // The native reservation/episode producer is absent in this checkout. Do not infer a
      // definition or committed Source binding from the caller's locator, or open another client.
      throw new ProblemError('dependency_unavailable');
    },
  };
  return service;
}
