import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Observe caller refusals without changing their inputs, assertions or limits. */
export function callerEvidence(caller: 'phrase-query' | 'projection-backfill') {
  const root = resolve(import.meta.dir, '../../..');
  const run = Bun.env.REZICS_QA_RUN_ID;
  if (!run) throw new Error('Caller evidence requires isolated QA');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const started = performance.now();
  const path = resolve(root, `.temp/realm-browse-caller-${caller}-${run}.jsonl`);
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const snapshot = () => ({ observedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started, load: readFileSync('/proc/loadavg', 'utf8').trim() });
  const save = (entry: Record<string, unknown>) => appendFileSync(path,
    JSON.stringify({ caller, run, source, ...entry }) + '\n');
  const failure = (error: unknown) => ({ name: error instanceof Error ? error.name : typeof error,
    class: error instanceof Error ? error.constructor.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined });
  save({ event: 'case.started', ...snapshot() });
  return {
    mark(event: string, input: unknown = null) { save({ event, input, ...snapshot() }); },
    async phase<T>(phase: string, input: unknown, action: () => Promise<T>): Promise<T> {
      save({ event: 'phase.started', phase, input, ...snapshot() });
      const before = performance.now();
      try {
        const answer = await action();
        save({ event: 'phase.answered', phase, input, answer,
          durationMs: performance.now() - before, ...snapshot() });
        return answer;
      } catch (error) {
        save({ event: 'phase.refused', phase, input, error: failure(error),
          durationMs: performance.now() - before, ...snapshot() });
        throw error;
      }
    },
    async read(request: Request, action: () => Promise<Response>): Promise<Response> {
      const input = { method: request.method, url: request.url,
        headers: Object.fromEntries([...request.headers].filter(([name]) =>
          !['authorization', 'cookie', 'x-session-key'].includes(name))),
        body: await request.clone().text() };
      save({ event: 'request.started', input, ...snapshot() });
      const before = performance.now();
      try {
        const response = await action();
        const durationMs = performance.now() - before;
        const observed = snapshot();
        const answer = await response.clone().text();
        save({ event: 'request.answered', input, status: response.status, answer, durationMs, ...observed });
        return response;
      } catch (error) {
        save({ event: 'request.refused', input, error: failure(error),
          durationMs: performance.now() - before, ...snapshot() });
        throw error;
      }
    },
  };
}
