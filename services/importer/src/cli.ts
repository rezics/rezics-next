import { createImportCliApplication } from './cli-application.ts';
import { type ImportCliOptions, type ImportCliResult } from './cli-contract.ts';
import { bindImportCliProcess, createImportCliHost, writeImportCliProcessResult } from './cli-host.ts';

export type { ImportCliObserver, ImportCliOptions, ImportCliResult } from './cli-contract.ts';
export { createImportCliApplication } from './cli-application.ts';
export { createImportCliHost, bindImportCliProcess } from './cli-host.ts';

/** Parse and run one real importer acquisition without import-time work. */
export async function runImportCli(argv: readonly string[], options: ImportCliOptions = {}): Promise<ImportCliResult> {
  return createImportCliApplication(createImportCliHost(options)).run(argv, options);
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException('Interrupted', 'AbortError'));
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const host = bindImportCliProcess(controller.signal);
  const application = createImportCliApplication(host);
  void application
    .run(process.argv.slice(2), host.invocation)
    .then(writeImportCliProcessResult, () => {
      process.stderr.write('Import failed safely.\n');
      process.exitCode = 1;
    })
    .finally(() => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      host.attempt.abort();
    });
}
