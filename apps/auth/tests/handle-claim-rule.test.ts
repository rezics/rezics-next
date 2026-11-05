import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const rules = {
  en: 'Use 3 to 64 characters: letters a–z, numbers, hyphens or underscores. Start and end with a letter or number.',
  'zh-Hans': '请输入 3 至 64 个字符：字母 a–z、数字、连字符或下划线。开头和结尾必须是字母或数字。',
  'zh-Hant': '請輸入 3 至 64 個字元：字母 a–z、數字、連字號或底線。開頭和結尾必須是字母或數字。',
  ja: '3〜64文字で入力してください。使える文字は英字 a–z、数字、ハイフン、アンダースコアです。先頭と末尾は英字または数字にしてください。',
  ko: '문자 3~64자를 입력하세요. 영문자 a–z, 숫자, 하이픈 또는 밑줄을 사용할 수 있습니다. 처음과 끝은 영문자나 숫자여야 합니다.',
  de: 'Verwende 3 bis 64 Zeichen: Buchstaben a–z, Zahlen, Bindestriche oder Unterstriche. Das erste und letzte Zeichen muss ein Buchstabe oder eine Zahl sein.',
  fr: 'Utilisez 3 à 64 caractères : lettres a–z, chiffres, tirets ou traits de soulignement. Le premier et le dernier caractère doivent être une lettre ou un chiffre.',
  es: 'Usa entre 3 y 64 caracteres: letras a–z, números, guiones o guiones bajos. El primer y el último carácter deben ser una letra o un número.',
};
const accepted = ['abc', '123', 'A_B', 'A-Z', 'a__--9', '9' + 'A'.repeat(62) + '0', 'Kaa'];
const refused = [
  '',
  'a',
  'ab',
  'abc_',
  'abc-',
  '_abc',
  '-abc',
  ' abc',
  'abc ',
  'a b',
  'a\tb',
  'a'.repeat(65),
  'éaa',
  '中文名',
  'a.b',
];
const calls: { path: string; body: Record<string, unknown> }[] = [];
const fake = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/turnstile.js')
      return new Response(
        'window.turnstile = { ready(fn) { fn(); }, render(el, options) { this.options = options; options.callback("token"); return "widget"; }, reset() { this.options.callback("token"); }, remove() {} };',
        {
          headers: { 'content-type': 'text/javascript' },
        },
      );
    if (path === '/session') return Response.json({ account_id: 'claim-test-account' });
    if (request.method === 'POST') {
      calls.push({ path, body: (await request.json()) as Record<string, unknown> });
      return Response.json(
        { error: path === '/signup' ? 'handle_unavailable' : 'account_operation_denied' },
        { status: 409 },
      );
    }
    return new Response('Not Found', { status: 404 });
  },
});
let child: ChildProcess | undefined;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  let output = '';
  child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AUTH_ORIGIN: fake.url.origin,
      TURNSTILE_SITE_KEY: 'claim-test',
      TURNSTILE_SCRIPT_URL: `${fake.url.origin}/turnstile.js`,
    },
  });
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dev server exited: ${output}`);
    try {
      if ((await fetch(`${origin}/signup`, { signal: AbortSignal.timeout(60_000) })).status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`dev server did not start: ${output}`);
    await Bun.sleep(500);
  }
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
});

async function open(path: string, locale = 'en'): Promise<Page> {
  const context = await browser.newContext({ locale, extraHTTPHeaders: { 'Accept-Language': locale } });
  await context.addCookies([{ name: 'rezics_locale', value: locale, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.locator('input[name="handle"]').waitFor();
  if (path === '/signup') {
    await page.locator('input[type="email"]').fill('claim@example.test');
    await page.locator('input[type="password"]').fill('claim-password');
  }
  return page;
}

function errorFor(page: Page, path: string) {
  return page.locator(path === '/signup' ? '#signup-handle-error' : '#organization-handle-error');
}

async function submit(page: Page, path: string, handle: string, sends: boolean) {
  await page.locator('input[name="handle"]').fill(handle);
  const count = calls.length;
  const response = sends
    ? page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === (path === '/signup' ? '/signup' : '/account-operations/approve'),
      )
    : undefined;
  await page.locator('form button[type="submit"]').click();
  await response;
  await errorFor(page, path).waitFor();
  expect(calls.length, `${path}: ${JSON.stringify(handle)}`).toBe(count + (sends ? 1 : 0));
}

test(
  'sign-up and create organization accept a handle only when, case-folded, it is 3 to 64 ASCII letters, digits, _ or - with a letter or digit at both ends, and refuse whitespace without trimming',
  async () => {
    const { normalizeSignupHandle } = await import('../src/signup');
    for (const value of accepted) expect(normalizeSignupHandle(value), value).toBe(value.toLowerCase());
    for (const value of [...refused, 'abc\n', 'abc\r', 'abc\r\n', 'abc\u2028', 'abc\u2029'])
      expect(normalizeSignupHandle(value), JSON.stringify(value)).toBeNull();
    for (const path of ['/signup', '/organizations/new']) {
      const page = await open(path);
      try {
        for (const value of refused) await submit(page, path, value, false);
        for (const value of accepted) {
          await submit(page, path, value, true);
          const body = calls.at(-1)!.body;
          expect(path === '/signup' ? body.handle : (body.operation as { handle: string }).handle).toBe(
            path === '/signup' ? value : value.toLowerCase(),
          );
        }
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "the Auth pages' claim pattern has the same source as the kernel's claim pattern in services/kernel/src/access/handle-policy.ts",
  async () => {
    const kernel = await Bun.file(join(app, '../../services/kernel/src/access/handle-policy.ts')).text();
    const signup = await Bun.file(join(app, 'src/signup.ts')).text();
    const { normalizeSignupHandle } = await import('../src/signup');
    const source = signup.match(/\/\^([^\n]+?)\$\//)?.[0];
    expect(source?.slice(1, -1)).toBe(kernel.match(/export const HANDLE_CLAIM_PATTERN = \/(.+)\//)?.[1]);
    expect(normalizeSignupHandle('ADMIN')).toBe('admin');
  },
  timeout,
);

test(
  'in every locale a refused handle states the new rule, and a reserved or taken handle answered by the server shows the taken-or-reserved message',
  async () => {
    for (const [locale, rule] of Object.entries(rules)) {
      const messages = await Bun.file(join(app, `messages/${locale}.json`)).json();
      expect(messages.auth_signup_handle_invalid).toBe(rule);
      expect(messages.auth_organization_handle_invalid).toBe(rule);
      for (const path of ['/signup', '/organizations/new']) {
        const page = await open(path, locale);
        try {
          await submit(page, path, 'ab', false);
          expect(await errorFor(page, path).innerText()).toBe(rule);
          for (const value of ['admin', 'claimed-handle']) {
            await submit(page, path, value, true);
            expect(await errorFor(page, path).innerText()).toBe(messages.auth_signup_handle_unavailable);
          }
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);
