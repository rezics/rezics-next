import { logWorkerFault } from '@rezics/observability/log';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { applyLibraryFile } from './apply.ts';
import type { LibraryFileStore, ApplyIntent } from './file-store.ts';
import { ImportJobLeaseLost } from './job-store.ts';
import { withImportJobProgress } from './job-context.ts';
import { ReaderImportUnavailable, abortable, type ReaderLibraryImportStore } from './reader-import.ts';

/** Credentials stay in memory for this run; process loss needs an explicit fresh-authority resume. */
export class LibraryImportApplyWorker {
  private readonly running=new Map<string,{ controller: AbortController; task: Promise<void> }>();
  constructor(private readonly files: LibraryFileStore,private readonly imports: ReaderLibraryImportStore) {}
  schedule(request: Request,agent: string,id: string,intent: ApplyIntent,token: string) {
    const controller=new AbortController();
    const owned=new Request('http://main.internal/library-import-job',{ signal: controller.signal,
      headers: { authorization: request.headers.get('authorization') ?? '' } });
    const task=withWorkerTelemetry('main.library-import.apply',() => this.run(owned,agent,id,intent,token,controller));
    this.running.set(token,{ controller,task });
    void task.finally(() => this.running.delete(token));
  }
  async stop() {
    for (const { controller } of this.running.values()) controller.abort(new ImportJobLeaseLost('Import worker stopped'));
    await Promise.all([...this.running.values()].map(run => run.task));
  }
  private async run(request: Request,agent: string,id: string,intent: ApplyIntent,token: string,controller: AbortController) {
    let checking=false;
    const watchdog=setInterval(() => {
      if (checking) return;
      checking=true;
      void this.files.jobs.status(agent,id).then(job => {
        if (job?.state!=='pending' || job.lease_token!==token) controller.abort(new ImportJobLeaseLost('Import worker lease expired'));
      }).catch(error => logWorkerFault('main.library-import.apply',error)).finally(() => { checking=false; });
    },1000);
    try {
      while (!controller.signal.aborted) {
        await this.files.jobs.renew(agent,id,token);
        const result=await abortable(withImportJobProgress(() => this.files.jobs.progress(agent,id,token),
          () => applyLibraryFile(this.files,this.imports,request,agent,id,intent,token)),controller.signal);
        if (result.completed===result.total) { await this.files.jobs.finish(agent,id,token,'completed');return; }
        if (result.state!=='pending') return;
        await abortable(new Promise<void>(resolve => setTimeout(resolve,1000)),controller.signal);
      }
    } catch (error) {
      const stalled=error instanceof ImportJobLeaseLost;
      await this.files.jobs.finish(agent,id,token,stalled ? 'stalled' : 'failed',stalled ? 'worker-stopped'
        : error instanceof ReaderImportUnavailable ? 'owner-refused' : 'apply-failed').catch(fault => logWorkerFault('main.library-import.apply',fault));
      if (!stalled) logWorkerFault('main.library-import.apply',error);
    } finally { clearInterval(watchdog); }
  }
}
const workers=new WeakMap<LibraryFileStore,WeakMap<ReaderLibraryImportStore,LibraryImportApplyWorker>>();
export function getLibraryImportApplyWorker(files: LibraryFileStore,imports: ReaderLibraryImportStore) {
  let byStore=workers.get(files);
  if (!byStore) { byStore=new WeakMap();workers.set(files,byStore); }
  let worker=byStore.get(imports);
  if (!worker) { worker=new LibraryImportApplyWorker(files,imports);byStore.set(imports,worker); }
  return worker;
}
