import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { workRead, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';

/** Advances one durable, bounded step. The published generation stays readable
 * through a delayed graph call, a failed preparation or a Main restart. */
export class RealmDirectoryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
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
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.tick().then(() => {}).catch(error => {
        if (!(error instanceof WorkReadMoved || error instanceof WorkReadUnavailable)) {
          console.error('Realm directory refresh failed', error);
        }
      })
        .finally(() => { this.running = undefined; });
    }, 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
