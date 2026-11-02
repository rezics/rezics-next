import {
  proofProtocolAuthorized,
  proofSourceUnchanged,
  registeredProof,
  ordinaryProofCommand,
  type ProofAuthorization,
  type ProofReservation,
} from './verification.ts';
import { spawnSync, type ChildProcess, type SpawnSyncOptions } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { NO_COMPILE_CACHE, remoteCheckEnvironment } from './merge.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import {
  processIdentity,
  sameProcess,
  terminateProcessGroup,
  waitForWorkerExit,
  workerExitPath,
  type ProcessIdentity,
  type WorkerExit,
} from './process.ts';
import { fixtureOwnerForLaunch, recordFixtureOwnedProcess } from './fixture-process-ownership.ts';
import type { AcceptancePlacement, Attempt, Brief, Pool, Profile, Settings, Task } from './types.ts';
import type { WorkerStore } from './store.ts';
import { recordFlow } from './flow.ts';
import { launchWorkerProcess } from './worker-slice.ts';
import { agentAdapter, cleanAgentEnvironment, type McpServer } from './agents.ts';
import { renderLaunchContext, type LaunchContext } from './launch-context.ts';
import { storybookPrompt, storybookServers } from './storybook.ts';
import { devProductBrief } from './briefs.ts';
import { workerTestCommands } from './affected-tests.ts';
import { branchHead } from './attempt-progress.ts';
import { CONTINUATION_DIRECTORY, continuesItself } from './continuation.ts';

export type LaunchOptions = {
  profile: Profile;
  pool: Pool;
  worktree: string;
  prompt: string;
  logPath?: string;
  readOnly?: boolean;
  research?: boolean;
  consultation?: boolean;
  /** A fresh, bounded train editing session through an adapter that supports it. */
  resolver?: boolean;
  codex?: Settings['codex'];
  mcpServers?: readonly McpServer[];
  resumeSession?: string;
};
export function launchCommand(
  options: LaunchOptions,
  resolveAdapter: typeof agentAdapter = agentAdapter,
): [string, string[]] {
  const { profile, pool } = options;
  if (pool.cli !== profile.cli) throw new Error('profile and pool CLI disagree');
  const adapter = resolveAdapter(profile.cli);
  if (options.resolver) {
    if (options.resumeSession) throw new Error('Train resolution requires a fresh session');
    if (!adapter.supportsResolver) throw new Error('Agent adapter does not support train resolution');
  }
  if (options.resumeSession && adapter.canResume) return adapter.resume({ ...options, session: options.resumeSession });
  const { resumeSession: _session, ...fresh } = options;
  return adapter.start(fresh);
}
export function workerEnvironment(
  pool: Pool,
  extra: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
  worktree?: string,
): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of Object.keys(env)) if (key.startsWith('GOAL_')) delete env[key];
  const result = agentAdapter(pool.cli).environment(pool, {
    ...cleanAgentEnvironment(env),
    ...NO_COMPILE_CACHE,
    ...extra,
  });
  const wrapperDirectory = worktree && join(worktree, 'scripts', 'check-host');
  if (wrapperDirectory && existsSync(join(wrapperDirectory, 'docker')))
    result.PATH = [wrapperDirectory, result.PATH].filter(Boolean).join(':');
  return result;
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function namedWorkerCheck(contractText: string): string | undefined {
  const match =
    /(?:^|\s)`?bun\s+("(?:\\.|[^"\\])*"|'(?:[^'\\]|\\.)+'|\/[^\s`]+\/scripts\/worker-check\.ts)(?=[\s`]|$)/m.exec(
      contractText,
    );
  if (!match) return undefined;
  const token = match[1]!;
  let path: string;
  try {
    path = token.startsWith('"')
      ? (JSON.parse(token) as string)
      : token.startsWith("'")
        ? token.slice(1, -1).replaceAll("'\\''", "'")
        : token;
  } catch {
    return undefined;
  }
  return path.startsWith('/') && path.endsWith('/scripts/worker-check.ts') ? path : undefined;
}
type CheckProtocolBrief = Pick<Brief, 'acceptance' | 'markdown'> & Partial<Brief>;
/** How a worker runs the tests of the test files it changed: with the landing's own commands for them. */
const OWN_TESTS =
  "After your last edit, run the test files you created or changed once, with the landing's command (`bun test <files>`; services/kernel: `bun run --cwd services/kernel check <files>`; apps/web: `bun apps/web/scripts/focused.ts --private-network -- bun test <files>`; paths relative to that workspace), and fix failures you caused.";
const LONG_WAIT =
  'Wait for a long command, even one queued for a test slot, in its open session with one yield of at least 300 seconds (Codex: `write_stdin`, `yield_time_ms: 300000`); never start a duplicate, interrupt it, poll faster, or use sleep loops, `ps` or `pgrep`.';
const REGRESSION = `Do not run the root typecheck or other regression suites yourself; the landing runs them. ${OWN_TESTS}`;
const UNFINISHED =
  'Unfinished work is not a blocker: if the contract does not fit this attempt, commit a coherent working part and return success with the remainder listed as follow-up.';
const LOCAL_PLACEMENT =
  'The acceptance placement is local and overrides any older prompt, saved session, remote invocation or `--wait` recipe. Do not invoke remote-check or any native, host or database route, and do not report an old check as cancelled.';
/** What a worker does with a wrapper that may hand back a detached check id. */
const WRAPPER_RESULT = [
  'If the wrapper prints a check id before the check ends, end the turn at once with `{"status":"waiting","checks":["<bare UUID>"]}` in the exit object, using that bare UUID.',
  'Never wait for it yourself: no `--wait` (obsolete, whatever older sessions say), status polls, log or process reads.',
  'The controller wakes this session with the result: use it exactly (missing, unknown or nonzero is not a pass) and do not return waiting again for those ids; success uses `"checks":[]`.',
  "A failure after the wrapper's own infrastructure rerun is final: a `tool` blocker.",
].join(' ');
/** Whether `<state>/verification-mode` asks for source completion and typing, with original acceptance deferred. */
export function minimalVerification(stateDirectory: string | undefined): boolean {
  if (!stateDirectory) return false;
  try {
    return readFileSync(join(stateDirectory, 'verification-mode'), 'utf8').trim() === 'minimal';
  } catch {
    return false;
  }
}
/** Current execution and result policy, repeated at every prompt boundary. */
export function workerCheckProtocol(
  worktree: string,
  briefOrContract: CheckProtocolBrief | string = '',
  stateDirectory?: string,
  proofRun?: ProofReservation,
  authorization?: ProofAuthorization,
): string {
  if (typeof briefOrContract !== 'string' && proofProtocolAuthorized(briefOrContract, proofRun))
    return [
      'This registered original integrated journey proof has a task-scoped exception to minimal verification.',
      `Captured source: ${proofRun!.binding.sourceCommit}; logical check UUID: ${proofRun!.binding.checkId}.`,
      'Product source, tests and contracts are read-only. Do not edit, typecheck, commit or land. Only check-owned ignored temporary or derived preparation under the original command is permitted.',
      'The controller has already started or replayed this one bound invocation. Use its current evidence; do not start an unbound worker-check or another invocation.',
      `Current owned check evidence: ${JSON.stringify(proofRun!.observation ?? { status: 'unknown', cause: 'Await controller evidence' })}.`,
      `If the supplied check is running, immediately end this turn with {"status":"waiting","checks":["${proofRun!.binding.checkId}"]}. Goal resumes this same session from actual terminal records.`,
      'Do not use --wait, ps, pgrep, log polling, duplicate invocation or an automatic model retry. The wrapper alone owns its one infrastructure rerun and holds the permit throughout.',
      'Use supplied terminal results exactly. Missing, unknown, timed out or nonzero wrapper results stay non-green. Route failed assertions and log evidence to the original Goal owner for a separate minimal product fix.',
      'Finish with structured success and checks:[] only after the owned terminal check passes; no source commit or landing is required.',
    ].join(' ');
  if (typeof briefOrContract !== 'string' && registeredProof(briefOrContract, authorization)) {
    const invocation = ordinaryProofCommand(briefOrContract.acceptance.command).invocation.map(shellQuote).join(' ');
    return [
      'This authenticated registered original proof has a task-scoped exception to minimal verification.',
      `Captured source: ${briefOrContract.proof!.sourceCommit}. Product source, tests and contracts are read-only. Do not edit, commit, land or typecheck. Only ignored check-owned preparation is permitted.`,
      `Run exactly one ordinary worker-check invocation from the worktree root: \`${invocation}\`. Preserve every original argv, environment prefix, input and wrapper flag. An original wrapper is already the invocation: never wrap it again.`,
      'The controller has not started a check for you. Native binding evidence is optional, never a prerequisite for running or success. Never invent a UUID.',
      'If the wrapper returns while its check is active, immediately return {"status":"waiting","checks":["<bare UUID printed by this invocation>"]} with the normal exit fields. Goal waits and wakes this same session with its actual result. Terminal success uses checks:[].',
      'Do not use --wait, ps, pgrep, polling, duplicate invocations or automatic model retries. On wake use the supplied result; never start the command again. The ordinary wrapper alone owns its supported infrastructure rerun.',
      'Success requires the actual declared command to finish with exit zero and unchanged captured source. Missing, unknown and nonzero results stay non-green; return the exact failed assertion or setup error and log reference to the original owner.',
    ].join(' ');
  }
  const workerOwnedAcceptance = typeof briefOrContract !== 'string' && briefOrContract.acceptance.workerOwned === true;
  if (minimalVerification(stateDirectory))
    return [
      'Verification is minimal: do not run acceptance, native or browser checks, a root check, worker-check or remote-check; they run after integration.',
      'Before finishing, type-check each workspace you changed from the worktree root (`bun run --cwd <workspace> typecheck`, or `bun scripts/typecheck.ts` for several) and fix every error; services/kernel and services/auth may use the compiler database or a check host: do not force `env -u KERNEL_CHECK_REMOTE` or local placement.',
      ...(workerOwnedAcceptance
        ? [
            'This brief leaves validation to the worker. Choose or add focused tests that exercise the stated outcome, run them with the landing command below, and report the exact command and actual result; a missing acceptance command is not a pass. Broader acceptance remains deferred under this policy.',
          ]
        : []),
      LONG_WAIT,
      OWN_TESTS,
      'Then commit and return success (blocker null, `"checks":[]`), naming what you completed and the deferred acceptance, which is neither a blocker nor a reason to wait; return waiting only for a still-running check UUID this attempt started.',
      'This policy overrides contract, saved-session and retry-manifest instructions to run acceptance or to start or poll checks.',
    ].join(' ');
  const contractText = typeof briefOrContract === 'string' ? briefOrContract : briefOrContract.markdown;
  const placement: AcceptancePlacement =
    typeof briefOrContract === 'string' ? 'default' : (briefOrContract.acceptance?.placement ?? 'default');
  const command = typeof briefOrContract === 'string' ? undefined : briefOrContract.acceptance?.command;
  const once = workerOwnedAcceptance
    ? 'This brief leaves acceptance to the worker. Choose or add a focused, meaningful check that exercises the stated outcome; no pass is presumed. Run the chosen command once after your last relevant edit and report its exact command and observed result.'
    : 'Check slots are scarce: run your acceptance command once after your last relevant edit.';
  const localRunner = join(worktree, 'scripts/worker-check.ts');
  const namedRunner = namedWorkerCheck(contractText);
  const runner = existsSync(localRunner)
    ? 'bun scripts/worker-check.ts'
    : namedRunner && existsSync(namedRunner)
      ? `bun ${placement === 'local' ? shellQuote(namedRunner) : JSON.stringify(namedRunner)}`
      : undefined;
  if (placement === 'local') {
    const exactCommand = command?.map(shellQuote).join(' ') ?? '<the declared acceptance argv>';
    if (!runner)
      return [
        once,
        LOCAL_PLACEMENT,
        `This base has no worker-check wrapper: run the exact declared local command \`${exactCommand}\` in the foreground from the worktree root, without a wrapper; it gives no check id and no waiting result.`,
        LONG_WAIT,
        REGRESSION,
      ].join(' ');
    return [
      once,
      LOCAL_PLACEMENT,
      `Run it from the worktree root as \`${runner} --local -- ${exactCommand}\`; \`--local\` keeps it off remote hosts.`,
      WRAPPER_RESULT,
      LONG_WAIT,
      REGRESSION,
    ].join(' ');
  }
  if (!runner)
    return [
      once,
      workerOwnedAcceptance
        ? 'This base has no scripts/worker-check.ts; do not add one. Run your focused validation command in the foreground from the worktree root and let it finish; it gives no check id and no waiting result.'
        : 'This base has no scripts/worker-check.ts; do not add one. Run the acceptance command in the foreground from the worktree root and let it finish, then report its actual exit status; it gives no check id and no waiting result.',
      ...(workerOwnedAcceptance ? ['Do not report success unless the chosen validation actually exits zero.'] : []),
      LONG_WAIT,
      REGRESSION,
    ].join(' ');
  return [
    once,
    `Run it from the worktree root as \`${runner} -- <command...>\` with wrapper options the contract names.`,
    WRAPPER_RESULT,
    LONG_WAIT,
    REGRESSION,
  ].join(' ');
}
export function workerPrompt(
  task: Task,
  evidence: string | undefined,
  consultation: string | undefined,
  resolutionFiles: readonly string[],
  mainCheckout: string,
  launchContext?: LaunchContext,
  stateDirectory = join(mainCheckout, '.temp', 'goal'),
): string {
  const frozen = ((task as Task & { frozenFiles?: { path: string }[] }).frozenFiles ?? []).map((file) => file.path);
  const contractMarkdown = launchContext
    ? task.brief.markdown
        .split(/(\n\s*\n)/)
        .map((section) =>
          /\b(?:saved|historical|previous|older)\b/i.test(section) &&
          /\b(?:prompt|instructions?|manifest|session)\b/i.test(section) &&
          /(?:worker-check|--wait)/i.test(section)
            ? '[Superseded historical check instructions are omitted; follow the current acceptance placement below.]'
            : section,
        )
        .join('')
    : task.brief.markdown;
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
  if (task.brief.kind === 'verification')
    return [
      `Work only in ${task.worktree}, at captured commit ${task.brief.proof?.sourceCommit}. The applicable AGENTS.md is already loaded.`,
      `The main checkout ${mainCheckout} is read-only.`,
      task.brief.markdown,
      ...(launchContext ? [renderLaunchContext(launchContext)] : []),
      'Finish with the normal JSON exit object: status, summary, blocker, checks and approaches.',
      workerCheckProtocol(
        task.worktree,
        task.brief,
        stateDirectory,
        task.proofRun?.binding.attempt === task.currentAttempt ? task.proofRun : undefined,
        task.proofAuthorization,
      ),
    ].join('\n\n');
  const devProduct = devProductBrief(task.brief);
  const research = task.brief.kind === 'research';
  const manager = task.brief.manager ?? task.brief.goal ?? '<your manager>';
  const tests = task.workspace ? [] : workerTestCommands(branchChangedPaths(task), task.worktree);
  return [
    `AGENTS.md is already loaded. The main checkout ${mainCheckout} is read-only; write only inside ${task.worktree}${research ? ` and the reference clones under ${mainCheckout}/.reference/` : ''}.`,
    'The contract is self-sufficient: open the workflow skill, docs/development, architecture or scope only for a section it links. Batch reads, read line ranges of large files, read each file once. Never run recursive searches (find, grep -r, rg, du, ls -R) outside the worktree and directories named here.',
    `Commit before each check and after each fix; an attempt without a commit counts as stalled. Send no progress reports. ${
      devProduct && !task.workspace
        ? 'Do not rebase; merge or cherry-pick only what the contract names.'
        : 'Do not rebase or merge.'
    }${devProduct && !research ? " Check the contract's premises against your base first." : ''}`,
    'If the requested behaviour already exists on the clean retained source, do not make an empty or unrelated commit. Report success without source changes; the controller runs the exact frozen acceptance on that bound source. Dirty source, changed contract, or failed or unavailable acceptance stays non-green.',
    research
      ? ''
      : `Write missing acceptance tests the contract names${devProduct ? ' or implies' : ''}; never edit a frozen file. If the contract changes a behaviour an existing test asserts, update that test and list it; keep assertions of unchanged behaviour. Write the fewest tests that pin user-visible behaviour and edge cases (as a rule fewer test lines than product lines) and only stories for states the contract names.`,
    task.workspace
      ? `Peers edit this tree at the same time. There are no path reservations or holds. Commit your own work often with git add <your paths> (never -A or .). Use path-limited commits (git commit --only -- <your paths>) so a peer's staged files stay theirs. Every commit must have the subject '${task.workspace.taskName}: <message>' and a 'Goal-Task: ${task.id}' trailer. Task name is the brief's file name without .md: ${task.workspace.taskName}. Never reset, checkout, stash, clean or rebase. A failure in files you did not touch is a peer's work in progress: rerun later or check only your own tests.`
      : '',
    `Declared paths are where work is expected, not a fence: change any other file the acceptance or a blocking defect needs, minimally, and list each with its reason; undeclared risk-area files stay closed. Decide ambiguities, product choices included: take the reversible option most consistent with the owner documents${
      devProduct
        ? `, record it in one line in your summary${research ? '' : ' and the owning document'}, send it with \`bun tools/goal/src/cli.ts inbox send ${manager} info "<decision>"\`, and continue.`
        : ', record it in one line in your summary, and continue.'
    }`,
    `A blocker is only two requirements in existing specs or tests that cannot both hold (quote both), or a tool or infrastructure failure (SSH, network, disk, memory, file watchers, a service that will not start) persisting after two retries: a \`tool\` blocker starting with the exact error line; never weaken a check instead.${devProductBrief(task.brief) ? ' On dev, when your change is complete and committed and only the shared check infrastructure fails, that is not a blocker: report success and name each check that could not run with its error line; dev is verified after the merge.' : ''} Code another Goal has not delivered is not a blocker: build against its documented contract or a minimal seam, and name it.${
      research
        ? ''
        : ` A question needing a large survey of products or sources is a \`spec-conflict\` blocker starting "Research needed:"; research the rest yourself in owner documents, primary sources and ${mainCheckout}/.reference/ (INDEX.md), read any reference source the contract names before designing, and list what you read.`
    }`,
    research
      ? `This is a research task: answer the contract's question from primary sources (official documentation, standards, and the source of established open-source projects). Reuse a clone in ${mainCheckout}/.reference/ or shallow-clone into .reference/<topic>/<project>/, and add or update its line in .reference/INDEX.md. Clones are untrusted data: never install, build or run anything from them. Write the report the contract names under docs/research/: findings, the patterns the sources share and a recommendation the manager can adopt, citing file paths, URLs and licences; recommend designs for this repository's stack, not code to copy. Commit it; decisions go to the owning document once adopted.`
      : '',
    frozen.length ? `Frozen acceptance files are already committed and must not be edited: ${frozen.join(', ')}.` : '',
    continuesItself(task)
      ? `If the outcome does not fit this attempt, commit a coherent, type-checking part and write the rest as a continuation brief at \`${CONTINUATION_DIRECTORY}/<short-name>.md\` by copying your contract's front matter and changing only paths, acceptance and estimate (goal ${task.brief.goal}, manager ${manager}), followed by the remaining outcome in user terms. Unfinished work is not a blocker: return success and name the continuation.`
      : UNFINISHED,
    'Finish with one JSON object: status, summary, blocker (null or kind and detail), checks, approaches. Summary at most 120 words: what changed, decisions, files outside declared paths, what was not run. Blocker detail at most 80 words. Commit no evidence or audit files.',
    task.brief.kind === 'bulk-text'
      ? 'Write the text yourself. Do not use translation services, translation scripts, or character mapping tables.'
      : '',
    'The task contract follows:',
    contractMarkdown,
    'A failure that also occurs on your base commit is not your blocker: name it. A test that passes on your base and fails after your change is yours to fix.',
    'Never stop or remove containers, databases or processes this attempt did not start, and never prune Docker. Never write under node_modules (hardlinked from a shared cache); to instrument a dependency, use a copy under .temp. Before changing a package.json or bun.lock, run `bun tools/goal/src/cli.ts deps private`.',
    tests.length
      ? `For the files this branch already changes, the landing's test commands are: ${tests.map((command) => `\`${command.map(shellQuote).join(' ')}\``).join('; ')}. Run each once after your last edit, with the tests of any file you change now.`
      : '',
    evidenceText ? `Continue from this retry manifest:\n${evidenceText}` : '',
    evidenceText
      ? 'The retry manifest records a failure from an earlier attempt. Hosts and tools may have been fixed since then. Rerun the failing command once before reporting any blocker about that failure; report a `tool` blocker only if it fails again.'
      : '',
    renderLaunchContext(launchContext),
    consultation ? `Read-only consultation:\n${consultation}` : '',
    storybookPrompt(task),
    resolutionFiles.length
      ? `The control plane has already started a rebase onto current main in this worktree. Conflicted files: ${resolutionFiles.join(', ')}. Resolve and stage them, then run \`git rebase --continue\` until the rebase completes. Do not start another rebase.`
      : '',
    workerCheckProtocol(task.worktree, task.brief, stateDirectory),
  ]
    .filter(Boolean)
    .join('\n\n');
}
/** Paths this task's branch changes against its base, committed or not; empty when Git cannot tell. */
function branchChangedPaths(task: Pick<Task, 'worktree' | 'base'>): string[] {
  if (!task.worktree || !task.base || !existsSync(task.worktree)) return [];
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: task.worktree, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : '';
  };
  const committed = run(['diff', '--name-only', '--no-renames', '-z', task.base, 'HEAD', '--']).split('\0');
  const status = run(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']).split('\0');
  const uncommitted = status.filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
  return [...new Set([...committed, ...uncommitted].filter(Boolean))];
}
/** Per-attempt variables: the attempt's identity, and the base the kernel check selects affected tests against. */
export function attemptEnvironment(
  task: Pick<Task, 'id' | 'base'> & Partial<Pick<Task, 'proofRun'>>,
  attempt: Pick<Attempt, 'attempt'>,
  stateDirectory?: string,
): Record<string, string> {
  return {
    GOAL_TASK_ID: task.id,
    GOAL_ATTEMPT: String(attempt.attempt),
    ...(task.proofRun?.native && task.proofRun.binding.attempt === attempt.attempt
      ? { GOAL_CHECK_REGISTRY: task.proofRun.native.registry }
      : {}),
    // The check runner selects affected tests itself and refuses a caller-supplied base.
    // Fedora's /etc/profile.d/debuginfod.sh exports an absolute certificate path into every login shell unless the
    // variable is already non-empty; Web checks refuse absolute host paths, so give it an inert relative value.
    DEBUGINFOD_IMA_CERT_PATH: 'none',
    // Fedora's gmpopenh264 profile appends to this one, so a relative head keeps the whole value relative.
    MOZ_GMP_PATH: 'none',
    // Fedora's nano-default-editor profile exports an absolute EDITOR unless one is set; a command name keeps it relative.
    EDITOR: 'nano',
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
/** Reconstruct the current prompt's clock, including on adoption; earlier turns cannot buy this turn silence. */
export function workerActivityBaseline(store: WorkerStore, ref: Attempt, now = Date.now()) {
  const event = store.events(ref.taskId, ref.attempt).findLast((event) => event.kind === 'worker-run-started');
  let metadata: { logStartOffset?: unknown; checkWaitBaseline?: unknown } = {};
  try {
    metadata = event ? JSON.parse(event.body) : {};
    if (!metadata || typeof metadata !== 'object') metadata = {};
  } catch {
    // Imported attempts may have no prompt-boundary metadata.
  }
  const nonnegative = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const logStartOffset = nonnegative(metadata.logStartOffset) ? (metadata.logStartOffset as number) : 0;
  const checkWaitBaseline =
    typeof metadata.checkWaitBaseline === 'number' &&
    Number.isFinite(metadata.checkWaitBaseline) &&
    metadata.checkWaitBaseline >= 0
      ? metadata.checkWaitBaseline
      : 0;
  const recordedStart = event ? Date.parse(event.at) : NaN;
  const startedAt = Number.isFinite(recordedStart)
    ? Math.max(Date.parse(ref.startedAt), Math.min(now, recordedStart))
    : Date.parse(ref.startedAt);
  const stat = statSync(ref.logPath, { throwIfNoEntry: false });
  const lastLogSize = stat?.size ?? 0;
  const lastLogMtime = stat?.mtimeMs ?? 0;
  const lastLogActivityAt =
    lastLogSize > logStartOffset ? Math.max(startedAt, Math.min(now, lastLogMtime || now)) : startedAt;
  const totalWait = checkWaitMs(ref.logPath);
  // Preserve waits already recorded during the silent interval, capped to that interval and this prompt's waits.
  const creditedWait = Math.min(Math.max(0, totalWait - checkWaitBaseline), Math.max(0, now - lastLogActivityAt));
  return {
    startedAt,
    logStartOffset,
    checkWaitBaseline,
    lastLogSize,
    lastLogMtime,
    lastLogActivityAt,
    checkWaitAtLastLogActivity: totalWait - creditedWait,
  };
}
export type RunningWorker = {
  child?: ChildProcess;
  exited: Promise<WorkerExit>;
  attempt: Attempt;
  /** Byte offset in the appended run log where this process began writing. */
  logStartOffset?: number;
  /** Whether this process resumed the previous agent session. */
  resuming?: boolean;
};
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
export type CapacityRelease = () => void;
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
  const running = store.runningAttemptsCount() + admittedStarts(stateDirectory);
  return hasCapacity(running, availableMiB(), capacity);
}
/** Stabilize and critical-path starts receive a bounded queue head start while respecting host capacity. */
export function startsFirst(task: Pick<Task, 'taskClass' | 'brief'>): boolean {
  return task.taskClass === 'critical-path' || task.brief.criticalPath === true || task.brief.target === 'stabilize';
}
/**
 * A worker starts only while the host has room: at most maxWorkers running and at least minAvailableMiB of memory
 * available. Otherwise it waits; it is never refused. Fifty-two workers on this host exhausted memory and swap and
 * killed unrelated processes (2026-10-27). `<state>/capacity.json` overrides the defaults and is read on every check.
 */
const CRITICAL_HEAD_START_MS = 30 * 60_000;
export async function awaitHostCapacity(
  store: WorkerStore,
  stateDirectory: string,
  first = false,
  taskId?: string,
  targetAttempt?: number,
  options: { pollIntervalMs?: number; now?: () => number } = {},
): Promise<CapacityRelease> {
  // A host opts in with <state>/capacity.json; without it nothing waits (tests, and hosts that pace by other means).
  const file = join(stateDirectory, 'capacity.json');
  if (!existsSync(file)) return () => {};
  // Waiters hold tickets so the oldest starts first: polling alone let a start wait over an hour behind newer ones.
  const queue = join(stateDirectory, 'capacity-queue');
  // The ticket names its task, so the host can tell a waiting start from a lost one. Critical-path starts used to skip
  // the cap and the queue; with most backend tasks critical path the running count stayed above the cap and ordinary
  // starts (most web tasks) waited for days (2026-10-29). Every start now respects the cap; critical path only dates
  // its ticket half an hour earlier, so it goes ahead of recent waiters without starving older ones.
  const ticket = `${String((options.now?.() ?? Date.now()) - (first ? CRITICAL_HEAD_START_MS : 0)).padStart(15, '0')}-${process.pid}-${taskId ?? crypto.randomUUID()}`;
  mkdirSync(queue, { recursive: true });
  const owner = processIdentity();
  if (!owner) throw new Error('Cannot identify capacity ticket owner');
  writeFileSync(join(queue, ticket), JSON.stringify(owner));
  let reported = false;
  let watcher: ReturnType<typeof watch> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let capacityChanged: (() => void) | undefined;
  try {
    // Watch the directory so atomic replacements and removal wake waiters too. Subscribe before checking capacity
    // so a policy change between the check and the wait cannot be lost. Worker/memory changes still use polling.
    watcher = watch(stateDirectory, (_event, name) => {
      if (name === null || String(name) === 'capacity.json') capacityChanged?.();
    });
    watcher.on('error', () => watcher?.close());
    for (;;) {
      const changed = new Promise<void>((resolve) => {
        capacityChanged = resolve;
      });
      let admissionLease: ReturnType<typeof acquireDirectoryLease>;
      try {
        admissionLease = acquireDirectoryLease(join(stateDirectory, 'capacity-admission-lock'));
      } catch (error) {
        if (!(error instanceof LeaseHeldError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      try {
        if (!existsSync(file)) return () => {};
        let capacity = DEFAULT_CAPACITY;
        try {
          capacity = { ...DEFAULT_CAPACITY, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<HostCapacity>) };
        } catch {
          /* Defaults. */
        }
        const admitted = admittedStarts(stateDirectory);
        const running = store.runningAttemptsCount();
        const ahead = waitersAhead(queue, ticket);
        if (hasCapacity(running + admitted + ahead, availableMiB(), capacity)) {
          const reservation = join(queue, `${ticket}.admitted`);
          renameSync(join(queue, ticket), reservation);
          return releaseWhenStarted(store, reservation, taskId, targetAttempt);
        }
        if (!reported)
          console.error(
            `Waiting for host capacity (${running} workers running, ${ahead} starts ahead, cap ${capacity.maxWorkers}).`,
          );
        reported = true;
      } finally {
        admissionLease.release();
      }
      await Promise.race([
        changed,
        new Promise<void>((resolve) => {
          pollTimer = setTimeout(resolve, Math.max(1, options.pollIntervalMs ?? 15_000));
        }),
      ]);
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  } finally {
    watcher?.close();
    clearTimeout(pollTimer);
    rmSync(join(queue, ticket), { force: true });
  }
}
function admittedStarts(stateDirectory: string): number {
  const queue = join(stateDirectory, 'capacity-queue');
  try {
    return readdirSync(queue).filter((name) => name.endsWith('.admitted') && liveTicket(queue, name)).length;
  } catch {
    return 0;
  }
}
function liveTicket(queue: string, name: string): boolean {
  const [, rawPid] = name.replace(/\.admitted$/, '').split('-');
  const pid = Number(rawPid);
  const identity = processIdentity(pid);
  if (!identity) {
    rmSync(join(queue, name), { force: true });
    return false;
  }
  let contents: string;
  try {
    contents = readFileSync(join(queue, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      rmSync(join(queue, name), { force: true });
      return false;
    }
    return sameProcess(identity);
  }
  try {
    const expected = JSON.parse(contents) as { pid?: unknown; start?: unknown; boot?: unknown; group?: unknown };
    if (expected.pid === pid && typeof expected.start === 'string' && typeof expected.boot === 'string') {
      if (
        identity.start !== expected.start ||
        identity.boot !== expected.boot ||
        (typeof expected.group === 'number' && identity.group !== expected.group)
      ) {
        rmSync(join(queue, name), { force: true });
        return false;
      }
    }
  } catch {
    // Older queue tickets have no identity payload; keep their PID-based liveness behavior.
  }
  if (sameProcess(identity)) return true;
  rmSync(join(queue, name), { force: true });
  return false;
}
function releaseWhenStarted(
  store: WorkerStore,
  reservation: string,
  taskId?: string,
  targetAttempt?: number,
): CapacityRelease {
  const [, rawPid] = reservation.split('-');
  const identity = processIdentity(Number(rawPid));
  let timer: ReturnType<typeof setInterval> | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (timer) clearInterval(timer);
    rmSync(reservation, { force: true });
  };
  timer = setInterval(() => {
    if (!identity || !sameProcess(identity)) {
      release();
      return;
    }
    if (!taskId) return;
    try {
      const attempts = store.attempts(taskId);
      const current =
        targetAttempt === undefined ? attempts.at(-1) : attempts.find((attempt) => attempt.attempt === targetAttempt);
      if (current && current.state !== 'pending' && current.state !== 'waiting') {
        release();
      }
    } catch {
      // Callers release explicitly when preparation fails; transient store errors must not admit another start early.
    }
  }, 250);
  timer.unref();
  return release;
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
    const [, , ...rest] = name.replace(/\.admitted$/, '').split('-');
    if (liveTicket(queue, name)) live.add(rest.join('-'));
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
    const baseName = name.replace(/\.admitted$/, '');
    if (baseName >= ticket || name.endsWith('.admitted')) return false;
    return liveTicket(queue, name);
  }).length;
}
export async function launch(
  store: WorkerStore,
  task: Task,
  attempt: Attempt,
  pool: Pool,
  prompt: string,
  codex?: Settings['codex'],
  resumeSession?: string,
): Promise<RunningWorker> {
  if (!agentAdapter(attempt.profile.cli).canResume) resumeSession = undefined;
  store.assertCurrent(attempt);
  if (
    task.brief.kind === 'verification' &&
    (!registeredProof(task.brief, task.proofAuthorization) ||
      !proofSourceUnchanged(task, task.proofAuthorization?.integrationBranch ?? ''))
  )
    throw new Error('Proof execution unavailable: authenticated exact read-only source registration required');
  recordFlow(store.db, {
    taskId: attempt.taskId,
    attempt: attempt.attempt,
    stage: 'start',
    action: 'requested',
    at: new Date().toISOString(),
  });
  mkdirSync(dirname(attempt.logPath), { recursive: true });
  const exitPath = workerExitPath(attempt.logPath),
    pidPath = `${attempt.logPath}.pid`;
  const fixtureOwner = fixtureOwnerForLaunch(attempt.logPath);
  for (const path of [exitPath, `${exitPath}.tmp`, pidPath]) rmSync(path, { force: true });
  const resuming = Boolean(resumeSession);
  // The branch head at this prompt; the first prompt's head tells whether the attempt made a new commit.
  const startHead = branchHead(task);
  const logStartOffset = resuming ? (statSync(attempt.logPath, { throwIfNoEntry: false })?.size ?? 0) : 0;
  const out = openSync(attempt.logPath, resumeSession ? 'a' : 'w'),
    err = openSync(`${attempt.logPath}.err`, 'w');
  const [program, args] = launchCommand({
    profile: attempt.profile,
    pool,
    worktree: task.worktree,
    prompt,
    mcpServers: storybookServers(task.worktree, task.brief),
    ...(resumeSession ? { resumeSession } : {}),
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
  let unrecordedFixtureWorker: ProcessIdentity | null = null;
  try {
    // Publication and spawn share the fence's write lock. A retry cannot miss a just-started process.
    store.write(attempt, () => {
      store.event(attempt, 'worker-run-started', {
        logStartOffset,
        resuming,
        checkWaitBaseline: checkWaitMs(attempt.logPath),
        branchHead: startHead,
      });
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
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : 0;
      const identity = processIdentity(pid);
      if (identity && fixtureOwner) {
        unrecordedFixtureWorker = identity;
        recordFixtureOwnedProcess(attempt.logPath, 'worker', identity);
        unrecordedFixtureWorker = null;
      }
      if (started.error) throw started.error;
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
  } catch (error) {
    if (unrecordedFixtureWorker) {
      try {
        await terminateProcessGroup(unrecordedFixtureWorker, 250);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'fixture ownership failed and its worker could not be reaped');
      }
    }
    throw error;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const saved = store.attempt(attempt);
  const exited = waitForWorkerExit(saved.process, attempt.logPath);
  void exited.catch(() => {});
  return { exited, attempt: saved, logStartOffset, resuming };
}
