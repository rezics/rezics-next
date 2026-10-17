import { afterEach, beforeEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let installed = false;

/** The Bun preload owns isolation, including tests that forget to opt into a fixture helper. */
export function isolateTestSettings(): void {
  if (installed) return;
  installed = true;
  const base = join(import.meta.dir, '../../../.temp/settings-fixtures');
  mkdirSync(base, { recursive: true });
  const run = mkdtempSync(join(base, 'run-'));
  const bin = join(run, 'bin');
  mkdirSync(bin);
  // Bare account launchers preserve each test's more specific PATH recorder. An inherited
  // absolute account launcher can never win, because the settings are replaced before imports.
  const recorder = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const args = process.argv.slice(2);
const program = basename(import.meta.filename);
const input = readFileSync(0, 'utf8');
appendFileSync(process.env.GOAL_TEST_LAUNCH_LOG ?? ${JSON.stringify(join(run, 'launches.jsonl'))},
  JSON.stringify({ program, args, input, cwd: process.cwd(), codexHome: process.env.CODEX_HOME,
    claudeHome: process.env.CLAUDE_CONFIG_DIR }) + '\\n');
const reviewOutput = args.indexOf('--output-last-message');
if (reviewOutput >= 0) writeFileSync(args[reviewOutput + 1], JSON.stringify({ findings: [] }));
const workerOutput = args.indexOf('-o');
if (workerOutput >= 0) writeFileSync(args[workerOutput + 1], 'RESULT: partial\\nNEXT: recorded fixture launch\\n');
console.log(JSON.stringify(program === 'codex' ? { type: 'thread.started', thread_id: 'recording-session' }
  : { session_id: 'recording-session', result: 'RESULT: partial', structured_output: { findings: [] } }));
`;
  for (const program of ['codex', 'claude', 'grok', 'cursor-agent']) {
    const launcher = join(bin, program);
    writeFileSync(launcher, recorder);
    chmodSync(launcher, 0o755);
  }
  const path = `${bin}:${process.env.PATH ?? ''}`;
  const environment = () => {
    const directory = mkdtempSync(join(run, 'case-'));
    const home = join(directory, 'codex'), claude = join(directory, 'claude');
    mkdirSync(home); mkdirSync(claude);
    writeFileSync(join(directory, 'settings.user.json'), JSON.stringify({ version: 1,
      accounts: [{ engine: 'codex', launcher: 'codex', home, weight: 1 }] }));
    return { GOAL_SETTINGS_DIRECTORY: directory, GOAL_CODEX_HOME: home, CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: claude, GOAL_TEST_LAUNCH_LOG: join(directory, 'launches.jsonl'), PATH: path };
  };
  const initial = environment();
  Object.assign(process.env, initial);
  beforeEach(() => { Object.assign(process.env, environment()); });
  afterEach(() => { Object.assign(process.env, initial); });
  // Detached recording children may still be finishing when a case ends.
  process.once('exit', () => rmSync(run, { recursive: true, force: true }));
}

isolateTestSettings();
