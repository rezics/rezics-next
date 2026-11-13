import { expect, test } from 'bun:test';
import { TermspacesWindows } from './windows.ts';

test('resolves stable termspaces sessions and registers and unregisters only its own window', async () => {
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
  expect(await windows.register('manager', ['claude', "brief with $() and a quote'"], '/cwd')).toBe('@3');
  expect(await windows.register('manager', ['claude'], '/cwd')).toBe('@3');
  expect(calls.filter((call) => call.argv.includes('new-window'))).toHaveLength(1);
  expect(calls.find((call) => call.argv.includes('new-window'))?.argv).toContain('$1:');
  await windows.unregister('manager');
  expect(calls.at(-1)?.argv).toEqual(['-u', '-S', '/socket', 'kill-window', '-t', '@3']);
  expect(calls.every((call) => call.executable !== 'tmux' || call.argv[0] === '-u')).toBe(true);
});

test('Window lookups find the termspaces session when the host runs without any locale variables (tmux prints tab separators as underscores in that case).', async () => {
  const windows = new TermspacesWindows({ socket: '/socket', session: 'rezics-agents' }, (_executable, argv) => {
    if (argv.includes('list-sessions')) return '$1_rezics-agents_rezics-agents';
    if (argv.includes('list-windows')) return '@2_other';
    if (argv.includes('new-window')) return '@3';
    return '';
  });
  expect(await windows.register('manager', ['claude'], '/cwd')).toBe('@3');
});

test('Preserve a manager session when its window status is unavailable', async () => {
  const replacements = (calls: string[][]) =>
    calls.some((argv) => argv.includes('apply') || argv.includes('respawn-pane') || argv.includes('new-window'));
  const failures: Array<Error & { code?: string }> = [
    Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    new Error('error connecting to /socket (Permission denied)'),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  ];
  for (const failure of failures) {
    const calls: string[][] = [];
    const windows = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (_executable, argv) => {
      calls.push(argv);
      throw failure;
    });
    const cause = failure.code ?? 'Permission denied';
    for (const action of [
      () => windows.alive('manager'),
      () => windows.register('manager', ['claude'], '/cwd'),
      () => windows.respawn('manager', ['claude'], '/cwd'),
    ]) {
      await expect(action()).rejects.toThrow(/window status unavailable:/);
      await expect(action()).rejects.toThrow(cause);
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
  expect(await absent.alive('manager')).toBe(false);
  expect(await absent.register('manager', ['claude'], '/cwd')).toBe('@3');
  expect(applied).toBe(true);
  const respawns: string[][] = [];
  const dead = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (_executable, argv) => {
    respawns.push(argv);
    if (argv.includes('list-sessions')) return '$1\tdisplay name\tstable';
    if (argv.includes('list-windows')) return argv.includes('#{pane_dead}') ? 'manager\t1' : '@3\tmanager';
    return '';
  });
  expect(await dead.alive('manager')).toBe(false);
  await dead.respawn('manager', ['claude'], '/cwd');
  expect(respawns.some((argv) => argv.includes('respawn-pane') && argv.includes('-k'))).toBe(true);
});

test('rebinds only a live owned Codex pane whose same-thread command differs only by endpoint', async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = (argv: string[]) => argv.map(quote).join(' ');
  const oldArgv = [
    'env',
    'CODEX_HOME=/codex',
    'GOAL_MANAGER=manager',
    'codex',
    'resume',
    'thread-1',
    '--remote',
    'ws://127.0.0.1:10001',
  ];
  const currentArgv = [...oldArgv];
  currentArgv[currentArgv.length - 1] = 'ws://127.0.0.1:10002';
  const calls: string[][] = [];
  let owned = true;
  let dead = '0';
  let paneCommand = command(oldArgv);
  const windows = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (_executable, argv) => {
    calls.push(argv);
    if (argv.includes('list-sessions')) return '$1\tstable\tstable';
    if (argv.includes('list-windows')) return owned ? '@3\tmanager' : '@2\tother';
    if (argv.includes('display-message')) return argv.at(-1) === '#{pane_dead}' ? dead : paneCommand;
    if (argv.includes('respawn-pane')) paneCommand = argv.at(-1)!;
    return '';
  });

  expect(await windows.rebindIfStale('manager', currentArgv, '/cwd')).toBe(true);
  expect(paneCommand).toBe(command(currentArgv));
  expect(calls.filter((argv) => argv.includes('respawn-pane'))).toHaveLength(1);
  expect(calls.some((argv) => argv.includes('new-window') || argv.includes('apply'))).toBe(false);

  expect(await windows.rebindIfStale('manager', currentArgv, '/cwd')).toBe(false);
  const beforeUnrelated = calls.filter((argv) => argv.includes('respawn-pane')).length;
  expect(await windows.rebindIfStale('manager', ['vim'], '/cwd')).toBe(false);
  dead = '1';
  expect(await windows.rebindIfStale('manager', oldArgv, '/cwd')).toBe(false);
  owned = false;
  expect(await windows.rebindIfStale('manager', oldArgv, '/cwd')).toBe(false);
  expect(calls.filter((argv) => argv.includes('respawn-pane'))).toHaveLength(beforeUnrelated);
  expect(calls.some((argv) => argv.includes('new-window') || argv.includes('apply'))).toBe(false);
});
