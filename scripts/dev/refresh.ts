export const refreshResources = ['account', 'main', 'main-relay'] as const;
export type RefreshResource = typeof refreshResources[number];
export type RefreshStep = 'build-image' | 'stop-writers' | 'prepare-storage' | 'align-model'
  | 'restart-resources' | 'wait-ready' | 'record-success';

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
}

/** A checkpoint is evidence of a completed refresh, never a substitute for live
 * storage, migration, model and resource checks. */
export function refreshPlan(input: RefreshInputs): { steps: RefreshStep[]; blockers: string[] } {
  const blockers: string[] = [];
  if (input.environmentChanges.length) blockers.push(
    `Generated stack environment would change (${input.environmentChanges.join(', ')}); restart the AppHost with task dev before retrying task dev:refresh`,
  );
  if (input.appHostChanged) blockers.push(
    'AppHost topology changed; restart the AppHost with task dev before retrying task dev:refresh',
  );
  const prepare = input.previousRevision !== input.revision || !input.imagePresent
    || input.storageChanged || input.pendingMigrations.length > 0;
  const restart = prepare || !input.modelCurrent || input.unhealthyResources.length > 0;
  const steps: RefreshStep[] = [];
  if (!input.imagePresent) steps.push('build-image');
  if (restart) steps.push('stop-writers');
  if (prepare) steps.push('prepare-storage');
  if (prepare || !input.modelCurrent) steps.push('align-model');
  if (restart) steps.push('restart-resources', 'wait-ready', 'record-success');
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
  stopWriters(): Promise<void>;
  prepareStorage(): Promise<void>;
  alignModel(): Promise<void>;
  restartResources(): Promise<void>;
  waitReady(): Promise<void>;
  recordSuccess(): Promise<void>;
}

/** No success record or implicit restart after a failed maintenance step. A
 * retry re-inspects live state and completes the unfinished operations. */
export async function executeRefresh(plan: ReturnType<typeof refreshPlan>, actions: RefreshActions): Promise<void> {
  if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
  const operations: Record<RefreshStep, () => Promise<void>> = {
    'build-image': () => actions.buildImage(),
    'stop-writers': () => actions.stopWriters(),
    'prepare-storage': () => actions.prepareStorage(),
    'align-model': () => actions.alignModel(),
    'restart-resources': () => actions.restartResources(),
    'wait-ready': () => actions.waitReady(),
    'record-success': () => actions.recordSuccess(),
  };
  for (const step of plan.steps) await operations[step]();
}
