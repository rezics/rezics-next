import { Elysia } from 'elysia';
import { logWorkerFault } from '@rezics/observability/log';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { workRead, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import type { RealmDirectoryIndex } from './index.ts';
import { REALM_DIRECTORY_COST } from './contract.ts';

/** Advances one durable, bounded step. The published generation stays readable
 * through a delayed graph call, a failed preparation or a Main restart. */
export class RealmDirectoryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly deps: MainWorkDependencies) {}

  async tick(): Promise<boolean> {
    const index = this.deps.access.realmDirectory;
    if (!index) throw new WorkReadUnavailable('Realm directory index is unavailable');
    return workRead(this.deps, new Request('http://main.internal/realm-directory-refresh', { method: 'POST' }),
      {}, session => index.refresh(session));
  }

  start(): void {
    if (this.timer) return;
    if (this.deps.access.realmDirectory?.closed) return;
    this.timer = setInterval(() => this.nudge(), REALM_DIRECTORY_COST.refreshIntervalMs);
    this.timer.unref();
    this.nudge();
  }

  /** A nudge never executes a rebuild on the request's stack or budget. Every
   * follow-up is another bounded step; a cold projection need not spend one
   * full scheduler interval between its clear and source phases. */
  nudge(): void {
    if (!this.timer) { this.start(); return; }
    if (this.deps.access.realmDirectory?.closed) { this.clearTimers(); return; }
    if (this.running || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      if (this.deps.access.realmDirectory?.closed) { this.clearTimers(); return; }
      let incomplete = false;
      fusekiReadBudget.exit(() => {
        this.running = this.tick().then(complete => { incomplete = !complete; }).catch(error => {
          if (this.deps.access.realmDirectory?.closed) { this.clearTimers(); return; }
          if (!(error instanceof WorkReadMoved || error instanceof WorkReadUnavailable)) {
            logWorkerFault('main.realm-directory.refresh', error);
          }
        }).finally(() => {
          this.running = undefined;
          if (this.deps.access.realmDirectory?.closed) this.clearTimers();
          else if (incomplete && this.timer) this.nudge();
        });
      });
    }, 0);
    this.scheduled.unref();
  }

  private clearTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.timer = undefined;
    this.scheduled = undefined;
  }

  async stop(): Promise<void> {
    this.clearTimers();
    await this.running;
  }
}

const workers = new WeakMap<RealmDirectoryIndex, RealmDirectoryWorker>();

/** Route-owned lifecycle also covers embedded Main.handle() compositions.
 * Request hooks are global in Elysia, so Query and Discover share this worker:
 * https://elysiajs.com/essential/life-cycle#request
 * Pools closed by embedded hosts stop their unref'd scheduler on its next tick. */
export function realmDirectoryLifecycle(deps: MainWorkDependencies) {
  const index = deps.access?.realmDirectory;
  const lifecycle = new Elysia({ name: 'realm-directory-refresh' });
  if (!index) return lifecycle;
  let worker = workers.get(index);
  if (!worker) {
    worker = new RealmDirectoryWorker(deps);
    workers.set(index, worker);
  }
  const shared = worker;
  index.setRefreshNudge(() => shared.nudge());
  return lifecycle.setup(() => shared.start())
    .request(() => { shared.start(); })
    .cleanup(() => shared.stop());
}
