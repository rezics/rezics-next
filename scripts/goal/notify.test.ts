import { isolateTestSettings } from './fixtures/settings.ts';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

isolateTestSettings();

const TOKEN = 'fake-telegram-token-should-never-appear';
const CLI = join(import.meta.dir, 'notify.ts');
const scratch = join(import.meta.dir, '../../.temp/notify-tests');

type Reply = { status?: number; body?: { ok?: boolean }; accepted?: boolean };
type Captured = { path: string; payload: { chat_id: string; text: string; parse_mode: string }; status: number };
const fixtures: Fixture[] = [];

interface Fixture {
  directory: string; stateDir: string; secrets: string; api: string; requests: Captured[]; accepted: Captured[];
  replies: Reply[]; server: ReturnType<typeof Bun.serve>;
  run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  stopServer(): Promise<void>;
  close(): void;
}

function fixture(): Fixture {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'case-'));
  process.env.GOAL_SETTINGS_DIRECTORY = join(directory, '.goalctl');
  const stateDir = join(directory, '.temp/goal-orchestration');
  const secrets = join(directory, 'fake-bots.json');
  writeFileSync(secrets, JSON.stringify({ telegram: [{ token: TOKEN }] }));
  const requests: Captured[] = [];
  const accepted: Captured[] = [];
  const replies: Reply[] = [];
  let serverStopped = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const payload = await request.json() as Captured['payload'];
      const reply = replies.shift() ?? {};
      const captured = { path: new URL(request.url).pathname, payload, status: reply.status ?? 200 };
      requests.push(captured);
      if (reply.accepted ?? (captured.status >= 200 && captured.status < 300 && reply.body?.ok !== false)) accepted.push(captured);
      return Response.json(reply.body ?? { ok: true }, { status: captured.status });
    },
  });
  const cliFixture: Fixture = {
    directory, stateDir, secrets, api: server.url.origin, requests, accepted, replies, server,
    async run(...args: string[]) {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      Object.assign(env, {
        GOAL_MAIL_STATE_DIR: stateDir,
        GOAL_SETTINGS_DIRECTORY: join(directory, '.goalctl'),
        GOAL_TELEGRAM_SECRETS: secrets,
        GOAL_TELEGRAM_CHAT: 'test-chat-22',
        GOAL_TELEGRAM_API: server.url.origin,
      });
      const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
    async stopServer() {
      if (serverStopped) return;
      serverStopped = true;
      await server.stop(true);
    },
    close() {
      void cliFixture.stopServer();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  fixtures.push(cliFixture);
  return cliFixture;
}

afterEach(() => {
  for (const current of fixtures.splice(0)) current.close();
});

function askArgs(question = 'Which route should we take?'): string[] {
  return ['ask', '--goal', 'program', '--task', 'G-017', '--question', question,
    '--option', 'a=Keep the current route', '--option', 'b=Choose the new route', '--recommend', 'a'];
}

function outbox(f: Fixture): { id: number; body: string; state: string; sentAt: string | null }[] {
  const path = join(f.stateDir, 'telegram.sqlite');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, strict: true });
  try { return db.query('SELECT id, body, state, sentAt FROM outbox ORDER BY id').all() as ReturnType<typeof outbox>; }
  finally { db.close(); }
}

function expectNoSecret(f: Fixture, result: { stdout: string; stderr: string }): void {
  expect(result.stdout.includes(TOKEN)).toBe(false);
  expect(result.stderr.includes(TOKEN)).toBe(false);
  const path = join(f.stateDir, 'telegram.sqlite');
  if (Bun.file(path).size > 0) {
    const db = new Database(path, { readonly: true, strict: true });
    try {
      const rows = [
        ...db.query('SELECT * FROM outbox').all(),
        ...db.query('SELECT * FROM decisions').all(),
      ];
      expect(JSON.stringify(rows).includes(TOKEN)).toBe(false);
    } finally { db.close(); }
  }
}

describe('Goal Telegram decisions and notices', () => {
  test('asks send the exact decision text with and without a default', async () => {
    const f = fixture();
    const without = await f.run(...askArgs());
    expect(without.code).toBe(0);
    expect(without.stdout.trim()).toBe('Sent D-1.');
    expect(f.accepted[0]!.payload).toEqual({
      chat_id: 'test-chat-22', parse_mode: 'HTML',
      text: '<code>D-1</code>\nGoal: program\nTask: G-017\nQuestion: Which route should we take?\nOptions:\na) Keep the current route\nb) Choose the new route\nRecommended: a — Keep the current route\n\n<code>D-1 a</code>',
    });

    const withDefault = await f.run(...askArgs('Should the route change after the review?'),
      '--default', 'b', '--default-at', '2026-10-15T12:30:00Z');
    expect(withDefault.code).toBe(0);
    expect(withDefault.stdout.trim()).toBe('Sent D-2.');
    expect(f.accepted[1]!.payload.text).toBe(
      '<code>D-2</code>\nGoal: program\nTask: G-017\nQuestion: Should the route change after the review?\nOptions:\na) Keep the current route\nb) Choose the new route\nRecommended: a — Keep the current route\nDefault: b at 2026-10-15T12:30:00Z\n\n<code>D-2 a</code>');
  });

  test('all fixed event notices include their Goal, task, question and notice number', async () => {
    const f = fixture();
    for (const event of ['start', 'pause', 'stop', 'fault', 'allowance', 'host']) {
      const result = await f.run('tell', '--event', event, '--goal', 'kernel', '--task', 'G-021');
      expect(result.code, result.stderr).toBe(0);
    }
    const texts = f.accepted.map(message => message.payload.text);
    expect(texts).toEqual([
      '<code>Goal start</code>\nGoal: kernel\nTask: G-021\nQuestion: Should this Goal start?\nNotice #1: The Goal manager started.',
      '<code>Goal pause</code>\nGoal: kernel\nTask: G-021\nQuestion: Should this Goal stay paused?\nNotice #2: The Goal manager paused the Goal.',
      '<code>Goal stop</code>\nGoal: kernel\nTask: G-021\nQuestion: Should this Goal stop?\nNotice #3: The Goal manager stopped the Goal.',
      '<code>Goal fault</code>\nGoal: kernel\nTask: G-021\nQuestion: What should happen after this fault?\nNotice #4: The Goal manager reported a fault.',
      '<code>Goal allowance</code>\nGoal: kernel\nTask: G-021\nQuestion: Should this Goal wait for its allowance to reset?\nNotice #5: The Goal manager reached an allowance limit.',
      '<code>Goal host</code>\nGoal: kernel\nTask: G-021\nQuestion: Should this Goal keep waiting on the host?\nNotice #6: The Goal manager is waiting on the host.',
    ]);
    const noted = await f.run('tell', '--event', 'fault', '--goal', 'kernel', '--note', 'Review <storage> & retry');
    expect(noted.code).toBe(0);
    expect(f.accepted.at(-1)!.payload.text).toContain('Note: Review &lt;storage&gt; &amp; retry');
  });

  test('decision codes continue across CLI processes and answers can be replaced once requested', async () => {
    const f = fixture();
    const first = await f.run(...askArgs('First question?'));
    const second = await f.run(...askArgs('Second question?'), '--default', 'b', '--default-at', '2026-10-16T09:00:00Z');
    expect(first.stdout).toContain('D-1');
    expect(second.stdout).toContain('D-2');

    const answer = await f.run('decide', 'D-1', 'b', '--note', 'Reviewed by the maintainer');
    expect(answer.code).toBe(0);
    expect(answer.stdout.trim()).toMatch(/^Recorded D-1 b at .*Z\.$/u);
    const refused = await f.run('decide', 'D-1', 'a');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--replace');
    const replaced = await f.run('decide', 'D-1', 'a', '--replace');
    expect(replaced.code).toBe(0);
    expect(replaced.stdout.trim()).toMatch(/^Recorded D-1 a at .*Z\.$/u);

    const open = await f.run('decisions');
    expect(open.code).toBe(0);
    expect(open.stdout).toContain('D-2 | age:');
    expect(open.stdout).toContain('Second question?');
    expect(open.stdout).toContain('recommended: a | default: b at 2026-10-16T09:00:00Z');
    expect(open.stdout).not.toContain('D-1');
    const all = await f.run('decisions', '--all');
    expect(all.stdout).toContain('D-1 | age:');
    const db = new Database(join(f.stateDir, 'telegram.sqlite'), { readonly: true, strict: true });
    try {
      expect(db.query('SELECT answerLetter, answerNote FROM decisions WHERE id = 1').get()).toEqual({
        answerLetter: 'a', answerNote: null,
      });
      expect(db.query('SELECT answeredAt FROM decisions WHERE id = 1').get()).toMatchObject({ answeredAt: expect.any(String) });
    } finally { db.close(); }
  });

  test('failed sends queue in order, flush retries the oldest first, and sent messages are not repeated', async () => {
    const f = fixture();
    f.replies.push({ status: 503 });
    const failed = await f.run(...askArgs('Older queued question?'));
    expect(failed.code).toBe(0);
    expect(failed.stdout).toContain('Queued D-1; message #1: Telegram returned HTTP 503');
    expect(outbox(f).map(row => row.state)).toEqual(['queued']);

    const newer = await f.run('tell', '--event', 'stop', '--goal', 'program', '--task', 'G-019');
    expect(newer.code).toBe(0);
    expect(f.accepted).toHaveLength(2);
    expect(f.accepted[0]!.payload.text).toContain('Older queued question?');
    expect(f.accepted[1]!.payload.text).toContain('Notice #2: The Goal manager stopped the Goal.');
    expect(outbox(f).map(row => row.state)).toEqual(['sent', 'sent']);
    const before = f.requests.length;
    const flushed = await f.run('flush');
    expect(flushed.stdout.trim()).toBe('Outbox is empty.');
    expect(f.requests).toHaveLength(before);
  });

  test('two concurrent flush processes claim one queued message only once', async () => {
    const f = fixture();
    writeFileSync(f.secrets, JSON.stringify({ telegram: [] }));
    const queued = await f.run('tell', '--event', 'start', '--goal', 'program');
    expect(queued.stdout).toContain('missing Telegram token');
    writeFileSync(f.secrets, JSON.stringify({ telegram: [{ token: TOKEN }] }));
    const results = await Promise.all([f.run('flush'), f.run('flush')]);
    expect(results.every(result => result.code === 0)).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(f.accepted).toHaveLength(1);
    expect(outbox(f).map(row => row.state)).toEqual(['sent']);
  });

  test('429 and a network failure leave messages queued without leaking the token', async () => {
    const f = fixture();
    f.replies.push({ status: 429, body: { ok: false } });
    const limited = await f.run(...askArgs('Please wait?'));
    expect(limited.code).toBe(0);
    expect(limited.stdout).toContain('Telegram returned HTTP 429');
    expect(outbox(f).map(row => row.state)).toEqual(['queued']);
    expectNoSecret(f, limited);

    await f.stopServer();
    const network = await f.run('flush');
    expect(network.code).toBe(0);
    expect(network.stdout).toContain('network error');
    expect(outbox(f).map(row => row.state)).toEqual(['queued']);
    expectNoSecret(f, network);
  });

  test('HTTP API rejection and missing credentials queue messages and never expose secrets', async () => {
    const f = fixture();
    f.replies.push({ status: 200, body: { ok: false } });
    const rejected = await f.run(...askArgs('Retry this decision?'));
    expect(rejected.stdout).toContain('Telegram rejected the message');
    expectNoSecret(f, rejected);

    writeFileSync(f.secrets, JSON.stringify({ telegram: [] }));
    const missingToken = await f.run('tell', '--event', 'host', '--goal', 'kernel');
    expect(missingToken.code).toBe(0);
    expect(missingToken.stdout).toContain('missing Telegram token');
    expect(f.requests).toHaveLength(1);
    expectNoSecret(f, missingToken);

    writeFileSync(f.secrets, JSON.stringify({ telegram: [{ token: TOKEN }] }));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    Object.assign(env, {
      GOAL_MAIL_STATE_DIR: f.stateDir,
      GOAL_TELEGRAM_SECRETS: f.secrets,
      GOAL_TELEGRAM_CHAT: '',
      GOAL_TELEGRAM_API: f.api,
    });
    const child = Bun.spawn([process.execPath, CLI, 'flush'], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stdout).toContain('missing Telegram chat');
    expectNoSecret(f, { stdout, stderr });
  });

  test('a local state chat file migrates into user settings and supplies the chat', async () => {
    const f = fixture();
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(join(f.stateDir, 'telegram-chat'), 'file-chat-31\n');
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    Object.assign(env, {
      GOAL_MAIL_STATE_DIR: f.stateDir,
      GOAL_TELEGRAM_SECRETS: f.secrets,
      GOAL_TELEGRAM_CHAT: '',
      GOAL_TELEGRAM_API: f.api,
    });
    const child = Bun.spawn([process.execPath, CLI, ...askArgs('Chat file question?')], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Sent D-1');
    expect(f.accepted[0]!.payload.chat_id).toBe('file-chat-31');
    expect(JSON.parse(readFileSync(join(f.directory, '.goalctl/settings.user.json'), 'utf8'))).toMatchObject({
      version: 1, telegramChat: 'file-chat-31',
    });
    expect(stderr).toContain('telegram-chat');
    expect(existsSync(join(f.stateDir, 'telegram-chat'))).toBe(false);
  });

  test('user settings supply the chat when no environment chat is set', async () => {
    const f = fixture();
    mkdirSync(join(f.directory, '.goalctl'), { recursive: true });
    writeFileSync(join(f.directory, '.goalctl/settings.user.json'), JSON.stringify({ version: 1, telegramChat: 'settings-chat' }));
    const child = Bun.spawn([process.execPath, CLI, ...askArgs('Configured chat question?')], {
      env: { ...process.env, GOAL_MAIL_STATE_DIR: f.stateDir, GOAL_TELEGRAM_SECRETS: f.secrets,
        GOAL_TELEGRAM_CHAT: '', GOAL_TELEGRAM_API: f.api }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(f.accepted[0]!.payload.chat_id).toBe('settings-chat');
  });

  test('field limits are accepted at the boundary and refused above it, with line breaks and code fences', async () => {
    const f = fixture();
    const boundary = await f.run('ask', '--goal', 'program', '--question', 'q'.repeat(500),
      '--option', `a=${'a'.repeat(200)}`, '--option', `b=${'b'.repeat(200)}`,
      '--option', 'c=Three', '--option', 'd=Four', '--recommend', 'a');
    expect(boundary.code).toBe(0);
    const noteBoundary = await f.run('tell', '--event', 'fault', '--goal', 'program', '--note', 'n'.repeat(300));
    expect(noteBoundary.code).toBe(0);

    const badInputs: string[][] = [
      ['ask', '--goal', 'program', '--question', 'q'.repeat(501), '--option', 'a=One', '--option', 'b=Two', '--recommend', 'a'],
      ['ask', '--goal', 'program', '--question', 'Question?', '--option', `a=${'a'.repeat(201)}`, '--option', 'b=Two', '--recommend', 'a'],
      ['tell', '--event', 'fault', '--goal', 'program', '--note', 'n'.repeat(301)],
      ['ask', '--goal', 'program', '--question', 'two\nlines', '--option', 'a=One', '--option', 'b=Two', '--recommend', 'a'],
      ['ask', '--goal', 'program', '--question', 'Question?', '--option', 'a=one\nline', '--option', 'b=Two', '--recommend', 'a'],
      ['tell', '--event', 'fault', '--goal', 'program', '--note', 'two\nlines'],
      ['ask', '--goal', 'program', '--question', 'bad ``` fence', '--option', 'a=One', '--option', 'b=Two', '--recommend', 'a'],
      ['ask', '--goal', 'program', '--question', 'Question?', '--option', 'a=```fence```', '--option', 'b=Two', '--recommend', 'a'],
      ['tell', '--event', 'fault', '--goal', 'program', '--note', '```fence```'],
      ['ask', '--goal', 'program', '--question', 'Question?', '--option', 'a=One', '--option', 'a=Two', '--recommend', 'a'],
      ['ask', '--goal', 'program', '--question', 'Question?', '--option', 'a=One', '--recommend', 'a'],
      ['ask', '--goal', 'program', '--question', 'Question?', '--option', 'a=One', '--option', 'b=Two',
        '--option', 'c=Three', '--option', 'd=Four', '--option', 'e=Five', '--recommend', 'a'],
      ['ask', '--goal', 'program', '--question', 'Question?', '--option', 'a=One', '--option', 'b=Two', '--recommend', 'c'],
      ['tell', '--event', 'unknown', '--goal', 'program'],
    ];
    for (const args of badInputs) {
      const result = await f.run(...args);
      expect(result.code, `${args.join(' ')}`).toBe(1);
      expectNoSecret(f, result);
    }
  });

  test('configured tokens are refused as message text before any row is stored', async () => {
    const f = fixture();
    const result = await f.run('tell', '--event', 'fault', '--goal', 'program', '--note', TOKEN);
    expect(result.code).toBe(1);
    expect(result.stderr.includes(TOKEN)).toBe(false);
    expect(result.stderr).toContain('cannot appear in a notification');
    expect(f.requests).toHaveLength(0);
    expectNoSecret(f, result);
    expect(outbox(f)).toEqual([]);
  });
});
