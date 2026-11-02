import { expect, test } from 'bun:test';
import { TermspacesWindows } from './windows.ts';

test('resolves stable termspaces sessions and registers and unregisters only its own window', () => {
  const calls: { executable: string; argv: string[] }[] = [];
  let registered = false;
  const windows = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (executable, argv) => {
    calls.push({ executable, argv });
    if (argv.includes('list-sessions')) return '$1\tdisplay name\tstable';
    if (argv.includes('list-windows')) return registered ? '@2\tother\n@3\tmanager' : '@2\tother';
    if (argv.includes('new-window')) return '@3';
    if (argv.includes('set-option')) registered = true;
    return '';
  });
  expect(windows.register('manager', ['claude', "brief with $() and a quote'"], '/cwd')).toBe('@3');
  expect(windows.register('manager', ['claude'], '/cwd')).toBe('@3');
  expect(calls.filter((call) => call.argv.includes('new-window'))).toHaveLength(1);
  expect(calls.find((call) => call.argv.includes('new-window'))?.argv).toContain('$1:');
  windows.unregister('manager');
  expect(calls.at(-1)?.argv).toEqual(['-S', '/socket', 'kill-window', '-t', '@3']);
});

test('Preserve a manager session when its window status is unavailable', () => {
  const replacements = (calls: string[][]) =>
    calls.some((argv) => argv.includes('apply') || argv.includes('respawn-pane') || argv.includes('new-window'));
  for (const failure of [
    Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    new Error('error connecting to /socket (Permission denied)'),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  ]) {
    const calls: string[][] = [];
    const windows = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (_executable, argv) => {
      calls.push(argv);
      throw failure;
    });
    const cause = String(failure.code ?? 'Permission denied');
    for (const action of [
      () => windows.alive('manager'),
      () => windows.register('manager', ['claude'], '/cwd'),
      () => windows.respawn('manager', ['claude'], '/cwd'),
    ]) {
      expect(action).toThrow(/window status unavailable:/);
      expect(action).toThrow(cause);
    }
    expect(replacements(calls)).toBe(false);
  }
  let applied = false;
  const absent = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (_executable, argv) => {
    if (argv.includes('list-sessions')) {
      if (!applied) throw new Error('no server running on /socket');
      return '$1\tdisplay name\tstable';
    }
    if (argv.includes('apply')) {
      applied = true;
      return '';
    }
    if (argv.includes('list-windows')) return argv.includes('#{pane_dead}') ? '' : '@2\tother';
    if (argv.includes('new-window')) return '@3';
    return '';
  });
  expect(absent.alive('manager')).toBe(false);
  expect(absent.register('manager', ['claude'], '/cwd')).toBe('@3');
  expect(applied).toBe(true);
  const respawns: string[][] = [];
  const dead = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (_executable, argv) => {
    respawns.push(argv);
    if (argv.includes('list-sessions')) return '$1\tdisplay name\tstable';
    if (argv.includes('list-windows')) return argv.includes('#{pane_dead}') ? 'manager\t1' : '@3\tmanager';
    return '';
  });
  expect(dead.alive('manager')).toBe(false);
  dead.respawn('manager', ['claude'], '/cwd');
  expect(respawns.some((argv) => argv.includes('respawn-pane') && argv.includes('-k'))).toBe(true);
});
