/** Apply accepts the job and returns before rows finish. Callers read status until it leaves pending. */
export const LIBRARY_IMPORT_APPLY_POLL_MS = 30_000;

export interface LibraryImportApplyProgress {
  total: number;
  completed: number;
  issues: number;
  pending: boolean;
  state: string;
  reason: string | null;
  receipt?: string;
}

export async function pollLibraryImportApply(
  read: () => Promise<Response>,
  options: { started?: Response | Promise<Response>; deadlineMs?: number } = {},
): Promise<LibraryImportApplyProgress> {
  const started = options.started === undefined ? undefined : await options.started;
  if (started && started.status !== 200 && started.status !== 202) {
    throw new Error(`${started.status}: ${await started.text()}`);
  }
  const deadline = Date.now() + (options.deadlineMs ?? LIBRARY_IMPORT_APPLY_POLL_MS);
  let latest: LibraryImportApplyProgress | undefined;
  for (;;) {
    const response = await read();
    if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`);
    latest = await response.json() as LibraryImportApplyProgress;
    if (!latest.pending) return latest;
    if (Date.now() >= deadline) throw new Error(`Library import stayed pending: ${JSON.stringify(latest)}`);
    await Bun.sleep(200);
  }
}
