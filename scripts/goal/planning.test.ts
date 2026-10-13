import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { git } from './ledger.ts';
import { GoalMailStore } from './mail.ts';
import { managerEvents } from './manager-commands.ts';
import { planningBody, planningLines, uncoveredPlanningRows } from './planning.ts';
import type { Ledger, Task } from './types.ts';

function fixture() {
  const parent = join(import.meta.dir, '../../.temp/planning-tests');
  mkdirSync(parent, { recursive: true });
  const repo = mkdtempSync(join(parent, 'case-'));
  const state = join(repo, '.temp/state');
  mkdirSync(state, { recursive: true });
  const write = (file: string, content: string) => {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), content);
  };
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'planning@example.test']);
  git(repo, ['config', 'user.name', 'Planning fixture']);
  write('docs/goals/program/GOAL.md', '---\nareas: [scripts/qa/cases/outcomes/program/**]\n---\n');
  write('docs/goals/kernel/GOAL.md', '---\nareas: [scripts/qa/cases/outcomes/kernel/**]\n---\n');
  const commit = () => { git(repo, ['add', '--', '.', ':!.temp']); git(repo, ['commit', '-m', 'Declaration fixture']); return git(repo, ['rev-parse', 'HEAD']); };
  const base = commit();
  const ledger: Ledger = { goals: { program: { manager: 'manager', startedAt: '' }, kernel: { manager: 'other', startedAt: '' } }, tasks: {} };
  const db = new Database(join(state, 'coordinator.sqlite'));
  db.exec('CREATE TABLE managers(goal TEXT PRIMARY KEY); CREATE TABLE events(goal TEXT,event_key TEXT,body TEXT,handled INTEGER DEFAULT 0)');
  db.query('INSERT INTO managers VALUES(?)').run('program');
  const mail = new GoalMailStore({ stateDir: state, goals: ['program', 'kernel'] });
  function declaration(id: string, goal = 'program', cells = "visitor: pending('visitor note'), owner: pending('owner note'), operator: proved('working')") {
    const file = `scripts/qa/cases/outcomes/${goal}/${id}.ts`;
    write(file, `import { rowOutcomes, pending, proved } from '../../outcome-cells.ts';\nexport default rowOutcomes('${goal}/${id}', {${cells}});`);
    return file;
  }
  function task(id: string, overrides: Partial<Task> = {}): Task {
    return { id, title: 'Fixture', engine: 'sol', effort: 'high', cases: [], paths: ['scripts/qa/cases/outcomes/**'],
      migrations: [], shared: [], depends: [], brief: '', worktree: repo, branch: '', base, state: 'verified', attempts: [], goal: 'program', ...overrides };
  }
  const save = () => writeFileSync(join(state, 'ledger.json'), JSON.stringify(ledger));
  return { repo, state, ledger, db, base, declaration, commit, task, write, save,
    events(goal = 'program') { save(); return managerEvents(state, goal, mail, repo).filter(event => event.key.startsWith('planning:')); },
    close() { mail.close(); db.close(); rmSync(repo, { recursive: true, force: true }); } };
}

test('pending main declarations raise one event containing every pending persona and note; proved and missing cells do not', () => {
  const f = fixture();
  try {
    const file = f.declaration('failure');
    f.declaration('proved', 'program', "visitor: proved('working')");
    f.declaration('missing', 'program', '');
    f.commit();
    f.declaration('unlanded');
    const events = f.events();
    expect(events).toHaveLength(1);
    expect(events[0]!.body).toContain('program/failure | visitor: "visitor note"; owner: "owner note"');
    expect(events[0]!.body).toContain(`declaration: ${file}`);
    expect(events[0]!.body).toContain('no task in ledger');
    expect(events[0]!.body).not.toContain('program/proved');
    expect(events[0]!.body).not.toContain('program/missing');
    expect(events[0]!.body).not.toContain('program/unlanded');
  } finally { f.close(); }
});

test('planning reads authored template notes without executing the declaration', () => {
  const f = fixture();
  try {
    const file = f.declaration('interpolation', 'program', 'visitor: pending(`${collectionGap} ${placementGap}; ${lifecycleGap}`)');
    const path = join(f.repo, file);
    writeFileSync(path, "const collectionGap = 'collection';\nconst placementGap = 'placement';\nconst lifecycleGap = 'lifecycle';\n" + readFileSync(path, 'utf8'));
    f.commit();
    expect(f.events()[0]!.body).toContain('program/interpolation | visitor: "collection placement; lifecycle"');
  } finally { f.close(); }
});

test('planning reads string sums built from constants', () => {
  const f = fixture();
  try {
    const file = f.declaration('sum', 'program', "visitor: pending(prefix + (' ' + suffix))");
    const path = join(f.repo, file);
    writeFileSync(path, "const prefix = 'collection';\nconst suffix = 'placement';\n" + readFileSync(path, 'utf8'));
    f.commit();
    expect(f.events()[0]!.body).toContain('program/sum | visitor: "collection placement"');
  } finally { f.close(); }
});

test('an unreadable declaration stays uncovered and reports one line without executing it or aborting the pass', () => {
  const f = fixture();
  try {
    const file = f.declaration('unreadable', 'program', "visitor: pending(\n  buildNote()\n)");
    const path = join(f.repo, file);
    writeFileSync(path, "function buildNote() { throw new Error('declaration executed'); }\n" + readFileSync(path, 'utf8'));
    f.declaration('readable'); f.commit();
    const rows = uncoveredPlanningRows(f.state, f.ledger, f.repo).get('program')!;
    expect(rows.map(row => row.id)).toContain('program/unreadable');
    const body = f.events()[0]!.body;
    expect(body).toContain('2 uncovered pending rows.');
    expect(body).toContain('program/readable | visitor: "visitor note"');
    const diagnostics = body.split('\n').filter(line => line.includes('unreadable declaration:'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toStartWith(`${file}: unreadable declaration: `);
    expect(diagnostics[0]).toContain('buildNote()');
    expect(body).not.toContain('declaration executed');
  } finally { f.close(); }
});

test('a row named by a brief is covered before dispatch, including untracked and queued briefs', () => {
  const f = fixture();
  try {
    f.declaration('written'); f.declaration('queued'); f.declaration('remaining'); f.commit();
    f.write('docs/goals/program/tasks/G-100.md', '---\nid: G-100\nrows: [program/written]\n---\n');
    f.write('docs/goals/program/tasks/G-101.md', '---\nid: G-101\nrows: [program/queued]\ndepends: [G-100]\n---\n');
    expect(uncoveredPlanningRows(f.state, f.ledger, f.repo).get('program')!.map(row => row.id))
      .toEqual(['program/remaining']);
    expect(f.ledger.tasks).toEqual({});
  } finally { f.close(); }
});

test('planning waits for a concurrent coordinator transaction instead of terminating the pump', async () => {
  const f = fixture();
  let writer: ReturnType<typeof spawn> | undefined;
  try {
    f.declaration('failure'); f.commit();
    const file = join(f.repo, '.temp/writer.ts');
    writeFileSync(file, `import { Database } from 'bun:sqlite';
      const db = new Database(${JSON.stringify(join(f.state, 'coordinator.sqlite'))});
      db.exec('BEGIN EXCLUSIVE');
      console.log('locked');
      await Bun.sleep(500);
      db.exec('COMMIT'); db.close();`);
    writer = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      writer!.stdout!.once('data', () => resolve());
      writer!.once('error', reject);
      writer!.once('exit', code => { if (code !== 0) reject(new Error(`Coordinator writer exited ${code}`)); });
    });
    expect(f.events()).toHaveLength(1);
  } finally {
    if (writer && writer.exitCode === null) {
      const exited = new Promise<void>(resolve => writer!.once('exit', () => resolve()));
      writer.kill('SIGTERM'); await exited;
    }
    f.close();
  }
});

test('an open implementation or outcome task naming a row covers it', () => {
  const f = fixture();
  try {
    f.declaration('failure'); f.commit();
    for (const kind of ['implementation', 'outcome'] as const) {
      for (const state of ['running', 'exited', 'conflict', 'merged', 'stopped'] as const) {
        f.ledger.tasks.cover = f.task('cover', { kind, rows: ['program/failure'], state });
        expect(f.events()).toEqual([]);
      }
      for (const state of ['verified', 'cancelled'] as const) {
        f.ledger.tasks.cover = f.task('cover', { kind, rows: ['program/failure'], state });
        expect(f.events()).toHaveLength(1);
      }
      f.ledger.tasks.cover = f.task('cover', { kind, rows: ['program/another'], state: 'running' });
      expect(f.events()).toHaveLength(1);
    }
    for (const kind of ['tooling', 'mechanism', 'surface'] as const) {
      f.ledger.tasks.cover = f.task('cover', { kind, rows: ['program/failure'], state: 'running' });
      expect(f.events()).toHaveLength(1);
    }
  } finally { f.close(); }
});

test('unacknowledged planning holds new rows; acknowledged sets repeat only when the set changes', () => {
  const f = fixture();
  try {
    f.declaration('first'); f.commit();
    const first = f.events()[0]!;
    f.db.query('INSERT INTO events(goal,event_key,body) VALUES(?,?,?)').run('program', first.key, first.body);
    expect(f.events()).toEqual([]);
    f.declaration('second'); f.commit();
    expect(f.events()).toEqual([]);
    f.db.query('UPDATE events SET handled=1').run();
    const second = f.events()[0]!;
    expect(second.key).not.toBe(first.key);
    expect(second.body).toContain('program/second');
    f.db.query('INSERT INTO events(goal,event_key,body,handled) VALUES(?,?,?,1)').run('program', second.key, second.body);
    expect(f.events()).toEqual([]);
    f.ledger.tasks.cover = f.task('cover', { kind: 'implementation', rows: ['program/second'], state: 'running' });
    expect(f.events()[0]!.key).not.toBe(first.key);
  } finally { f.close(); }
});

test('the same handled set stays quiet even if notes change', () => {
  const f = fixture();
  try {
    f.declaration('first'); f.commit();
    const first = f.events()[0]!;
    f.db.query('INSERT INTO events(goal,event_key,body,handled) VALUES(?,?,?,1)').run('program', first.key, first.body);
    expect(f.events()).toEqual([]);
    f.declaration('first', 'program', "visitor: pending('revised note')"); f.commit();
    expect(f.events()).toEqual([]);
  } finally { f.close(); }
});

test('each Goal gets its own rows; the landed declaration task takes precedence over the file area', () => {
  const f = fixture();
  try {
    const file = f.declaration('landed');
    const mergedCommit = f.commit();
    f.declaration('fallback', 'kernel');
    f.declaration('fallback');
    f.commit();
    f.ledger.tasks.lander = f.task('G-12', { goal: 'kernel', paths: [file], mergedCommit,
      attempts: [{ n: 1, effort: 'high', pid: 0, session: '', output: '/old/state/runs/G-12/attempt-1.json',
        lastMessage: '/old/state/runs/G-12/attempt-1.last.md', startedAt: '' }] });
    f.db.query('INSERT INTO managers VALUES(?)').run('kernel');
    expect(f.events()[0]!.body).toContain('program/fallback');
    expect(f.events()[0]!.body).not.toContain('program/landed');
    const body = f.events('kernel')[0]!.body;
    expect(body).toContain('kernel/fallback');
    expect(body).not.toContain('program/landed');
    const landed = uncoveredPlanningRows(f.state, f.ledger, f.repo).get('kernel')!.filter(row => row.id === 'program/landed');
    expect(landed).toHaveLength(1);
    expect(planningBody('kernel', landed)).toContain(`landed: G-12 | handoff: ${join(f.state, 'runs/G-12/attempt-1.last.md')}`);
  } finally { f.close(); }
});

test('an unlanded task cannot own a declaration on main', () => {
  const f = fixture();
  try {
    const file = f.declaration('failure');
    const mergedCommit = f.commit();
    git(f.repo, ['branch', 'worker']);
    git(f.repo, ['checkout', 'worker']);
    f.declaration('worker-only'); const workerCommit = f.commit();
    git(f.repo, ['checkout', 'main']);
    f.ledger.tasks.unlanded = f.task('G-13', { goal: 'kernel', paths: [file], mergedCommit: workerCommit });
    expect(f.events()[0]!.body).toContain('program/failure');
    f.ledger.tasks.unlanded.mergedCommit = mergedCommit;
    expect(f.events()).toEqual([]);
  } finally { f.close(); }
});

test('a later task with an old base cannot take an introduction, including an addition outside the landing task claim', () => {
  const f = fixture();
  try {
    f.declaration('failure');
    const introduced = f.commit();
    f.declaration('another');
    const later = f.commit();
    f.ledger.tasks.later = f.task('G-15', { goal: 'kernel', mergedCommit: later });
    f.ledger.tasks.original = f.task('G-14', { paths: ['unrelated.ts'], mergedCommit: introduced });
    const rows = uncoveredPlanningRows(f.state, f.ledger, f.repo);
    expect(rows.get('program')!.find(row => row.id === 'program/failure')?.task).toBe('G-14');
    expect(rows.get('kernel')!.find(row => row.id === 'program/another')?.task).toBe('G-15');
  } finally { f.close(); }
});

test('planning slices six rows from one vertical in scope order and raises the next slice when briefs cover it', () => {
  const f = fixture();
  try {
    for (const vertical of ['anime', 'recipes', 'books']) {
      for (let index = 0; index < 8; index++) {
        const file = f.declaration(`row-${index}`, 'program', "visitor: pending('two\\nlines'), owner: pending('owner')");
        const path = join(f.repo, file);
        const content = readFileSync(path, 'utf8').replace(`program/row-${index}`, `${vertical}/row-${index}`);
        f.write(`scripts/qa/cases/outcomes/program/${vertical}-${index}.ts`, content);
        rmSync(path);
      }
    }
    f.commit();
    const rows = uncoveredPlanningRows(f.state, f.ledger, f.repo).get('program')!;
    const body = planningBody('program', [...rows].reverse());
    expect(rows).toHaveLength(24);
    expect(body).toContain('18 uncovered rows wait after this slice.');
    expect(body.match(/declaration:/g)).toHaveLength(6);
    expect(body).toContain('books/row-0 |');
    expect(body).toContain('books/row-5 |');
    expect(body).not.toContain('books/row-6 |');
    expect(body).not.toContain('anime/row-');
    expect(body).not.toContain('recipes/row-');
    expect(body).toEndWith('A row that waits for another task gets its brief now, queued behind that task.');
    expect(body).toContain('a fixture that cannot reach the state counts as a cause');
    const event = f.events()[0]!;
    f.db.query('INSERT INTO events(goal,event_key,body,handled) VALUES(?,?,?,1)').run('program', event.key, event.body);
    expect(f.events()).toEqual([]);
    f.write('docs/goals/program/tasks/G-100.md', '---\nrows: [books/row-0, books/row-1, books/row-2, books/row-3, books/row-4, books/row-5]\n---\n');
    const changed = f.events()[0]!;
    expect(changed.key).not.toBe(event.key);
    expect(changed.body).toContain('16 uncovered rows wait after this slice.');
    expect(changed.body.match(/declaration:/g)).toHaveLength(2);
    expect(changed.body).toContain('books/row-6 |');
    expect(changed.body).toContain('books/row-7 |');
    f.db.query('INSERT INTO events(goal,event_key,body,handled) VALUES(?,?,?,1)').run('program', changed.key, changed.body);
    f.write('docs/goals/program/tasks/G-101.md', '---\nrows: [books/row-6, books/row-7]\n---\n');
    expect(f.events()[0]!.body).toContain('recipes/row-0 |');
    expect(f.events()[0]!.body).not.toContain('anime/row-');
  } finally { f.close(); }
});

test('no enrolled manager means no event, while the planning command still reports rows', () => {
  const f = fixture();
  try {
    f.declaration('failure'); f.commit();
    f.db.query('DELETE FROM managers').run();
    expect(f.events()).toEqual([]);
    const expected = planningLines(f.state, f.ledger, 'program', f.repo).join('\n');
    const cli = spawnSync(process.execPath, [join(import.meta.dir, 'goalctl.ts'), 'planning', 'program'],
      { cwd: f.repo, env: { ...process.env, GOAL_MAIL_STATE_DIR: f.state }, encoding: 'utf8' });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim()).toBe(expected);
    const all = spawnSync(process.execPath, [join(import.meta.dir, 'goalctl.ts'), 'planning'],
      { cwd: f.repo, env: { ...process.env, GOAL_MAIL_STATE_DIR: f.state }, encoding: 'utf8' });
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout.trim()).toBe(planningLines(f.state, f.ledger, undefined, f.repo).join('\n'));
  } finally { f.close(); }
});
