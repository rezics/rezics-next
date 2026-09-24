import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../../.yarn/plugins/rezics-bootstrap.cjs');

test('P0.1 bootstrap installs immutable workspace dependencies before loading Bun code', () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const spawn = (command: string, args: string[], options: { cwd: string }) => {
    calls.push({ command, args, cwd: options.cwd });
    return { status: 0 };
  };

  expect(plugin.installToolchain('/clean-clone', spawn)).toBe(0);
  expect(calls).toEqual([
    { command: 'corepack', args: ['yarn', 'install', '--immutable'], cwd: '/clean-clone' },
    { command: 'bun', args: ['scripts/dev/cli.ts', 'toolchain:install'], cwd: '/clean-clone' },
  ]);
});

test('P0.1 bootstrap stops before loading Bun code when immutable install fails', () => {
  const calls: string[] = [];
  const spawn = (command: string) => {
    calls.push(command);
    return { status: 42 };
  };

  expect(plugin.installToolchain('/clean-clone', spawn)).toBe(42);
  expect(calls).toEqual(['corepack']);
});

test('P0.1 bootstrap propagates a terminated install as an error', () => {
  const spawn = () => ({ status: null, signal: 'SIGTERM' });
  expect(() => plugin.installToolchain('/clean-clone', spawn)).toThrow('stopped by SIGTERM');
});

test('P0.1 Yarn plugin registers the documented root command', () => {
  const registered = plugin.factory((name: string) => {
    expect(name).toBe('@yarnpkg/cli');
    return { BaseCommand: class {} };
  });
  expect(registered.commands).toHaveLength(1);
  expect(registered.commands[0].paths).toEqual([['toolchain:install']]);
});
