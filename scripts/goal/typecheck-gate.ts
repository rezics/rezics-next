import { spawn, spawnSync } from 'node:child_process';
import { UNIT_GATE_OUTPUT_CAP, stopProcessGroup, unitGateBudgetMs } from './unit-gate.ts';
import { git } from './ledger.ts';
import { mkdirSync, existsSync, statSync, readdirSync, readFileSync, utimesSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fusekiImageFromCompose } from '../load/image.ts';
import { typecheckWorkspaces } from '../qa/affected.ts';

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

/** Branch type checks run together under one deadline; main is checked only for workspaces whose branch run has
 * diagnostics, under a second deadline shared by every comparison so that side stays within the budget in total.
 * An unfinished run, a failure with no parsed diagnostic, or an unrecognised error line is inconclusive and refuses the merge. */
export async function typecheckGate(workspaces: readonly string[],
  run: (workspace: string, side: TypecheckSide, deadline: number) => Promise<TypecheckRun>,
  budgetMs: number, now: () => number = Date.now): Promise<string | undefined> {
  if (!workspaces.length) return;
  const branchDeadline = now() + budgetMs;
  const branch = await Promise.all(workspaces.map(async workspace => ({ workspace, result: await run(workspace, 'branch', branchDeadline) })));
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
  let mainDeadline: number | undefined;
  for (const { workspace, diagnostics } of failing) {
    mainDeadline ??= now() + budgetMs;
    const main = await run(workspace, 'main', mainDeadline);
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

async function runTypecheck(cwd: string, workspace: string, deadline: number): Promise<TypecheckRun> {
  const child = spawn('task', [`${workspace}:typecheck`], {
    cwd, env: { ...process.env, AGENT: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const chunks: string[] = [];
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => { bytes += chunk.length; if (bytes <= UNIT_GATE_OUTPUT_CAP) chunks.push(chunk); });
  }
  const closed = new Promise<number | null>(resolve => {
    child.once('error', error => { chunks.push(`Unable to start the type check: ${error.message}`); resolve(null); });
    child.once('close', code => resolve(code));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
  });
  try {
    const outcome = await Promise.race([closed, timeout]);
    if (outcome === 'timeout') await stopProcessGroup(child);
    return { done: outcome !== 'timeout' && outcome !== null, status: outcome === 'timeout' ? null : outcome, output: chunks.join('') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A classification checkout is a detached worktree, so git does not materialize the ignored `.temp` directory. */
export function addGateWorktree(mainRoot: string, directory: string, commit: string): void {
  git(mainRoot, ['worktree', 'add', '--detach', directory, commit]);
  mkdirSync(join(directory, '.temp'), { recursive: true });
}

/** True when the lockfile or a dependency patch is newer than the worktree's last install: a rebase rewrote them. */
export function dependencyInstallIsStale(worktree: string): boolean {
  const state = join(worktree, 'node_modules', '.yarn-state.yml');
  if (!existsSync(state)) return false;
  const installedAt = statSync(state).mtimeMs;
  const patches = join(worktree, '.yarn', 'patches');
  const inputs = [join(worktree, 'yarn.lock'),
    ...(existsSync(patches) ? readdirSync(patches).map(name => join(patches, name)) : [])];
  return inputs.some(file => existsSync(file) && statSync(file).mtimeMs > installedAt);
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
  if (!dependencyInstallIsStale(worktree)) return;
  console.log('Pre-merge install: the lockfile or a dependency patch changed under this branch; running task install');
  const install = spawnSync('task', ['install'], { cwd: worktree, encoding: 'utf8', timeout: 300_000 });
  if (install.status === 0) {
    // Yarn leaves its state file alone when nothing changed; mark the install as current either way.
    const now = new Date();
    utimesSync(join(worktree, 'node_modules', '.yarn-state.yml'), now, now);
    return;
  }
  return `Dependency install failed in ${worktree}; not merging:\n${`${install.stdout ?? ''}\n${install.stderr ?? ''}`.trim().slice(-2000)}`;
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
  try {
    return await typecheckGate(workspaces, async (workspace, side, deadline) => {
      if (side === 'branch') return runTypecheck(worktree, workspace, deadline);
      if (!baseline) {
        mkdirSync(join(mainRoot, '.temp'), { recursive: true });
        baseline = mkdtempSync(join(mainRoot, '.temp/type-gate-'));
        addGateWorktree(mainRoot, baseline, before);
        const install = spawnSync('task', ['install'], { cwd: baseline, encoding: 'utf8', timeout: 120_000 });
        if (install.status !== 0) throw new Error(`Type check baseline dependency install failed:\n${install.stdout}\n${install.stderr}`);
      }
      return runTypecheck(baseline, workspace, deadline);
    }, unitGateBudgetMs());
  } finally {
    if (baseline) {
      git(mainRoot, ['worktree', 'remove', '--force', baseline], true);
      rmSync(baseline, { recursive: true, force: true });
    }
  }
}
