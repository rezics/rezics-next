import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { createFakeAuthState, startFakeAuth, type FakeAuthRequest } from '../scripts/fake-auth';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const accountId = 'screenshot-account';
const session = 'account-operation-session';
const calls: FakeAuthRequest[] = [];
const state = createFakeAuthState();
const fake = startFakeAuth({ state, onRequest: (request) => calls.push(request) });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;
let issuerOrigin = '';

function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AUTH_ORIGIN: fake.url.origin, PRIVACY_CONTACT_URL: 'mailto:privacy@example.test' },
    });
    let startError: Error | undefined;
    child.on('error', (error) => (startError = error));
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    issuerOrigin = origin;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(60_000) });
        if (response.status === 200) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(
  path: string,
  options: BrowserContextOptions = {},
  withSessionCookie = true,
): Promise<{ page: Page; origin: string }> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    ...options,
    javaScriptEnabled: true,
  });
  if (withSessionCookie)
    await context.addCookies([
      { name: 'auth_session', value: session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    expect(response?.status(), `the documented dev server serves ${path}`).toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function authCalls(path: string): FakeAuthRequest[] {
  return calls.filter((call) => new URL(call.url, fake.url).pathname === path);
}

function postBodies(path: string): Record<string, unknown>[] {
  return authCalls(path).map((call) => {
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
    expect(call.headers.origin).toBe(issuerOrigin);
    return JSON.parse(call.body) as Record<string, unknown>;
  });
}

function reset(overrides: Partial<typeof state> = {}) {
  calls.length = 0;
  Object.assign(state, {
    signedOut: false,
    sessionFresh: true,
    signInSucceeds: false,
    organizationsOpen: true,
    denyAccountOperation: false,
    dropFirstExecuteResponse: false,
    sessionCount: 4,
    organizationCount: 1,
    ...overrides,
  });
}

const confirmations = {
  en: [
    'delete my account',
    'Type “delete my account” to confirm.',
    'Deletion is final and cannot be undone. Your private data is removed at once. Your public contributions stay without your name.',
  ],
  de: [
    'mein Konto löschen',
    'Gib zur Bestätigung „mein Konto löschen“ ein.',
    'Die Löschung ist endgültig und kann nicht rückgängig gemacht werden. Deine privaten Daten werden sofort gelöscht. Deine öffentlichen Beiträge bleiben ohne deinen Namen erhalten.',
  ],
  es: [
    'eliminar mi cuenta',
    'Escribe «eliminar mi cuenta» para confirmar.',
    'La eliminación es definitiva y no se puede deshacer. Tus datos privados se eliminan de inmediato. Tus contribuciones públicas se conservan sin tu nombre.',
  ],
  fr: [
    'supprimer mon compte',
    'Saisissez « supprimer mon compte » pour confirmer.',
    'La suppression est définitive et irréversible. Vos données privées sont effacées immédiatement. Vos contributions publiques restent sans votre nom.',
  ],
  ja: [
    'アカウントを削除',
    '確認のため「アカウントを削除」と入力してください。',
    'アカウントの削除は確定後に取り消せません。非公開データは直ちに削除され、公開した投稿などは名前を伏せて残ります。',
  ],
  ko: [
    '내 계정 삭제',
    '확인하려면 “내 계정 삭제”를 입력하세요.',
    '계정을 삭제하면 되돌릴 수 없습니다. 비공개 데이터는 즉시 삭제되며, 공개한 기여는 이름 없이 남습니다.',
  ],
  'zh-Hans': [
    '删除我的账号',
    '请输入“删除我的账号”以确认。',
    '账号一经删除便无法恢复。私密数据会立即删除，公开贡献会保留，但不再显示你的名字。',
  ],
  'zh-Hant': [
    '刪除我的帳號',
    '請輸入「刪除我的帳號」以確認。',
    '帳號一經刪除便無法復原。私人資料會立即刪除，公開貢獻會保留，但不再顯示你的名字。',
  ],
} as const;

beforeAll(async () => {
  await site();
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test(
  'the account deletion page asks the person to type a localized confirmation phrase shown on the page, in each of the eight locales, and enables Delete only when the typed text matches it after trimming and Unicode normalization',
  async () => {
    for (const [locale, [phrase, label]] of Object.entries(confirmations)) {
      reset();
      const { page } = await open('/account/delete', { locale, extraHTTPHeaders: { 'Accept-Language': locale } });
      try {
        const input = page.getByRole('textbox', { name: label, exact: true });
        await input.waitFor();
        expect(await page.locator('html').getAttribute('lang')).toBe(locale);
        expect(await page.getByText(label, { exact: true }).isVisible()).toBe(true);
        const button = page.locator('button[type="submit"]');
        expect(await button.isDisabled()).toBe(true);
        for (const invalid of [
          '   ',
          phrase.slice(0, -1),
          `${phrase}!`,
          `x${phrase}`,
          phrase.replace(' ', '  ') + 'x',
        ]) {
          await input.fill(invalid);
          expect(await button.isDisabled(), `${locale}: ${invalid}`).toBe(true);
        }
        for (const valid of [phrase, ` \t${phrase}\u3000`, phrase.toLocaleUpperCase(locale).normalize('NFD')]) {
          await input.fill(valid);
          expect(await button.isEnabled(), `${locale}: ${valid}`).toBe(true);
        }
        await input.fill('');
        expect(await button.isDisabled()).toBe(true);
        expect(authCalls('/account-operations/approve')).toHaveLength(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "the page says plainly, before the control, that deletion is final and cannot be undone, that private data is removed at once and that public contributions stay without the person's name",
  async () => {
    for (const [locale, [, label, outcome]] of Object.entries(confirmations)) {
      reset();
      const { page } = await open('/account/delete', { locale, extraHTTPHeaders: { 'Accept-Language': locale } });
      try {
        const warning = page.getByText(outcome, { exact: true });
        await warning.waitFor();
        expect(await warning.isVisible()).toBe(true);
        const input = page.getByRole('textbox', { name: label, exact: true });
        expect(
          await warning.evaluate(
            (element, id) =>
              Boolean(element.compareDocumentPosition(document.getElementById(id)!) & Node.DOCUMENT_POSITION_FOLLOWING),
            await input.getAttribute('id'),
          ),
        ).toBe(true);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a stale session still goes to /step-up and returns to the page, with the typed confirmation cleared',
  async () => {
    reset({ sessionFresh: false, signInSucceeds: true });
    const { page, origin } = await open('/account/delete');
    try {
      await page.getByRole('textbox', { name: confirmations.en[1], exact: true }).fill(confirmations.en[0]);
      await Promise.all([
        page.waitForURL((url) => url.pathname === '/step-up'),
        page.getByRole('button', { name: 'Delete account', exact: true }).click(),
      ]);
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      expect(new URL(page.url()).searchParams.get('return_to')).toBe('/account/delete');
      expect(authCalls('/account-operations/approve')).toHaveLength(1);
      expect(authCalls('/account-operations/execute')).toHaveLength(0);
      await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
      await page.getByLabel('Password', { exact: true }).fill('secure-password');
      await Promise.all([
        page.waitForURL((url) => url.origin === origin && url.pathname === '/account/delete'),
        page.getByRole('button', { name: 'Verify your identity', exact: true }).click(),
      ]);
      const input = page.getByRole('textbox', { name: confirmations.en[1], exact: true });
      await input.waitFor();
      expect(await input.inputValue()).toBe('');
      expect(await page.getByRole('button', { name: 'Delete account', exact: true }).isDisabled()).toBe(true);
      expect(state.sessionFresh).toBe(true);
      expect(authCalls('/account-operations/execute')).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the old confirmation checkbox is gone, and the approve request body is unchanged',
  async () => {
    reset();
    const { page } = await open('/account/delete');
    try {
      const input = page.getByRole('textbox', { name: confirmations.en[1], exact: true });
      await input.waitFor();
      expect(await page.getByRole('checkbox').count()).toBe(0);
      await input.fill(confirmations.en[0]);
      await page.getByRole('button', { name: 'Delete account', exact: true }).click();
      await page.getByRole('status').waitFor();
      expect(postBodies('/account-operations/approve')).toEqual([
        { operationKey: expect.any(String), operation: { kind: 'delete', accountId } },
      ]);
      expect(authCalls('/session')).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a mismatched confirmation focuses the input with a linked localized error and sends no request',
  async () => {
    reset();
    const { page } = await open('/account/delete');
    try {
      const input = page.getByRole('textbox', { name: confirmations.en[1], exact: true });
      await input.fill('wrong phrase');
      await page.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
      await page.locator('#account-delete-confirmation-error').waitFor();
      expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await input.getAttribute('aria-invalid')).toBe('true');
      expect(await input.getAttribute('aria-describedby')).toContain('account-delete-confirmation-error');
      expect(await page.locator('#account-delete-confirmation-error').innerText()).toContain(
        'Type the confirmation phrase shown above.',
      );
      expect(authCalls('/account-operations/approve')).toHaveLength(0);
      await input.fill(confirmations.en[0]);
      expect(await page.locator('#account-delete-confirmation-error').count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Delete account', exact: true }).isEnabled()).toBe(true);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
