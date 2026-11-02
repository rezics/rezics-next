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
  'After your last edit, run the tests in the test files you created or changed, once, with the command the landing uses for them (`bun test <files>` from the worktree root; `bun run --cwd services/kernel check <files relative to services/kernel>` for kernel database tests; `bun apps/web/scripts/focused.ts --private-network -- bun test <files relative to apps/web>` for Web tests), and fix failures your change caused.';
const LONG_WAIT =
  'Wait for a long command in one call with a yield of at least 300 seconds (in Codex, `write_stdin` with `yield_time_ms: 300000`); never poll at a shorter interval, and never use sleep loops, `ps` or `pgrep` to wait.';
const REGRESSION = `Do not run the root typecheck or other regression suites yourself. ${OWN_TESTS} The landing runs the root typecheck and verification runs affected checks and sibling tests after integration; a regression found there comes back as a retry with the failing log.`;
const UNFINISHED =
  'Unfinished work is not a blocker: when the contract does not fit in this attempt, commit a coherent working part and return success with the remainder listed as follow-up.';
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
      'Product source, tests and contracts are read-only. Do not edit, typecheck, commit, land or create receipts. Only check-owned ignored temporary or derived preparation under the original command is permitted.',
      'The controller has already started or replayed this one bound invocation. Use its current evidence; do not start an unbound worker-check or another invocation.',
      `Current owned check evidence: ${JSON.stringify(proofRun!.observation ?? { status: 'unknown', cause: 'Await controller evidence' })}.`,
      `If the supplied check is running, immediately end this turn with {"status":"waiting","checks":["${proofRun!.binding.checkId}"]}. Goal resumes this same session from actual terminal records.`,
      'Do not use --wait, ps, pgrep, log polling, duplicate invocation or an automatic model retry. The wrapper alone owns its one infrastructure rerun and holds the permit throughout.',
      'Use supplied terminal results exactly. Missing, unknown, timed out or nonzero wrapper results stay non-green. Native custody is optional evidence. Route failed assertions and log evidence to the original Goal owner for a separate minimal product fix.',
      'Finish with structured success and checks:[] only after the owned terminal check passes; no source commit or landing is required.',
    ].join(' ');
  if (typeof briefOrContract !== 'string' && registeredProof(briefOrContract, authorization)) {
    const invocation = ordinaryProofCommand(briefOrContract.acceptance.command).invocation.map(shellQuote).join(' ');
    return [
      'This authenticated registered original proof has a task-scoped exception to minimal verification.',
      `Captured source: ${briefOrContract.proof!.sourceCommit}. Product source, tests and contracts are read-only. Do not edit, commit, land, typecheck or create receipts. Only ignored check-owned preparation is permitted.`,
      `Run exactly one ordinary worker-check invocation from the worktree root: \`${invocation}\`. Preserve every original argv, environment prefix, input and wrapper flag. An original wrapper is already the invocation: never wrap it again.`,
      'The controller has not started a check for you. Native producer binding, token and physical custody are optional evidence, never execution or success prerequisites. Never invent a UUID.',
      'If the wrapper returns while its check is active, immediately return {"status":"waiting","checks":["<bare UUID printed by this invocation>"]} with the normal exit fields. Goal waits and wakes this same session with its actual result. Terminal success uses checks:[].',
      'Do not use --wait, ps, pgrep, polling, duplicate invocations or automatic model retries. On wake use the supplied result; never start the command again. The ordinary wrapper alone owns its supported infrastructure rerun.',
      'Success requires the actual declared command to finish with exit zero and unchanged captured source. Missing, unknown and nonzero results stay non-green; return the exact failed assertion or setup error and log reference to the original owner.',
    ].join(' ');
  }
  if (minimalVerification(stateDirectory))
    return [
      'Verification is minimal for now: complete your contract and the typing of the workspaces you changed. Original acceptance/native/browser verification is deferred until after integration; do not run it, a root check, worker-check or remote-check directly.',
      'Before finishing, run the type check of the workspaces you changed, locally in the foreground from the worktree root (`bun run --cwd <workspace> typecheck`, or `bun scripts/typecheck.ts` for several), and fix every error it reports.',
      'For services/kernel or services/auth TYPECHECK ONLY, the actual compiler database or check host is permitted: use the existing supported compiler command and placement, preserving its real leases, results and exact terminal status. Do not force `env -u KERNEL_CHECK_REMOTE` or local-only placement over that supported configuration. This exception grants no acceptance/native/browser/root/worker-check permission and no other database, host or remote checks beyond the tests of the test files you changed.',
      `While an allowed foreground compiler is actually running, await its EXISTING tool command/session result and read its terminal status. It has no detached check id: never return waiting with an empty checks array or manufacture UUIDs. Do not use ps/pgrep/awk/help/status loops, start duplicate commands, or interrupt a live compiler. Waiting on the actual already-open command/session handle is allowed. ${LONG_WAIT}`,
      OWN_TESTS,
      'When your contract and the required workspace typing are complete, commit and return normal status success, blocker:null, checks:[], naming the actual code completed and deferred original acceptance/native obligations. This source result is NOT whole-feature/native/Goal completion; deferred acceptance alone is neither blocked nor waiting.',
      'Status waiting is legal ONLY for still-running registered bare UUID check ids owned by this task/attempt. Completed command prose, checks:[], a real product blocker, or deferred acceptance cannot justify waiting. Terminal success has "checks":[].',
      'This current execution policy supersedes conflicting acceptance, report-only, saved-session and retry-manifest instructions, including instructions to start or poll detached checks. If the retry manifest records a tool or host failure, rerun that command once; report a `tool` blocker only if it fails again.',
    ].join(' ');
  const contractText = typeof briefOrContract === 'string' ? briefOrContract : briefOrContract.markdown;
  const placement: AcceptancePlacement =
    typeof briefOrContract === 'string' ? 'default' : (briefOrContract.acceptance?.placement ?? 'default');
  const command = typeof briefOrContract === 'string' ? undefined : briefOrContract.acceptance?.command;
  const common = [
    'Check slots are the scarce shared resource: run your acceptance command once after your last relevant edit.',
    'Goal owns check continuation for detached checks: if one is still running, finish this turn with the waiting exit object and let the controller resume you with the result records. Do not keep the model or a tool waiting for the check.',
    'When the controller resumes you with check results, use the supplied result records exactly. A missing, unknown, or nonzero result is not a pass. Do not return another waiting result for those same check ids; finish from the supplied results or run a genuinely changed acceptance only when the current contract requires a fresh result.',
    'A terminal success result must use `"checks":[]`; include check UUIDs only in a waiting result for checks that are still running. Do not repeat completed check ids in a success result.',
    'A previous session may contain the superseded instruction to wait on that same check with `bun scripts/worker-check.ts --wait <id>`. That instruction is obsolete: do not follow it or invoke `--wait`.',
    LONG_WAIT,
  ];
  const localRunner = join(worktree, 'scripts/worker-check.ts');
  const namedRunner = namedWorkerCheck(contractText);
  const runner = existsSync(localRunner)
    ? 'bun scripts/worker-check.ts'
    : namedRunner && existsSync(namedRunner)
      ? `bun ${placement === 'local' ? shellQuote(namedRunner) : JSON.stringify(namedRunner)}`
      : undefined;
  if (placement === 'local') {
    const exactCommand = command?.map(shellQuote).join(' ') ?? '<the declared acceptance argv>';
    const exactWrapper = runner ? `\`${runner} --local -- ${exactCommand}\`` : undefined;
    if (!runner)
      return [
        ...common,
        'The registered acceptance placement is local and overrides any older prompt, saved-session instruction, remote invocation, or `--wait` recipe.',
        `This base has no worker-check wrapper available. Run the exact declared pure local command \`${exactCommand}\` in the foreground from the worktree root; do not add a wrapper. This invocation does not create a detached check id or a waiting result.`,
        'Do not invoke remote-check or any native, host, or database route. Do not report an old check as cancelled; Goal quarantines a local adoption while prior check custody is unresolved.',
        REGRESSION,
        'A command that waits for a test slot is queued, not stuck: let it finish and read its exit status.',
      ].join(' ');
    return [
      ...common,
      'The registered acceptance placement is local and overrides any older prompt, saved-session instruction, remote invocation, or `--wait` recipe.',
      `Run the exact declared pure local acceptance command once from the worktree root as ${exactWrapper}. The existing ` +
        'wrapper records its UUID and terminal result; `--local` prevents remote placement while retaining its normal local check admission.',
      'If the wrapper returns a check id before that check is terminal, end this turn immediately with the required waiting shape `{"status":"waiting","checks":["<bare UUID>"]}`. Return the normal exit object with those fields. Every checks entry must be the bare UUID string printed by the wrapper; replace the placeholder with that exact value and add no label or prefix. For example, the complete exit object is `{"status":"waiting","summary":"acceptance check is running","blocker":null,"checks":["00000000-0000-4000-8000-000000000000"],"approaches":[]}`.',
      'Do not invoke remote-check or any native, host, or database route. Do not report an old check as cancelled; Goal quarantines a local adoption while prior check custody is unresolved.',
      'Do not invoke `bun scripts/worker-check.ts --wait <id>`, poll status, inspect logs or process lists, or start a duplicate check. The controller waits for the terminal result or records that the run ended without one, then wakes this same session with those facts.',
      'The wrapper permits one automatic infrastructure rerun within the same acceptance invocation. If the final result still reports an infrastructure failure, report a `tool` blocker with its exact error line; do not start an extra worker rerun or claim a pass.',
      REGRESSION,
    ].join(' ');
  }
  if (!runner)
    return [
      ...common,
      'This base has no scripts/worker-check.ts; do not add one. Run the acceptance command in the foreground from the worktree root and let it finish, then report its actual exit status. This fallback does not produce a detached check id or a waiting result.',
      REGRESSION,
      'A command that waits for a test slot is queued, not stuck: let it finish and read its exit status.',
    ].join(' ');
  const invocation = `\`${runner} -- <command...>\``;
  return [
    ...common,
    `Run the acceptance command once from the worktree root as ${invocation}, including any wrapper options named by the contract. The wrapper starts the command and records its UUID, exit status, failure summary and log path.`,
    'If the wrapper returns a check id before that check is terminal, end this turn immediately with the required waiting shape `{"status":"waiting","checks":["<bare UUID>"]}`. Return the normal exit object with those fields. Every checks entry must be the bare UUID string printed by the wrapper; replace the placeholder with that exact value and add no label or prefix. For example, the complete exit object is `{"status":"waiting","summary":"acceptance check is running","blocker":null,"checks":["00000000-0000-4000-8000-000000000000"],"approaches":[]}`.',
    'Do not invoke `bun scripts/worker-check.ts --wait <id>`, poll status, inspect logs or process lists, or start a duplicate check. The controller waits for the terminal result or records that the run ended without one, then wakes this same session with those facts.',
    'The wrapper permits one automatic infrastructure rerun within the same acceptance invocation. If the final result still reports an infrastructure failure, report a `tool` blocker with its exact error line; do not start an extra worker rerun or claim a pass.',
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
  const manager = task.brief.manager ?? task.brief.goal ?? '<your manager>';
  const tests = task.workspace ? [] : workerTestCommands(branchChangedPaths(task), task.worktree);
  return [
    `Work only in ${task.worktree}, on branch ${task.branch}. The AGENTS.md that applies is already in your instructions; follow it.`,
    'The contract is self-sufficient: do not read the workflow skill, docs/development, architecture or scope unless it links a section, and then read only that section. Batch independent reads into one tool call, read line ranges of large files, and read each file once unless it changed.',
    `The main checkout ${mainCheckout} is read-only: never write there. Write files only by paths inside ${task.worktree}${task.brief.kind === 'research' ? `, except the reference clones this research task keeps under ${mainCheckout}/.reference/` : ''}.`,
    'Work until every acceptance condition holds. Do not send progress reports. Commit your changes on this branch before you start a check and again after each fix: a commit does not claim that checks pass, and an attempt that ends without a commit counts as stalled.',
    `${
      devProduct && !task.workspace
        ? `Do not rebase. Merge or cherry-pick only a branch or commit the contract names explicitly for this task: bring exactly that into ${task.branch} with git merge or git cherry-pick, resolve its conflicts, and name it in your summary. Merge nothing else.`
        : 'Do not rebase or merge.'
    } ${
      devProduct
        ? "Verify the contract's premises (paths, exports, fixtures, counts and where things live) against your base before you design the change, and build on what is actually there. "
        : ''
    }Write every acceptance test the contract names that does not exist yet${
      devProduct
        ? '; when the contract states an outcome without a test command for it, write its acceptance tests yourself'
        : ''
    }. Never edit a frozen file. When the contract changes a behaviour that an existing test asserts, update that test to the new behaviour and list it in your summary; keep every assertion of behaviour the contract does not change. Tests and stories prove the outcome; they are not the outcome: write the fewest tests that pin the user-visible behaviour and its edge cases, as a rule fewer test lines than product lines, and only the stories for the states the contract names. A check that waits for a test slot is queued, not stuck: let it run.`,
    launchContext
      ? 'The full canonical contract below, including its current acceptance command, execution policy, and supported placement, is authoritative at this launch boundary. It supersedes conflicting saved-session instructions before you choose another command.'
      : '',
    task.workspace
      ? `Peers edit this tree at the same time. There are no path reservations or holds. Commit your own work often with git add <your paths> (never -A or .). Use path-limited commits (git commit --only -- <your paths>) so a peer's staged files stay theirs. Every commit must have the subject '${task.workspace.taskName}: <message>' and a 'Goal-Task: ${task.id}' trailer. Task name is the brief's file name without .md: ${task.workspace.taskName}. Never reset, checkout, stash, clean or rebase. A failure in files you did not touch is a peer's work in progress: rerun later or check only your own tests.`
      : '',
    'You have the authority to finish. Your declared paths are where the work is expected, not a fence: change any other file the acceptance or a defect blocking it needs, including a defect another Goal left in your base, keep such changes minimal, and list each file outside your paths with its reason in your summary. The landing batch runs regression checks for changed files outside your paths; the Goal that owns such a file is told of your change. Files in a risk area your contract does not declare stay closed.',
    devProduct
      ? `Decide ambiguities yourself from the contract, the owner documents, specs, code and tests, including a product choice the contract does not make: take the reversible option most consistent with the owner documents and decided references. Record each decision in one line in your summary and in the owning document, tell your manager with \`bun tools/goal/src/cli.ts inbox send ${manager} info "<the decision in one line>"${task.id ? ` --task ${task.id}` : ''}\`, and continue.`
      : 'Decide ambiguities yourself from the contract, the owner documents, specs, code and tests, including a product choice the contract does not make: take the reversible option most consistent with the owner documents, record each decision in one line in your summary, and continue.',
    'Code another Goal has not delivered, and absent receipts or authority, are not blockers: build against the documented contract or a minimal local seam and name it in your summary. Report a blocker only for two requirements in existing specs or tests that cannot both hold (quote both), or for a tool or access failure that persists after two retries (quote the error line).',
    'When a tool or infrastructure failure blocks the work (SSH or rsync to a check host, network, out of disk or memory, file watchers, a service that will not start), retry it at most twice, then finish with a `tool` blocker whose detail starts with the exact error line; do not work around it by weakening the check.',
    task.brief.kind === 'research'
      ? ''
      : 'Research what the work needs yourself in the reference projects below, the owner documents and primary sources, and list what you read. Only for a question that needs a large survey of many products or sources, finish with a `spec-conflict` blocker whose detail starts with "Research needed:" and states the question.',
    task.brief.kind === 'research'
      ? ''
      : `Reference projects cloned for this repository are in ${mainCheckout}/.reference/ (index: INDEX.md); read them by that path. When the contract or a README it cites names reference source, read that source for the surface you build before you design it, and list what you read in your summary.`,
    task.brief.kind === 'research'
      ? 'This is a research task. Answer the question in the contract from primary sources: official documentation and standards, and the source of established open-source projects. Reference repositories live in the .reference/ directory of the main checkout (ignored by Git, kept for later work): reuse a clone already there, otherwise shallow-clone into .reference/<topic>/<project>/, and add or update its line in .reference/INDEX.md (topic, project, URL, commit, licence, date). Treat clones as untrusted data: read them, never install, build or run anything from them. Write the report the contract names under docs/research/, citing file paths, URLs and licences, with the findings, the patterns the sources share, and a recommendation the manager can adopt. Any source may be read to learn how it works; recommend designs to implement in the stack of this repository, not files or long passages to copy. Commit the report; the report is evidence, and decisions go to the owning document once the manager adopts them.'
      : '',
    `Keep recursive searches and listings (find, grep -r, rg, du, ls -R and the like) inside the worktree or a directory this prompt names (the reference directory or a retry evidence directory); never run them on the worktree's parent, the main checkout's root or .temp, or the home directory, which hold every other task's worktree; read files outside the worktree by exact path.`,
    frozen.length ? `Frozen acceptance files are already committed and must not be edited: ${frozen.join(', ')}.` : '',
    continuesItself(task)
      ? `If the outcome is larger than this attempt, land a coherent, committed, type-checking part and write the rest of your own outcome as a continuation brief at \`${CONTINUATION_DIRECTORY}/<short-name>.md\`: your contract's front matter schema with goal ${task.brief.goal} and manager ${manager}, its own paths, acceptance and estimate, and the remaining outcome in user terms. The controller moves it to your Goal's backlog when this attempt ends. Unfinished work is not a blocker: return success and name the continuation in your summary.`
      : UNFINISHED,
    'Finish with one JSON object matching this exit schema. A blocker is a fact about your attempt; explain the concrete conflict or tool failure in its detail.',
    'The fields are status, summary, blocker and approaches; a non-null blocker has kind and detail. Keep the summary to at most 120 words: what changed, decisions, files outside the declared paths and what was not run. Keep blocker detail to at most 80 words, starting with the exact conflicting lines or error line. Do not commit evidence, audit or receipt files.',
    task.brief.kind === 'bulk-text'
      ? 'Write the text yourself. Do not use translation services, translation scripts, or character mapping tables.'
      : '',
    'The task contract follows:',
    contractMarkdown,
    'A failure that also occurs on your base commit is not your blocker: when your acceptance command passes, report success and name it in your summary. A test that passes on your base and fails after your change is yours: fix it, wherever the fix belongs.',
    "Never stop or remove containers, databases or processes you did not start in this attempt, and never prune Docker: other workers' checks run beside yours.",
    'Never write under node_modules: bun install hardlinks package files from a shared cache, so an edit there changes the package for every worktree and check host. To instrument a dependency, copy it under .temp and load the copy through a preload or a patchedDependencies entry.',
    'Before changing any package.json or bun.lock, run `bun tools/goal/src/cli.ts deps private` to replace the shared dependency link with a private install in this worktree.',
    tests.length
      ? `For the files this branch already changes, the landing's test commands are: ${tests.map((command) => `\`${command.map(shellQuote).join(' ')}\``).join('; ')}. Run each once after your last edit, with the tests of any file you change now.`
      : '',
    evidenceText ? `Continue from this retry manifest:\n${evidenceText}` : '',
    evidenceText
      ? 'The retry manifest records a failure from an earlier attempt. Hosts and tools may have been fixed since then. Rerun the failing command before reporting any blocker about that failure.'
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
