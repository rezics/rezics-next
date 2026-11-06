// Seeded Realm question-management walk for the six personas on the mounted product. Run as the command of
// `dev-stack.ts walk` inside a worker check, so the check owns the stack, its startup and its cleanup.
// Every step records its own result; a failed step does not stop the rest, so one run shows each defect.
// Credentials and bearer tokens never leave this process.
import type { BrowserContext, Page } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
// Playwright is installed under apps/web; resolve it from there.
const { chromium } = await import(Bun.resolveSync('playwright', resolve(root, 'apps/web/package.json')));

const outDir = resolve(root, '.temp/walk-run/question-management');
const shots = resolve(outDir, 'screens');
mkdirSync(shots, { recursive: true });
const resultsFile = resolve(outDir, 'results.json');

const env = process.env;
const web = env.REZICS_LOCAL_STACK_WEB_ORIGIN!;
const issuer = env.REZICS_LOCAL_STACK_ISSUER_ORIGIN!;
const kernel = env.REZICS_LOCAL_STACK_KERNEL_ORIGIN!;
const stamp = Date.now().toString(36);

type Result = { step: string; ok: boolean; detail?: unknown };
const results: Result[] = [];
function record(step: string, ok: boolean, detail?: unknown): void {
  results.push({ step, ok, detail });
  console.log(
    new Date().toISOString(),
    ok ? 'PASS' : 'FAIL',
    step,
    detail === undefined ? '' : JSON.stringify(detail).slice(0, 500),
  );
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
}
/** Stage marker for the check log: each named stage appears once, in order, before its steps. */
function stage(name: string): void {
  console.log(new Date().toISOString(), 'STAGE', name);
}
async function attempt<T>(
  step: string,
  run: () => Promise<T>,
  passed: (value: T) => boolean = () => true,
): Promise<T | undefined> {
  try {
    const value = await run();
    const ok = passed(value);
    record(step, ok, ok ? undefined : value);
    return value;
  } catch (error) {
    record(step, false, String(error).slice(0, 500));
    return undefined;
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(shots, `${name}.png`), fullPage: true });
}
/** Web pages are ready when the root hydrates; Auth pages carry no hydration marker, so their form is the readiness. */
async function webReady(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}
async function pageText(page: Page): Promise<string> {
  return (
    await page
      .locator('body')
      .innerText({ timeout: 10_000 })
      .catch(() => '')
  ).slice(0, 1200);
}

/** Ordinary sign-up through the Auth pages. The control list is recorded so a failed run shows what the page offers. */
async function signUp(context: BrowserContext, email: string, password: string, name: string): Promise<string> {
  const page = await context.newPage();
  let reached: string | undefined;
  for (const path of ['/auth/sign-up', '/auth/signup', '/auth/register']) {
    const response = await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (response && response.status() < 400) {
      reached = path;
      break;
    }
  }
  if (!reached) throw new Error('no sign-up page answered under /auth/sign-up, /auth/signup or /auth/register');
  const controls = await page.evaluate(() =>
    [...document.querySelectorAll('input, button')].map((node) => {
      const input = node as HTMLInputElement;
      return `${node.tagName}|${input.name || ''}|${input.type || ''}|${(node.textContent || '').trim().slice(0, 40)}`;
    }),
  );
  const nameField = page.locator('input[name="name"]');
  await page.locator('input[name="email"]').waitFor({ state: 'visible', timeout: 60_000 });
  if ((await nameField.count()) > 0) await nameField.first().fill(name);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').first().fill(password);
  const confirm = page.locator('input[name="confirmPassword"], input[name="password_confirmation"]');
  if ((await confirm.count()) > 0) await confirm.first().fill(password);
  const submitted = page
    .waitForResponse((response) => new URL(response.url()).pathname.includes('sign-up'), { timeout: 60_000 })
    .catch(() => null);
  await page
    .getByRole('button', { name: /sign up|create account|register/i })
    .first()
    .click();
  await submitted;
  await page.waitForTimeout(3_000);
  await page.close();
  return controls.join(' ; ').slice(0, 1500);
}

async function signIn(context: BrowserContext, email: string, password: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${web}/auth/sign-in?return_to=${encodeURIComponent('/en/')}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByLabel(/email/i)
    .waitFor({ state: 'visible', timeout: 60_000 })
    .catch(async (error) => {
      record('sign-in form not visible', false, {
        url: page.url(),
        title: await page.title().catch(() => ''),
        error: String(error).slice(0, 200),
      });
      throw error;
    });
  await page.getByLabel(/email/i).fill(email);
  await page.locator('input[name="password"]').fill(password);
  const callback = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return url.origin === web && url.pathname === '/auth/callback';
    },
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await callback;
  await page.waitForURL((url) => url.origin === web && !url.pathname.startsWith('/auth/'), { timeout: 60_000 });
  await webReady(page);
  return page;
}

async function bearer(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(issuer)).map((entry) => `${entry.name}=${entry.value}`).join('; ');
  const response = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', cookie },
    body: '{}',
  });
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

function subjectOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;
}

async function api(
  path: string,
  options: { token?: string | undefined; method?: string | undefined; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { origin: web };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${kernel}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text for diagnosis.
  }
  return { status: response.status, body };
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  let value = await read();
  for (let turn = 0; turn < 60 && !done(value); turn++) {
    await Bun.sleep(1000);
    value = await read();
  }
  if (!done(value)) throw new Error(`${label}: not reached; last=${JSON.stringify(value).slice(0, 600)}`);
  return value;
}

// Persona provisioning: the developer persona carries the platform governance role the Realm owner needs.
stage('persona');
const persona = Bun.spawn([process.execPath, 'services/auth/scripts/dev-stack.ts', 'persona'], {
  cwd: root,
  env,
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await persona.exited) !== 0) throw new Error('dev-stack persona failed');
const keys = JSON.parse(readFileSync(resolve(root, '.temp/local-stack/keys.json'), 'utf8')) as {
  password: string;
  bootstrapPassword?: string;
};
const developerPassword = keys.bootstrapPassword ?? keys.password;
const memberPassword = `Walk-${stamp}-member-Pass1`;
const otherPassword = `Walk-${stamp}-other-Pass1`;
record('persona: developer provisioned', true);

const browser = await chromium.launch();
try {
  stage('manager');
  const managerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const managerPage = await attempt('manager: sign in through the mounted Auth pages', () =>
    signIn(managerContext, 'developer@rezics.test', developerPassword),
  );
  const managerToken = await attempt('manager: Kernel bearer from the session', () => bearer(managerContext));
  const contexts = await attempt(
    'manager: readable Context list',
    () => api('/v1/contexts?limit=20', { token: managerToken }),
    (r) => r.status === 200,
  );
  const contextId: string | undefined = contexts?.body?.items?.[0]?.id ?? contexts?.body?.contexts?.[0]?.id;
  const space = await attempt(
    'manager: create Space',
    () =>
      api('/v1/spaces', {
        token: managerToken,
        method: 'POST',
        body: { title: `Walk Space ${stamp}`, summary: 'Question walk fixture.' },
      }),
    (r) => r.status === 201,
  );
  const realm = contextId
    ? await attempt(
        'manager: create public Realm',
        () =>
          api('/v1/realms', {
            token: managerToken,
            method: 'POST',
            body: { spaceId: space?.body?.id, title: `Walk Realm ${stamp}`, visibility: 'public', contextId },
          }),
        (r) => r.status === 201,
      )
    : undefined;
  const realmId: string | undefined = realm?.body?.id;
  if (!realmId) throw new Error('no Realm created; later steps need one');

  const label = `Walk clarity ${stamp}`;
  await attempt(
    'manager: create definition through the mounted page',
    async () => {
      if (!managerPage) throw new Error('manager page unavailable');
      await managerPage.goto(`${web}/en/realms/${realmId}/questions`, { waitUntil: 'domcontentloaded' });
      await webReady(managerPage);
      await managerPage.getByRole('button', { name: 'Create definition', exact: true }).click();
      const form = managerPage.locator('form').first();
      await form
        .getByLabel('Immutable meaning')
        .fill('Judge the clarity of the walk fixture independently of enjoyment.');
      await form.getByLabel('Rating question', { exact: true }).fill(label);
      await managerPage.getByRole('button', { name: 'Review definition', exact: true }).click();
      await managerPage.getByRole('button', { name: 'Confirm creation', exact: true }).click();
      await managerPage.getByText(label, { exact: true }).first().waitFor({ state: 'visible', timeout: 60_000 });
      await shot(managerPage, 'manager-01-created');
      return true;
    },
    (ok) => ok === true,
  );

  const created = await attempt('manager: independent readback of the created question', () =>
    eventually(
      () => api(`/v1/realms/${realmId}/rating-questions/management`, { token: managerToken }),
      (v) => v.status === 200 && v.body.directory.ratingQuestions.some((q: any) => q.label === label),
      'management readback',
    ),
  );
  const question = created?.body?.directory?.ratingQuestions?.find((q: any) => q.label === label);
  const questionId: string | undefined = question?.id;
  const captionLabel = `Walk caption ${stamp}`;
  if (questionId) {
    await attempt(
      'manager: caption revision through the native command',
      () =>
        api(`/v1/rating-questions/${questionId}/label`, {
          token: managerToken,
          method: 'PUT',
          body: { expectedLabelRevision: question.labelRevision, label: captionLabel },
        }),
      (r) => r.status === 200 && r.body?.labelRevision === question.labelRevision + 1,
    );
    await attempt(
      'manager: caption history lists both revisions',
      () => api(`/v1/rating-questions/${questionId}/labels?limit=20`, { token: managerToken }),
      (r) => r.status === 200 && Array.isArray(r.body?.labels) && r.body.labels.length >= 2,
    );
    await attempt('manager: current readback shows the new caption', () =>
      eventually(
        () => api(`/v1/realms/${realmId}/rating-questions/management`, { token: managerToken }),
        (v) =>
          v.status === 200 &&
          v.body.directory.ratingQuestions.some((q: any) => q.id === questionId && q.label === captionLabel),
        'caption readback',
      ),
    );
    await attempt(
      'manager: retire through the native command',
      () =>
        api(`/v1/rating-questions/${questionId}/$retire`, {
          token: managerToken,
          method: 'POST',
          body: { expectedLifecycleRevision: question.lifecycle.revision },
        }),
      (r) => r.status === 200 && r.body?.lifecycle?.state === 'retired',
    );
    await attempt(
      'manager: restore through the native command',
      () =>
        api(`/v1/rating-questions/${questionId}/$restore`, {
          token: managerToken,
          method: 'POST',
          body: { expectedLifecycleRevision: question.lifecycle.revision + 1 },
        }),
      (r) => r.status === 200 && r.body?.lifecycle?.state === 'active',
    );
  }

  stage('anonymous');
  const anonymousContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonymous = await anonymousContext.newPage();
  await attempt(
    'anonymous: management read is refused by the Kernel',
    () => api(`/v1/realms/${realmId}/rating-questions/management`),
    (r) => r.status === 401,
  );
  await attempt(
    'anonymous: mounted page shows no management controls',
    async () => {
      await anonymous.goto(`${web}/en/realms/${realmId}/questions`, { waitUntil: 'domcontentloaded' });
      await webReady(anonymous);
      await shot(anonymous, 'anonymous-01-page');
      const text = await pageText(anonymous);
      return {
        hasCreate: text.includes('Create definition'),
        hasLabel: text.includes(label),
        text: text.slice(0, 400),
      };
    },
    (v) => v.hasCreate === false && v.hasLabel === false,
  );
  await anonymousContext.close();

  stage('member and other account');
  const memberEmail = `member-${stamp}@rezics.test`;
  const otherEmail = `other-${stamp}@rezics.test`;
  await attempt('member: ordinary sign-up through the Auth pages', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      return { controls: await signUp(context, memberEmail, memberPassword, `Member ${stamp}`) };
    } finally {
      await context.close();
    }
  });
  await attempt('other: ordinary sign-up through the Auth pages', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      return { controls: await signUp(context, otherEmail, otherPassword, `Other ${stamp}`) };
    } finally {
      await context.close();
    }
  });

  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const memberPage = await attempt('member: sign in through the Auth pages', () =>
    signIn(memberContext, memberEmail, memberPassword),
  );
  const memberToken = await attempt('member: Kernel bearer', () => bearer(memberContext));
  const memberId = memberToken ? subjectOf(memberToken) : undefined;

  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const otherPage = await attempt('other: sign in through the Auth pages', () =>
    signIn(otherContext, otherEmail, otherPassword),
  );
  const otherToken = await attempt('other: Kernel bearer', () => bearer(otherContext));
  const otherId = otherToken ? subjectOf(otherToken) : undefined;

  stage('independent and banned member');
  if (memberToken) {
    await attempt(
      'member: management read is refused before join',
      () => api(`/v1/realms/${realmId}/rating-questions/management`, { token: memberToken }),
      (r) => r.status === 401 || r.status === 403 || r.status === 404,
    );
  }
  if (otherToken) {
    await attempt(
      'other: management read is refused without membership',
      () => api(`/v1/realms/${realmId}/rating-questions/management`, { token: otherToken }),
      (r) => r.status === 401 || r.status === 403 || r.status === 404,
    );
    await attempt(
      'other: mounted page shows no management controls',
      async () => {
        if (!otherPage) throw new Error('other page unavailable');
        await otherPage.goto(`${web}/en/realms/${realmId}/questions`, { waitUntil: 'domcontentloaded' });
        await webReady(otherPage);
        await shot(otherPage, 'other-01-page');
        const text = await pageText(otherPage);
        return {
          hasCreate: text.includes('Create definition'),
          hasLabel: text.includes(label),
          text: text.slice(0, 400),
        };
      },
      (v) => v.hasCreate === false && v.hasLabel === false,
    );
  }
  if (memberToken) {
    await attempt(
      'member: join the public Realm',
      () => api(`/v1/realms/${realmId}/membership`, { token: memberToken, method: 'POST', body: {} }),
      (r) => r.status === 202 || r.status === 200,
    );
    await attempt('member: membership readable after join', () =>
      eventually(
        () => api(`/v1/realms/${realmId}/members?limit=50`, { token: managerToken }),
        (v) => v.status === 200 && JSON.stringify(v.body).includes(memberId ?? '!'),
        'member readback',
      ),
    );
    await attempt(
      'member: management read still refused for a non-manager',
      () => api(`/v1/realms/${realmId}/rating-questions/management`, { token: memberToken }),
      (r) => r.status === 403 || r.status === 404,
    );
  }
  if (memberId) {
    await attempt(
      'manager: ban the member in the Realm',
      () =>
        api(`/v1/realms/${realmId}/bans/${memberId}`, {
          token: managerToken,
          method: 'PUT',
          body: { reason: 'walk fixture' },
        }),
      (r) => r.status === 200 || r.status === 204,
    );
    await attempt(
      'member: join is refused after the ban',
      () => api(`/v1/realms/${realmId}/membership`, { token: memberToken, method: 'POST', body: {} }),
      (r) => r.status >= 400,
    );
  }

  stage('suspended account');
  if (otherId) {
    await attempt(
      'manager: suspend the other account',
      () =>
        api(`/v1/accounts/${otherId}/$suspend`, {
          token: managerToken,
          method: 'POST',
          body: { key: crypto.randomUUID(), reason: 'walk fixture' },
        }),
      (r) => r.status >= 200 && r.status < 300,
    );
    await attempt(
      'other: suspended bearer is refused by the Kernel',
      () => api(`/v1/realms/${realmId}/rating-questions/management`, { token: otherToken }),
      (r) => r.status === 401 || r.status === 403,
    );
  }

  stage('review pages');
  if (memberPage) {
    await memberPage
      .goto(`${web}/en/realms/${realmId}/questions`, { waitUntil: 'domcontentloaded' })
      .catch(() => undefined);
    await shot(memberPage, 'member-01-page').catch(() => undefined);
  }
  await managerPage
    ?.goto(`${web}/en/realms/${realmId}/questions`, { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  await managerPage
    ?.screenshot({ path: resolve(shots, 'manager-02-final.png'), fullPage: true })
    .catch(() => undefined);
  record('journey: finished', true, { realmId, questionId: questionId ?? null, steps: results.length });
} finally {
  for (const context of browser.contexts()) await context.close().catch(() => undefined);
  await browser.close();
  stage('closed');
}

// A failed step fails the walk: the check reports pass only when every recorded step passed.
const failedSteps = results.filter((result) => !result.ok).map((result) => result.step);
if (failedSteps.length > 0) {
  console.log('walk failed steps:', failedSteps.join(' | '));
  process.exitCode = 1;
}
