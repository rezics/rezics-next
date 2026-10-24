import { type Engine, GROK_MODEL, cursorModel, isCodex, MODELS, type Task, engineOf, modelOf, type Ledger, type Attempt, programOf, launcherOf, isClaudeCode, type UsageLevel, engineEnv, TRANSPORT_ERRORS } from './types.ts';
import { loadSettings, settingsDirectory } from './config.ts';
import { join, resolve } from 'node:path';
import { stateDir, root, pidAlive, readLedger, git, regenerationOnlyFiles } from './ledger.ts';
import { existsSync, readFileSync, mkdirSync, openSync } from 'node:fs';
import { currentUsage, codexAccounts, describeAccount } from './usage.ts';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { type ChangedFile, isGeneratedOutput, outOfScope } from './briefs.ts';
import { handoverPrompt, prepareHandover, type WorkerHandover } from './handover.ts';
import { handoffResult } from './land.ts';
import { assertClaudeCapacity, assertPreviousClaudeExited, recordClaudeLaunch } from './claude-capacity.ts';

// Workers run in bypass permission mode, as the manager does, and accept no inbound session
// messages; the manager changes a worker's instructions only by stopping or resuming it.
export function launchCommand(options: { id: string; effort: string; session: string; prompt: string;
  resume: boolean; engine?: Engine; worktree?: string; lastMessage?: string }): [string, string[]] {
  const { id, effort, session, prompt, resume } = options;
  const engine = options.engine ?? 'claude';
  if (engine === 'sol') throw new Error('Resolve sol to its Codex account before launching');
  // A prompt may start with `---` (brief frontmatter) or `-`, so no engine may parse it as an option:
  // Grok's parser takes a dash-leading value only in `--single=<prompt>` form; the others take the prompt after `--`.
  if (engine === 'grok') {
    return ['grok', ['-m', GROK_MODEL, '--reasoning-effort', effort,
      '--permission-mode', 'bypassPermissions', '--no-subagents', '--output-format', 'json',
      '--cwd', options.worktree ?? '.', ...(resume ? ['-r', session] : []), `--single=${prompt}`]];
  }
  if (engine === 'cursor') {
    return ['cursor-agent', ['-p', '--model', cursorModel(effort), '--force', '--trust',
      '--sandbox', 'disabled', '--output-format', 'json', '--workspace', options.worktree ?? '.',
      ...(resume ? ['--resume', session] : []), '--', prompt]];
  }
  if (isCodex(engine)) {
    // Maintainer, 2026-10-03: Codex workers run on the fast service tier unless GOAL_CODEX_SERVICE_TIER says otherwise.
    const tier = process.env.GOAL_CODEX_SERVICE_TIER ?? codexServiceTier();
    const common = ['-m', modelOf(engine), '-c', `model_reasoning_effort=${effort}`,
      '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false',
      ...codexMcpOverrides(engine),
      ...(engine === 'luna' ? [] : ['-c', `model_context_window=${SOL_CONTEXT_WINDOW}`]),
      '-c', `model_auto_compact_token_limit=${codexCompactTokens(engine)}`,
      '-c', `tool_output_token_limit=${codexToolOutputTokens()}`,
      ...(tier ? ['-c', `service_tier="${tier}"`] : []),
      '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', options.lastMessage ?? '/dev/null'];
    return [launcherOf(engine), resume ? ['exec', 'resume', session, ...common, '--', prompt]
      : ['exec', ...common, '-C', options.worktree ?? '.', '--', prompt]];
  }
  return ['claude', ['-p', '--model', MODELS[engine], '--effort', effort, '--dangerously-skip-permissions',
    '--settings', JSON.stringify({ forceLoginMethod: 'claudeai', fastMode: false }),
    '--disallowedTools', 'Agent',
    ...(resume ? ['--resume', session] : ['--session-id', session]), '-n', id.toLowerCase(),
    '--output-format', 'json', '--', prompt]];
}

export function codexMcpOverrides(engine: Engine): string[] {
  const home = engineEnv(engine).CODEX_HOME;
  if (!home) return [];
  const config = join(home, 'config.toml');
  if (!existsSync(config)) return [];
  const { mcp_servers: servers } = Bun.TOML.parse(readFileSync(config, 'utf8')) as { mcp_servers?: Record<string, unknown> };
  // Codex merges tables, so an empty mcp_servers override does not clear the account's servers.
  const disabled = Object.keys(servers ?? {}).map(name => `${JSON.stringify(name)}={enabled=false}`);
  return disabled.length ? ['-c', `mcp_servers={${disabled.join(',')}}`] : [];
}

/** Sol's context window in Codex since 2026-10-12 (it was 272,000). The account's own config still declares
 * 1,000,000 with compaction at 900,000, which is more than the model takes, so a worker states the real one. */
export const SOL_CONTEXT_WINDOW = 500_000;
/** Each launch reads the layered per-family compaction limits; the project uses Sol 160,000 and Luna
 * 200,000. GOAL_CODEX_COMPACT_TOKENS overrides either family. Measure fresh and resumed sessions by
 * per-attempt token deltas, tracking re-sent context, wake prompt sizes, and rereads or mistakes after
 * compaction to balance context cost against lost detail. */
function codexCompactTokens(engine: Engine): number {
  const override = Number(process.env.GOAL_CODEX_COMPACT_TOKENS);
  if (Number.isSafeInteger(override) && override > 0) return override;
  const limits = loadSettings({ stateDirectory: stateDir }).settings.codexCompactTokens;
  return engine === 'luna' ? limits.luna : limits.sol;
}

/** What one command's output may add to a worker's context. Sol's own default is 10,000 tokens; a token
 * of output is paid once as new input and again on every later call. Cutting at about 16,000 characters
 * keeps 84% of the output volume measured to 2026-10-10. `GOAL_CODEX_TOOL_OUTPUT_TOKENS` overrides it. */
export const CODEX_TOOL_OUTPUT_TOKENS = 4_000;
function codexToolOutputTokens(): number {
  const override = Number(process.env.GOAL_CODEX_TOOL_OUTPUT_TOKENS);
  return Number.isSafeInteger(override) && override > 0 ? override : CODEX_TOOL_OUTPUT_TOKENS;
}

/** The environment can override the layered service tier for one invocation. */
function codexServiceTier(): string {
  const override = process.env.GOAL_CODEX_SERVICE_TIER?.trim();
  if (override) return override;
  return loadSettings({ stateDirectory: stateDir }).settings.codexServiceTier;
}

/** Where a task's brief lives in its worktree; shared worktrees hold one brief per task. */
export function briefFile(task: Pick<Task, 'id' | 'worktree'> & { shared?: boolean }): string {
  return task.shared ? `.temp/goal/brief-${task.id.toLowerCase()}.md` : '.temp/goal/brief.md';
}

export async function workerPrompt(task: Task, manager: string, engine: Engine = engineOf(task), effort = task.effort,
  handover?: WorkerHandover): Promise<string> {
  handover ??= await prepareHandover(task, readFileSync(task.brief, 'utf8'));
  return [
    `You are REZICS Goal worker ${task.id} (${modelOf(engine)}/${effort}). Work only inside ${task.worktree}.`,
    `Edit, create and delete files only under ${task.worktree} (and /tmp). The main checkout ${root} and every`
      + ' other worktree are read-only for you, even when a brief or handoff cites an absolute path there;'
      + ` translate such paths to ${task.worktree}.`,
    'goalctl commands you run (test, owner, slot) may write their own bookkeeping under the main checkout\'s'
      + ' .temp/goal-orchestration; that is allowed. Use `bun scripts/goal/goalctl.ts test` for QA.',
    `Read docs/goals/worker.md there and follow it and the brief below.`
      + ` The brief's copy is at ${briefFile({ ...task, shared: !!task.worktreeName })}.`,
    ...task.worktreeName ? [`Other workers share this worktree at the same time (shared worktree "${task.worktreeName}").`
      + ' Change only your claimed paths; commit only them with `git commit --only <paths>` (retry if index.lock is held);'
      + ' never reset, checkout, stash or reformat files you did not change. Start no dev server, Storybook,'
      + ' type-check watcher or browser: use the shared ones listed in .temp/goal/shared.md, and leave Storybook'
      + ' and browser runs to the manager unless your brief asks you to run them. Run the unit and integration'
      + ' files (and any stories) your task adds or fixes through'
      + ' `bun scripts/goal/goalctl.ts test <files>`, one run at a time; an unverified fix is not done.'] : [],
    `${task.goal ? `Your Goal is ${task.goal}; its manager` : 'The manager'} session is "${manager}".`
      + ' End with the handoff that the worker protocol specifies.',
    handoverPrompt(handover, task.tests ?? []),
  ].join('\n');
}

export function taskOf(ledger: Ledger, id: string): Task {
  const task = ledger.tasks[id.toUpperCase()];
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}

export function lastAttempt(task: Task): Attempt {
  const attempt = task.attempts.at(-1);
  if (!attempt) throw new Error(`${task.id} has no attempt`);
  return attempt;
}

export function running(task: Task): boolean {
  return task.state === 'running' && pidAlive(lastAttempt(task).pid, programOf(engineOf(lastAttempt(task))));
}

export function memoryFloorRefusal(meminfo: string, floorGiB = 12): string | undefined {
  if (!Number.isFinite(floorGiB) || floorGiB < 0) throw new Error('GOAL_MEMORY_FLOOR_GIB must be a finite non-negative number');
  const availableKiB = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(meminfo)?.[1];
  if (availableKiB === undefined) throw new Error('Cannot determine host MemAvailable from /proc/meminfo; refusing to launch');
  const availableGiB = Number(availableKiB) / (1024 * 1024);
  return availableGiB < floorGiB
    ? `Memory floor reached: host MemAvailable ${availableGiB.toFixed(2)} GiB is below GOAL_MEMORY_FLOOR_GIB=${floorGiB}; let running workers finish`
    : undefined;
}

/** Dispatch and resume consume the same host capacity and the selected engine's account. */
export function launchGates(tasks: Task[], engine: Engine, forceUsage: boolean) {
  // The local reserve and unknown-capacity refusal cannot be bypassed with --force-usage.
  assertClaudeCapacity(engine);
  const live = tasks.filter(running).length;
  const limit = Number(process.env.GOAL_MAX_WORKERS ?? 25);
  if (live >= limit) throw new Error(`Concurrency limit reached: ${live}/${limit} live workers`);
  const memory = memoryFloorRefusal(readFileSync(process.env.GOAL_MEMINFO_FILE ?? '/proc/meminfo', 'utf8'), Number(process.env.GOAL_MEMORY_FLOOR_GIB ?? 12));
  if (memory) throw new Error(memory);
  const usage = currentUsage();
  const account = codexAccounts().find(candidate => candidate.engines.includes(engine));
  if (!forceUsage) {
    if (account?.reached && !account.pastAllowance?.length) throw new Error(`${describeAccount(account)}; use another engine or pass --force-usage`);
  }
  return { live, limit, usage, account };
}

/** A manager wake is one turn, and a Goal only advances through its manager.
 * Claude usage and the live-worker cap slow workers; they stay visible here and do not refuse the wake.
 * The memory floor and a reached Codex account for this engine still do. */
export function managerWakeGates(engine: Engine): { live: number; limit: number; claude: UsageLevel } {
  const live = Object.values(readLedger().tasks).filter(running).length;
  const limit = Number(process.env.GOAL_MAX_WORKERS ?? 25);
  const memory = memoryFloorRefusal(readFileSync(process.env.GOAL_MEMINFO_FILE ?? '/proc/meminfo', 'utf8'), Number(process.env.GOAL_MEMORY_FLOOR_GIB ?? 12));
  if (memory) throw new Error(memory);
  const claude = currentUsage().level;
  const account = codexAccounts().find(candidate => candidate.engines.includes(engine));
  if (account?.reached && !account.pastAllowance?.length) throw new Error(`${describeAccount(account)}; use another engine or pass --force-usage`);
  return { live, limit, claude };
}

export function workerSessionEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  // A new worker has its own native session; inherited manager IDs misidentify it and its tools as that session's owner.
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

export function launch(task: Task, effort: string, session: string, prompt: string, resume: boolean,
  manager: string, engine: Engine = engineOf(task), round: NonNullable<Attempt['round']> = task.attempts.length ? 'fix' : 'initial'): Attempt {
  assertPreviousClaudeExited(task);
  assertClaudeCapacity(engine, task);
  const env = { ...workerSessionEnvironment(isClaudeCode(engine) ? claudeSubscriptionEnvironment(process.env) : process.env),
    ...engineEnv(engine), GOAL_TASK_ID: task.id, GOAL_WORKTREE: resolve(task.worktree), GOAL_MANAGER: manager,
    GOAL_SETTINGS_DIRECTORY: settingsDirectory() };
  if (isClaudeCode(engine)) {
    assertClaudeSubscription(task.worktree, env);
    assertClaudeCapacity(engine, task); // The bounded native check must not outlive our fresh usage sample.
  }
  const n = task.attempts.length + 1;
  const runDir = join(stateDir, 'runs', task.id);
  mkdirSync(runDir, { recursive: true });
  const output = join(runDir, `attempt-${n}.json`);
  const lastMessage = isCodex(engine) ? join(runDir, `attempt-${n}.last.md`) : undefined;
  // A wave can keep old application code; its detached job controller still follows current main.
  prompt = `For recorded jobs, use \`bun ${join(root, 'scripts/goal/goalctl.ts')} job -- <command…>\``
    + ` from this worktree, so job ownership and wake rules use main’s code.\n${prompt}`;
  const [program, args] = launchCommand({ id: task.id, effort, session, prompt, resume, engine,
    worktree: task.worktree, lastMessage });
  const child = spawn(program, args, {
    cwd: task.worktree, detached: true,
    stdio: ['ignore', openSync(output, 'w'), openSync(join(runDir, `attempt-${n}.err`), 'w')],
    env,
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not start ${program}`);
  const attempt = { n, effort, engine, round, pid: child.pid, session, output, lastMessage, startedAt: new Date().toISOString() };
  try { recordClaudeLaunch(task, attempt); }
  catch (error) { child.kill('SIGTERM'); throw error; }
  return attempt;
}

/** A new Claude worker uses the same native OAuth store as the usage reader, with no API/cloud fallback. */
export function claudeSubscriptionEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => !['ANTHROPIC_', 'CLAUDE_', 'CCR_', 'AGENT_PROXY_']
    .some(prefix => key.startsWith(prefix)) || key === 'CLAUDE_CONFIG_DIR'));
  if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = resolve(env.CLAUDE_CONFIG_DIR);
  return env;
}

function assertClaudeSubscription(cwd: string, env: NodeJS.ProcessEnv): void {
  // Native status can contain identity fields. Capture it only in memory; never forward its output/errors.
  // It is a bounded credential read, not a model request. Settings/env are identical to the actual launch.
  const result = spawnSync('claude', ['--settings', '{"forceLoginMethod":"claudeai","fastMode":false}', 'auth', 'status'],
    { cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string;
      apiKeySource?: string | null; configDirectory?: string; forcedLoginMethod?: string };
    if (result.status === 0 && status.loggedIn === true && status.authMethod === 'claude.ai'
      && status.apiProvider === 'firstParty' && (!status.apiKeySource || status.apiKeySource === 'none')
      && (!status.forcedLoginMethod || status.forcedLoginMethod === 'claudeai')
      && status.configDirectory && resolve(status.configDirectory) === resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))) return;
  } catch { /* Reject missing, malformed or truncated status without exposing its contents. */ }
  throw new Error('Claude usage is restricted (native subscription authentication required; no paid fallback)');
}

export function changedFiles(task: Task): { committed: string[]; dirty: string[]; ahead: number } {
  if (!existsSync(task.worktree)) return { committed: [], dirty: [], ahead: 0 };
  const committed = git(root, ['diff', '--name-only', `main...${task.branch}`], true).split('\n').filter(Boolean);
  const dirty = git(task.worktree, ['status', '--porcelain', '--untracked-files=all'], true).split('\n')
    .filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, ''));
  const ahead = Number(git(root, ['rev-list', '--count', `main..${task.branch}`], true) || 0);
  return { committed, dirty, ahead };
}

/** The branch's changes since it left main, with each file's content on both sides for `historyIntroductions`. */
export function branchChanges(task: Task): ChangedFile[] {
  const base = git(root, ['merge-base', 'main', task.branch]);
  const show = (revision: string, path: string) => git(root, ['show', `${revision}:${path}`], true);
  return git(root, ['diff', '--name-status', '-M', `${base}..${task.branch}`]).split('\n').filter(Boolean).map(line => {
    const [code = 'M', first = '', second] = line.split('\t');
    const status = (['A', 'D', 'R'].includes(code[0]!) ? code[0] : 'M') as ChangedFile['status'];
    const path = second ?? first;
    const from = status === 'R' ? first : undefined;
    return { path, status, from, before: status === 'A' ? undefined : show(base, from ?? path),
      after: status === 'D' ? undefined : show(task.branch, path) };
  });
}

export function describe(task: Task): string {
  const { committed, dirty, ahead } = changedFiles(task);
  const exempt = new Set(existsSync(task.worktree) ? regenerationOnlyFiles(task.worktree) : []);
  const watched = [...new Set([...committed.filter(file => !exempt.has(file)), ...dirty])].filter(file => !isGeneratedOutput(file));
  const violations = outOfScope(watched, task.paths);
  return [
    `${task.branch}: ${ahead} commit(s) ahead of main; worktree ${dirty.length ? `DIRTY (${dirty.length} files)` : 'clean'}`,
    violations.length ? `scope: VIOLATIONS\n  ${violations.join('\n  ')}` : 'scope: ok',
  ].join('\n');
}

function readCodexResult(attempt: Attempt): { text: string; session?: string; error: boolean; tokens?: string } {
  const lines = existsSync(attempt.output) ? readFileSync(attempt.output, 'utf8').split('\n') : [];
  let session: string | undefined;
  let input = 0, cached = 0, output = 0;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string;
        usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } };
      if (event.type === 'thread.started') session ??= event.thread_id;
      if (event.type === 'turn.completed') {
        input += event.usage?.input_tokens ?? 0; cached += event.usage?.cached_input_tokens ?? 0;
        output += event.usage?.output_tokens ?? 0;
      }
    } catch { /* partial line */ }
  }
  const text = attempt.lastMessage && existsSync(attempt.lastMessage) ? readFileSync(attempt.lastMessage, 'utf8') : '';
  const errPath = attempt.output.replace(/\.json$/, '.err');
  const tail = !text && existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(-3000) : '';
  return { text: text || `(no final message)\n${tail}`, session, error: !text,
    tokens: `input ${input} (cached ${cached}), output ${output}` };
}

export function readResult(attempt: Attempt): { text: string; session?: string; error: boolean; cost?: number; tokens?: string } {
  const engine = engineOf(attempt);
  if (isCodex(engine)) return readCodexResult(attempt);
  try {
    const data = JSON.parse(readFileSync(attempt.output, 'utf8')) as Record<string, unknown>;
    const text = String(data.result ?? data.text ?? '');
    const session = (data.session_id ?? data.sessionId) as string | undefined;
    return { text, session, error: data.is_error === true || !text, cost: data.total_cost_usd as number | undefined };
  } catch {
    const errPath = attempt.output.replace(/\.json$/, '.err');
    const tail = existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(-3000) : '';
    return { text: `(no parsable output)\n${tail}`, error: true };
  }
}

export function elapsed(fromIso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(fromIso)) / 60_000);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Trailing attempts wait started after a dropped connection. A later manual resume breaks the streak. */
export function transportContinuations(task: Task, reason: NonNullable<Attempt['continuedFor']> = 'transport'): number {
  let count = 0;
  for (const attempt of [...task.attempts].reverse()) {
    if (attempt.continuedFor !== reason) break;
    count++;
  }
  return count;
}

/** A handoff resets the allowance; capacity or transport retries cannot grant another one. */
export function handoffContinuations(task: Task): number {
  let count = 0;
  for (const attempt of [...task.attempts].reverse()) {
    if (hasHandoff(readResult(attempt).text)) break;
    if (attempt.continuedFor === 'handoff') count++;
  }
  return count;
}

/** Malformed RESULT lines still belong to the manager, rather than an automatic continuation. */
export function hasHandoff(text: string): boolean {
  return handoffResult(text) !== undefined || /^RESULT:/m.test(text);
}

/** Progress text can survive a failed Codex turn; only a completed turn authorizes this continuation. */
export function cleanSessionEnd(attempt: Attempt): boolean {
  if (readResult(attempt).error) return false;
  if (!isCodex(engineOf(attempt))) return true;
  try {
    const last = readFileSync(attempt.output, 'utf8').trimEnd().split(/\r?\n/).at(-1) ?? '';
    return (JSON.parse(last) as { type?: string }).type === 'turn.completed';
  } catch { return false; }
}

/** Only model-capacity refusals retry automatically; routing failures need a manager disposition. */
export function capacityRefusal(attempt: Attempt): boolean {
  if (!isCodex(engineOf(attempt))) return false;
  try {
    const last = readFileSync(attempt.output, 'utf8').trimEnd().split(/\r?\n/).at(-1) ?? '';
    return /"type":"turn\.failed"/.test(last) && /at capacity/i.test(last);
  } catch { return false; }
}

/** No result, and the error output's last line is a connection drop. Any other failure is left exited. */
export function transportDrop(attempt: Attempt): boolean {
  if (!readResult(attempt).error) return false;
  const errPath = attempt.output.replace(/\.json$/, '.err');
  if (!existsSync(errPath)) return false;
  const last = readFileSync(errPath, 'utf8').trimEnd().split(/\r?\n/).filter(line => line.trim()).at(-1)?.trim() ?? '';
  return TRANSPORT_ERRORS.some(pattern => pattern.test(last));
}

/** Names the work the dropped session left behind. Wait never commits it. */
export function transportContinuationPrompt(dirty: readonly string[]): string {
  return dirty.length
    ? ['The previous session lost its connection. It left these files uncommitted:',
      ...dirty.map(file => `- ${file}`), 'Review them, commit what stands, and continue the brief.'].join('\n')
    : 'The previous session lost its connection. The worktree is clean; continue the brief from its commits.';
}
