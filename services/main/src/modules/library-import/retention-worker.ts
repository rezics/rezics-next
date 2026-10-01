import type { Pool } from 'pg';
import { expireLibraryUploads, eraseLibraryImportsForPrincipals } from './privacy.ts';

/** A minute poll drains expired uploads in bounded batches. */
export class LibraryImportRetentionWorker {
  private readonly controller = new AbortController();
  private task: Promise<void> | undefined;
  constructor(private readonly content: Pool, private readonly access: Pool) {}
  start() { this.task = this.run(); }
  async stop() { this.controller.abort();await this.task; }
  async poll() {
    while (await expireLibraryUploads(this.content) === 10) { if (this.controller.signal.aborted) return; }
    let after = '';
    while (!this.controller.signal.aborted) {
      const inactive = (await this.access.query<{ id: string }>(`SELECT o.principal_id AS id FROM access.outbox o JOIN access.principal p ON p.id=o.principal_id
        WHERE o.kind='account.deletion_fenced' AND NOT p.active AND o.principal_id::text>$1
        ORDER BY o.principal_id LIMIT 100`,[after])).rows.map(row => row.id);
      if (inactive.length) await eraseLibraryImportsForPrincipals(this.content,this.access,inactive);
      if (inactive.length < 100) break;
      after = inactive.at(-1)!;
    }
  }
  private async run() {
    while (!this.controller.signal.aborted) {
      try { await this.poll(); } catch (error) { console.error('Library import retention:',error); }
      if (this.controller.signal.aborted) break;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer);this.controller.signal.removeEventListener('abort',finish);resolve(); };
        const timer = setTimeout(finish,60_000);this.controller.signal.addEventListener('abort',finish,{ once: true });
      });
    }
  }
}
