import type { Database } from 'bun:sqlite';
import type { AttemptFence, GateOutcomeSink, LandingRequest } from './contracts.ts';
import type { SharedInboxQueries } from './inbox-shared.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import type { SqliteLandingQueue } from './land.ts';
import type { ManagerServices, ManagerSpec } from './managers.ts';
import type { MergeTrain, TrainConfigurationReloader } from './merge-train.ts';

/** Composition belongs to the caller; this module never reads worker configuration or tables. */
export type IntegrationRuntime = {
  queue?: SqliteLandingQueue;
  train?: Pick<MergeTrain, 'runWaiting'>;
  inbox?: SqliteManagerInbox;
  /** Pure shared read API for authenticated managers and report consumers. */
  sharedInbox?: SharedInboxQueries;
  pump?(): Promise<void>;
  drain?(): Promise<void>;
  drainJobs?(): Promise<void>;
  /** Enqueue manager-owned accepted work through the durable landing queue. */
  managerLand?(task: string, manager: string): boolean;
  /** Start the existing controller train without running gates in the manager command process. */
  handoffTrain?(): Promise<void>;
  /** Reload the effective train settings between landings in a long-lived train process. */
  refreshTrainConfiguration?: TrainConfigurationReloader;
  hostSweepIntervalMs?: number;
  /** The published tools/goal object id this process loaded; a host retires when main publishes another one. */
  loadedCodeVersion?: string;
  /** Set once this process retires for newer tools/goal: from then on it starts no new attempt. */
  codeRetirement?: { retiring: boolean };
  hourlyEfficiencyReport?: { enabled: boolean; timeoutMs: number };
  recoverOrphans?(options?: { adoptRunning?: boolean }): Promise<void>;
  deliverReminders?(): number | Promise<number>;
  /** Periodic, bounded scan of current worker ownership that may wake an under-width Goal manager. */
  sweepWidth?(): Promise<void>;
  /** One backlog run; the host runs it in a single-flight `backlog dispatch` child process. */
  backlog?(): Promise<unknown>;
  /** One promotion step; returns at once when a promotion holds the lease or nothing changed. */
  promote?(): Promise<void>;
  verify?(): Promise<void>;
  evaluateFlow?(): void | Promise<void>;
  dispatchDailyStepAudit?(): void;
  db: Database;
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  managerSocket: string;
  supermanager?: string;
  fence: AttemptFence;
  sink: GateOutcomeSink;
  landing(task: string): LandingRequest;
  manager(goal: string, engine: 'codex' | 'claude', budget: number): ManagerSpec;
  managerServices: ManagerServices;
};
export type HostRequest = {
  command:
    | 'start'
    | 'renew'
    | 'stop'
    | 'complete'
    | 'decision'
    | 'turn-start'
    | 'turn-end'
    | 'outgoing-message'
    | 'register-supermanager';
  manager?: string;
  spec?: ManagerSpec;
  recipient?: string;
  summary?: string;
  sessionId?: string;
};
