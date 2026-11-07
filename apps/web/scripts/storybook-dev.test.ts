import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { storybookLaunchPlan, webServeNeedsGeneratedMessages } from './storybook-dev.ts';
import { scripts } from '../package.json';

const roots = { web: '/work/apps/web', ui: '/work/packages/ui' };

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

test('refuses a non-loopback bind address', () => {
  expect(() => storybookLaunchPlan(['--host', '0.0.0.0'], {}, roots)).toThrow('loopback address');
  expect(() => storybookLaunchPlan(['--app', '--host=0.0.0.0'], {}, roots)).toThrow('loopback address');
});

test('Vite app and finite test serving generate Paraglide messages before the child starts', () => {
  expect(webServeNeedsGeneratedMessages('app')).toBe(true);
  expect(webServeNeedsGeneratedMessages('vite')).toBe(true);
  expect(webServeNeedsGeneratedMessages('storybook')).toBe(false);
  const source = readFileSync(resolve(import.meta.dir, 'storybook-dev.ts'), 'utf8');
  const viteConfig = readFileSync(resolve(import.meta.dir, '../vite.config.ts'), 'utf8');
  expect(source.indexOf('ensureMessagesReady(webRoot)')).toBeGreaterThan(
    source.indexOf('webServeNeedsGeneratedMessages(plan.kind)'),
  );
  expect(source.indexOf('await runChild(plan.command, plan.args, plan.cwd)')).toBeGreaterThan(
    source.indexOf('ensureMessagesReady(webRoot)'),
  );
  expect(source).toContain('generated = await ensureMessagesReady(webRoot)');
  expect(source.indexOf('stage=messages-preparation start')).toBeLessThan(
    source.indexOf('generated = await ensureMessagesReady(webRoot)'),
  );
  expect(viteConfig).toContain('ensureMessagesReady(appRoot)');
  expect(viteConfig).not.toContain('withParaglideGenerateLock');
});

test('the app entry logs before loading check custody and defers operator policy', () => {
  const source = readFileSync(resolve(import.meta.dir, 'storybook-dev.ts'), 'utf8');
  expect(source).not.toContain("from './check-placement.ts'");
  expect(source).not.toContain("from './operator-entry.ts'");
  expect(source).toContain("if (args.includes('--operator'))");
  expect(source.indexOf('stage=entry start')).toBeLessThan(source.indexOf("await import('./operator-entry.ts')"));
  expect(source.indexOf('stage=entry start')).toBeLessThan(source.indexOf("await import('./web-check-custody.ts')"));
});
