import { expect, test } from 'bun:test';
import { pausedGoalMenuSelection, TermspacesWindows } from './windows.ts';

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

function viewerFixture(dead = '0') {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = (argv: string[]) => argv.map(quote).join(' ');
  const oldArgv = [
    'env', '-u', 'CODEX_HOME', '-u', 'GOAL_MANAGER',
    'CODEX_HOME=/codex', 'GOAL_MANAGER=manager', '/home/edge/.local/bin/codex', 'resume', 'thread-1',
    '--remote', 'ws://127.0.0.1:10001',
  ];
  const currentArgv = [...oldArgv];
  currentArgv[currentArgv.length - 1] = 'ws://127.0.0.1:10002';
  const calls: string[][] = [];
  const panes = new Map<string, { dead: string; cwd: string; command: string; draft: string }>([
    ['%3', { dead, cwd: '/cwd', command: `"${command(oldArgv)}"`, draft: 'unsent screenshot notes' }],
  ]);
  const archived = new Map<string, unknown>();
  let nextPane = 4;
  const probes: (() => void)[] = [];
  let menuReady = true;
  let activePane = '%3';
  let owned = true;
  const windows = new TermspacesWindows({ socket: '/socket', session: 'stable' }, (_executable, argv) => {
    calls.push(argv);
    if (argv.includes('list-sessions')) return '$1\tstable\tstable';
    if (argv.includes('list-windows')) return owned ? '@3\tmanager' : '@2\tother';
    if (argv.includes('list-panes')) return [...panes.keys()].join('\n');
    if (argv.includes('display-message')) {
      const target = argv[argv.indexOf('-t') + 1]!;
      const pane = panes.get(target.startsWith('@') ? activePane : target);
      if (!pane) return '';
      if (argv.at(-1) === '#{pane_dead}') return pane.dead;
      if (argv.at(-1) === '#{pane_current_path}') return pane.cwd;
      return pane.command;
    }
    if (argv.includes('split-window')) {
      const id = `%${nextPane++}`;
      panes.set(id, {
        dead: '0',
        cwd: argv[argv.indexOf('-c') + 1]!,
        command: argv.at(-1)!,
        draft: '',
      });
      activePane = id;
      return id;
    }
    if (argv.includes('break-pane')) {
      const id = argv[argv.indexOf('-s') + 1]!;
      archived.set(id, panes.get(id));
      panes.delete(id);
    }
    if (argv.includes('select-pane')) activePane = argv.at(-1)!;
    if (argv.includes('kill-pane')) panes.delete(argv.at(-1)!);
    if (argv.includes('capture-pane') && argv.at(-1) !== '%3' && menuReady) return 'Resume paused goal?\n› 1. Resume goal   Mark it active and continue when idle\n2. Leave paused  Keep it paused; use /goal resume later\nenter select · esc back';
    return '';
  }, (_delayMs, probe) => { probes.push(probe); });
  return {
    windows,
    calls,
    panes,
    probes,
    setMenuReady: (ready: boolean) => (menuReady = ready),
    archived,
    oldArgv,
    currentArgv,
    encode: command,
    setActivePane: (id: string) => (activePane = id),
    setOwned: (value: boolean) => (owned = value),
  };
}

test('reconnects to one manager pane across successive endpoint changes and moves drafts aside', async () => {
  const f = viewerFixture();
  const original = f.panes.get('%3')!;
  expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd')).toBe(true);
  expect(f.archived.get('%3')).toEqual(original);
  expect([...f.panes.keys()]).toEqual(['%4']);
  expect(f.panes.get('%4')?.command).toStartWith("'/bin/sh' '-c' ");
  expect(f.panes.get('%4')?.command).toEndWith(f.encode(f.currentArgv));
  expect(f.calls.some((argv) => argv.includes('send-keys'))).toBe(false);
  expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd')).toBe(false);

  const nextArgv = [...f.currentArgv];
  nextArgv[nextArgv.length - 1] = 'ws://127.0.0.1:10003';
  f.panes.get('%4')!.draft = 'second unsent draft';
  expect(await f.windows.rebindIfStale('manager', nextArgv, '/cwd')).toBe(true);
  expect(f.archived.get('%4')).toMatchObject({ draft: 'second unsent draft' });
  expect([...f.panes.keys()]).toEqual(['%5']);
  expect(f.calls.filter((argv) => argv.includes('split-window'))).toHaveLength(2);
  expect(f.calls.some((argv) => argv.includes('respawn-pane') || argv.includes('kill-pane'))).toBe(false);
});

test('a menu arriving after viewer recovery is left paused exactly once', async () => {
  const f = viewerFixture();
  f.setMenuReady(false);
  expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd')).toBe(true);
  f.probes.shift()!();
  await Bun.sleep(0);
  expect(f.calls.some((argv) => argv.includes('send-keys'))).toBe(false);
  f.setMenuReady(true);
  f.probes.shift()!();
  await Bun.sleep(0);
  expect(f.calls.filter((argv) => argv.includes('send-keys')).map((argv) => argv.slice(-3))).toEqual([
    ['%4', 'Down', 'Enter'],
  ]);
  expect(f.probes).toHaveLength(0);
});

test('leaves unrelated panes and unowned windows alone', async () => {
  const f = viewerFixture();
  const pane = f.panes.get('%3')!;
  for (const [index, value] of [
    [5, 'CODEX_HOME=/other-pool'],
    [6, 'GOAL_MANAGER=other-manager'],
    [7, 'vim'],
    [9, 'other-thread'],
  ] as const) {
    const foreign = [...f.oldArgv];
    foreign[index] = value;
    pane.command = f.encode(foreign);
    expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd')).toBe(false);
  }
  pane.command = f.encode(f.oldArgv);
  f.setOwned(false);
  expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd')).toBe(false);
  expect(await f.windows.rebindIfStale('manager', ['vim'], '/cwd')).toBe(false);
});

test('restores a dead stale pane only when authorized and does not repeat a same-endpoint failure', async () => {
  const f = viewerFixture('1');
  expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd')).toBe(false);
  expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd', { restoreExited: true })).toBe(true);
  expect(f.archived.get('%3')).toMatchObject({ draft: 'unsent screenshot notes' });
  f.panes.get('%4')!.dead = '1';
  expect(await f.windows.rebindIfStale('manager', f.currentArgv, '/cwd', { restoreExited: true })).toBe(false);
  expect(f.calls.filter((argv) => argv.includes('split-window'))).toHaveLength(1);
});

test('recognizes the visible paused-goal selection without confirming other dialogs', () => {
  const body = 'Resume paused goal?\n1. Resume goal   Mark it active and continue when idle\n› 2. Leave paused  Keep it paused; use /goal resume later\nenter select · esc back';
  expect(pausedGoalMenuSelection(body)).toBe('leave');
  expect(pausedGoalMenuSelection(body.replace('enter select · esc back', ''))).toBeUndefined();
  expect(pausedGoalMenuSelection('Someone said Resume paused goal?')).toBeUndefined();
});
