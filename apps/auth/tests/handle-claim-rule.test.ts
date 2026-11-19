import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { readRegistrationPage } from '../../../services/auth/src/registration-page';
import { isClaimHandle, isReservedHandle } from '../../../services/kernel/src/access/handle-policy';
import { accountOperationProfile } from '../src/account-operation-step-up';
import { normalizeSignupHandle } from '../src/signup';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const rules = {
  en: 'Use 3 to 64 characters: letters a–z, numbers, hyphens or underscores. Start and end with a letter or number.',
  'zh-Hans': '请输入 3 至 64 个字符：字母 a–z、数字、连字符或下划线。开头和结尾必须是字母或数字。',
  'zh-Hant': '請輸入 3 至 64 個字元：字母 a–z、數字、連字號或底線。開頭和結尾必須是字母或數字。',
  ja: '3〜64文字で入力してください。使える文字は英字 a–z、数字、ハイフン、アンダースコアです。先頭と末尾は英字または数字にしてください。',
  ko: '3~64자를 입력하세요. 영문자 a–z, 숫자, 하이픈 또는 밑줄을 사용할 수 있습니다. 처음과 끝은 영문자나 숫자여야 합니다.',
  de: 'Verwende 3 bis 64 Zeichen: Buchstaben a–z, Zahlen, Bindestriche oder Unterstriche. Das erste und letzte Zeichen muss ein Buchstabe oder eine Zahl sein.',
  fr: 'Utilisez 3 à 64 caractères : lettres a–z, chiffres, tirets ou traits de soulignement. Le premier et le dernier caractère doivent être une lettre ou un chiffre.',
  es: 'Usa entre 3 y 64 caracteres: letras a–z, números, guiones o guiones bajos. El primer y el último carácter deben ser una letra o un número.',
};
const accepted = ['abc', '123', 'A_B', 'A-Z', 'a__--9', '9' + 'A'.repeat(62) + '0', 'Kaa'];
const overlong = 'a'.repeat(65);
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
  overlong,
  'éaa',
  '中文名',
  'a.b',
];
const paths = ['/signup', '/organizations/new'] as const;
type ClaimPage = (typeof paths)[number];
const calls: { path: string; body: Record<string, unknown> }[] = [];
let issuer: ReturnType<typeof Bun.serve> | undefined;
let child: ChildProcess | undefined;
let browser: Browser;
let origin: string;

async function startSite() {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  issuer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { 'cache-control': 'no-store' };
      if (url.pathname === '/turnstile.js')
        return new Response(
          'window.turnstile = { ready(fn) { fn(); }, render(el, options) { this.options = options; options.callback("token"); el.dataset.fixtureToken = "ready"; return "widget"; }, reset() { this.options.callback("token"); }, remove() {} };',
          { headers: { ...headers, 'content-type': 'text/javascript' } },
        );
      const readSession = async () =>
        request.headers.get('cookie')?.split('; ').includes('auth_session=claim-test')
          ? Response.json({ account_id: 'claim-test-account', ...accountOperationProfile('organization') }, { headers })
          : new Response(null, { status: 401, headers });
      if (url.pathname === '/registration-page') {
        if (
          request.method !== 'GET' ||
          url.search ||
          request.headers.get('origin') !== origin ||
          request.headers.get('sec-fetch-site') === 'cross-site' ||
          request.headers.has('authorization')
        )
          return Response.json({ error: 'unavailable' }, { status: 403, headers });
        const page = await readRegistrationPage({
          readSession,
          passwordLimits: async () => ({ minLength: 8, maxLength: 128 }),
          verificationConfigured: true,
        });
        return Response.json(page, { headers });
      }
      if (url.pathname === '/session') return readSession();
      if (request.method === 'POST') {
        calls.push({ path: url.pathname, body: (await request.json()) as Record<string, unknown> });
        return Response.json(
          url.pathname === '/signup'
            ? { error: 'handle_unavailable' }
            : { error: 'account_operation_denied', effect_status: 'not_applied' },
          { status: 409, headers },
        );
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  let output = '';
  child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AUTH_ORIGIN: issuer.url.origin,
      AUTH_SECURITY_SCOPE_CONFIGURATION: 'native-no-catalogue',
      TURNSTILE_SITE_KEY: 'claim-test',
      TURNSTILE_SCRIPT_URL: `${issuer.url.origin}/turnstile.js`,
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
}

afterAll(async () => {
  await browser?.close();
  issuer?.stop(true);
  if (child?.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
});

async function open(path: ClaimPage, locale: string): Promise<Page> {
  const context = await browser.newContext({ locale, extraHTTPHeaders: { 'Accept-Language': locale } });
  await context.addCookies([{ name: 'rezics_locale', value: locale, url: origin }]);
  if (path === '/organizations/new')
    await context.addCookies([{ name: 'auth_session', value: 'claim-test', url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.locator('input[name="handle"]').waitFor();
  if (path === '/signup') {
    await page.locator('[data-fixture-token="ready"]').waitFor({ state: 'attached' });
    await page.locator('input[type="email"]').fill('claim@example.test');
    await page.locator('#signup-password').fill('claim-password');
    await page.locator('#signup-confirm-password').fill('claim-password');
  }
  return page;
}

test('Auth handle normalization matches the Kernel claim contract', () => {
  expect(isReservedHandle('admin')).toBe(true);
  for (const value of [...accepted, 'ADMIN']) {
    expect(isClaimHandle(value), value).toBe(true);
    expect(normalizeSignupHandle(value), value).toBe(value.toLowerCase());
  }
  for (const value of [...refused, 'abc\n', 'abc\r', 'abc\r\n', 'abc\u2028', 'abc\u2029', 'abc\u00a0', 'abc\ufeff']) {
    expect(isClaimHandle(value), JSON.stringify(value)).toBe(false);
    expect(normalizeSignupHandle(value), JSON.stringify(value)).toBeNull();
  }
});

test(
  'mounted signup and organization forms enforce handle syntax and show localized issuer denials',
  async () => {
    await startSite();
    for (const [locale, rule] of Object.entries(rules)) {
      const messages = await Bun.file(join(app, `messages/${locale}.json`)).json();
      for (const path of paths) {
        const signup = path === '/signup';
        const error = signup ? '#signup-handle-error' : '#organization-handle-error';
        const values = locale === 'en' ? [...accepted, 'admin', 'claimed-handle'] : ['admin', 'claimed-handle'];
        for (const [index, value] of values.entries()) {
          // A denial restricts organization creation and sends signup into handle correction.
          const page = await open(path, locale);
          try {
            const handle = page.locator('input[name="handle"]');
            const button = page.locator('form button[type="submit"]');
            if (index === 0) {
              expect(await page.locator('html').getAttribute('lang')).toBe(locale);
              for (const invalid of locale === 'en' ? refused : ['ab']) {
                const count = calls.length;
                await handle.fill(invalid);
                if (signup && invalid === overlong) {
                  // Signup's native input cap stops typing past the 64th character.
                  expect(await handle.inputValue()).toBe(invalid.slice(0, 64));
                  continue;
                }
                await button.click();
                const fieldError = page.locator(error);
                await fieldError.waitFor();
                expect(await fieldError.innerText(), `${path}: ${JSON.stringify(invalid)}`).toBe(
                  invalid ? rule : messages.auth_form_required,
                );
                expect(calls).toHaveLength(count);
              }
            }
            const count = calls.length;
            const endpoint = signup ? '/signup' : '/account-operations/approve';
            await handle.fill(value);
            await button.click();
            if (signup) {
              await page
                .locator(error)
                .and(page.getByText(messages.auth_signup_handle_unavailable, { exact: true }))
                .waitFor();
            } else {
              await page.getByRole('alert').getByText(messages.auth_organization_refused, { exact: true }).waitFor();
              expect(await page.locator(error).count()).toBe(0);
              expect(await button.isDisabled()).toBe(true);
            }
            expect(calls).toHaveLength(count + 1);
            const { path: postedPath, body } = calls[count]!;
            expect(postedPath).toBe(endpoint);
            expect(signup ? body.handle : body.operation).toEqual(
              signup ? value.toLowerCase() : { kind: 'organization', handle: value.toLowerCase() },
            );
          } finally {
            await page.context().close();
          }
        }
      }
    }
  },
  timeout,
);
