import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { cleanupAll, ownBunProcess, withCleanup, type ProcessCustody } from './support/server-custody.ts';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const timeout = 300_000;
const activeDirectories = new Map<string, ProcessCustody | undefined>();
const activeBrowsers = new Set<Browser>();

afterAll(async () => {
  await cleanupAll([
    ...[...activeDirectories.keys()].map((directory) => ({
      label: `Fake-module fixture ${directory}`,
      timeoutMs: 8000,
      run: async () => {
        const custody = activeDirectories.get(directory);
        let closeError: unknown;
        try {
          await custody?.close();
        } catch (error) {
          closeError = error;
        }
        if (custody && !custody.settled)
          throw new AggregateError(
            [closeError, new Error(`Preserved unsafe fake-module fixture: ${directory}`)],
            'Fake-module fixture process group did not settle; fixture was preserved',
          );
        rmSync(directory, { recursive: true, force: true });
        activeDirectories.delete(directory);
        if (closeError) throw closeError;
      },
    })),
    ...[...activeBrowsers].map((browser) => ({
      label: 'Fake-module browser',
      timeoutMs: 5000,
      run: async () => {
        await browser.close();
        activeBrowsers.delete(browser);
      },
    })),
  ]);
});

// Exercise fresh discovery in a new process, without adding temporary files to the real source tree.
function sandbox() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/fake-modules-'));
  activeDirectories.set(directory, undefined);
  try {
    cpSync(join(app, 'src/kernel'), join(directory, 'src/kernel'), { recursive: true });
    symlinkSync(join(app, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const kernel = join(directory, 'src/kernel');
    const original = readFileSync(join(kernel, 'fake.ts'), 'utf8');
    mkdirSync(join(kernel, 'fake'), { recursive: true });
    mkdirSync(join(kernel, 'fixtures'), { recursive: true });
    writeFileSync(
      join(kernel, 'fake/extension.ts'),
      `export const routes = [
      { method: 'POST', path: /^\\/v1\\/extensions\\/([^/]+)$/, 
        story: async ({ request, recordings, match }) => ({
          ...recordings['extension-recording'], id: match[1], body: await request.json(),
          header: request.headers.get('x-extension'), mode: 'story'
        }),
        fixture: async ({ request, recordings, fixtures, match }) => ({
          ...recordings['extension-recording'], id: match[1], body: await request.json(),
          header: request.headers.get('x-extension'), mode: 'fixture',
          subjects: fixtures.subjects.map(item => item.id), accounts: fixtures.accounts.map(item => item.id)
        }) },
      { method: 'GET', path: '/v1/extension-story', story: () => ({ status: 204 }) },
      { method: 'GET', path: '/v1/extension-fixture', fixture: () => ({ status: 204 }) },
      // A declining module must leave the body available to the existing route chain.
      { method: 'POST', path: '/v1/pages:read', story: async ({ request }) => { await request.json(); },
        fixture: async ({ request }) => { await request.json(); } },
      { method: 'GET', path: /^\\/v1\\/subjects\\/module-override$/, 
        story: () => ({ status: 200, override: true }), fixture: () => ({ status: 200, override: true }) }
    ];\n`,
    );
    writeFileSync(
      join(kernel, 'recorded/extension-recording.json'),
      JSON.stringify({ status: 201, recorded: 'new file' }),
    );
    // Deliberately write in reverse filename order.
    for (const suffix of ['z', 'a']) {
      writeFileSync(
        join(kernel, `fixtures/extension-${suffix}.json`),
        JSON.stringify({
          subjects: [{ id: `extension-${suffix}`, type: 'schema:Book', labels: { en: suffix }, statements: {} }],
          accounts: [
            {
              id: `account-${suffix}`,
              handle: `extension-${suffix}`,
              kind: 'actor',
              state: 'active',
              displayName: suffix,
              bio: null,
              links: [],
              avatar: null,
              subject: null,
            },
          ],
        }),
      );
    }
    // Exactly the shared files copied above remain untouched.
    expect(readFileSync(join(kernel, 'fake.ts'), 'utf8')).toBe(original);
    expect(readFileSync(join(kernel, 'fixtures.json'), 'utf8')).toBe(
      readFileSync(join(app, 'src/kernel/fixtures.json'), 'utf8'),
    );
    writeFileSync(join(directory, 'exercise.ts'), exercise);
    return directory;
  } catch (primary) {
    try {
      rmSync(directory, { recursive: true, force: true });
      activeDirectories.delete(directory);
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], 'Fake-module sandbox setup and cleanup failed', { cause: primary });
    }
    throw primary;
  }
}

const exercise = `
import { createFakeKernelFetch, createStoryRecordedKernelFetch, createRecordedKernelFetch } from './src/kernel/fake.ts';
import given from './src/kernel/fixtures.json';
export async function exercise() {
  const before = JSON.stringify(given);
  const fixture = createFakeKernelFetch(given);
  const story = createStoryRecordedKernelFetch();
  const call = async (fetcher, path, init) => {
    const response = await fetcher('http://kernel.local' + path, init);
    return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
  };
  const post = { method: 'POST', headers: { 'x-extension': 'present' }, body: JSON.stringify({ value: 7 }) };
  const moduleFixture = await call(fixture, '/v1/extensions/new?query=kept', post);
  const moduleStory = await call(story, '/v1/extensions/new?query=kept', post);
  const page = { method: 'POST', body: JSON.stringify({ target: { route: '/' } }) };
  const subject = await call(fixture, '/v1/subjects/extension-a');
  const account = await call(fixture, '/v1/pages:read', {
    method: 'POST', body: JSON.stringify({ target: { account: 'extension-a' } })
  });
  const explicit = createRecordedKernelFetch({ 'extension-recording': { status: 202, recorded: 'override' } });
  return {
    moduleFixture, moduleStory, subject, account,
    fixtureOnly: await call(fixture, '/v1/extension-fixture'),
    storyOnly: await call(story, '/v1/extension-story'),
    fixtureIgnoresStory: (await call(fixture, '/v1/extension-story')).status,
    storyIgnoresFixture: (await call(story, '/v1/extension-fixture')).status,
    wrongMethod: (await call(fixture, '/v1/extensions/new')).status,
    wrongPath: (await call(story, '/v1/extensions/new/extra', post)).status,
    fixtureOverride: await call(fixture, '/v1/subjects/module-override'),
    storyOverride: await call(story, '/v1/subjects/module-override'),
    fixtureFallback: (await call(fixture, '/v1/pages:read', page)).status,
    storyFallback: (await call(story, '/v1/pages:read', page)).status,
    explicit: await call(explicit, '/v1/extensions/new', post),
    originalUnchanged: before === JSON.stringify(given),
    repeat: (await call(createFakeKernelFetch(given), '/v1/extensions/new', post)).body?.subjects
  };
}
`;

function verify(result: any) {
  for (const [mode, response] of [
    ['fixture', result.moduleFixture],
    ['story', result.moduleStory],
  ] as const) {
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      recorded: 'new file',
      id: 'new',
      body: { value: 7 },
      header: 'present',
      mode,
    });
    expect(response.body).not.toHaveProperty('status');
  }
  expect(result.moduleFixture.body.subjects.slice(-2)).toEqual(['extension-a', 'extension-z']);
  expect(result.moduleFixture.body.accounts.slice(-2)).toEqual(['account-a', 'account-z']);
  // Adding accounts must preserve the dev server's existing default demo cast.
  expect(result.moduleFixture.body.accounts.length).toBeGreaterThan(2);
  expect(result.subject).toMatchObject({ status: 200, body: { subject: { id: 'extension-a' } } });
  expect(result.account).toMatchObject({ status: 200, body: { account: 'account-a' } });
  expect(result.fixtureOnly).toEqual({ status: 204, body: null });
  expect(result.storyOnly).toEqual({ status: 204, body: null });
  for (const key of ['fixtureIgnoresStory', 'storyIgnoresFixture', 'wrongMethod', 'wrongPath'])
    expect(result[key]).toBe(404);
  for (const key of ['fixtureOverride', 'storyOverride'])
    expect(result[key]).toEqual({ status: 200, body: { override: true } });
  expect(result.fixtureFallback).toBe(200);
  expect(result.storyFallback).toBe(200);
  expect(result.explicit).toMatchObject({ status: 202, body: { recorded: 'override' } });
  expect(result.originalUnchanged).toBe(true);
  expect(result.repeat).toEqual(result.moduleFixture.body.subjects);
}

test(
  'new route, recording and fixture files are discovered under Bun without shared edits',
  async () => {
    const directory = sandbox();
    let stdout = '';
    let stderr = '';
    let custody: ReturnType<typeof ownBunProcess> | undefined;
    await withCleanup(async () => {
      writeFileSync(
        join(directory, 'run.ts'),
        `import { exercise } from './exercise.ts'; console.log(JSON.stringify(await exercise()));`,
      );
      const child = Bun.spawn(['bun', join(directory, 'run.ts')], {
        cwd: directory,
        detached: true,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      custody = ownBunProcess(child, {
        label: 'Fake-module fixture program',
        onOutput: (chunk, stream) => {
          if (stream === 'stdout') stdout += Buffer.from(chunk).toString();
          else stderr += Buffer.from(chunk).toString();
        },
      });
      activeDirectories.set(directory, custody);
      const code = await child.exited;
      await custody.outputSettled;
      expect(code, stderr).toBe(0);
      verify(JSON.parse(stdout));
    }, [
      {
        label: 'Fake-module fixture group and sandbox',
        run: async () => {
          let closeError: unknown;
          try {
            await custody?.close();
          } catch (error) {
            closeError = error;
          }
          if (custody && !custody.settled)
            throw new AggregateError(
              [closeError, new Error(`Preserved unsafe fake-module sandbox: ${directory}`)],
              'Fake-module fixture group did not settle; sandbox was preserved',
            );
          rmSync(directory, { recursive: true, force: true });
          activeDirectories.delete(directory);
          if (closeError) throw closeError;
        },
      },
    ]);
  },
  timeout,
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

test(
  'Storybook discovers the same new files through Vite in the browser',
  async () => {
    const directory = sandbox();
    let custody: ReturnType<typeof ownBunProcess> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    await withCleanup(async () => {
      const port = await freePort();
      mkdirSync(join(directory, '.storybook'));
      writeFileSync(
        join(directory, '.storybook/main.ts'),
        `export default { framework: { name: '@storybook/react-vite', options: {} }, stories: ['../extension.stories.tsx'],
      core: { disableTelemetry: true }, viteFinal: config => ({ ...config, cacheDir: ${JSON.stringify(join(directory, 'cache'))} }) };`,
      );
      writeFileSync(
        join(directory, 'extension.stories.tsx'),
        `import React from 'react'; import { exercise } from './exercise.ts';
     export default { title: 'Extensions' };
     export const AddedFiles = { loaders: [async () => ({ result: await exercise() })],
       render: (_, { loaded }) => <pre data-result>{JSON.stringify(loaded.result)}</pre> };`,
      );
      const child = Bun.spawn(
        ['bun', join(app, 'node_modules/.bin/storybook'), 'dev', '--ci', '--disable-telemetry', '--port', String(port)],
        { cwd: directory, detached: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BROWSER: 'none' } },
      );
      const serverCustody = (custody = ownBunProcess(child, { label: 'Fake-module Storybook' }));
      activeDirectories.set(directory, serverCustody);
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 180_000;
      while (true) {
        try {
          if ((await fetch(`${origin}/index.json`)).ok) break;
        } catch {}
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`Storybook did not start: ${serverCustody.diagnostics()}`);
        }
        await Bun.sleep(100);
      }
      browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
      activeBrowsers.add(browser);
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/iframe.html?id=extensions--added-files&viewMode=story`);
      await page.locator('[data-result]').waitFor({ timeout: 120_000 });
      verify(JSON.parse((await page.locator('[data-result]').textContent())!));
      expect(errors).toEqual([]);
    }, [
      {
        label: 'Fake-module browser',
        run: async () => {
          if (!browser) return;
          await browser.close();
          activeBrowsers.delete(browser);
        },
        timeoutMs: 5000,
      },
      {
        label: 'Fake-module Storybook group and sandbox',
        run: async () => {
          let closeError: unknown;
          try {
            await custody?.close();
          } catch (error) {
            closeError = error;
          }
          if (custody && !custody.settled)
            throw new AggregateError(
              [closeError, new Error(`Preserved unsafe Storybook sandbox: ${directory}`)],
              'Fake-module Storybook group did not settle; sandbox was preserved',
            );
          rmSync(directory, { recursive: true, force: true });
          activeDirectories.delete(directory);
          if (closeError) throw closeError;
        },
      },
    ]);
  },
  timeout,
);
