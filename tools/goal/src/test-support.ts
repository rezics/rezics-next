import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git as repositoryGit } from './merge.ts';

import { loadSettings } from './config.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks, git } from './tasks.ts';
import type { Brief, Pool, PoolReading, Settings } from './types.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';


export function temporaryDirectory(): { path: string; close(): void } {
  const root = resolve(import.meta.dir, '../../../.temp/goal-tests');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'case-'));
  return { path, close: () => rmSync(path, { recursive: true, force: true }) };
}
export function repository() {
  const temporary = temporaryDirectory();
  const main = join(temporary.path, 'main'); mkdirSync(main);
  repositoryGit(main, 'init', '-b', 'main');
  repositoryGit(main, 'config', 'user.email', 'test@example.invalid'); repositoryGit(main, 'config', 'user.name', 'Test');
  writeFileSync(join(main, 'base'), 'base\n'); repositoryGit(main, 'add', '.'); repositoryGit(main, 'commit', '-m', 'Initial');
  return { ...temporary, main, commit(file: string, content = file) {
    writeFileSync(join(main, file), content); repositoryGit(main, 'add', '--', file); repositoryGit(main, 'commit', '-m', `Change ${file}`);
  }, branch(name: string, file: string, content = file) {
    const worker = join(temporary.path, name);
    repositoryGit(main, 'worktree', 'add', '-b', name, worker, 'main');
    writeFileSync(join(worker, file), content); repositoryGit(worker, 'add', '.'); repositoryGit(worker, 'commit', '-m', `Change ${file}`);
    return { taskId: name, attempt: 1, branch: name, worktree: worker, declaredPaths: [file], gate: ['true'] };
  } };
}

export function tempDirectory(): string {
  return temporaryDirectory().path;
}
export const markdown = `---
goal: fixture
kind: implementation
paths: [result.txt]
riskAreas: []
acceptance:
  command: [bun, test]
  tests: [acceptance]
  failing: true
estimate:
  lines: 100
  files: 4
criticalPath: false
waiting: []
---
Write the requested result and commit it.
`;
export function brief(): Brief { return parseBrief(markdown, readRiskOwnership(join(import.meta.dir, '../risk-areas.json'))); }
export function fixturePool(directory = '/fixture'): Pool {
  return { name: 'fixture', cli: 'codex', classes: ['codex'], configDirectory: directory, command: 'codex', allowanceKey: 'fixture',
    policy: { weight: 1, reservePercent: 0, allowUnknown: true, maxAgeMs: 60000 } };
}
export function reading(pool: Pool, used = 0): PoolReading {
  return { pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date().toISOString(), observedAt: new Date().toISOString(),
    windows: [{ usedPercent: used, minutes: 10080, resetsAt: Date.now() + 86400000 }], exhausted: used >= 100, error: null };
}
export function harness(script = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'commit',type:'command_execution',command:'git commit -m fixture'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
`): { root: string; settings: Settings; store: WorkerStore; tasks: WorkerTasks; briefFile: string; dispose(): void } {
  const root = tempDirectory();
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.temp/\n'); writeFileSync(join(root, 'README.md'), 'Fixture\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Initial fixture']);
  const state = join(root, '.temp/goal'); mkdirSync(state, { recursive: true });
  const command = join(state, 'codex');
  writeFileSync(command, script.replaceAll('__GOAL_TEST_DATABASE_PATH__', JSON.stringify(join(state, 'goal.sqlite')))); chmodSync(command, 0o755);
  const pool = { ...fixturePool(join(state, 'account')), command };
  writeFileSync(join(state, 'local.json'), JSON.stringify({ version: 1, terminationGraceMs: 1000, pools: [pool] }));
  const settings = loadSettings({ cwd: root, env: {} });
  mkdirSync(settings.stateDirectory, { recursive: true });
  const store = new WorkerStore(openDb(join(settings.stateDirectory, 'goal.sqlite'))), tasks = new WorkerTasks(settings, store);
  const briefFile = join(state, 'source.md'); writeFileSync(briefFile, markdown);
  return { root, settings, store, tasks, briefFile, dispose() { store.db.close(); rmSync(root, { recursive: true, force: true }); } };
}
