/** Work-owned queue, intent and client vocabulary. Time and facts arrive as values. */

export const WORK_APPLICATION = 'rezics-kernel';
export const DBOS_SCHEMA = 'dbos';
export const LOCATOR_EFFECTS_QUEUE = 'locator-effects';

export const WORK_QUEUE_NAMES = [
  'governance',
  'effects',
  'locator-effects',
  'workflows',
  'delivery',
  'import',
  'maintenance',
] as const;

export type WorkQueueName = (typeof WORK_QUEUE_NAMES)[number];

export type WorkQueueOptions = Readonly<{
  workerConcurrency?: number;
  partitionConcurrency?: number;
}>;

export type WorkPool = object;

export type WorkQueryResult<T = Record<string, unknown>> = {
  readonly rows: readonly T[];
  readonly rowCount: number;
};

export type WorkQueryClient = {
  query<T = Record<string, unknown>>(
    queryTextOrConfig: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ): Promise<WorkQueryResult<T>>;
};

export type WorkSdkClient = object;

export type WorkIntent = Readonly<{
  queue: WorkQueueName;
  workflowName: string;
  workflowId: string;
  input: Readonly<{ accounts: readonly string[]; [locator: string]: unknown }>;
  arguments?: readonly unknown[];
  queuePartitionKey?: string;
  deduplicationID?: string;
  priority?: number;
  delaySeconds?: number;
}>;

export type WorkClock = () => Date;

export type WorkUnavailabilityReason = 'deadline' | 'overloaded' | 'contention' | 'fenced' | 'moved';

export type WorkAccountReference = Readonly<{
  accountRoute: number;
  accountId: string;
  roles: number;
}>;

export type WorkHistoryScope = Readonly<{
  artifactType: string;
  accounts: readonly WorkAccountReference[];
}>;

export type WorkScopedRequest = Readonly<{
  owner: string;
  intent: WorkIntent;
  scope: WorkHistoryScope;
}>;

export type WorkSelectedLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  episodeId: string;
}>;

export type WorkSelectedOutcome = Readonly<{
  kind: 'complete' | 'continue' | 'failure' | 'obsolete';
  version: string;
  continuation?: string;
}>;

export type WorkSelectedIdentity = Readonly<{
  workflowID: string;
  functionID: number;
  stepName: string;
  attemptGeneration: string;
  restoreGeneration: string;
  workflowName: string;
  queueName: string | null;
  creatorXid: string | null;
  serialization: string | null;
  inputs: string;
  stepArguments: string;
  deadline: number;
  schema: string;
}>;

export type WorkWriterState = Readonly<{
  workflowID: string;
  generation: string;
  restoreGeneration: string;
  closureID: string | null;
  closedAt: number | null;
}>;

export type WorkRetirementFence = Readonly<{
  workflowID: string;
  generation: string;
  closureID: string;
  closedAt: number;
}>;

export type WorkDispatchCost = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  engineRequests: number;
}>;

export type WorkAuthorization = Readonly<{ access: unknown; readConsent: unknown }>;

export type WorkService = { stop(): Promise<void> };

export type WorkHistoryRegistry = { seal(): void };

export type WorkRegisteredEffects = {
  enqueue(envelopes: readonly unknown[]): Promise<void>;
  admit?(client: WorkQueryClient, envelopes: readonly unknown[]): Promise<void>;
};

export type WorkEffect = Readonly<{
  name: string;
  types: string[];
  delivery?: 'native';
  run?: (event: unknown) => Promise<void>;
  admit?: (client: WorkQueryClient, event: unknown) => Promise<void>;
}>;
