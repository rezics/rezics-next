import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const timeout = 300_000;

// Exercise fresh discovery in a new process, without adding temporary files to the real source tree.
function sandbox() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/fake-modules-'));
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
    try {
      writeFileSync(
        join(directory, 'run.ts'),
        `import { exercise } from './exercise.ts'; console.log(JSON.stringify(await exercise()));`,
      );
      const child = Bun.spawn(['bun', join(directory, 'run.ts')], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      verify(JSON.parse(stdout));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
      { cwd: directory, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BROWSER: 'none' } },
    );
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 180_000;
      while (true) {
        try {
          if ((await fetch(`${origin}/index.json`)).ok) break;
        } catch {}
        if (child.exitCode !== null || Date.now() > deadline) {
          if (child.exitCode === null) child.kill();
          throw new Error(`Storybook did not start: ${(await output).join('\n')}`);
        }
        await Bun.sleep(100);
      }
      browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/iframe.html?id=extensions--added-files&viewMode=story`);
      await page.locator('[data-result]').waitFor({ timeout: 120_000 });
      verify(JSON.parse((await page.locator('[data-result]').textContent())!));
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      child.kill();
      await child.exited;
      await output;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  timeout,
);
