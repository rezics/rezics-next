import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { storybookLaunchPlan, webServeEnvironment, webServeNeedsGeneratedMessages } from './storybook-dev.ts';
import { runWebStartupChild, webStartupSelection } from './web-startup.ts';
import { ownBunProcess, processIdentity } from '../tests/support/server-custody.ts';
import { scripts } from '../package.json';

const roots = { web: '/work/apps/web', ui: '/work/packages/ui' };

test('interrupted Web preparation settles an ignored TERM and its descendant before returning', async () => {
  const temporary = resolve(import.meta.dir, '../../../.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(resolve(temporary, 'web-startup-stop-'));
  const marker = resolve(directory, 'ready.json');
  const controller = new AbortController();
  const stopped = runWebStartupChild(
    process.execPath,
    [
      '-e',
      `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `,
      marker,
    ],
    directory,
    { signal: controller.signal, ownChild: (child) => ownBunProcess(child) },
  );
  try {
    const deadline = performance.now() + 5_000;
    let pids: number[] = [];
    while (performance.now() < deadline) {
      const file = Bun.file(marker);
      if (await file.exists()) {
        pids = JSON.parse(await readFile(marker, 'utf8')) as number[];
        break;
      }
      await Bun.sleep(25);
    }
    expect(pids).toHaveLength(2);
    controller.abort('SIGTERM');
    expect(await stopped).toBe(143);
    for (const pid of pids) expect(processIdentity(pid)).toBeUndefined();
  } finally {
    controller.abort('SIGTERM');
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('ordinary Web bounds V8 while retaining caller Node options and explicit heap limits', () => {
  expect(webServeEnvironment('app', { NODE_OPTIONS: '--enable-source-maps' }).NODE_OPTIONS).toBe(
    '--enable-source-maps --max-old-space-size=2048',
  );
  for (const options of ['--max-old-space-size=768', '--max_old_space_size 768'])
    expect(webServeEnvironment('app', { NODE_OPTIONS: options }).NODE_OPTIONS).toBe(options);
  expect(webServeEnvironment('vite', {}).NODE_OPTIONS).toBeUndefined();
});

test('starts Web Storybook on the requested port and a loopback host', () => {
  expect(storybookLaunchPlan(['--port', '16497', '--exact-port', '--ci'], {}, roots)).toEqual({
    kind: 'storybook',
    command: 'storybook',
    cwd: roots.web,
    args: ['dev', '--config-dir', '.storybook', '--port', '16497', '--exact-port', '--ci', '--host', '127.0.0.1'],
  });
});

test('runs the UI catalogue from its own workspace', () => {
  expect(storybookLaunchPlan(['--ui', '--host', '::1', '--port', '16498'], {}, roots)).toEqual({
    kind: 'storybook',
    command: 'storybook',
    cwd: roots.ui,
    args: ['dev', '--config-dir', '.storybook', '--host', '::1', '--port', '16498'],
  });
});

test('preserves finite Web Vite execution and rejects its entry outside test runtime', () => {
  expect(storybookLaunchPlan(['--web', '--port', '5000'], { REZICS_TEST_RUNTIME: '1' }, roots)).toEqual({
    kind: 'vite',
    command: 'vite',
    cwd: roots.web,
    args: ['--config', 'vite.config.ts', '--port', '5000'],
  });
  expect(() => storybookLaunchPlan(['--web'], {}, roots)).toThrow('finite test commands');
});

test('starts the ordinary local app without test runtime or check admission', () => {
  expect(scripts.dev).toBe('bun scripts/storybook-dev.ts --app');
  expect(storybookLaunchPlan(['--app'], {}, roots)).toEqual({
    kind: 'app',
    command: 'vite',
    cwd: roots.web,
    args: ['--config', 'vite.config.ts', '--port', '3000', '--strictPort', '--host', '127.0.0.1'],
  });
  const finite = storybookLaunchPlan(['--app', '--port', '5000'], { REZICS_TEST_RUNTIME: '1' }, roots);
  expect(finite.kind).toBe('vite');
  expect(finite.args).toContain('5000');
  expect(finite.args).not.toContain('3000');
});

test('records the inherited native binding without inventing test or walk selections', () => {
  expect(webStartupSelection('app', { NODE_ENV: 'development' })).toMatchObject({
    kind: 'app',
    nodeEnv: 'development',
    testRuntime: 'disabled',
    walkSlot: 'unset',
    cache: 'default',
    cloudflareLocal: 'unset',
    nativeTls: 'disabled',
  });
  expect(
    webStartupSelection('vite', {
      NODE_ENV: 'test',
      REZICS_TEST_RUNTIME: '1',
      REZICS_WALK_STACK_SLOT: '2',
      WEB_VITE_CACHE_DIR: '/private/cache',
      CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
    }),
  ).toMatchObject({
    kind: 'vite',
    testRuntime: 'enabled',
    walkSlot: 'selected',
    cache: 'provided',
    cloudflareLocal: 'enabled',
  });
});

test('refuses a non-loopback bind address', () => {
  expect(() => storybookLaunchPlan(['--host', '0.0.0.0'], {}, roots)).toThrow('loopback address');
  expect(() => storybookLaunchPlan(['--app', '--host=0.0.0.0'], {}, roots)).toThrow('loopback address');
});

test('Web prepares messages in disposable Bun processes while the live plugin validates its cache', () => {
  expect(webServeNeedsGeneratedMessages('app')).toBe(true);
  expect(webServeNeedsGeneratedMessages('vite')).toBe(true);
  expect(webServeNeedsGeneratedMessages('storybook')).toBe(false);
  const source = readFileSync(resolve(import.meta.dir, 'storybook-dev.ts'), 'utf8');
  const viteConfig = readFileSync(resolve(import.meta.dir, '../vite.config.ts'), 'utf8');
  const preparation = source.indexOf('await ensureMessagesReady(webRoot, startupEnv');
  const child = source.indexOf('await runWebStartupChild(plan.command, plan.args, plan.cwd');
  expect(preparation).toBeGreaterThan(source.indexOf('webServeNeedsGeneratedMessages(plan.kind)'));
  expect(child).toBeGreaterThan(preparation);
  expect(source).toContain('signal: interruptions.signal');
  expect(source.indexOf("webStartupLog('messages-preparation-start'")).toBeLessThan(
    source.indexOf('await ensureMessagesReady(webRoot, startupEnv'),
  );
  expect(viteConfig).toContain('ensureMessagesReady(appRoot, process.env');
  expect(source).toContain('await prepareLiveMessages(webRoot, startupEnv');
  expect(viteConfig).toContain('shouldUseStandaloneLocalizationGenerator()');
  expect(viteConfig).toContain("env.REZICS_TEST_RUNTIME === '1' && Boolean(env.REZICS_PARAGLIDE_COMPILER_MODULE)");
  expect(viteConfig).toContain(
    "[paraglideVitePlugin({ project: './project.inlang', outputStructure: 'message-modules' })]",
  );
  expect(viteConfig).toContain('traceWebVitePlugins(');
  expect(viteConfig).toContain("name: 'web-startup-evidence'");
  expect(viteConfig).not.toContain('withParaglideGenerateLock');
});

test('the app entry logs before loading check custody and defers operator policy', () => {
  const source = readFileSync(resolve(import.meta.dir, 'storybook-dev.ts'), 'utf8');
  expect(source).not.toContain("from './check-placement.ts'");
  expect(source).not.toContain("from './operator-entry.ts'");
  expect(source).toContain("if (args.includes('--operator'))");
  expect(source.indexOf("webStartupLog('entry-start'")).toBeLessThan(
    source.indexOf("await import('./operator-entry.ts')"),
  );
  expect(source.indexOf("webStartupLog('entry-start'")).toBeLessThan(
    source.indexOf("await import('./web-check-custody.ts')"),
  );
});
