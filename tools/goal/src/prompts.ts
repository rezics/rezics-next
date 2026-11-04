import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { workerTestCommands } from './affected-tests.ts';
import { CONTINUATION_DIRECTORY, continuesItself } from './continuation.ts';
import { renderLaunchContext, type LaunchContext } from './launch-context.ts';
import { storybookServers } from './storybook.ts';
import {
  ordinaryProofCommand,
  proofProtocolAuthorized,
  registeredProof,
  type ProofAuthorization,
  type ProofReservation,
} from './verification.ts';
import { acceptanceRequirements, devProductBrief } from './briefs.ts';
import type { AttemptRef } from './contracts.ts';
import type { AcceptanceRequirement, Attempt, Brief, PromptManifest, Task } from './types.ts';

export const DEFAULT_PROMPT_DIRECTORY = join(import.meta.dir, '../prompts');
export const CONDITION_IDS = [
  'minimal-verification',
  'proof-run',
  'registered-proof',
  'local-placement',
  'no-wrapper',
  'wrapper',
  'shared-workspace',
  'retry',
  'rebase',
  'storybook',
  'bulk-text',
  'continuation',
] as const;
export type ConditionId = (typeof CONDITION_IDS)[number];

const PLACEHOLDER = /\{\{(policy|task)\.([A-Za-z0-9_.]+)\}\}/g;
const RETRY_WORDS = ['zero', 'one', 'two'] as const;
const WRAPPER_RESULT =
  'If the wrapper prints a check id before the check ends, end the turn at once with `{"status":"waiting","checks":["<bare UUID>"]}` in the exit object, using that bare UUID. Never wait for it yourself: no `--wait` (obsolete, whatever older sessions say), status polls, log or process reads. The controller wakes this session with the result: use it exactly (missing, unknown or nonzero is not a pass) and do not return waiting again for those ids; success uses `"checks":[]`. A failure after the wrapper\'s own infrastructure rerun is final: a `tool` blocker. ';
const OWNED_ONCE =
  'This brief leaves acceptance to the worker. Choose or add a focused, meaningful check that exercises the stated outcome; no pass is presumed. Run the chosen command once after your last relevant edit and report its exact command and observed result.';
const SCARCE_ONCE = 'Check slots are scarce: run your acceptance command once after your last relevant edit.';
const CHECK_CONDITIONS = new Set<ConditionId>([
  'minimal-verification',
  'proof-run',
  'registered-proof',
  'local-placement',
  'no-wrapper',
  'wrapper',
]);
const WAIT =
  'Wait for a long command, even one queued for a test slot, in its open session with one yield of at least {{task.waitSeconds}} seconds (Codex: `write_stdin`, `yield_time_ms: {{task.waitMs}}`); never start a duplicate, interrupt it, poll faster, or use sleep loops, `ps` or `pgrep`.';
const OWN_TESTS =
  "After your last edit, run the test files you created or changed once, with the landing's command (`bun test <files>`; services/kernel: `bun run --cwd services/kernel check <files>`; apps/web: `bun apps/web/scripts/focused.ts --private-network -- bun test <files>`), and fix failures you caused.";
const REGRESSION = `Do not run the root typecheck or other regression suites yourself; the landing runs them. ${OWN_TESTS}`;
const PROTOCOL_FOOTER: Partial<Record<ConditionId, string>> = {
  'minimal-verification': `${WAIT} ${OWN_TESTS}`,
  'local-placement': `${WAIT} ${REGRESSION}`,
  wrapper: `${WAIT} ${REGRESSION}`,
  'no-wrapper': `${WAIT} ${REGRESSION}`,
};

type TemplateCache = { mtimeMs: number; size: number; text: string; sha: string };
const templateCache = new Map<string, TemplateCache>();

export type PromptView = Record<string, string>;
export type RenderedPrompt = {
  prompt: string;
  manifest: PromptManifest;
  deferredAcceptance: AcceptanceRequirement[];
  roleBytes: number;
  conditionBytes: number;
  conditionPromptBytes: number;
  briefBytes: number;
};
export type WorkerPromptInput = {
  task: Task;
  evidence?: string | undefined;
  consultation?: string | undefined;
  resolutionFiles?: readonly string[];
  mainCheckout: string;
  launchContext?: LaunchContext | undefined;
  stateDirectory?: string | undefined;
  policy?: ControlPolicy | undefined;
  promptDirectory?: string | undefined;
  proofRun?: ProofReservation | undefined;
  authorization?: ProofAuthorization | undefined;
};

export function gitBlobSha(content: string | Buffer): string {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function policyHash(policy: ControlPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

export function readTemplate(path: string): { text: string; sha: string } {
  const stat = statSync(path);
  const hit = templateCache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const text = readFileSync(path, 'utf8');
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, text, sha: gitBlobSha(text) };
  templateCache.set(path, entry);
  return entry;
}

function lookup(root: unknown, path: string, label: string): string {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current as object, key))
      throw new Error(`unknown placeholder {{${label}.${path}}}`);
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined || current === null) throw new Error(`unknown placeholder {{${label}.${path}}}`);
  return String(current);
}

export function fillTemplate(template: string, task: PromptView, policy: ControlPolicy): string {
  return template.replace(PLACEHOLDER, (_match, root: string, path: string) =>
    root === 'policy' ? lookup(policy, path, 'policy') : lookup(task, path, 'task'),
  );
}

function splitFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const parsed = Bun.YAML.parse(match[1]!);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('condition front matter must be an object');
  return { data: parsed as Record<string, unknown>, body: text.slice(match[0].length) };
}

function collapse(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
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

export function minimalVerification(stateDirectory: string | undefined): boolean {
  if (!stateDirectory) return false;
  try {
    return readFileSync(join(stateDirectory, 'verification-mode'), 'utf8').trim() === 'minimal';
  } catch {
    return false;
  }
}

function branchChangedPaths(task: Pick<Task, 'worktree' | 'base'>, policy: ControlPolicy): string[] {
  if (!task.worktree || !task.base || !existsSync(task.worktree)) return [];
  const run = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: task.worktree,
      encoding: 'utf8',
      maxBuffer: policy.workerPrompt.gitBufferBytes,
    });
    return result.status === 0 ? result.stdout : '';
  };
  const committed = run(['diff', '--name-only', '--no-renames', '-z', task.base, 'HEAD', '--']).split('\0');
  const status = run(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']).split('\0');
  const uncommitted = status.filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
  return [...new Set([...committed, ...uncommitted].filter(Boolean))];
}

function wrapperRunner(
  worktree: string,
  brief: Pick<Brief, 'acceptance' | 'markdown'> & Partial<Brief>,
): { runner: string | undefined; local: boolean } {
  const placement = brief.acceptance?.placement ?? 'default';
  const localRunner = join(worktree, 'scripts/worker-check.ts');
  const named = namedWorkerCheck(typeof brief.markdown === 'string' ? brief.markdown : '');
  const runner = existsSync(localRunner)
    ? 'bun scripts/worker-check.ts'
    : named && existsSync(named)
      ? `bun ${placement === 'local' ? shellQuote(named) : JSON.stringify(named)}`
      : undefined;
  return { runner, local: placement === 'local' };
}

type CheckProtocolBrief = Pick<Brief, 'acceptance' | 'markdown'> & Partial<Brief>;

function evidenceManifest(evidence: string | undefined): string {
  if (!evidence) return '';
  const failurePath = join(evidence, 'failure.json');
  if (!existsSync(failurePath)) return `Retry evidence directory: ${evidence}`;
  try {
    const document = JSON.parse(readFileSync(failurePath, 'utf8')) as { manifest?: unknown };
    return typeof document.manifest === 'string' ? document.manifest : `Retry evidence directory: ${evidence}`;
  } catch {
    return `Retry evidence directory: ${evidence}`;
  }
}

export function selectConditions(input: {
  task: Task;
  evidence?: string | undefined;
  resolutionFiles?: readonly string[];
  stateDirectory?: string | undefined;
  proofRun?: ProofReservation | undefined;
  authorization?: ProofAuthorization | undefined;
}): ConditionId[] {
  const { task } = input;
  const selected: ConditionId[] = [];
  const brief = task.brief;
  const proofRun = input.proofRun ?? (task.proofRun?.binding.attempt === task.currentAttempt ? task.proofRun : undefined);
  const authorization = input.authorization ?? task.proofAuthorization;
  if (proofProtocolAuthorized(brief, proofRun)) selected.push('proof-run');
  else if (registeredProof(brief, authorization)) selected.push('registered-proof');
  else if (minimalVerification(input.stateDirectory)) selected.push('minimal-verification');
  else {
    const { runner, local } = wrapperRunner(task.worktree, brief);
    if (local) selected.push('local-placement');
    else selected.push(runner ? 'wrapper' : 'no-wrapper');
  }
  if (task.workspace) selected.push('shared-workspace');
  if (input.evidence) selected.push('retry');
  if (input.resolutionFiles?.length) selected.push('rebase');
  if (storybookServers(task.worktree, brief).length) selected.push('storybook');
  if (brief.kind === 'bulk-text') selected.push('bulk-text');
  if (continuesItself(task)) selected.push('continuation');
  return selected;
}

function conditionDefers(data: Record<string, unknown>): AcceptanceRequirement[] {
  const raw = data.defers;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => item !== 'browser' && item !== 'native' && item !== 'root'))
    throw new Error('condition defers must be a list of browser, native and root');
  return raw as AcceptanceRequirement[];
}

function deferredSentence(items: AcceptanceRequirement[]): string {
  if (!items.length) return '';
  const names = items.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `${names} ${items.length === 1 ? 'is' : 'are'} deferred to the verifier.`;
}

function promptView(input: WorkerPromptInput): PromptView {
  const policy = input.policy ?? defaultPolicy;
  const { task, mainCheckout } = input;
  const brief = task.brief;
  const research = brief.kind === 'research';
  const product = devProductBrief(brief);
  const manager = brief.manager ?? brief.goal ?? '<your manager>';
  const owned = brief.acceptance?.workerOwned === true;
  const { runner, local } = wrapperRunner(task.worktree, brief);
  const command = brief.acceptance?.command;
  const exactCommand = command?.map(shellQuote).join(' ') ?? '<the declared acceptance argv>';
  const servers = storybookServers(task.worktree, brief);
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const frozen = ((task as Task & { frozenFiles?: { path: string }[] }).frozenFiles ?? []).map((file) => file.path);
  const tests = task.workspace ? [] : workerTestCommands(branchChangedPaths(task, policy), task.worktree);
  const proofRun =
    input.proofRun ?? (task.proofRun?.binding.attempt === task.currentAttempt ? task.proofRun : undefined);
  const authorization = input.authorization ?? task.proofAuthorization;
  const proofSource =
    proofRun?.binding.sourceCommit ??
    brief.proof?.sourceCommit ??
    '';
  const proofCheckId = proofRun?.binding.checkId ?? '';
  const proofObservation = JSON.stringify(proofRun?.observation ?? { status: 'unknown', cause: 'Await controller evidence' });
  const proofInvocation = registeredProof(brief, authorization)
    ? ordinaryProofCommand(brief.acceptance.command).invocation.map(shellQuote).join(' ')
    : '';
  const localRun = runner
    ? `Run it from the worktree root as \`${runner} --local -- ${exactCommand}\`; \`--local\` keeps it off remote hosts.`
    : `This base has no worker-check wrapper: run the exact declared local command \`${exactCommand}\` in the foreground from the worktree root, without a wrapper; it gives no check id and no waiting result.`;
  return {
    id: task.id ?? '',
    goal: brief.goal ?? '',
    manager,
    mainCheckout,
    worktree: task.worktree,
    researchWriteScope: research ? ` and the reference clones under ${mainCheckout}/.reference/` : '',
    mergeRule:
      product && !task.workspace
        ? 'Do not rebase; merge or cherry-pick only what the contract names.'
        : 'Do not rebase or merge.',
    premiseCheck: product && !research ? " Check the contract's premises against your base first." : '',
    acceptanceTests: research
      ? ''
      : `Write missing acceptance tests the contract names${product ? ' or implies' : ''}; never edit a frozen file. If the contract changes a behaviour an existing test asserts, update that test and list it; keep assertions of unchanged behaviour. Write the fewest tests that pin user-visible behaviour and edge cases (as a rule fewer test lines than product lines) and only stories for states the contract names.`,
    decisionFollowThrough: product
      ? `, record it in one line in your summary${research ? '' : ' and the owning document'}, send it with \`bun tools/goal/src/cli.ts inbox send ${manager} info "<decision>"\`, and continue.`
      : ', record it in one line in your summary, and continue.',
    toolFailureRetries: RETRY_WORDS[policy.guidance.toolFailureRetries] ?? String(policy.guidance.toolFailureRetries),
    devInfrastructure: product
      ? ' On dev, when your change is complete and committed and only the shared check infrastructure fails, that is not a blocker: report success and name each check that could not run with its error line; dev is verified after the merge.'
      : '',
    researchNeeded: research
      ? ''
      : ' A question needing a large survey of products or sources is a `spec-conflict` blocker starting "Research needed:"; research the rest yourself in owner documents, primary sources and the main checkout\'s .reference/ (INDEX.md), read any reference source the contract names before designing, and list what you read.',
    frozenFilesLine: frozen.length
      ? `Frozen acceptance files are already committed and must not be edited: ${frozen.join(', ')}.`
      : '',
    unfinished: continuesItself(task)
      ? ''
      : 'Unfinished work is not a blocker: if the contract does not fit this attempt, commit a coherent working part and return success with the remainder listed as follow-up.',
    continuationBriefPath: `${CONTINUATION_DIRECTORY}/<short-name>.md`,
    waitSeconds: String(policy.guidance.longCommandWaitMs / 1000),
    waitMs: String(policy.guidance.longCommandWaitMs),
    checkOnce: owned ? OWNED_ONCE : SCARCE_ONCE,
    noWrapperRun: owned
      ? 'This base has no scripts/worker-check.ts; do not add one. Run your focused validation command in the foreground from the worktree root and let it finish; it gives no check id and no waiting result.'
      : 'This base has no scripts/worker-check.ts; do not add one. Run the acceptance command in the foreground from the worktree root and let it finish, then report its actual exit status; it gives no check id and no waiting result.',
    ownedNoWrapperTail: owned ? ' Do not report success unless the chosen validation actually exits zero.' : '',
    wrapperInvocation: runner ? `${runner} -- <command...>` : '',
    wrapperResult: local && runner ? WRAPPER_RESULT : '',
    localRun,
    minimalOwned: owned
      ? 'This brief leaves validation to the worker. Choose or add focused tests that exercise the stated outcome, run them with the landing command below, and report the exact command and actual result; a missing acceptance command is not a pass. Broader acceptance remains deferred under this policy. '
      : '',
    proofSourceCommit: proofSource,
    proofCheckId,
    proofObservation,
    proofInvocation,
    workspaceTaskName: task.workspace?.taskName ?? '',
    evidenceManifest: evidenceManifest(input.evidence),
    resolutionFiles: (input.resolutionFiles ?? []).join(', '),
    storybookStart: servers.map((server) => `\`${server.start}\``).join(' and '),
    storybookMcp: servers.map((server) => `${server.project} \`${server.url}\``).join(' and '),
    storybookNames: servers.map((server) => `\`${server.name}\``).join(' and '),
    testCommands: tests.length
      ? `For the files this branch already changes, the landing's test commands are: ${tests
          .map((item) => `\`${item.map(shellQuote).join(' ')}\``)
          .join('; ')}. Run each once after your last edit, with the tests of any file you change now.`
      : '',
    consultation: input.consultation ? `Read-only consultation:\n${input.consultation}` : '',
  };
}

function budgetMessage(layers: { name: string; bytes: number; budget?: number }[]): string {
  return layers
    .map((layer) =>
      layer.budget === undefined ? `${layer.name} ${layer.bytes} bytes` : `${layer.name} ${layer.bytes}/${layer.budget} bytes`,
    )
    .join(', ');
}

function loadCondition(
  directory: string,
  id: ConditionId,
  view: PromptView,
  policy: ControlPolicy,
): { id: ConditionId; text: string; bodyBytes: number; sha: string; defers: AcceptanceRequirement[] } {
  const file = readTemplate(join(directory, 'conditions', `${id}.md`));
  const { data, body } = splitFrontMatter(file.text);
  const bodyText = collapse(fillTemplate(body, view, policy));
  const footer = PROTOCOL_FOOTER[id] ? ` ${fillTemplate(PROTOCOL_FOOTER[id]!, view, policy)}` : '';
  return {
    id,
    text: collapse(bodyText + footer),
    bodyBytes: bytes(bodyText),
    sha: file.sha,
    defers: conditionDefers(data),
  };
}

export function renderWorkerPrompt(input: WorkerPromptInput): RenderedPrompt {
  const policy = input.policy ?? defaultPolicy;
  const directory = input.promptDirectory ?? DEFAULT_PROMPT_DIRECTORY;
  const { task, mainCheckout } = input;
  const view = promptView(input);
  const research = task.brief.kind === 'research';
  const verification = task.brief.kind === 'verification';
  const roleName = research ? 'research.md' : 'worker.md';
  const roleFile = readTemplate(join(directory, roleName));
  const roleBudget = research ? policy.prompt.researchRoleBytes : policy.prompt.workerRoleBytes;
  const roleText = verification
    ? collapse(
        [
          `Work only in ${task.worktree}, at captured commit ${task.brief.proof?.sourceCommit ?? ''}. The applicable AGENTS.md is already loaded.`,
          `The main checkout ${mainCheckout} is read-only.`,
          'Finish with the normal JSON exit object: status, summary, blocker, checks and approaches.',
        ].join('\n\n'),
      )
    : collapse(fillTemplate(roleFile.text, view, policy));
  const selected = selectConditions(input);
  const renderedConditions = selected.map((id) => loadCondition(directory, id, view, policy));
  const conditionText = renderedConditions.map((item) => item.text).filter(Boolean).join('\n\n');
  const conditionBodyBytes = renderedConditions.reduce((sum, item) => sum + item.bodyBytes, 0);
  const required = acceptanceRequirements(task.brief);
  const deferred = [
    ...new Set(renderedConditions.flatMap((item) => item.defers).filter((item) => required.includes(item))),
  ];
  const agentsPath = join(existsSync(join(task.worktree, 'AGENTS.md')) ? task.worktree : mainCheckout, 'AGENTS.md');
  const agentsSha = existsSync(agentsPath) ? gitBlobSha(readFileSync(agentsPath)) : gitBlobSha('');
  const briefText = task.brief.markdown;
  const prefix = selected.filter((id) => !CHECK_CONDITIONS.has(id));
  const suffix = selected.filter((id) => CHECK_CONDITIONS.has(id));
  const prefixText = renderedConditions
    .filter((item) => prefix.includes(item.id))
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n');
  const suffixText = renderedConditions
    .filter((item) => suffix.includes(item.id))
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n');
  const extras = [
    view.unfinished,
    view.testCommands,
    input.evidence ? `Continue from this retry manifest:\n${view.evidenceManifest}` : '',
    renderLaunchContext(input.launchContext, policy.launchContext),
    view.consultation,
    deferredSentence(deferred),
  ].filter(Boolean);
  const prompt = collapse(
    [
      roleText,
      prefixText,
      'The task contract follows:',
      briefText,
      ...extras,
      suffixText,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  const roleBytes = bytes(roleText);
  const conditionBytes = conditionBodyBytes;
  const briefBytes = bytes(briefText);
  const totalBytes = bytes(prompt);
  const layers = [
    { name: 'role', bytes: roleBytes, budget: roleBudget },
    { name: 'conditions', bytes: conditionBytes, budget: policy.prompt.conditionBytes },
    { name: 'brief', bytes: briefBytes },
    { name: 'total', bytes: totalBytes, budget: policy.prompt.workerTotalBytes },
  ];
  if (roleBytes > roleBudget || conditionBytes > policy.prompt.conditionBytes || totalBytes > policy.prompt.workerTotalBytes)
    throw new Error(`prompt exceeds budget: ${budgetMessage(layers)}`);
  return {
    prompt,
    deferredAcceptance: deferred,
    roleBytes,
    conditionBytes,
    conditionPromptBytes: bytes(conditionText),
    briefBytes,
    manifest: {
      agents: agentsSha,
      role: roleFile.sha,
      conditions: Object.fromEntries(renderedConditions.map((item) => [item.id, item.sha])),
      brief: gitBlobSha(task.brief.markdown),
      policy: policyHash(policy),
      layers: { role: roleBytes, conditions: conditionBytes, brief: briefBytes, total: totalBytes },
    },
  };
}

export function renderCheckProtocol(
  worktree: string,
  briefOrContract: CheckProtocolBrief | string = '',
  stateDirectory?: string,
  proofRun?: ProofReservation,
  authorization?: ProofAuthorization,
  policy: ControlPolicy = defaultPolicy,
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
): string {
  const brief: CheckProtocolBrief =
    typeof briefOrContract === 'string'
      ? { markdown: briefOrContract, acceptance: { command: [], tests: [], failing: false } }
      : briefOrContract;
  const task = {
    worktree,
    brief,
    currentAttempt: proofRun?.binding.attempt ?? 0,
    proofRun,
    proofAuthorization: authorization,
  } as Task;
  const selected = selectConditions({ task, stateDirectory, proofRun, authorization });
  const check = selected.find((id) => CHECK_CONDITIONS.has(id));
  if (!check) return '';
  const view = promptView({ task, mainCheckout: worktree, stateDirectory, policy, promptDirectory, proofRun, authorization });
  return loadCondition(promptDirectory, check, view, policy).text;
}

export function renderManagerOpening(input: {
  spec: {
    id: string;
    goal: string;
    brief: string;
    cwd: string;
    engine: 'codex' | 'claude';
  };
  continuationFile?: string | undefined;
  continuationText?: string | undefined;
  backlogPath: string;
  command: string;
  policy?: ControlPolicy | undefined;
  promptDirectory?: string | undefined;
  warn?: (message: string) => void;
}): { prompt: string; roleBytes: number; openingBytes: number } {
  const policy = input.policy ?? defaultPolicy;
  const directory = input.promptDirectory ?? DEFAULT_PROMPT_DIRECTORY;
  const roleFile = readTemplate(join(directory, 'manager.md'));
  const continuationPath = join('.temp', 'goal', input.spec.id, 'CONTINUATION.md');
  const view: PromptView = {
    id: input.spec.id,
    goal: input.spec.goal,
    backlogPath: input.backlogPath,
    command: input.command,
    continuationRef: input.continuationFile ? `the continuation ${input.continuationFile}` : 'continuation',
    continuationPath,
    continuationCharacters: policy.manager.continuationCharacters.toLocaleString('en-US'),
    stoppedLimit: policy.backlog.stoppedTaskLimitMs === 3_600_000 ? 'an hour' : `${policy.backlog.stoppedTaskLimitMs} ms`,
    idleRule:
      input.spec.engine === 'codex'
        ? 'When no decision is pending, end the turn; do not use clock.sleep or poll: the controller resumes this thread when an inbox event arrives.'
        : `When no decision is pending, run ${input.command} inbox wait ${input.spec.id} in the background and end the turn.`,
  };
  const roleText = collapse(fillTemplate(roleFile.text, view, policy));
  const goalPath = join(input.spec.cwd, 'docs', 'goals', `${input.spec.goal}.md`);
  const goalText = existsSync(goalPath) ? readFileSync(goalPath, 'utf8').trim() : '';
  const prompt = collapse(
    [roleText, goalText, input.spec.brief, input.continuationText].filter(Boolean).join('\n\n'),
  );
  const roleBytes = bytes(roleText);
  const openingBytes = bytes(prompt);
  if (roleBytes > policy.prompt.managerRoleBytes)
    throw new Error(
      `prompt exceeds budget: ${budgetMessage([
        { name: 'role', bytes: roleBytes, budget: policy.prompt.managerRoleBytes },
        { name: 'opening', bytes: openingBytes, budget: policy.prompt.managerOpeningBytes },
      ])}`,
    );
  if (openingBytes > policy.prompt.managerOpeningBytes)
    (input.warn ?? console.warn)(`manager opening is ${openingBytes} bytes; budget is ${policy.prompt.managerOpeningBytes}`);
  return { prompt, roleBytes, openingBytes };
}

export function applyRenderedPrompt(
  store: {
    updateAttempt(ref: AttemptRef, update: (attempt: Attempt) => void): Attempt;
    updateTask(ref: AttemptRef, update: (task: Task) => void): Task;
  },
  ref: AttemptRef,
  rendered: RenderedPrompt,
): string {
  store.updateAttempt(ref, (attempt: Attempt) => {
    attempt.prompt = rendered.manifest;
  });
  if (rendered.deferredAcceptance.length)
    store.updateTask(ref, (task) => {
      task.deferredAcceptance = rendered.deferredAcceptance;
    });
  return rendered.prompt;
}
