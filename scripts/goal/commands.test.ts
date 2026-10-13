import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scratch = join(import.meta.dir, '../../.temp/goal-command-tests');
const GOALCTL = join(import.meta.dir, 'goalctl.ts');
const NOTIFY = join(import.meta.dir, 'notify.ts');
const TOKEN = 'fake-goal-command-token';

interface CliResult { code: number; stdout: string; stderr: string }
interface Fixture {
  directory: string;
  requests: { path: string; text: string }[];
  server: ReturnType<typeof Bun.serve>;
  goal(...args: string[]): Promise<CliResult>;
  notify(...args: string[]): Promise<CliResult>;
}

const fixtures: Fixture[] = [];

function fixture(): Fixture {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'case-'));
  const stateDir = join(directory, 'state');
  const secrets = join(directory, 'fake-bots.json');
  writeFileSync(secrets, JSON.stringify({ telegram: [{ token: TOKEN }] }));
  const requests: Fixture['requests'] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const payload = await request.json() as { text: string };
      requests.push({ path: new URL(request.url).pathname, text: payload.text });
      return Response.json({ ok: true });
    },
  });
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, {
    GOAL_MAIL_STATE_DIR: stateDir,
    GOAL_TELEGRAM_SECRETS: secrets,
    GOAL_TELEGRAM_CHAT: 'test-chat',
    GOAL_TELEGRAM_API: server.url.origin,
  });

  async function run(cli: string, ...args: string[]): Promise<CliResult> {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  const current: Fixture = {
    directory, requests, server,
    goal: (...args) => run(GOALCTL, ...args),
    notify: (...args) => run(NOTIFY, ...args),
  };
  fixtures.push(current);
  return current;
}

afterEach(async () => {
  for (const current of fixtures.splice(0)) {
    await current.server.stop(true);
    rmSync(current.directory, { recursive: true, force: true });
  }
  rmSync(scratch, { recursive: true, force: true });
});

test('unknown commands print goalctl usage and every command usage line, then exit 2', async () => {
  const f = fixture();
  const result = await f.goal('not-a-command');

  expect(result.code).toBe(2);
  expect(result.stderr).toContain('Usage: goalctl goal start');
  for (const usage of [
    'Usage: goalctl ask ',
    'Usage: goalctl decide ',
    'Usage: goalctl decisions [--all]',
    'Usage: goalctl flush',
    'Usage: goalctl tell ',
  ]) expect(result.stderr).toContain(usage);
});

test('invalid command names take the unknown-command path without resolving outside commands', async () => {
  const f = fixture();
  for (const name of ['../notify', 'notify.ts', 'Notify']) {
    const result = await f.goal(name);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage: goalctl goal start');
  }
});

test('Telegram command files forward their arguments through notifyCommand with isolated state', async () => {
  const f = fixture();
  const ask = await f.goal('ask', '--goal', 'program', '--question', 'Which path?',
    '--option', 'a=Current', '--option', 'b=New', '--recommend', 'b');
  expect(ask.code).toBe(0);
  expect(ask.stdout.trim()).toBe('Sent D-1.');
  expect(f.requests[0]).toEqual({
    path: `/bot${TOKEN}/sendMessage`,
    text: '<code>D-1</code>\nGoal: program\nTask: none\nQuestion: Which path?\nOptions:\na) Current\nb) New\nRecommended: b — New\n\n<code>D-1 b</code>',
  });

  const tell = await f.goal('tell', '--event', 'fault', '--goal', 'program', '--note', 'Check storage');
  expect(tell.code).toBe(0);
  expect(tell.stdout.trim()).toBe('Sent 1 queued message.');
  expect(f.requests[1]!.text).toContain('Note: Check storage');

  const decide = await f.goal('decide', 'D-1', 'a', '--note', 'Reviewed');
  expect(decide.code).toBe(0);
  expect(decide.stdout.trim()).toMatch(/^Recorded D-1 a at .*Z\.$/u);

  const [direct, throughGoalctl] = await Promise.all([f.notify('decisions'), f.goal('decisions')]);
  expect(direct.code).toBe(0);
  expect(throughGoalctl).toEqual(direct);
  expect(throughGoalctl.stdout.trim()).toBe('No open decisions.');

  const all = await f.goal('decisions', '--all');
  expect(all.code).toBe(0);
  expect(all.stdout).toContain('D-1 | age:');
  expect(all.stdout).toContain('Which path?');

  const flush = await f.goal('flush');
  expect(flush.code).toBe(0);
  expect(flush.stdout.trim()).toBe('Outbox is empty.');
});
