import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { WORKER_TYPE_PROJECTS } from '../qa/worker-types.ts';
import { checkFailureLines, runCheckCommand, type CheckRunner, type CheckResult } from './check.ts';

export interface BranchCheckResult { commit: string; code: number; log: string; checks: CheckResult[] }
export interface BranchCheckOptions { cwd?: string; runner?: CheckRunner; print?: (line: string) => void }
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to inspect branch');
  return result.stdout.trim();
}

/** A snapshot prevents uncommitted edits or a moving ref from being certified as a commit. */
export async function branchCheck(ref: string, options: BranchCheckOptions = {}): Promise<BranchCheckResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const commit = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  const root = join(cwd, '.temp/goal/branch-check');
  mkdirSync(root, { recursive: true });
  const record = join(root, `${commit}.json`);
  const print = options.print ?? console.log;
  const cached = () => {
    if (!existsSync(record)) return;
    try {
      const result = JSON.parse(readFileSync(record, 'utf8')) as BranchCheckResult;
      if (result.commit === commit && (result.code === 0 || result.code === 1) && Array.isArray(result.checks)) return result;
    } catch { /* An interrupted write does not certify a branch. */ }
  };
  const reuse = (result: BranchCheckResult) => {
    print(`Branch ${ref}: ${result.code ? 'failed' : 'ok'} (recorded ${commit})`);
    print(`Full output: ${result.log}`);
    return result;
  };
  const previous = cached();
  if (previous) return reuse(previous);
  const lock = join(root, `${commit}.lock`);
  while (true) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const result = cached();
      if (result) return reuse(result);
      // Exclusive creation has no directory/metadata gap; recover dead owners or abandoned empty writes.
      try {
        const pid = Number(readFileSync(lock, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (gone) { if ((gone as NodeJS.ErrnoException).code === 'ESRCH') rmSync(lock, { force: true }); }
        } else if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch (race) { if ((race as NodeJS.ErrnoException).code !== 'ENOENT') throw race; }
      await Bun.sleep(100);
    }
  }
  const directory = mkdtempSync(join(root, `${commit}-`));
  const tree = join(directory, 'tree');
  const log = join(directory, 'output.log');
  try {
    const raced = cached();
    if (raced) return reuse(raced);
    mkdirSync(tree);
    const archive = join(directory, 'tree.tar');
    git(cwd, ['archive', '--format=tar', `--output=${archive}`, commit]);
    const unpack = spawnSync('tar', ['-xf', archive, '-C', tree], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(unpack.stderr || 'Unable to extract branch');
    rmSync(archive);
    // Workspace links must resolve to the certified snapshot, never the caller's dirty sources.
    const linkDependencies = (original: string, destination: string) => {
      if (!existsSync(original)) return;
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(original)) {
        const path = join(original, entry);
        const target = join(destination, entry);
        if (entry.startsWith('@')) { linkDependencies(path, target); continue; }
        const local = lstatSync(path).isSymbolicLink() ? resolve(original, readlinkSync(path)) : path;
        const location = relative(cwd, local);
        symlinkSync(location && !location.startsWith('..') && !location.startsWith('node_modules/')
          ? join(tree, location) : path, target);
      }
    };
    linkDependencies(join(cwd, 'node_modules'), join(tree, 'node_modules'));
    for (const { root: prefix } of WORKER_TYPE_PROJECTS)
      linkDependencies(join(cwd, prefix, 'node_modules'), join(tree, prefix, 'node_modules'));
    writeFileSync(log, `Branch ${ref} at ${commit}\n`);
    const run = options.runner ?? runCheckCommand;
    const checks: CheckResult[] = [];
    // Regenerate this snapshot's ignored contracts; never borrow another tip's generated code.
    const commands: [CheckResult['name'], string[]][] = [
      ['contract', ['task', 'gen']],
      ...WORKER_TYPE_PROJECTS.filter(project => existsSync(join(tree, project.project)))
        .map(project => ['types', project.task ? ['task', project.task]
          : ['task', 'goal:type-files', '--', '--project', project.project]] as [CheckResult['name'], string[]]),
      ['lint', ['node_modules/.bin/oxlint', '--type-aware', 'apps', 'packages', 'services', 'scripts', 'tests', 'apphost']],
      ['ast', ['task', 'ast-grep', '--', 'scan']],
      ['guards', ['task', 'guards']],
    ];
    for (const [index, [name, command]] of commands.entries()) {
      const start = performance.now();
      let result;
      try { result = await run(command, tree, join(directory, `${index}-${name}.log`)); }
      catch (error) { result = { code: 1, output: `error: ${String(error)}` }; }
      if (name === 'guards' && existsSync(join(tree, '.temp/repository-guards'))) {
        const artifacts = join(directory, 'guard-artifacts');
        cpSync(join(tree, '.temp/repository-guards'), artifacts, { recursive: true });
        result.output = result.output.replaceAll(join(tree, '.temp/repository-guards'), artifacts);
        result.output += `\nGuard artifacts: ${artifacts}\n`;
      }
      checks.push({ name, code: result.code, seconds: (performance.now() - start) / 1000 });
      writeFileSync(log, `${readFileSync(log, 'utf8')}\n${result.output}\n`);
      print(`${name}: ${result.code ? 'failed' : 'ok'} (${checks.at(-1)!.seconds.toFixed(1)}s)`);
      if (result.code) for (const line of checkFailureLines(result.output)) print(line);
      // A failed generator leaves the snapshot unsuitable for static validation.
      if (name === 'contract' && result.code) break;
    }
    const result: BranchCheckResult = { commit, code: checks.some(check => check.code !== 0) ? 1 : 0, log, checks };
    const temporary = join(directory, 'result.json');
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(temporary, record);
    print(`Branch ${ref}: ${result.code ? 'failed' : 'ok'} (${commit})`);
    print(`Full output: ${log}`);
    return result;
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(lock, { force: true });
  }
}
