import { expect, test } from 'bun:test';
import { TermspacesWindows } from './windows.ts';

test('resolves stable termspaces sessions and registers and unregisters only its own window', () => {
  const calls: { executable: string; argv: string[] }[] = []; let registered = false;
  const windows = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (executable, argv) => {
    calls.push({ executable, argv });
    if (argv.includes('list-sessions')) return '$1\tdisplay name\tstable';
    if (argv.includes('list-windows')) return registered ? '@2\tother\n@3\tmanager' : '@2\tother';
    if (argv.includes('new-window')) return '@3';
    if (argv.includes('set-option')) registered = true;
    return '';
  });
  expect(windows.register('manager', ['claude', 'brief with $() and a quote\''], '/cwd')).toBe('@3');
  expect(windows.register('manager', ['claude'], '/cwd')).toBe('@3');
  expect(calls.filter(call => call.argv.includes('new-window'))).toHaveLength(1);
  expect(calls.find(call => call.argv.includes('new-window'))?.argv).toContain('$1:');
  windows.unregister('manager');
  expect(calls.at(-1)?.argv).toEqual(['-S', '/socket', 'kill-window', '-t', '@3']);
});
