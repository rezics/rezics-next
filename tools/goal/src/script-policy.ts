import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, resolve } from 'node:path';
import { readLocalFile } from './local-settings.ts';
import { defaultPolicy, readControlPolicy, type ControlPolicy } from './policy.ts';

// Standalone scripts can run from a newer source checkout against an older target without runtime composition.
const policies = new AsyncLocalStorage<ControlPolicy>();
export const scriptPolicy = (): ControlPolicy => policies.getStore() ?? defaultPolicy;
export function withScriptPolicy<T>(policy: ControlPolicy, run: () => T): T {
  return policies.run(policy, run);
}

/** Read only policy here; the release's config smoke still validates the complete candidate configuration. */
export function readScriptPolicy(main: string, env = process.env): ControlPolicy {
  const file = resolve(process.cwd(), env.GOAL_LOCAL_CONFIG ?? join(main, '.temp/goal/local.json'));
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: main, encoding: 'utf8', timeout: defaultPolicy.nativeCommands.commandTimeoutMs, maxBuffer: defaultPolicy.nativeCommands.commandBufferBytes });
  if (tracked.status === 0) throw new Error('local settings must be untracked');
  if (tracked.error) throw tracked.error;
  const local = readLocalFile(file);
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('local settings must be an object');
  return readControlPolicy((local as { policy?: unknown }).policy);
}
