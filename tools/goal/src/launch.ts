import { type ChildProcess, type SpawnSyncOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import defaults from '../defaults.json';
import { NO_COMPILE_CACHE, remoteCheckEnvironment } from './merge.ts';
import { processIdentity, waitForWorkerExit, workerExitPath, type WorkerExit } from './process.ts';
import type { Attempt, Pool, Profile, Settings, Task } from './types.ts';
import type { WorkerStore } from './store.ts';
import { launchWorkerProcess } from './worker-slice.ts';

export type LaunchOptions = {
  profile: Profile;
  pool: Pool;
  worktree: string;
  prompt: string;
  logPath: string;
  readOnly?: boolean;
  research?: boolean;
  codex?: Settings['codex'];
};
export function launchCommand(options: LaunchOptions): [string, string[]] {
  const { profile, pool, worktree, prompt } = options;
  if (!['codex', 'grok', 'cursor', 'claude'].includes(profile.cli)) throw new Error('unsupported worker CLI');
  if (pool.cli !== profile.cli) throw new Error('profile and pool CLI disagree');
  if (profile.cli === 'grok')
    return [
      pool.command,
      [
        '-m',
        profile.model,
        '--reasoning-effort',
        profile.effort,
        // No --json-schema: with it Grok answers in structured form only and stops using tools, so the parser reads its
        // status object out of free text instead.
        '--permission-mode',
        'bypassPermissions',
        '--no-subagents',
        '--output-format',
        'json',
        '--cwd',
        worktree,
        `--single=${prompt}`,
      ],
    ];
  // Workers share the managers' Claude configuration; its hooks and MCP servers belong to the managers' sessions.
  if (profile.cli === 'claude')
    return [
      pool.command,
      [
        '-p',
        '--model',
        profile.model,
        '--effort',
        profile.effort,
        '--permission-mode',
        'bypassPermissions',
        '--output-format',
        'stream-json',
        '--verbose',
        '--strict-mcp-config',
        '--settings',
        JSON.stringify({ disableAllHooks: true }),
        '--',
        prompt,
      ],
    ];
  if (profile.cli === 'cursor')
    return [
      pool.command,
      [
        '-p',
        '--model',
        `${profile.model}-${profile.effort}`,
        '--force',
        '--trust',
        '--sandbox',
        'disabled',
        '--output-format',
        'json',
        '--workspace',
        worktree,
        '--',
        prompt,
      ],
    ];
  const codex = options.codex ?? defaults.codex;
  const mcp: string[] = [];
  const config = join(pool.configDirectory, 'config.toml');
  if (existsSync(config)) {
    const servers = (Bun.TOML.parse(readFileSync(config, 'utf8')) as { mcp_servers?: Record<string, unknown> })
      .mcp_servers;
    // A dotted `-c` path keeps the quotes in the key, defining a new server without a transport; an inline table merges.
    const disabled = Object.keys(servers ?? {}).map((name) => `${JSON.stringify(name)}={enabled=false}`);
    if (disabled.length) mcp.push('-c', `mcp_servers={${disabled.join(',')}}`);
  }
  return [
    pool.command,
    [
      'exec',
      '--json',
      '-m',
      profile.model,
      '-c',
      `model_reasoning_effort=${profile.effort}`,
      '-c',
      `model_auto_compact_token_limit=${profile.model.includes('luna') ? codex.compactTokens.luna : codex.compactTokens.sol}`,
      '-c',
      `tool_output_token_limit=${codex.toolOutputTokens}`,
      '-c',
      'features.unified_exec=true',
      '-c',
      `background_terminal_max_timeout=${codex.backgroundTerminalMaxTimeoutMs}`,
      '-c',
      // Only settings choose the tier: Fast spends included allowance 2.5 times as fast, so neither a routing profile nor
      // the profile a retry keeps from an earlier attempt can select it.
      `service_tier=${JSON.stringify(codex.serviceTier)}`,
      ...(profile.model.includes('sol') ? ['-c', `model_context_window=${codex.solContextWindow}`] : []),
      '-c',
      'features.multi_agent=false',
      '-c',
      'features.multi_agent_v2=false',
      ...mcp,
      ...(options.readOnly
        ? ['-s', 'read-only', '-c', 'approval_policy="never"']
        : ['--dangerously-bypass-approvals-and-sandbox']),
      ...(options.research ? ['-c', 'web_search="live"'] : []),
      ...(!options.readOnly ? ['--output-schema', join(import.meta.dir, '../worker-result.schema.json')] : []),
      '-C',
      worktree,
      '--',
      prompt,
    ],
  ];
}
export function workerEnvironment(
  pool: Pool,
  extra: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
  worktree?: string,
): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of Object.keys(env)) if (key.startsWith('GOAL_')) delete env[key];
  for (const key of [
    'GOAL_MANAGER',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_HOME',
    'GROK_HOME',
    'GROK_CONFIG_DIR',
    'CURSOR_CONFIG_DIR',
    'CLAUDE_CONFIG_DIR',
  ])
    delete env[key];
  const key =
    pool.cli === 'codex'
      ? 'CODEX_HOME'
      : pool.cli === 'grok'
        ? 'GROK_HOME'
        : pool.cli === 'claude'
          ? 'CLAUDE_CONFIG_DIR'
          : 'CURSOR_CONFIG_DIR';
  // With CLAUDE_CONFIG_DIR set, Claude Code looks for .claude.json inside it, not beside the default ~/.claude.
  const result: NodeJS.ProcessEnv =
    pool.cli === 'claude' && resolve(pool.configDirectory) === join(homedir(), '.claude')
      ? { ...env, ...NO_COMPILE_CACHE, ...extra }
      : { ...env, ...NO_COMPILE_CACHE, ...extra, [key]: pool.configDirectory };
  const wrapperDirectory = worktree && join(worktree, 'scripts', 'check-host');
  if (wrapperDirectory && existsSync(join(wrapperDirectory, 'docker')))
    result.PATH = [wrapperDirectory, result.PATH].filter(Boolean).join(':');
  return result;
}
export function workerPrompt(
  task: Task,
  evidence: string | undefined,
  consultation: string | undefined,
  resolutionFiles: readonly string[],
  mainCheckout: string,
): string {
  const frozen = ((task as Task & { frozenFiles?: { path: string }[] }).frozenFiles ?? []).map((file) => file.path);
  const evidenceText = evidence
    ? (() => {
        const failurePath = join(evidence, 'failure.json');
        if (!existsSync(failurePath)) return `Retry evidence directory: ${evidence}`;
        try {
          const document = JSON.parse(readFileSync(failurePath, 'utf8')) as { manifest?: unknown };
          return typeof document.manifest === 'string' ? document.manifest : `Retry evidence directory: ${evidence}`;
        } catch {
          return `Retry evidence directory: ${evidence}`;
        }
      })()
    : undefined;
  return [
    `Work only in ${task.worktree}, on branch ${task.branch}. The AGENTS.md that applies is already in your instructions; follow it.`,
    `The main checkout ${mainCheckout} is read-only: never write there. Write files only by paths inside ${task.worktree}${task.brief.kind === 'research' ? `, except the reference clones this research task keeps under ${mainCheckout}/.reference/` : ''}.`,
    'Work until every acceptance condition holds. Do not send progress reports. Commit the completed changes on this branch.',
    'Do not rebase or merge. Write every acceptance test the contract names that does not exist yet; never weaken or edit an existing acceptance test or a frozen file. A check that waits for a test slot is queued, not stuck: let it run.',
    // A stabilize base can predate the check wrapper (dev tooling reaches stabilize at a cut); without it every check
    // failed with 'Module not found' before acceptance (2026-10-28).
    existsSync(join(task.worktree, 'scripts/worker-check.ts'))
      ? 'Check slots are the scarce shared resource: run your acceptance command once after your last relevant edit, plus the root typecheck. Run each as one foreground command through `bun scripts/worker-check.ts -- <command...>` from the worktree root. The wrapper writes live output under `.temp/goal/checks/` and stays silent until exit, then prints the exit status, a short failure summary when needed, and the log path. If Codex returns a session while the wrapper runs, use one blocking wait for the configured `background_terminal_max_timeout`; never poll or rerun the check. Run a whole-workspace check (a workspace check with no files named, or a full web check) only when the contract names one, never to obtain a success summary or after the acceptance passed; an extra check you choose names at most 12 test files, those closest to your change.'
      : 'Check slots are the scarce shared resource: run your acceptance command once after your last relevant edit, plus the root typecheck, each as one foreground command from the worktree root. This base has no scripts/worker-check.ts; do not add one. A command that waits for a test slot is queued, not stuck: let it finish and read its exit status.',
    'You have the authority to finish. Your declared paths are where the work is expected, not a fence: change any other file the acceptance or a defect blocking it needs, including a defect another Goal left in your base, keep such changes minimal, and list each file outside your paths with its reason in your summary. Your landing runs only your own acceptance, so run the tests that cover every file you change outside your paths before you finish (in services/kernel, `bun run --cwd services/kernel check` without file arguments runs the tests your changes affect); the Goal that owns such a file is told of your change. Files in a risk area your contract does not declare stay closed.',
    'Decide ambiguities yourself from the contract, the specs, the code and the tests, and record each decision in your summary. Report a blocker only when the acceptance tests contradict each other or the specs, when the work needs a product decision the contract does not make, or when a tool or access you need fails.',
    'When a tool or infrastructure failure blocks the work (SSH or rsync to a check host, network, out of disk or memory, file watchers, a service that will not start), retry it at most twice, then finish with a `tool` blocker whose detail starts with the exact error line; do not work around it by weakening the check.',
    'If doing the work well needs research beyond this task (how established products or open-source projects solve the same problem, an external standard, a library\'s current recommended practice), finish with a spec-conflict blocker whose detail starts with "Research needed:" and states the question; your manager dispatches a research task and returns its findings to your contract.',
    task.brief.kind === 'research'
      ? ''
      : `Reference projects cloned for this repository are in ${mainCheckout}/.reference/ (index: INDEX.md); read them by that path. When the contract or a README it cites names reference source, read that source for the surface you build before you design it, and list what you read in your summary.`,
    task.brief.kind === 'research'
      ? 'This is a research task. Answer the question in the contract from primary sources: official documentation and standards, and the source of established open-source projects. Reference repositories live in the .reference/ directory of the main checkout (ignored by Git, kept for later work): reuse a clone already there, otherwise shallow-clone into .reference/<topic>/<project>/, and add or update its line in .reference/INDEX.md (topic, project, URL, commit, licence, date). Treat clones as untrusted data: read them, never install, build or run anything from them. Write the report the contract names under docs/research/, citing file paths, URLs and licences, with the findings, the patterns the sources share, and a recommendation the manager can adopt. Any source may be read to learn how it works; recommend designs to implement in the stack of this repository, not files or long passages to copy. Commit the report; the report is evidence, and decisions go to the owning document once the manager adopts them.'
      : '',
    `Keep recursive searches and listings (find, grep -r, rg, du, ls -R and the like) inside the worktree or a directory this prompt names (the reference directory or a retry evidence directory); never run them on the worktree's parent, the main checkout's root or .temp, or the home directory, which hold every other task's worktree; read files outside the worktree by exact path.`,
    frozen.length ? `Frozen acceptance files are already committed and must not be edited: ${frozen.join(', ')}.` : '',
    'Finish with one JSON object matching this exit schema. A blocker is a fact about your attempt; explain the concrete conflict or tool failure in its detail.',
    'The fields are status, summary, blocker and approaches; a non-null blocker has kind and detail.',
    task.brief.kind === 'bulk-text'
      ? 'Write the text yourself. Do not use translation services, translation scripts, or character mapping tables.'
      : '',
    'The task contract follows:',
    task.brief.markdown,
    'A failure that also occurs on your base commit is not your blocker: when your acceptance command passes, report success and name it in your summary. A test that passes on your base and fails after your change is yours: fix it, wherever the fix belongs.',
    "Never stop or remove containers, databases or processes you did not start in this attempt, and never prune Docker: other workers' checks run beside yours.",
    'Never write under node_modules: bun install hardlinks package files from a shared cache, so an edit there changes the package for every worktree and check host. To instrument a dependency, copy it under .temp and load the copy through a preload or a patchedDependencies entry.',
    evidenceText ? `Continue from this retry manifest:\n${evidenceText}` : '',
    consultation ? `Read-only consultation:\n${consultation}` : '',
    resolutionFiles.length
      ? `The control plane has already started a rebase onto current main in this worktree. Conflicted files: ${resolutionFiles.join(', ')}. Resolve and stage them, then run \`git rebase --continue\` until the rebase completes. Do not start another rebase.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
/** Per-attempt variables: the attempt's identity, and the base the kernel check selects affected tests against. */
export function attemptEnvironment(
  task: Pick<Task, 'id' | 'base'>,
  attempt: Pick<Attempt, 'attempt'>,
  stateDirectory?: string,
): Record<string, string> {
  return {
    GOAL_TASK_ID: task.id,
    GOAL_ATTEMPT: String(attempt.attempt),
    KERNEL_CHECK_AFFECTED: task.base,
    ...remoteCheckEnvironment(stateDirectory),
    // The worker check wrapper appends its full wait here, in milliseconds per line; the class limit adds it back.
    ...(stateDirectory
      ? { GOAL_CHECK_WAIT_FILE: join(stateDirectory, 'runs', task.id, `${attempt.attempt}.check-wait`) }
      : {}),
  };
}
/** Milliseconds an attempt's checks spent waiting for a slot, as its check tools recorded them beside the run log. */
export function checkWaitMs(logPath: string): number {
  try {
    return readFileSync(logPath.replace(/\.jsonl$/, '.check-wait'), 'utf8')
      .split('\n')
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((total, value) => total + value, 0);
  } catch {
    return 0;
  }
}
export type RunningWorker = { child?: ChildProcess; exited: Promise<WorkerExit>; attempt: Attempt };
/**
 * A manager's tool sandbox kills the whole process tree of the command that launched a worker, and a new process
 * group does not leave that tree. The wrapper forks twice, so the worker is reparented away from its launcher, and
 * becomes a session leader. The intermediate process publishes the wrapper's pid before it exits. When the CLI ends,
 * the wrapper records its exit code or signal beside the run log.
 */
const WRAPPER = `import os,sys,json,signal,subprocess
exit_path,pid_path=sys.argv[1:3]
r,w=os.pipe()
if os.fork():
 os.close(w)
 pid=os.read(r,32)
 if not pid: sys.exit(1)
 open(pid_path,'w').write(pid.decode())
 os._exit(0)
os.close(r)
os.setsid()
os.write(w,str(os.getpid()).encode())
os.close(w)
code,sig=None,None
try:
 status=subprocess.Popen(sys.argv[3:]).wait()
 if status<0: sig=signal.Signals(-status).name
 else: code=status
except OSError:
 code=127
open(exit_path+'.tmp','w').write(json.dumps({'code':code,'signal':sig}))
os.rename(exit_path+'.tmp',exit_path)
`;
export type HostCapacity = { maxWorkers: number; minAvailableMiB: number };
const DEFAULT_CAPACITY: HostCapacity = { maxWorkers: 32, minAvailableMiB: 6144 };
/** Whether one more worker may start: below the worker cap and above the memory floor. */
export function hasCapacity(running: number, availableMiB: number, capacity: HostCapacity): boolean {
  return running < capacity.maxWorkers && availableMiB >= capacity.minAvailableMiB;
}
function availableMiB(): number {
  const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  return match ? Number(match[1]) / 1024 : Number.POSITIVE_INFINITY;
}
/** Whether an ordinary start could begin now, without waiting; a host without capacity.json always has room. */
export function capacityAvailable(store: WorkerStore, stateDirectory: string): boolean {
  const file = join(stateDirectory, 'capacity.json');
  if (!existsSync(file)) return true;
  let capacity = DEFAULT_CAPACITY;
  try {
    capacity = { ...DEFAULT_CAPACITY, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<HostCapacity>) };
  } catch {
    /* Defaults. */
  }
  const running = store.runningAttemptsCount();
  return hasCapacity(running, availableMiB(), capacity);
}
/** Starts on the stabilize branch and on the critical path skip the worker cap; only the memory floor holds them. */
export function startsFirst(task: Pick<Task, 'taskClass' | 'brief'>): boolean {
  return task.taskClass === 'critical-path' || task.brief.criticalPath === true || task.brief.target === 'stabilize';
}
/**
 * A worker starts only while the host has room: at most maxWorkers running and at least minAvailableMiB of memory
 * available. Otherwise it waits; it is never refused. Fifty-two workers on this host exhausted memory and swap and
 * killed unrelated processes (2026-10-27). `<state>/capacity.json` overrides the defaults and is read on every check.
 */
export async function awaitHostCapacity(
  store: WorkerStore,
  stateDirectory: string,
  first = false,
  taskId?: string,
): Promise<void> {
  // A host opts in with <state>/capacity.json; without it nothing waits (tests, and hosts that pace by other means).
  const file = join(stateDirectory, 'capacity.json');
  if (!existsSync(file)) return;
  // Waiters hold tickets so the oldest starts first: polling alone let a start wait over an hour behind newer ones.
  const queue = join(stateDirectory, 'capacity-queue');
  // The ticket names its task, so the host can tell a waiting start from a lost one.
  const ticket = `${String(Date.now()).padStart(15, '0')}-${process.pid}-${taskId ?? crypto.randomUUID()}`;
  if (!first) {
    mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, ticket), '');
  }
  let reported = false;
  try {
    for (;;) {
      if (!existsSync(file)) return;
      let capacity = DEFAULT_CAPACITY;
      try {
        capacity = { ...DEFAULT_CAPACITY, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<HostCapacity>) };
      } catch {
        /* Defaults. */
      }
      const running = first ? 0 : store.runningAttemptsCount();
      const ahead = first ? 0 : waitersAhead(queue, ticket);
      if (hasCapacity(running + ahead, availableMiB(), capacity)) return;
      if (!reported)
        console.error(
          `Waiting for host capacity (${running} workers running, ${ahead} starts ahead, cap ${capacity.maxWorkers}).`,
        );
      reported = true;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  } finally {
    if (!first) rmSync(join(queue, ticket), { force: true });
  }
}
/** Task ids that a live process is waiting to start, from the capacity queue's tickets. */
export function capacityWaiters(stateDirectory: string): Set<string> {
  const queue = join(stateDirectory, 'capacity-queue');
  let names: string[];
  try {
    names = readdirSync(queue);
  } catch {
    return new Set();
  }
  const live = new Set<string>();
  for (const name of names) {
    const [, pid, ...rest] = name.split('-');
    try {
      process.kill(Number(pid), 0);
      live.add(rest.join('-'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') live.add(rest.join('-'));
    }
  }
  return live;
}
/** Live waiters whose tickets are older than `ticket`; a ticket whose process has ended is removed. */
export function waitersAhead(queue: string, ticket: string): number {
  let names: string[];
  try {
    names = readdirSync(queue);
  } catch {
    return 0;
  }
  return names.filter((name) => {
    if (name >= ticket) return false;
    const pid = Number(name.split('-')[1]);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
      rmSync(join(queue, name), { force: true });
      return false;
    }
  }).length;
}
export async function launch(
  store: WorkerStore,
  task: Task,
  attempt: Attempt,
  pool: Pool,
  prompt: string,
  codex?: Settings['codex'],
): Promise<RunningWorker> {
  store.assertCurrent(attempt);
  mkdirSync(dirname(attempt.logPath), { recursive: true });
  const exitPath = workerExitPath(attempt.logPath),
    pidPath = `${attempt.logPath}.pid`;
  for (const path of [exitPath, `${exitPath}.tmp`, pidPath]) rmSync(path, { force: true });
  const out = openSync(attempt.logPath, 'w'),
    err = openSync(`${attempt.logPath}.err`, 'w');
  const [program, args] = launchCommand({
    profile: attempt.profile,
    pool,
    worktree: task.worktree,
    prompt,
    logPath: attempt.logPath,
    ...(codex ? { codex } : {}),
    // Research clones and reads reference projects and lands its report, so it needs the same access as other work.
    // Keyed on the brief's kind: a research brief that declares a risk area or cites sources routes as a claim.
    ...(task.brief.kind === 'research' ? { research: true } : {}),
  });
  const env = workerEnvironment(
    pool,
    attemptEnvironment(task, attempt, dirname(dirname(dirname(attempt.logPath)))),
    process.env,
    task.worktree,
  );
  try {
    // Publication and spawn share the fence's write lock. A retry cannot miss a just-started process.
    store.write(attempt, () => {
      const driver = processIdentity();
      if (!driver) throw new Error('Cannot identify driver process');
      // The wrapper cannot report a missing program to the launcher, so refuse it here.
      if (!Bun.which(program, { PATH: env.PATH ?? '', cwd: task.worktree }))
        throw new Error(`Worker CLI not found: ${program}`);
      const wrapperArgs = ['-c', WRAPPER, exitPath, pidPath, program, ...args];
      const startOptions: SpawnSyncOptions = {
        cwd: task.worktree,
        stdio: ['ignore', out, err],
        env,
      };
      const started = launchWorkerProcess(
        task.id,
        attempt.attempt,
        'python3',
        wrapperArgs,
        startOptions,
        () => existsSync(pidPath) || existsSync(exitPath),
      );
      if (started.error) throw started.error;
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : 0;
      const identity = processIdentity(pid);
      if (started.status !== 0 || !identity) throw new Error(`Worker wrapper failed to start (exit ${started.status})`);
      store.updateAttempt(attempt, (current) => {
        current.driver = driver;
        current.process = identity;
        current.state = 'running';
      });
      store.updateTask(attempt, (current) => {
        current.state = 'running';
      });
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const saved = store.attempt(attempt);
  const exited = waitForWorkerExit(saved.process, attempt.logPath);
  void exited.catch(() => {});
  return { exited, attempt: saved };
}
