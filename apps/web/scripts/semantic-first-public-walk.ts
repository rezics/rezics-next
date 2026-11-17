#!/usr/bin/env bun
/**
 * First-public Semantic catalogue and Zone walk. Run under `dev-stack.ts walk --first-public-web`.
 * Uses the admitted catalogue editor and authors the fixture through the native API.
 * The full walk retains native writes, independent readback and mounted pages.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import {
  firstPublicWebWalk,
  readLocalDeveloperAccountId,
  semanticWalkClientRegistration,
  startSeededFrontends,
} from '../../../services/auth/scripts/dev-stack.ts';
import { FIRST_PUBLIC_JOURNEYS } from './semantic-first-public-inventory.ts';
import {
  createAndReadNativeBook,
  readActiveDefinitions,
  requireId,
  resolveEditorAgent,
  walkReadinessUrls,
  nativeWalkAccessToken,
  type KernelCall,
  type WalkStackOrigins,
} from './semantic-first-public-native.ts';

import {
  kernelDeadlineTimings,
  nativeWalkCall,
  summarizeBoundaryRequest,
  type NativeObservation,
} from './semantic-first-public-request.ts';
import { updateFirstPublicInventory } from './semantic-first-public-evidence.ts';
import { walkAcceptanceId, walkStackAdmitted } from '../../../scripts/stack-run.ts';
import { walkStackLogPath, withWalkResources } from '../../../scripts/walk-stack.ts';
import { hydrated } from './semantic-first-public-browser.ts';

import {
  semanticFirstPublicCases,
  failingRow,
  type SemanticFirstPublicResult,
  type SemanticFirstPublicSession,
} from './semantic-first-public-cases.ts';

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/semantic-first-public-walk');
const editorEmail = 'developer@rezics.test';
const token = randomUUID().slice(0, 8);

type Stack = WalkStackOrigins;

const roundResults: SemanticFirstPublicResult[] = [];
let roundRevision = '';

function loopback(variable: string): string {
  const value = process.env[variable];
  if (value === undefined) throw new Error(`${variable} is required inside dev-stack walk`);
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error(`${variable} must be loopback HTTP`);
  return url.origin;
}

function stackOrigins(): Stack {
  return {
    web: loopback('REZICS_LOCAL_STACK_WEB_ORIGIN'),
    issuer: loopback('REZICS_LOCAL_STACK_ISSUER_ORIGIN'),
    native: loopback('REZICS_LOCAL_STACK_NATIVE_ORIGIN'),
    kernel: loopback('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
  };
}

type TypedProbe = { url: string; status: number; error?: string; code?: string; digest?: string; phase: string };

async function typedProbe(url: string, phase: string): Promise<TypedProbe> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    const text = await response.text();
    let body: { code?: unknown; digest?: unknown } | undefined;
    try {
      body = text ? (JSON.parse(text) as { code?: unknown; digest?: unknown }) : undefined;
    } catch {
      body = undefined;
    }
    const code = typeof body?.code === 'string' ? body.code : undefined;
    const digest = typeof body?.digest === 'string' ? body.digest : undefined;
    return {
      url,
      status: response.status,
      phase,
      ...(code === undefined ? {} : { code }),
      ...(digest === undefined ? {} : { digest }),
    };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    const name = error instanceof Error ? error.name : 'fetch-failed';
    return { url, status: 0, phase, error: code || name };
  }
}

function describeProbe(probe: TypedProbe, expected: string): string {
  const actual =
    probe.status === 0
      ? (probe.error ?? 'unreachable')
      : `HTTP ${probe.status}${probe.code ? ` ${probe.code}` : ''}${probe.digest ? ` digest=${probe.digest}` : ''}`;
  return `${probe.phase} GET ${probe.url} ${actual} (expected ${expected})`;
}

async function accessToken(stack: Stack, email: string, password: string): Promise<string> {
  const client = semanticWalkClientRegistration();
  return nativeWalkAccessToken(stack, { email, password, clientId: client.clientId, scopes: client.scopes });
}

async function personaKeys(): Promise<{ password: string }> {
  return JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as { password: string };
}

async function seededEditorAgent(call: KernelCall, editor: string) {
  return resolveEditorAgent(call, editor, requireId(await readLocalDeveloperAccountId(), 'seeded editor account'));
}

async function prepareSeededEditorAgent(call: KernelCall, editor: string) {
  const release = await readActiveDefinitions(call).catch(() => {
    throw new Error('seeded editor Agent fixture requires a current native Definitions release');
  });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'semantic-first-public-editor-agent.ts')], {
    cwd: root,
    stdin: new Blob([JSON.stringify({ bearer: editor, ...release })]),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) throw new Error('seeded editor Agent fixture synchronization was blocked');
}

async function recordInventory(revision: string, utc: string, results: SemanticFirstPublicResult[]): Promise<void> {
  const path = join(root, 'docs/goals/semantic.capabilities.md');
  const document = await readFile(path, 'utf8');
  const next = updateFirstPublicInventory(document, revision, utc, results);
  await writeFile(join(evidenceDir, 'inventory.md'), next, { mode: 0o600 });
}

async function runNativeBoundaries(stack: Stack, revision: string, stackLog: string) {
  const trace: NativeObservation[] = [];
  let editor: Promise<string> | undefined;
  const getEditor = () =>
    (editor ??= personaKeys()
      .catch(() => {
        throw new Error('seeded editor keys could not be read');
      })
      .then(({ password }) => accessToken(stack, editorEmail, password)));
  const checks = [
    ['active-definitions', readActiveDefinitions],
    [
      'book-create-read',
      async (call) => createAndReadNativeBook(call, await getEditor(), `Walk boundary Book ${token}`),
    ],
    [
      'editor-agent',
      async (call) => {
        const editor = await getEditor();
        await prepareSeededEditorAgent(call, editor);
        return seededEditorAgent(call, editor);
      },
    ],
  ] satisfies [string, (call: KernelCall) => Promise<unknown>][];
  const results = [];
  for (const [id, check] of checks) {
    const offset = trace.length;
    const started = Date.now();
    const outcome = await check(nativeWalkCall(stack.kernel, trace)).then(
      (native) => ({ status: 'Passing' as const, native }),
      (error: unknown) => {
        const request = trace.length > offset ? trace.at(-1) : undefined;
        const failure =
          request?.status !== undefined && request.status >= 300
            ? `${request.method} ${new URL(request.url).pathname} returned HTTP ${request.status}`
            : error instanceof SyntaxError
              ? 'native response could not be decoded'
              : (error instanceof Error ? error.message : 'native boundary failed').slice(0, 800);
        return { status: 'Failing' as const, failure };
      },
    );
    results.push({
      id,
      ...outcome,
      ms: Date.now() - started,
      requests: trace.slice(offset).map(summarizeBoundaryRequest),
    });
  }
  const passing = results.filter(({ status }) => status === 'Passing').length;
  const evidence = {
    scope: 'native-boundaries',
    revision,
    utc: new Date().toISOString(),
    results,
    kernelDeadlineTimings: await kernelDeadlineTimings(stackLog, trace),
  };
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(join(evidenceDir, 'native-boundaries.json'), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`semantic native boundaries ${passing}/${checks.length}`);
  if (passing !== checks.length) process.exitCode = 1;
}

type WalkScope = 'all' | 'native-boundaries' | 'mounted-subject' | 'statement-consent';

async function main(scope: WalkScope) {
  const walkId = walkAcceptanceId(process.env);
  if (
    !walkId ||
    !firstPublicWebWalk() ||
    !walkAcceptanceId(process.env, 'native') ||
    !walkAcceptanceId(process.env, 'browser') ||
    !walkStackAdmitted(process.env, root)
  )
    throw new Error('Use dev-stack.ts walk --first-public-web with native and browser acceptance');

  const stack = stackOrigins();
  const stackLog = walkStackLogPath(root, walkId);
  const revision = (roundRevision = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim());
  if (scope === 'mounted-subject' || scope === 'statement-consent') {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(evidenceDir, `${scope}.json`),
      JSON.stringify({ scope, revision, utc: new Date().toISOString(), phase: 'preparing', result: null }, null, 2) +
        String.fromCharCode(10),
      { mode: 0o600 },
    );
  }
  if (scope === 'native-boundaries') return runNativeBoundaries(stack, revision, stackLog);

  return withWalkResources(async (own) => {
    await mkdir(join(evidenceDir, 'screenshots'), { recursive: true, mode: 0o700 });
    const readinessUrls = walkReadinessUrls(stack);
    const readiness = {
      jwks: await typedProbe(readinessUrls.jwks, 'identity'),
      definitions: await typedProbe(readinessUrls.definitions, 'kernel'),
      active: await typedProbe(readinessUrls.active, 'kernel'),
    };
    await writeFile(join(evidenceDir, 'readiness.json'), `${JSON.stringify({ stack, readiness }, null, 2)}\n`, {
      mode: 0o600,
    });
    if (readiness.jwks.status === 0) throw new Error(describeProbe(readiness.jwks, 'HTTP 200 JWKS'));
    const kernelCause =
      readiness.definitions.status === 200 || readiness.active.status === 200
        ? undefined
        : describeProbe(
            readiness.definitions.status !== 0 ? readiness.definitions : readiness.active,
            'HTTP 200 digest',
          );
    if (readiness.definitions.status === 0 && readiness.active.status === 0)
      throw new Error(kernelCause ?? describeProbe(readiness.definitions, 'HTTP 200 digest'));
    if (kernelCause)
      await writeFile(
        join(evidenceDir, 'setup-failure.json'),
        `${JSON.stringify(
          {
            utc: new Date().toISOString(),
            error: kernelCause,
            stack,
            readiness,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    let keys: { password: string } | undefined;
    let personaCause: string | undefined;
    try {
      keys = await personaKeys();
    } catch (error) {
      personaCause ??= error instanceof Error ? error.message : String(error);
    }
    let editor = '';
    let editorIssued = 0;
    let editorCause: string | undefined;
    if (keys) {
      try {
        const issued = Date.now();
        editor = await accessToken(stack, editorEmail, keys.password);
        editorIssued = issued;
      } catch (error) {
        editorCause = error instanceof Error ? error.message : String(error);
      }
    } else {
      editorCause = personaCause ?? 'persona keys.json missing';
    }
    const trace: NativeObservation[] = [];
    const call = nativeWalkCall(stack.kernel, trace);
    let editorAgentCause = editorCause;
    if (editor) {
      try {
        await prepareSeededEditorAgent(call, editor);
      } catch (error) {
        editorAgentCause = error instanceof Error ? error.message : 'seeded editor Agent fixture failed';
      }
    }
    let frontends: { stop(): Promise<void> } = { stop: async () => undefined };
    let frontendCause: string | undefined;
    try {
      frontends = await startSeededFrontends();
      own('frontends', () => frontends.stop());
    } catch (error) {
      frontendCause = error instanceof Error ? error.message : String(error);
      await writeFile(
        join(evidenceDir, 'frontend-failure.json'),
        `${JSON.stringify({ utc: new Date().toISOString(), error: frontendCause, stack, readiness }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    const browserTemp = join(evidenceDir, 'browser');
    await mkdir(browserTemp, { recursive: true, mode: 0o700 });
    const results = roundResults;
    let browser: Browser | undefined;
    try {
      const server = await chromium.launchServer({ headless: true, env: { ...process.env, TMPDIR: browserTemp } });
      own(
        'browser',
        async () => {
          await server.close();
          await browser?.close();
        },
        async () => {
          await server.kill();
          await browser?.close();
        },
      );
      browser = await chromium.connect(server.wsEndpoint());
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      results.push(...FIRST_PUBLIC_JOURNEYS.map((row) => failingRow(row, cause)));
    }
    const anonymous = browser
      ? await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
      : undefined;
    const member = browser
      ? await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
      : undefined;
    const session: SemanticFirstPublicSession | undefined =
      anonymous && member
        ? {
            stack,
            call,
            trace,
            editor,
            anonymous,
            member,
            revision,
            evidenceDir,
            editorAgent: () => seededEditorAgent(call, editor),
            ...(editorCause === undefined ? {} : { editorCause }),
            ...(editorAgentCause === undefined ? {} : { editorAgentCause }),
            ...(frontendCause === undefined ? {} : { frontendCause }),
            ...(keys
              ? {
                  async refreshEditor() {
                    if (editor && Date.now() - editorIssued < 240_000) return;
                    const issued = Date.now();
                    const token = await accessToken(stack, editorEmail, keys.password);
                    editor = token;
                    session!.editor = token;
                    editorIssued = issued;
                  },
                }
              : {}),
          }
        : undefined;
    if (!session) {
      // Playwright did not start: every row already carries that cause.
    } else {
      if (editor && !frontendCause && keys) {
        try {
          const signIn = await session.member.newPage();
          const accountEmail = editorEmail;
          const returnTo = '/en/catalogue/new';
          const destination = new URL(returnTo, stack.web).href;
          let callbackAccepted = false;
          let accountConfirmed = false;
          try {
            signIn.on('response', (response) => {
              const url = new URL(response.url());
              if (url.origin !== stack.web || url.pathname !== '/auth/callback' || response.status() !== 303) return;
              const next = response.headers().location;
              if (next && new URL(next, url).href === destination) callbackAccepted = true;
            });
            await signIn.goto(`${stack.web}/en/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, {
              waitUntil: 'domcontentloaded',
              timeout: 180_000,
            });
            for (let attempt = 0; attempt < 4;) {
              const step = await signIn.waitForFunction(
                ({ issuer, web, destination, accountEmail, accountConfirmed }) => {
                  if (location.href === destination) return 'arrived';
                  if (location.origin === web && location.pathname === '/auth/callback') return false;
                  if (location.origin !== issuer) return 'unexpected-origin';
                  if (!document.documentElement.hasAttribute('data-hydrated')) return false;
                  const email = document.querySelector<HTMLInputElement>('input[type="email"]');
                  if (email?.readOnly && email.value !== accountEmail) return 'wrong-account';
                  if (email?.readOnly && !accountConfirmed) return 'confirmed-account';
                  const password = document.querySelector<HTMLInputElement>('input[type="password"]');
                  if (email?.disabled || password?.readOnly || password?.disabled) return false;
                  if (document.querySelector('form button[type="submit"]:enabled')) return 'submit';
                  if (
                    Array.from(document.querySelectorAll('button:enabled')).some(
                      (button) => button.textContent?.trim() === 'Continue',
                    )
                  )
                    return 'continue-account';
                  return false;
                },
                { issuer: stack.issuer, web: stack.web, destination, accountEmail, accountConfirmed },
                { timeout: 30_000 },
              );
              const next = await step.jsonValue();
              await step.dispose();
              if (next === 'arrived') break;
              if (next === 'wrong-account') throw new Error('Auth presented a different readonly sign-in account');
              if (next === 'unexpected-origin') throw new Error('Auth left the expected sign-in and callback routes');
              if (next === 'confirmed-account') {
                accountConfirmed = true;
                continue;
              }
              if (new URL(signIn.url()).origin !== stack.issuer) continue;
              attempt++;
              if (next === 'continue-account') {
                const current = signIn.getByText(`You’re signed in as ${accountEmail}.`, { exact: true });
                if (!(await current.isVisible())) throw new Error('Auth presented a different current sign-in account');
                accountConfirmed = true;
                await signIn.getByRole('button', { name: 'Continue', exact: true }).click();
                continue;
              }
              const email = signIn.locator('input[type="email"]');
              if (await email.count()) {
                if ((await email.inputValue()) !== accountEmail) {
                  if (!(await email.isEditable()))
                    throw new Error('Auth presented a different readonly sign-in account');
                  await email.fill(accountEmail);
                }
                accountConfirmed = true;
              }
              const password = signIn.locator('input[type="password"]:not([readonly]):enabled');
              if (await password.count()) await password.fill(keys.password);
              await signIn.locator('form button[type="submit"]:enabled').first().click();
            }
            await signIn.waitForURL(destination, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            if (!accountConfirmed || !callbackAccepted)
              throw new Error('Auth did not confirm the expected account and Web callback');
            await hydrated(signIn);
            await signIn.locator('#account-menu-button').waitFor({ state: 'visible', timeout: 30_000 });
          } finally {
            await signIn.close();
          }
        } catch (error) {
          session.frontendCause = error instanceof Error ? error.message : String(error);
          frontendCause = session.frontendCause;
        }
      }
      const setupCause = editorCause ?? personaCause ?? kernelCause;
      const cases = semanticFirstPublicCases(session, token);
      if (scope === 'mounted-subject' || scope === 'statement-consent') {
        const id = scope === 'mounted-subject' ? 'generic-creation' : 'statement-consent';
        const result = editor
          ? await cases.find((item) => item.id === id)!.run()
          : failingRow(
              FIRST_PUBLIC_JOURNEYS.find((row) => row.id === id)!,
              setupCause ?? 'The ordinary catalogue author is unavailable',
            );
        const evidence = {
          scope,
          revision,
          utc: new Date().toISOString(),
          phase: 'completed',
          result,
          kernelDeadlineTimings: await kernelDeadlineTimings(stackLog, trace),
        };
        await writeFile(join(evidenceDir, `${scope}.json`), `${JSON.stringify(evidence, null, 2)}\n`, {
          mode: 0o600,
        });
        if (result.status === 'Failing') process.exitCode = 1;
        return;
      }
      if (setupCause && !editor) {
        for (const row of FIRST_PUBLIC_JOURNEYS) {
          if (row.id === 'released-definitions' || row.id === 'catalogue-browsing') continue;
          results.push(failingRow(row, setupCause, 'anonymous'));
        }
      }

      for (const item of cases) {
        if (!editor && item.id !== 'released-definitions' && item.id !== 'catalogue-browsing') continue;
        results.push(await item.run());
      }
    }

    const missing = FIRST_PUBLIC_JOURNEYS.filter((row) => !results.some((result) => result.id === row.id));
    if (missing.length) {
      results.push(
        ...missing.map((row) =>
          failingRow(row, `walk omitted this row after recording ${results.length}/${FIRST_PUBLIC_JOURNEYS.length}`),
        ),
      );
    }
    const passing = results.filter((row) => row.status === 'Passing');
    const failing = results.filter((row) => row.status === 'Failing').sort((a, b) => b.ms - a.ms);
    const slowest = failing[0];
    const summary = {
      revision,
      utc: new Date().toISOString(),
      stack,
      kernelCause: kernelCause ?? null,
      editorCause: editorCause ?? null,
      personaCause: personaCause ?? null,
      frontendCause: frontendCause ?? null,
      passing: passing.length,
      total: FIRST_PUBLIC_JOURNEYS.length,
      slowestFailing: slowest
        ? { id: slowest.id, ms: slowest.ms, owner: slowest.failure?.owner, detail: slowest.failure }
        : null,
      results,
      kernelDeadlineTimings: await kernelDeadlineTimings(stackLog, trace),
    };
    await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    await recordInventory(revision, summary.utc, results);
    console.log(
      `semantic first-public ${passing.length}/${FIRST_PUBLIC_JOURNEYS.length}; slowest failing: ${
        slowest ? `${slowest.name} (${slowest.failure?.owner})` : 'none'
      }`,
    );
    if (failing.length) process.exitCode = 1;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const scope = args.length === 2 && args[0] === '--scope' ? args[1] : args.length === 0 ? 'all' : null;
  if (
    scope !== 'all' &&
    scope !== 'native-boundaries' &&
    scope !== 'mounted-subject' &&
    scope !== 'statement-consent'
  ) {
    console.error('Usage: semantic-first-public-walk.ts [--scope native-boundaries|mounted-subject|statement-consent]');
    process.exit(1);
  }
  try {
    await main(scope);
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error);
    if (scope !== 'all') {
      console.error(actual);
      process.exit(1);
    }
    const utc = new Date().toISOString();
    const revision = roundRevision || (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    const completed = new Set(roundResults.map((row) => row.id));
    roundResults.push(
      ...FIRST_PUBLIC_JOURNEYS.filter((row) => !completed.has(row.id)).map((row) => failingRow(row, actual)),
    );
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(evidenceDir, 'evidence.json'),
      `${JSON.stringify({ revision, utc, results: roundResults, error: actual }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await recordInventory(revision, utc, roundResults);
    await writeFile(
      join(evidenceDir, 'setup-failure.json'),
      `${JSON.stringify({ utc: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
