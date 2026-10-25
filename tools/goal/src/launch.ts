import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import defaults from '../defaults.json';
import { processIdentity } from './process.ts';
import type { Attempt, Pool, Profile, Settings, Task } from './types.ts';
import type { WorkerStore } from './store.ts';

export type LaunchOptions = { profile: Profile; pool: Pool; worktree: string; prompt: string; logPath: string; readOnly?: boolean; research?: boolean; codex?: Settings['codex'] };
export function launchCommand(options: LaunchOptions): [string, string[]] {
  const { profile, pool, worktree, prompt } = options;
  if (!['codex', 'grok', 'cursor'].includes(profile.cli)) throw new Error('unsupported worker CLI');
  if (pool.cli !== profile.cli) throw new Error('profile and pool CLI disagree');
  if (profile.cli === 'grok') return [pool.command, ['-m', profile.model, '--reasoning-effort', profile.effort,
    '--permission-mode', 'bypassPermissions', '--no-subagents', '--output-format', 'json', '--cwd', worktree, `--single=${prompt}`]];
  if (profile.cli === 'cursor') return [pool.command, ['-p', '--model', `${profile.model}-${profile.effort}`, '--force', '--trust',
    '--sandbox', 'disabled', '--output-format', 'json', '--workspace', worktree, '--', prompt]];
  const codex = options.codex ?? defaults.codex;
  const mcp: string[] = [];
  const config = join(pool.configDirectory, 'config.toml');
  if (existsSync(config)) {
    const servers = (Bun.TOML.parse(readFileSync(config, 'utf8')) as { mcp_servers?: Record<string, unknown> }).mcp_servers;
    // A dotted `-c` path keeps the quotes in the key, defining a new server without a transport; an inline table merges.
    const disabled = Object.keys(servers ?? {}).map(name => `${JSON.stringify(name)}={enabled=false}`);
    if (disabled.length) mcp.push('-c', `mcp_servers={${disabled.join(',')}}`);
  }
  return [pool.command, ['exec', '--json', '-m', profile.model, '-c', `model_reasoning_effort=${profile.effort}`,
    '-c', `model_auto_compact_token_limit=${profile.model.includes('luna') ? codex.compactTokens.luna : codex.compactTokens.sol}`,
    '-c', `tool_output_token_limit=${codex.toolOutputTokens}`, '-c', `service_tier=${JSON.stringify(codex.serviceTier)}`,
    ...(profile.model.includes('sol') ? ['-c', `model_context_window=${codex.solContextWindow}`] : []),
    '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', ...mcp,
    ...(options.readOnly ? ['-s', 'read-only', '-c', 'approval_policy="never"'] : ['--dangerously-bypass-approvals-and-sandbox']),
    ...(options.research ? ['-c', 'web_search="live"'] : []), ...(!options.readOnly ? ['--output-schema', join(import.meta.dir, '../worker-result.schema.json')] : []), '-C', worktree, '--', prompt]];
}
export function workerEnvironment(pool: Pool, extra: NodeJS.ProcessEnv = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of Object.keys(env)) if (key.startsWith('GOAL_')) delete env[key];
  for (const key of ['GOAL_MANAGER', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_HOME', 'GROK_HOME', 'GROK_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'CLAUDE_CONFIG_DIR']) delete env[key];
  const key = pool.cli === 'codex' ? 'CODEX_HOME' : pool.cli === 'grok' ? 'GROK_HOME' : pool.cli === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CURSOR_CONFIG_DIR';
  return { ...env, ...extra, [key]: pool.configDirectory };
}
export function workerPrompt(task: Task, evidence: string | undefined, consultation: string | undefined, resolutionFiles: readonly string[], mainCheckout: string): string {
  return [
    `Work only in ${task.worktree}, on branch ${task.branch}. Read and follow its AGENTS.md.`,
    `The main checkout ${mainCheckout} is read-only: never write there. Write files only by paths inside ${task.worktree}.`,
    'Work until every acceptance condition holds. Do not send progress reports. Commit the completed changes on this branch.',
    'Do not rebase, merge, change acceptance tests, or expand the declared scope.',
    'Finish with one JSON object matching this exit schema. A blocker is a fact about your attempt; explain the concrete conflict or tool failure in its detail.',
    readFileSync(join(import.meta.dir, '../worker-result.schema.json'), 'utf8'),
    task.brief.kind === 'bulk-text' ? 'Write the text yourself. Do not use translation services, translation scripts, or character mapping tables.' : '',
    'The task contract follows:', task.brief.markdown,
    'A failure outside your declared paths is not your blocker: when your acceptance command passes, report success and name any such failure in your summary.',
    "Never stop or remove containers, databases or processes you did not start in this attempt, and never prune Docker: other workers' checks run beside yours.",
    evidence ? `Continue from this evidence bundle:\n${evidence}` : '',
    consultation ? `Read-only consultation:\n${consultation}` : '',
    resolutionFiles.length ? `The control plane has already started a rebase onto current main in this worktree. Conflicted files: ${resolutionFiles.join(', ')}. Resolve and stage them, then run \`git rebase --continue\` until the rebase completes. Do not start another rebase.` : '',
  ].filter(Boolean).join('\n\n');
}
export type RunningWorker = { child: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; attempt: Attempt };
export async function launch(store: WorkerStore, task: Task, attempt: Attempt, pool: Pool, prompt: string, codex?: Settings['codex']): Promise<RunningWorker> {
  store.assertCurrent(attempt);
  mkdirSync(dirname(attempt.logPath), { recursive: true });
  const out = openSync(attempt.logPath, 'w'), err = openSync(`${attempt.logPath}.err`, 'w');
  const [program, args] = launchCommand({ profile: attempt.profile, pool, worktree: task.worktree, prompt, logPath: attempt.logPath, ...(codex ? { codex } : {}),
    ...(task.taskClass === 'research' ? { readOnly: true, research: true } : {}) });
  let child: ChildProcess;
  try {
    // Publication and spawn share the fence's write lock. A retry cannot miss a just-started process.
    child = store.write(attempt, () => {
      const driver = processIdentity();
      if (!driver) throw new Error('Cannot identify driver process');
      const started = spawn(program, args, { cwd: task.worktree, detached: true, stdio: ['ignore', out, err], env: workerEnvironment(pool, {
        GOAL_TASK_ID: task.id, GOAL_ATTEMPT: String(attempt.attempt),
      }) });
      const identity = started.pid ? processIdentity(started.pid) : null;
      store.updateAttempt(attempt, current => { current.driver = driver; current.process = identity; current.state = 'running'; });
      store.updateTask(attempt, current => { current.state = 'running'; });
      return started;
    });
  } finally { closeSync(out); closeSync(err); }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  // Register exit listeners before awaiting spawn; even a very short fake CLI is observable.
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const saved = store.attempt(attempt);
  if (!saved.process && child.pid) store.updateAttempt(attempt, current => { current.process = processIdentity(child.pid!); });
  return { child, exited, attempt: store.attempt(attempt) };
}
