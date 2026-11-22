import { expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createLauncher } from '../src/index.ts';
import { processLaunchIssue } from '../src/launch-issues.ts';
import { Minecraft } from '../src/minecraft.ts';
import { MinecraftAuth } from '../src/minecraft-auth.ts';
import { MinecraftVersions } from '../src/minecraft-versions.ts';
import { createLaunchDiagnostics } from '../src/plugins/launch-diagnostics.ts';
import { writeJson } from '../src/storage.ts';

test.each([
  'net.fabricmc.loader.impl.discovery.ModResolutionException: duplicate mod fixture',
  'Found duplicate mods',
  'Duplicate mods found',
])('routes duplicate mod diagnostics to the Mods panel for %s', (line) => {
  expect(processLaunchIssue(line)).toEqual({
    kind: 'mods',
    action: 'mods',
    summary: 'The loader reported duplicate mods. Open Mods to review the JAR files.',
  });
});

test.skipIf(process.platform === 'win32')(
  'finishes a launch report when a descendant holds the output pipe',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rezics-launch-drain-'));
    const pidFile = join(root, 'fixture-pid');
    const diagnostics = createLaunchDiagnostics((id) => join(root, id));
    const terminalReports: ReturnType<typeof diagnostics.read>[] = [];
    const unsubscribe = diagnostics.subscribe((id) => terminalReports.push(diagnostics.read(id)));
    try {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
        const holder = require('node:child_process').spawn(
          process.execPath, [
            '-e', 'setTimeout(() => console.log("late descendant output"), 150); setTimeout(() => {}, 4500)',
          ], { stdio: ['ignore', 1, 2] }
        );
        require('node:fs').writeFileSync(process.argv[1], String(holder.pid));
        holder.unref();
        process.stdout.write('last line before exit\\n');
        `,
          pidFile,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await Promise.race([
        diagnostics.begin('instance').watch(child),
        setTimeout(3100, undefined, { ref: false }).then(() => {
          throw new Error('An inherited output pipe held the launch report open.');
        }),
      ]);
      expect(await diagnostics.read('instance')).toMatchObject({
        state: 'exited',
        exitCode: 0,
        truncated: true,
        output: expect.stringContaining('last line before exit'),
      });
      expect(await Promise.all(terminalReports)).toMatchObject([
        { state: 'exited', truncated: true, output: expect.stringContaining('late descendant output') },
      ]);
    } finally {
      unsubscribe();
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => 0));
      if (pid > 0) {
        try {
          process.kill(pid);
        } catch {
          // The fixture may have exited by itself.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('redacts output from independent streams and retains a bounded tail and the exit status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rezics-launch-diagnostics-'));
  try {
    const diagnostics = createLaunchDiagnostics((id) => join(root, id));
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      process.stdout.write('x'.repeat(70000) + '\\n' + 'first-secret-');
      process.stderr.write('stderr message\\n');
      setTimeout(() => {
        process.stdout.write('second-half\\n--accessToken provided-capture\\nlast output');
        process.exitCode = 7;
      }, 40);
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const attempt = diagnostics.begin('instance');
    await attempt.watch(child, 'first-secret-second-half');
    const reopened = createLaunchDiagnostics((id) => join(root, id));
    const report = await reopened.read('instance');
    expect(report).toMatchObject({ state: 'failed', exitCode: 7, truncated: true });
    expect(report?.output).toContain('stderr message');
    expect(report?.output).toContain('--accessToken [redacted]');
    expect(report?.output).toContain('last output');
    expect(report?.output).not.toContain('first-secret');
    expect(report?.output).not.toContain('provided-capture');
    expect(report?.output.length).toBeLessThanOrEqual(65_536);
    expect(report?.issue).toBeUndefined();
    expect((await reopened.copy('instance', []))?.length).toBeLessThanOrEqual(65_536);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('redacts split authentication fields and strips local paths and account arguments from copied text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rezics-launch-redaction-'));
  try {
    const diagnostics = createLaunchDiagnostics((id) => join(root, id));
    const local = join(root, 'Private game folder', 'world.dat');
    const windows = String.raw`C:\Users\PrivateWindowsUser\Game With Spaces\latest.log`;
    const networkPath = String.raw`\\?\UNC\server\PrivateShare\world.dat`;
    const next = [
      'token":',
      '    "private-refresh-value",',
      'Authorization: Bearer private-bearer-value',
      'Cookie: session=private-cookie-value; next=private-cookie-two',
      '["--accessToken", "private-args-value"]',
      'x-api-key=private-key-value',
      'last-token-value',
      `Working file "${local}"`,
      `Alternate path ${windows}`,
      `Network path ${networkPath}`,
      'Profile --username PrivatePlayer --uuid private-player-uuid',
      'https://launcher.example.invalid/resource?signature=private-query-value',
      'Provider message user@example.invalid',
      'Ordinary diagnostic line',
    ].join('\n');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write('prefix "refresh_'); setTimeout(() => { process.stdout.write(${JSON.stringify(next)}); process.exitCode = 3; }, 20);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await diagnostics.begin('one').watch(child, 'last-token-value');
    const report = await diagnostics.read('one');
    const persisted = await readFile(join(root, 'one', 'last-launch.json'), 'utf8');
    for (const secret of [
      'private-refresh-value',
      'private-bearer-value',
      'private-cookie-value',
      'private-cookie-two',
      'private-args-value',
      'private-key-value',
      'last-token-value',
    ]) {
      expect(report?.output).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(report?.output).toContain(local);

    const copied = await diagnostics.copy('one', [root]);
    expect(copied).toContain('Exit code 3');
    expect(copied).toContain('Ordinary diagnostic line');
    for (const privateValue of [
      root,
      'Private game folder',
      'PrivateWindowsUser',
      'Game With Spaces',
      'PrivateShare',
      'PrivatePlayer',
      'private-player-uuid',
      'private-query-value',
      'user@example.invalid',
    ]) {
      expect(copied).not.toContain(privateValue);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('classifies specific Minecraft failures and leaves user stops and ordinary exits without a cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rezics-launch-cause-'));
  try {
    const diagnostics = createLaunchDiagnostics((id) => join(root, id));
    const cases = [
      { id: 'mods', line: 'Incompatible mods found!', kind: 'mods', action: 'mods' },
      {
        id: 'memory',
        line: 'Error occurred during initialization of VM\nCould not reserve enough space for object heap',
        kind: 'memory',
        action: 'settings',
      },
      {
        id: 'java',
        line: 'java.lang.UnsupportedClassVersionError: class file version 65.0',
        kind: 'java',
        action: 'settings',
      },
      { id: 'generic', line: 'Minecraft process exited', kind: undefined },
    ];
    for (const info of cases) {
      const child = spawn(
        process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(info.line)}); process.exitCode = 7;`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await diagnostics.begin(info.id, true).watch(child);
      const report = await diagnostics.read(info.id);
      expect(report).toMatchObject({ exitCode: 7, state: 'failed' });
      if (info.kind) expect(report?.issue).toMatchObject({ kind: info.kind, action: info.action });
      else expect(report?.issue).toBeUndefined();
    }

    const stopping = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("Incompatible mods found!\\n"); setInterval(() => {}, 1000);'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const recording = diagnostics.begin('user-stopped', true);
    const done = recording.watch(stopping);
    await new Promise<void>((resolve) => stopping.stdout!.once('data', () => resolve()));
    expect(stopping.kill('SIGKILL')).toBe(true);
    recording.stopped();
    await done;
    const report = await diagnostics.read('user-stopped');
    expect(report?.state).toBe('exited');
    expect(report?.issue).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('reads old reports with safe errors and classifies host prelaunch boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rezics-launch-host-'));
  try {
    const launcher = createLauncher({
      dataDir: root,
      catalogUrl: 'https://catalog.example.invalid',
      webUrl: 'https://rezics.example.invalid',
      launcherVersion: '0.1.0',
      openExternal: async () => {},
    });
    const minecraft = await launcher.createMinecraft({ name: 'Unprepared', loader: 'vanilla' });
    await expect(launcher.launch(minecraft.id)).rejects.toThrow('Prepare this Minecraft instance');
    expect(await launcher.readLaunchReport(minecraft.id)).toMatchObject({
      issue: { kind: 'installation', action: 'repair' },
    });
    expect(await launcher.launchDiagnosticText(minecraft.id)).toContain('Prepare this Minecraft instance');

    const local = join(root, 'private-missing-fixture.exe');
    await writeFile(local, 'fixture');
    const game = await launcher.importInstance({ kind: 'local', name: 'Fixture', executable: local });
    const home = join(root, 'instances', game.id);
    await writeJson(join(home, 'last-launch.json'), {
      state: 'failed',
      exitCode: 5,
      signal: null,
      truncated: false,
      error: 'Raw exception includes a private-legacy-value',
      output: `"refresh_token":"private-old-token"\nOld local path ${local}\nUseful older line`,
    });
    expect(await launcher.readLaunchReport(game.id)).toMatchObject({
      exitCode: 5,
      output: expect.stringContaining('Useful older line'),
    });
    const old = await launcher.launchDiagnosticText(game.id);
    expect(old).toContain('Exit code 5');
    for (const privateValue of [local, 'private-old-token', 'private-legacy-value'])
      expect(old).not.toContain(privateValue);

    await rm(local);
    await expect(launcher.launch(game.id)).rejects.toThrow('selected game executable could not be started');
    const report = await launcher.readLaunchReport(game.id);
    expect(report).toMatchObject({ state: 'failed', issue: { kind: 'executable', action: 'none' } });
    expect(JSON.stringify(report)).not.toContain(local);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('diagnoses a new Minecraft crash report even with exit code zero and clears it after a clean relaunch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rezics-minecraft-crash-'));
  const launcher = createLauncher({
    dataDir: root,
    catalogUrl: 'https://catalog.example.invalid',
    webUrl: 'https://rezics.example.invalid',
    launcherVersion: '0.1.0',
    openExternal: async () => {},
  });
  const prepare = spyOn(Minecraft.prototype, 'prepare').mockResolvedValue({ versionId: 'fixture', javaMajor: 21 });
  const secret = 'unlabelled-private-launch-token';
  const header = '---- Minecraft Crash Report ----\n';
  const folderPath = ['crash-reports', 'crash-2026-11-22_03.44.01-client.txt'].join('/');
  const report = [
    header,
    'Incompatible mods found!',
    `File: ${join(root, 'Private game', 'mods', 'fixture.jar')}`,
    secret,
    'Authorization: Bearer fixture-private-bearer',
    'Large detail follows',
    'x'.repeat(30_000),
    'End of report',
  ].join('\n');
  let crashing = true;
  const start = spyOn(Minecraft.prototype, 'start').mockImplementation(
    async (game, _installation, _settings, notice) => {
      const code = crashing
        ? `require('node:fs').writeFileSync(${JSON.stringify(folderPath)}, ${JSON.stringify(report)});
         process.stdout.write('Ordinary process output\\n'.repeat(3000));`
        : 'process.stdout.write("Game closed normally.\\n");';
      const child = spawn(process.execPath, ['-e', code], { cwd: game, stdio: ['ignore', 'pipe', 'pipe'] });
      notice?.(child, secret, Promise.resolve());
      return { child, accessToken: secret };
    },
  );
  const reports: ReturnType<typeof launcher.readLaunchReport>[] = [];
  const unsubscribe = launcher.subscribeLaunchReport((id) => reports.push(launcher.readLaunchReport(id)));
  try {
    const game = await launcher.createMinecraft({ name: 'Crash fixture', loader: 'vanilla' });
    await launcher.prepareMinecraft(game.id);
    const directory = join(root, 'instances', game.id, 'game', 'crash-reports');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'crash-2026-11-21_12.00.00-client.txt'), header + 'Previous crash\n');
    await launcher.launch(game.id);
    await launcher.waitForGameWork();
    const [completed] = await Promise.all(reports.splice(0));
    expect(completed).toMatchObject({
      state: 'failed',
      exitCode: 0,
      issue: { kind: 'mods', action: 'mods' },
      truncated: true,
    });
    expect(completed?.output).toContain('Ordinary process output');
    expect(completed?.crashReport?.truncated).toBe(true);
    expect(completed?.crashReport?.text).toContain('Incompatible mods found!');
    expect(completed?.crashReport?.text).not.toContain('Previous crash');
    expect(completed?.crashReport?.text).not.toContain('End of report');
    const persisted = await readFile(join(root, 'instances', game.id, 'last-launch.json'), 'utf8');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('fixture-private-bearer');
    expect(await launcher.readLaunchReport(game.id)).toEqual(completed);
    const copy = await launcher.launchDiagnosticText(game.id);
    expect(copy).toContain('Minecraft crash report (excerpt)');
    expect(copy).toContain('Incompatible mods found!');
    expect(copy).toContain('Ordinary process output');
    expect(copy).not.toContain(root);
    expect(copy).not.toContain('Private game');
    expect(copy?.length).toBeLessThanOrEqual(65_536);

    crashing = false;
    await launcher.launch(game.id);
    await launcher.waitForGameWork();
    expect(await launcher.readLaunchReport(game.id)).toEqual({
      state: 'exited',
      exitCode: 0,
      signal: null,
      truncated: false,
      output: 'Game closed normally.\n',
    });
  } finally {
    await launcher.waitForGameWork();
    unsubscribe();
    prepare.mockRestore();
    start.mockRestore();
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'does not attach linked crash files or an explicitly stopped attempt',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rezics-linked-crash-'));
    try {
      const diagnostics = createLaunchDiagnostics((id) => join(root, id));
      const external = join(root, 'external.txt');
      await writeFile(external, '---- Minecraft Crash Report ----\nOutside the instance\n');
      const game = join(root, 'game');
      const folder = join(game, 'crash-reports');
      await mkdir(folder, { recursive: true });
      const recording = diagnostics.begin('links', true);
      await recording.prepareMinecraftCrashReports(game);
      await symlink(external, join(folder, 'crash-2026-11-22_00.00.00-client.txt'));
      await link(external, join(folder, 'crash-2026-11-22_00.00.01-client.txt'));
      await writeFile(join(folder, 'crash-2026-11-22_00.00.02-client.txt'), 'Unexpected file contents\n');
      const child = spawn(process.execPath, ['-e', 'process.exitCode = 6;'], { stdio: ['ignore', 'pipe', 'pipe'] });
      await recording.watch(child);
      expect(await diagnostics.read('links')).toEqual({
        state: 'failed',
        exitCode: 6,
        signal: null,
        truncated: false,
        output: '',
      });

      const stopped = diagnostics.begin('stopped', true);
      await stopped.prepareMinecraftCrashReports(game);
      await writeFile(
        join(folder, 'crash-2026-11-22_00.00.03-client.txt'),
        '---- Minecraft Crash Report ----\nNew report\n',
      );
      const terminated = spawn(process.execPath, ['-e', 'process.exitCode = 7;'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const done = stopped.watch(terminated);
      stopped.stopped();
      await done;
      expect(await diagnostics.read('stopped')).toEqual({
        state: 'exited',
        exitCode: 7,
        signal: null,
        truncated: false,
        output: '',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

test('normalizes private Java exceptions and authorization failures at the Minecraft adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rezics-minecraft-launch-'));
  try {
    const id = 'fixture-version';
    const time = '2024-08-08T00:00:00Z';
    const resources = join(root, 'minecraft-resources');
    const asset = 'fixture asset';
    const hash = createHash('sha1').update(asset).digest('hex');
    const index = JSON.stringify({ objects: { 'fixtures/asset': { hash, size: Buffer.byteLength(asset) } } });
    const sha1 = createHash('sha1').update(index).digest('hex');
    const assetsDirectory = join(resources, 'assets', 'objects', hash.slice(0, 2));
    const assetPath = join(assetsDirectory, hash);
    const indexDirectory = join(resources, 'assets', 'indexes');
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(join(indexDirectory, `${sha1}.json`), index);
    await writeJson(join(resources, 'versions', id, `${id}.json`), {
      id,
      type: 'release',
      time,
      releaseTime: time,
      mainClass: 'fixture.Game',
      minimumLauncherVersion: 21,
      arguments: { game: [], jvm: [] },
      assets: 'fixture-assets',
      assetIndex: { id: 'fixture-assets', sha1 },
      libraries: [],
      downloads: {},
      javaVersion: { component: 'fixture-java', majorVersion: 21 },
    });
    await writeFile(join(resources, 'versions', id, `${id}.jar`), 'local client fixture');
    const auth = new MinecraftAuth(undefined, join(root, 'account.json'));
    const versions = new MinecraftVersions(fetch);
    const executable = join(root, 'private-Java-folder', 'java');
    const customJava = { loader: 'vanilla', settings: { java: { kind: 'custom', executable } } } as const;
    const game = join(root, 'game');
    const brokenJava = new Minecraft(root, auth, versions, async () => {
      throw new Error(`Raw permission failure ${executable}`);
    });
    const javaError = await brokenJava.start(game, { versionId: id }, customJava).catch((error: unknown) => error);
    expect(javaError).toMatchObject({
      issue: { kind: 'java', action: 'settings', summary: expect.stringContaining('Java 21') },
    });
    expect(JSON.stringify(javaError)).not.toContain(executable);
    const managedError = await brokenJava
      .start(game, { versionId: id, javaRuntime: 'fixture-java' }, { loader: 'vanilla' })
      .catch((error: unknown) => error);
    expect(managedError).toMatchObject({ issue: { kind: 'installation', action: 'repair' } });

    const availableJava = new Minecraft(root, auth, versions, async () => ({
      executable,
      major: 21,
      architecture: 'x64',
    }));
    const assetIssue = {
      kind: 'installation',
      action: 'repair',
      summary: 'One or more Minecraft assets are missing or damaged. Verify and repair the instance.',
    };
    await expect(availableJava.start(game, { versionId: id }, customJava)).rejects.toMatchObject({ issue: assetIssue });
    await mkdir(assetsDirectory, { recursive: true });
    await writeFile(assetPath, asset.slice(1));
    await expect(availableJava.start(game, { versionId: id }, customJava)).rejects.toMatchObject({ issue: assetIssue });
    await writeFile(assetPath, asset);
    const authError = await availableJava.start(game, { versionId: id }, customJava).catch((error: unknown) => error);
    expect(authError).toMatchObject({ issue: { kind: 'account', action: 'account' } });
    expect(JSON.stringify(authError)).not.toContain(executable);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
