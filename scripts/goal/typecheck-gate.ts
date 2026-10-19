import { ensureDependencies } from './dependencies.ts';
export { dependencyInstallIsStale } from './dependencies.ts';
import { spawn, spawnSync } from 'node:child_process';
import { UNIT_GATE_OUTPUT_CAP, stopProcessGroup, unitGateBudgetMs } from './unit-gate.ts';
import { git } from './ledger.ts';
import { mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fusekiImageFromCompose } from '../load/image.ts';
import { typecheckWorkspaces } from '../qa/affected.ts';
import { randomUUID } from 'node:crypto';
import { admittedCommandBudgetEnv, admittedCommandTokenEnv } from '../qa/host-admission.ts';
import { qaMemoryDeadline } from '../qa/memory-admission.ts';

/** `tsc` diagnostics keyed without line and column, so an edit above an old error does not make it new.
 * A diagnostic with no location (`error TS6053: File not found`) is keyed by its code and message. */
export function typecheckDiagnostics(output: string): string[] {
  const diagnostics: string[] = [];
  for (const line of output.split('\n')) {
    const located = /^(\S.*?)\(\d+,\d+\): (error TS\d+: .*)$/.exec(line.trimEnd());
    const bare = /^(error TS\d+: .*)$/.exec(line.trimEnd());
    if (located) diagnostics.push(`${located[1]}: ${located[2]}`);
    else if (bare) diagnostics.push(bare[1]!);
    else if (/^\s+\S/.test(line) && diagnostics.length) diagnostics[diagnostics.length - 1] += ` ${line.trim()}`;
  }
  return diagnostics.sort();
}

/** Lines that name a TypeScript error in a shape the parser does not know (for example `tsc --pretty`).
 * Comparing around them would let a branch-only error pass, so the run is inconclusive instead. */
export function unclassifiedTypecheckLines(output: string): string[] {
  const known = (line: string) => /^(\S.*?)\(\d+,\d+\): error TS\d+: /.test(line) || /^error TS\d+: /.test(line);
  return output.split('\n').filter(line => /error TS\d+/.test(line) && !/^\s/.test(line) && !known(line.trimEnd()));
}

/** Branch diagnostics beyond those `main` already has, counting repeats. */
export function introducedTypecheckDiagnostics(branch: readonly string[], main: readonly string[]): string[] {
  const inherited = new Map<string, number>();
  for (const diagnostic of main) inherited.set(diagnostic, (inherited.get(diagnostic) ?? 0) + 1);
  return branch.filter(diagnostic => {
    const left = inherited.get(diagnostic) ?? 0;
    if (left) inherited.set(diagnostic, left - 1);
    return !left;
  });
}

export interface TypecheckRun { done: boolean; status: number | null; output: string }
export type TypecheckSide = 'branch' | 'main';

/** Charge the union of admitted compiler spans: one queued workspace must not pause another compiler.
 * Closed spans are retained because notifications from concurrent children can arrive out of order. */
export class TypecheckBudget {
  private spans: { start: number; end?: number }[] = [];
  private listeners = new Set<() => void>();
  readonly createdAt: number;

  constructor(readonly budgetMs: number, readonly admissionDeadline: number, private now: () => number = Date.now) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || !Number.isSafeInteger(admissionDeadline) || admissionDeadline < 1)
      throw new Error('Invalid type check budget or admission deadline');
    this.createdAt = now();
  }

  remainingMs(): number {
    let spent = 0, end = -Infinity;
    const now = this.now();
    for (const span of [...this.spans].sort((left, right) => left.start - right.start)) {
      const until = span.end ?? now;
      spent += Math.max(0, until - Math.max(end, span.start));
      end = Math.max(end, until);
    }
    return Math.max(0, this.budgetMs - spent);
  }

  get active(): boolean { return this.spans.some(span => span.end === undefined); }

  start(at = this.now()): (at?: number) => void {
    const span: { start: number; end?: number } = { start: at };
    this.spans.push(span);
    this.changed();
    return (at = this.now()) => {
      if (span.end !== undefined) return;
      span.end = at;
      this.changed();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void { for (const listener of this.listeners) listener(); }
}

/** Branch type checks run together under one active-work budget; main is checked only for workspaces whose branch run has
 * diagnostics, under a second budget shared by every comparison. Host admission has its own finite deadline.
 * An unfinished run, a failure with no parsed diagnostic, or an unrecognised error line is inconclusive and refuses the merge. */
export async function typecheckGate(workspaces: readonly string[],
  run: (workspace: string, side: TypecheckSide, budget: TypecheckBudget) => Promise<TypecheckRun>,
  budgetMs: number, now: () => number = Date.now): Promise<string | undefined> {
  if (!workspaces.length) return;
  const admissionDeadline = qaMemoryDeadline(process.env);
  const branchBudget = new TypecheckBudget(budgetMs, admissionDeadline, now);
  const branch = await Promise.all(workspaces.map(async workspace => ({ workspace, result: await run(workspace, 'branch', branchBudget) })));
  const inconclusive: string[] = [];
  const failing: { workspace: string; diagnostics: string[] }[] = [];
  for (const { workspace, result } of branch) {
    const diagnostics = typecheckDiagnostics(result.output);
    const unknown = unclassifiedTypecheckLines(result.output);
    if (!result.done) inconclusive.push(`${workspace}: the branch type check did not finish`);
    else if (unknown.length) inconclusive.push(`${workspace}: unrecognised type error output:\n    ${unknown.join('\n    ')}`);
    else if (result.status === 0) console.log(`Type check ${workspace}: passes`);
    else if (!diagnostics.length) inconclusive.push(`${workspace}: the type check failed without diagnostics:\n${result.output.slice(-2000)}`);
    else failing.push({ workspace, diagnostics });
  }
  const introduced: string[] = [];
  let mainBudget: TypecheckBudget | undefined;
  for (const { workspace, diagnostics } of failing) {
    mainBudget ??= new TypecheckBudget(budgetMs, admissionDeadline, now);
    const main = await run(workspace, 'main', mainBudget);
    const inherited = typecheckDiagnostics(main.output);
    if (!main.done || unclassifiedTypecheckLines(main.output).length || (main.status !== 0 && !inherited.length)) {
      inconclusive.push(`${workspace}: the type check on main is inconclusive`);
      continue;
    }
    const added = introducedTypecheckDiagnostics(diagnostics, inherited);
    console.log(`Type check ${workspace}: ${diagnostics.length} diagnostic(s) on the branch, ${diagnostics.length - added.length} already on main, ${added.length} introduced`);
    for (const diagnostic of diagnostics.filter(diagnostic => !added.includes(diagnostic))) console.log(`  on main, not blocking: ${diagnostic}`);
    introduced.push(...added.map(diagnostic => `${workspace}: ${diagnostic}`));
  }
  if (introduced.length) return `introduced type errors; not merging:\n  ${introduced.join('\n  ')}`;
  if (inconclusive.length) return `type check inconclusive; not merging:\n  ${inconclusive.join('\n  ')}`;
}

export async function runTypecheck(cwd: string, workspace: string, budget: TypecheckBudget,
  options: { env?: NodeJS.ProcessEnv; legacyAdmission?: boolean } = {}): Promise<TypecheckRun> {
  // The legacy side keeps its original wall deadline, including baseline preparation and gaps between comparisons.
  let finishActive = options.legacyAdmission ? budget.start(budget.createdAt) : undefined;
  if (budget.remainingMs() <= 0 || Date.now() >= budget.admissionDeadline) {
    finishActive?.();
    return { done: false, status: null, output: 'Type check budget or admission deadline reached; no work started' };
  }
  const token = randomUUID();
  const started = Date.now();
  const child = spawn('task', [`${workspace}:typecheck`], {
    cwd, env: { ...(options.env ?? process.env), AGENT: '1', REZICS_QA_ADMISSION_LOG_FD: '2',
      REZICS_QA_MEMORY_DEADLINE: String(budget.admissionDeadline),
      [admittedCommandBudgetEnv]: String(Math.max(1, Math.ceil(budget.remainingMs()))),
      [admittedCommandTokenEnv]: options.legacyAdmission ? undefined : token }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const chunks: string[] = [];
  let bytes = 0;
  let admittedAt: number | undefined = options.legacyAdmission ? started : undefined;
  let terminalDeadline: number | undefined;
  let completed: { status: number | null; timedOut: boolean } | undefined;
  let invalid = false;
  const prefix = `QA_ADMITTED_COMMAND ${token} `;
  const observe = (line: string) => {
    if (!line.startsWith(prefix)) return;
    const event = line.slice(prefix.length);
    const begin = /^BEGIN (\d+)$/.exec(event);
    const end = /^END (\d+) (\d+|signal) (exit|timeout)$/.exec(event);
    if (begin && !finishActive && !completed) {
      const at = Number(begin[1]);
      if (!Number.isSafeInteger(at) || at < started || at > Date.now()) invalid = true;
      else { admittedAt = at; finishActive = budget.start(at); }
    } else if (end && finishActive && !completed) {
      const at = Number(end[1]);
      const status = end[2] === 'signal' ? null : Number(end[2]);
      if (!Number.isSafeInteger(at) || at < admittedAt! || at > Date.now()
        || (status !== null && (!Number.isSafeInteger(status) || status > 255))) invalid = true;
      else {
        completed = { status, timedOut: end[3] === 'timeout' };
        // Task still has to close its streams and the wrapper has to release its CPU permit.
        terminalDeadline = Date.now() + 5_000;
        finishActive(at);
      }
    } else invalid = true;
    armTimer();
  };
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      bytes += chunk.length;
      if (bytes <= UNIT_GATE_OUTPUT_CAP) chunks.push(chunk);
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) observe(line);
    });
  }
  const closed = new Promise<number | null>(resolve => {
    child.once('error', error => { chunks.push(`Unable to start the type check: ${error.message}`); resolve(null); });
    child.once('close', code => resolve(code));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire!: () => void;
  const timeout = new Promise<'timeout'>(resolve => { expire = () => resolve('timeout'); });
  function armTimer(): void {
    clearTimeout(timer);
    const remaining = budget.remainingMs();
    const admissionRemaining = finishActive ? Infinity : budget.admissionDeadline - Date.now();
    const terminalRemaining = terminalDeadline === undefined ? Infinity : terminalDeadline - Date.now();
    if (invalid || remaining <= 0 || admissionRemaining <= 0 || terminalRemaining <= 0) { expire(); return; }
    const delay = Math.min(budget.active ? remaining : Infinity, admissionRemaining, terminalRemaining, 2_147_483_647);
    timer = setTimeout(armTimer, Math.max(1, delay));
  }
  const unsubscribe = budget.subscribe(armTimer);
  armTimer();
  try {
    const outcome = await Promise.race([closed, timeout]);
    if (outcome === 'timeout') {
      chunks.push(invalid ? 'Invalid type check admission notification' : budget.remainingMs() <= 0
        ? 'Type check shared active-work budget reached' : completed
        ? 'Type check terminal cleanup deadline reached' : 'Type check admission deadline reached; no work started');
      await stopProcessGroup(child);
    }
    const done = outcome !== 'timeout' && outcome !== null && !invalid && (options.legacyAdmission || (completed !== undefined
      && completed.status !== null && !completed.timedOut && (outcome === 0) === (completed.status === 0)));
    return { done, status: outcome === 'timeout' ? null : outcome, output: chunks.join('') };
  } finally {
    unsubscribe();
    clearTimeout(timer);
    finishActive?.();
  }
}

/** The known pre-protocol host wrapper cannot report admission. Preserve its previous shared wall
 * budget for pinned main comparisons; an unknown, missing or partial implementation cannot opt out. */
export function legacyTypecheckBaseline(mainRoot: string, before: string): boolean {
  return git(mainRoot, ['rev-parse', `${before}:scripts/qa/host-admission.ts`]).trim()
    === '0510625863c6d24de1194fb68fbf503d8074336d';
}

/** A classification checkout is a detached worktree, so git does not materialize the ignored `.temp` directory. */
export function addGateWorktree(mainRoot: string, directory: string, commit: string): void {
  git(mainRoot, ['worktree', 'add', '--detach', directory, commit]);
  mkdirSync(join(directory, '.temp'), { recursive: true });
}

/** A branch that moves the pinned Fuseki image must not reach main before that image exists on this host.
 * Every stack started from main in between tries to build it inside its own run and fails: on 2026-10-12
 * browser runs could not start for half an hour after a pin landed. */
export function missingPinnedImage(worktree: string, mainRoot: string,
  present: (image: string) => boolean = image =>
    spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 30_000 }).status === 0): string | undefined {
  const pinned = (checkout: string) => {
    try { return fusekiImageFromCompose(readFileSync(join(checkout, 'infra/dev/compose.yaml'), 'utf8')).image; }
    catch { return undefined; }
  };
  const image = pinned(worktree);
  if (!image || image === pinned(mainRoot) || present(image)) return;
  return `This branch pins ${image}, which is not built on this host. Build it from the task worktree first `
    + '(start one stack there, or run the image build), then merge; a pin on main without its image stops every stack';
}

/** A rebase past a dependency change leaves the worktree's installed packages behind the tree it now holds,
 * and the gate would test new code against old packages. Install again before any gate runs. */
export function reinstallStaleDependencies(worktree: string): string | undefined {
  try { ensureDependencies(worktree); }
  catch (error) { return `${String(error)}; not merging`; }
}

/** Type-checks the workspaces the branch touched before the unit gate, within the unit gate's per-side budget.
 * `only` narrows a rerun to workspaces whose `main` sources changed under the branch. */
export async function preMergeTypecheckGate(worktree: string, mainRoot: string, before: string, files: readonly string[],
  skip: boolean, only?: readonly string[]): Promise<string | undefined> {
  if (skip) {
    console.log('Type check skipped: --skip-type-gate explicitly requested by the manager');
    return;
  }
  const workspaces = typecheckWorkspaces(files, worktree).filter(workspace => !only || only.includes(workspace));
  console.log(`Pre-merge type check: ${workspaces.length ? workspaces.join(', ') : 'no TypeScript workspace touched'} against main ${before.slice(0, 12)}`);
  let baseline: string | undefined;
  let legacyBaseline = false;
  try {
    return await typecheckGate(workspaces, async (workspace, side, budget) => {
      if (side === 'branch') return runTypecheck(worktree, workspace, budget);
      if (!baseline) {
        mkdirSync(join(mainRoot, '.temp'), { recursive: true });
        baseline = mkdtempSync(join(mainRoot, '.temp/type-gate-'));
        addGateWorktree(mainRoot, baseline, before);
        const install = spawnSync('task', ['install'], { cwd: baseline, encoding: 'utf8', timeout: 120_000 });
        if (install.status !== 0) throw new Error(`Type check baseline dependency install failed:\n${install.stdout}\n${install.stderr}`);
        legacyBaseline = legacyTypecheckBaseline(mainRoot, before);
        if (legacyBaseline) console.log(`Type check on pinned main ${before.slice(0, 12)} predates admission reporting; `
          + `retaining the shared ${budget.budgetMs} ms wall budget for its comparisons`);
      }
      return runTypecheck(baseline, workspace, budget, { legacyAdmission: legacyBaseline });
    }, unitGateBudgetMs());
  } finally {
    if (baseline) {
      git(mainRoot, ['worktree', 'remove', '--force', baseline], true);
      rmSync(baseline, { recursive: true, force: true });
    }
  }
}
