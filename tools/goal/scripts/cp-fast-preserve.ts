#!/usr/bin/env bun
/** Adopt main-only changes before the existing fast publisher snapshots dev. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Anchor = { main: string; source: string };
type State = { publication: Anchor; adoptedMain: string; notifiedMain?: string };
export type PreservationConflict = { base: string; main: string; dev: string; paths: string[] };
export type PreservationOptions = {
  checkout: string;
  stateFile: string;
  notify: (conflict: PreservationConflict) => void | Promise<void>;
};
export type PreservationResult = { status: 'ready' | 'conflict'; main: string; dev: string };

function run(checkout: string, args: string[], input?: string) {
  return spawnSync('git', args, { cwd: checkout, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
}
function git(checkout: string, ...args: string[]): string {
  const result = run(checkout, args);
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}
function revision(checkout: string, value: string): string {
  return git(checkout, 'rev-parse', '--verify', `${value}^{commit}`);
}
function tree(checkout: string, value: string): string {
  return git(checkout, 'rev-parse', `${value}^{tree}`);
}
function writeState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`);
  renameSync(temporary, file);
}
function verifyPublication(checkout: string, publication: Anchor): void {
  if (tree(checkout, publication.main) !== tree(checkout, publication.source))
    throw new Error('Fast publication does not have its recorded dev source tree.');
}
/** Bootstrap only from the existing publisher's commit metadata and an exact full-tree match. */
function bootstrap(checkout: string): State {
  const history = git(checkout, 'log', 'main', '--first-parent', '-100', '--format=%H %s');
  for (const line of history.split('\n')) {
    const match = /^([a-f0-9]{40,64}) control-plane: fast sync from dev ([a-f0-9]{10,64})$/.exec(line);
    if (!match) continue;
    const publication = { main: match[1]!, source: revision(checkout, match[2]!) };
    verifyPublication(checkout, publication);
    return { publication, adoptedMain: publication.main };
  }
  throw new Error('No evidenced fast publication found; checkpoint the last verified snapshot and its dev source.');
}
function readState(options: PreservationOptions): State {
  if (!existsSync(options.stateFile)) return bootstrap(options.checkout);
  const state = JSON.parse(readFileSync(options.stateFile, 'utf8')) as State;
  if (!state.publication?.main || !state.publication.source || !state.adoptedMain)
    throw new Error('Invalid fast publication state.');
  verifyPublication(options.checkout, state.publication);
  return state;
}

/** No worktree is changed. merge-tree owns its in-memory index; only the dev ref moves, with a main/dev CAS. */
export async function preserveMainHotfixes(options: PreservationOptions): Promise<PreservationResult> {
  const { checkout } = options;
  let state = readState(options);
  for (let attempt = 0; attempt < 5; attempt++) {
    const main = revision(checkout, 'refs/heads/main');
    const dev = revision(checkout, 'refs/heads/dev');
    if (run(checkout, ['merge-base', '--is-ancestor', state.adoptedMain, main]).status !== 0)
      throw new Error('Main no longer contains the retained adoption anchor.');
    if (main === state.adoptedMain || tree(checkout, main) === tree(checkout, state.adoptedMain))
      return { status: 'ready', main, dev };
    // An explicit merge into dev already received main, including any manual conflict resolution.
    if (run(checkout, ['merge-base', '--is-ancestor', main, dev]).status === 0) {
      const verified = run(checkout, ['update-ref', '--stdin'],
        `update refs/heads/main ${main} ${main}\nupdate refs/heads/dev ${dev} ${dev}\n`);
      if (verified.status !== 0) continue;
      writeState(options.stateFile, { publication: state.publication, adoptedMain: main });
      return { status: 'ready', main, dev };
    }
    const merged = run(checkout, [
      'merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${state.adoptedMain}`, dev, main,
    ]);
    if (merged.status === 1) {
      // With -z the tree is followed by conflict paths, an empty field, then informational messages.
      const fields = merged.stdout.split('\0');
      const paths = fields.slice(1, fields.indexOf('', 1));
      if (revision(checkout, 'refs/heads/main') !== main || revision(checkout, 'refs/heads/dev') !== dev) continue;
      if (state.notifiedMain !== main) {
        await options.notify({ base: state.adoptedMain, main, dev, paths });
        state = { ...state, notifiedMain: main };
        writeState(options.stateFile, state);
      }
      return { status: 'conflict', main, dev };
    }
    if (merged.status !== 0) throw new Error(`git merge-tree: ${merged.stderr || merged.error?.message}`);
    const mergedTree = merged.stdout.split('\0')[0]!.trim();
    const next = mergedTree === tree(checkout, dev) ? dev : git(checkout,
      'commit-tree', mergedTree, '-p', dev, '-p', main,
      '-m', 'control-plane: preserve main hotfixes on dev before fast publication');
    const transaction = run(checkout, ['update-ref', '-m', 'cp-fast preserve main hotfixes', '--stdin'],
      // A no-op update keeps the main CAS while its history hook can distinguish it from deletion.
      `update refs/heads/main ${main} ${main}\nupdate refs/heads/dev ${next} ${dev}\n`);
    if (transaction.status !== 0) continue;
    // Repeating after a crash before this write produces the same tree and no duplicate adoption commit.
    writeState(options.stateFile, { publication: state.publication, adoptedMain: main });
    return { status: 'ready', main, dev: next };
  }
  throw new Error('Main or dev kept moving during hotfix adoption; retry this publication.');
}

/** Called only after the existing publisher's smoke succeeds; also accepts an explicit historical bootstrap. */
export function checkpointFastPublication(checkout: string, stateFile: string, main: string, source: string): void {
  const publication = { main: revision(checkout, main), source: revision(checkout, source) };
  verifyPublication(checkout, publication);
  if (run(checkout, ['merge-base', '--is-ancestor', publication.main, 'refs/heads/main']).status !== 0)
    throw new Error('Checkpoint is not on current main history.');
  writeState(stateFile, { publication, adoptedMain: publication.main });
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const checkout = resolve(process.env.GOAL_MAIN_CHECKOUT || process.cwd());
    const stateDirectory = resolve(process.env.GOAL_STATE_DIRECTORY || join(checkout, '.temp/goal'));
    const stateFile = join(stateDirectory, 'watch/cp-fast-state.json');
    if (command === 'checkpoint' && args.length === 2) {
      checkpointFastPublication(checkout, stateFile, args[0]!, args[1]!);
    } else if (command === 'prepare' && args.length === 1) {
      const owner = args[0]!;
      const result = await preserveMainHotfixes({ checkout, stateFile, async notify(conflict) {
        const evidencePath = join(stateDirectory, 'watch/cp-fast-conflict.json');
        mkdirSync(dirname(evidencePath), { recursive: true });
        writeFileSync(evidencePath, `${JSON.stringify(conflict, null, 2)}\n`);
        const databasePath = join(stateDirectory, 'goal.sqlite');
        if (!existsSync(databasePath)) throw new Error(`Native inbox database is missing: ${databasePath}`);
        const [{ openDb }, { SqliteManagerInbox }] = await Promise.all([
          import('../src/db.ts'), import('../src/inbox.ts'),
        ]);
        const db = openDb(databasePath);
        try {
          new SqliteManagerInbox(db, stateDirectory).deliver({
            managerId: owner, from: 'cp-fast', kind: 'question', evidencePath,
            summary: `Fast publication waits: main ${conflict.main.slice(0, 10)} overlaps dev in ${conflict.paths.slice(0, 5).join(', ')}. Reconcile these main hotfixes onto dev, then retry; main retains its hotfix and product work continues.`,
          });
        } finally { db.close(); }
      } });
      if (result.status === 'conflict') process.exitCode = 2;
      else console.log(`${result.main} ${result.dev}`);
    } else throw new Error('usage: cp-fast-preserve.ts prepare <owner> | checkpoint <published-main> <source-dev>');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
