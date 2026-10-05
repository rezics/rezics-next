export const refreshResources = ['account', 'main', 'main-relay'] as const;
export type RefreshResource = typeof refreshResources[number];
export type RefreshStep = 'build-image' | 'rehearse-migrations' | 'stop-writers' | 'prepare-storage' | 'align-model'
  | 'restart-resources' | 'wait-ready' | 'approve-zones' | 'record-success';

export const appHostRestartInstruction = 'In the main checkout, run task dev:stop, then task dev, then retry task dev:refresh';

export class AppHostResourceLost extends Error {
  constructor(resource: string, operation: string) {
    super(`AppHost resource ${resource} is lost (${operation}). ${appHostRestartInstruction}`);
  }
}

export interface OfficialZoneApproval { slug: string; digest: string; approvedDigest: string | null }

export interface RefreshInputs {
  revision: string;
  previousRevision?: string;
  imagePresent: boolean;
  storageChanged: boolean;
  pendingMigrations: readonly string[];
  modelCurrent: boolean;
  unhealthyResources: readonly string[];
  environmentChanges: readonly string[];
  appHostChanged: boolean;
  lostResources: readonly string[];
  zoneApprovals: readonly OfficialZoneApproval[];
}

/** A checkpoint is evidence of a completed refresh, never a substitute for live
 * storage, migration, model and resource checks. */
export function refreshPlan(input: RefreshInputs): { steps: RefreshStep[]; blockers: string[] } {
  const blockers: string[] = [];
  if (input.environmentChanges.length) blockers.push(
    `Generated stack environment would change (${input.environmentChanges.join(', ')}). ${appHostRestartInstruction}`,
  );
  if (input.appHostChanged) blockers.push(
    `AppHost topology changed. ${appHostRestartInstruction}`,
  );
  if (input.lostResources.length) blockers.push(
    `AppHost restart required for lost resources: ${input.lostResources.join(', ')}. ${appHostRestartInstruction}`,
  );
  const prepare = input.previousRevision !== input.revision || !input.imagePresent
    || input.storageChanged || input.pendingMigrations.length > 0;
  const restart = prepare || !input.modelCurrent || input.unhealthyResources.length > 0;
  const steps: RefreshStep[] = [];
  if (!input.imagePresent) steps.push('build-image');
  if (input.pendingMigrations.length) steps.push('rehearse-migrations');
  if (restart) steps.push('stop-writers');
  if (prepare) steps.push('prepare-storage');
  if (prepare || !input.modelCurrent) steps.push('align-model');
  if (restart) steps.push('restart-resources', 'wait-ready');
  if (!restart && input.zoneApprovals.length) steps.push('wait-ready');
  if (restart || input.zoneApprovals.length) steps.push('approve-zones');
  if (restart || input.zoneApprovals.length) steps.push('record-success');
  return { steps, blockers };
}

/** Report names only: configuration values include credentials. */
export function changedEnvironment(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(name => before[name] !== after[name]).sort();
}

export function assertRefreshCheckout(worktree: boolean, branch: string, dirty: boolean): void {
  if (worktree) throw new Error('dev:refresh runs only in the main checkout, never in a worktree');
  if (branch !== 'main' || dirty) throw new Error('dev:refresh requires committed main with no tracked edits');
}

export interface RefreshActions {
  buildImage(): Promise<void>;
  rehearseMigrations(): Promise<void>;
  stopWriters(): Promise<void>;
  prepareStorage(): Promise<void>;
  alignModel(): Promise<void>;
  restartResources(): Promise<void>;
  waitReady(): Promise<void>;
  approveZones(): Promise<void>;
  stopAppHost(): Promise<void>;
  recordSuccess(): Promise<void>;
}

/** Maintenance failures remain stopped for a retry. A lost orchestration
 * resource instead shuts down this AppHost, avoiding partially stopped writers. */
export async function executeRefresh(plan: ReturnType<typeof refreshPlan>, actions: RefreshActions): Promise<void> {
  if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
  const operations: Record<RefreshStep, () => Promise<void>> = {
    'build-image': () => actions.buildImage(),
    'rehearse-migrations': () => actions.rehearseMigrations(),
    'stop-writers': () => actions.stopWriters(),
    'prepare-storage': () => actions.prepareStorage(),
    'align-model': () => actions.alignModel(),
    'restart-resources': () => actions.restartResources(),
    'wait-ready': () => actions.waitReady(),
    'approve-zones': () => actions.approveZones(),
    'record-success': () => actions.recordSuccess(),
  };
  try {
    for (const step of plan.steps) await operations[step]();
  } catch (error) {
    if (error instanceof AppHostResourceLost) {
      try { await actions.stopAppHost(); }
      catch {
        throw new Error(`${error.message}. Automatic AppHost shutdown failed; task dev:stop must succeed before restarting`, { cause: error });
      }
      throw new Error(`${error.message}. This AppHost was stopped; data volumes were retained`, { cause: error });
    }
    throw error;
  }
}
