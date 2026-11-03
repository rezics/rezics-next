import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import {
  preparedInputEvidenceProgram,
  REMOTE_CHECK_PRODUCER_CONTROL_FILES,
  REMOTE_CHECK_PRODUCER_CONTROL_DIRECTORIES,
  runScript,
  sourceInputVerificationProgram,
  validateCandidateUploadPaths,
  validateExpectedSourceManifest,
} from './remote-check.ts';

type SourceEntry = {
  path: string;
  mode: number;
  kind: 'file' | 'link';
  sha256: string;
  target: string | null;
};

type SourceManifest = {
  sourceSha256: string;
  head: string;
  indexTree: string;
  entries: SourceEntry[];
  deleted: string[];
};

type Fixture = {
  root: string;
  run: string;
  host: string;
  manifest: SourceManifest;
  controls: { alive: string; supervisor: string; slotCount: string };
};

const repository = resolve(import.meta.dir, '..');
const host = 'check-a';
const run = 'run-123';
const head = 'a'.repeat(40);
const indexTree = 'b'.repeat(40);
const uid = process.getuid?.() ?? 0;

function fileEntry(root: string, path: string, contents: string, mode = 0o644): SourceEntry {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  chmodSync(absolute, mode);
  return {
    path,
    mode,
    kind: 'file',
    sha256: createHash('sha256').update(contents).digest('hex'),
    target: null,
  };
}

function linkEntry(root: string, path: string, target: string): SourceEntry {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  symlinkSync(target, absolute);
  return {
    path,
    mode: lstatSync(absolute).mode & 0o7777,
    kind: 'link',
    sha256: createHash('sha256').update(target).digest('hex'),
    target,
  };
}

function sourceFingerprint(entries: SourceEntry[], deleted: string[], sourceHead: string, tree: string): string {
  const digest = createHash('sha256');
  const byUtf8 = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
  for (const entry of [...entries].sort((left, right) => byUtf8(left.path, right.path))) {
    digest.update(entry.path + '\0' + entry.mode + '\0');
    digest.update(entry.kind + '\0' + (entry.kind === 'link' ? entry.target : entry.sha256) + '\0');
  }
  for (const path of [...deleted].sort(byUtf8)) digest.update('deleted\0' + path + '\0');
  digest.update('HEAD\0' + sourceHead + '\0index\0' + tree + '\0');
  return digest.digest('hex');
}

function manifestFor(entries: SourceEntry[], deleted = ['obsolete/removed.ts'], tree = indexTree): SourceManifest {
  return {
    sourceSha256: sourceFingerprint(entries, deleted, head, tree),
    head,
    indexTree: tree,
    entries,
    deleted,
  };
}

function writeOwned(root: string, path: string, value: string): void {
  const absolute = join(root, path);
  writeFileSync(absolute, value);
  chmodSync(absolute, 0o644);
}

function writeSourceManifest(fixture: Fixture, manifest = fixture.manifest): void {
  const directory = join(fixture.root, '.temp', 'check-host');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'source-manifest-' + fixture.run + '.json');
  writeFileSync(path, JSON.stringify(manifest) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function createFixture(): Fixture {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repository, '.temp', 'remote-check-input-custody-'));
  const entries = [
    fileEntry(root, 'package.json', '{"name":"fixture","private":true}\n'),
    fileEntry(root, 'src/main.ts', 'export const value = 1;\n'),
    linkEntry(root, 'src/current.ts', 'main.ts'),
  ];
  const manifest = manifestFor(entries);
  const alive = join(root, '.alive');
  const supervisor = join(root, '.remote-check-supervisor');
  const slotCount = join(root, '.remote-check-slot-count');
  writeOwned(root, '.alive', '');
  writeOwned(root, '.remote-check-slot-count', '2\n');
  writeOwned(
    root,
    '.remote-check-supervisor',
    JSON.stringify({
      schema: 1,
      host,
      run,
      pid: process.pid,
      started: '123456789',
      group: process.pid,
      uid,
    }) + '\n',
  );
  const fixture = { root, run, host, manifest, controls: { alive, supervisor, slotCount } };
  writeSourceManifest(fixture);
  return fixture;
}

function visibleSourcePaths(root: string, prefix = ''): string[] {
  const skip = new Set([
    'build',
    'dist',
    'out',
    'coverage',
    '.next',
    '.turbo',
    'playwright-report',
    'test-results',
    'node_modules',
    '.git',
    '.temp',
  ]);
  const result: string[] = [];
  for (const name of readdirSync(join(root, prefix))) {
    if (prefix === '' && skip.has(name)) continue;
    const relative = prefix ? prefix + '/' + name : name;
    const absolute = join(root, relative);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) result.push(relative);
    else if (info.isDirectory()) result.push(...visibleSourcePaths(root, relative));
    else if (info.isFile()) result.push(relative);
  }
  return result.sort();
}

function runSource(fixture: Fixture, manifest = fixture.manifest, program = sourceInputVerificationProgram) {
  writeSourceManifest(fixture, manifest);
  return spawnSync('python3', ['-c', program, fixture.root, manifest.sourceSha256, fixture.run, fixture.host], {
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function generatedScript(fixture: Fixture): string {
  return runScript(
    fixture.run,
    fixture.root,
    '.',
    ['true'],
    fixture.host,
    { version: '1.2.3', revision: 'a'.repeat(40) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [{ cwd: '.', command: ['prepare-marker'] }],
    fixture.manifest.sourceSha256,
  );
}

function addPreparedControls(fixture: Fixture, cacheState: 'hit' | 'miss' = 'miss'): void {
  writeOwned(fixture.root, '.bun-install-complete', '');
  writeOwned(
    fixture.root,
    '.preparation-started',
    JSON.stringify({
      schema: 1,
      host: fixture.host,
      run: fixture.run,
      deadline: 123.456,
      limitMs: 60_000,
    }) + '\n',
  );
  writeOwned(
    fixture.root,
    'preparation-install.json',
    JSON.stringify({
      schema: 1,
      host: fixture.host,
      run: fixture.run,
      cache: cacheState,
      nativeCache: cacheState,
      key: 'c'.repeat(64),
      packages: [],
      nativeChecks: [],
    }) + '\n',
  );
  const cache = join(fixture.root, 'bun-runtime-transpiler-cache');
  mkdirSync(cache, { mode: 0o755 });
  writeFileSync(join(cache, 'runtime.bin'), 'producer cache state\n');
  chmodSync(join(cache, 'runtime.bin'), 0o644);
}

function runPrepared(fixture: Fixture, receiptRoot: string) {
  return spawnSync(
    'python3',
    [
      '-c',
      preparedInputEvidenceProgram,
      fixture.root,
      fixture.run,
      fixture.host,
      fixture.manifest.sourceSha256,
      receiptRoot,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
}

function receiptAt(root: string, fixture: Fixture) {
  return JSON.parse(readFileSync(join(root, fixture.run, 'prepared-inputs.json'), 'utf8')) as {
    manifestSha256: string;
    fileCount: number;
    totalBytes: number;
  };
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

test('the generated source verifier accepts producer controls after the frozen source set mismatch is demonstrated', () => {
  const fixture = createFixture();
  try {
    const frozenPaths = fixture.manifest.entries.map((entry) => entry.path).sort();
    const preRepairPaths = visibleSourcePaths(fixture.root);
    const producerPaths = ['.alive', '.remote-check-slot-count', '.remote-check-supervisor'].sort();
    expect(preRepairPaths).not.toEqual(frozenPaths);
    expect(preRepairPaths.filter((path) => !frozenPaths.includes(path))).toEqual(producerPaths);
    const preRepairProgram = sourceInputVerificationProgram
      .replace("validate_producer_controls(root,run,host,'source')\n", '')
      .replace(
        '        if relative_path in CONTROL_ROOT_DIRECTORIES:\n            dirs.remove(name)\n            continue\n',
        '',
      )
      .replace('        if rel in CONTROL_ROOT_FILES: continue\n', '');
    expect(preRepairProgram).not.toBe(sourceInputVerificationProgram);
    const preRepair = runSource(fixture, fixture.manifest, preRepairProgram);
    expect(preRepair.status).not.toBe(0);
    expect(preRepair.stderr).toContain('uploaded source file set does not match the frozen candidate');

    const verified = runSource(fixture);
    expect(verified.status, verified.stderr).toBe(0);

    const script = generatedScript(fixture);
    const sourceCheck = script.indexOf('frozen source upload verification failed');
    const install = script.indexOf('\"$bun\" install --frozen-lockfile');
    const preparation = script.indexOf('prepare-marker');
    const preparedEvidence = script.indexOf('prepared input evidence unavailable');
    const commandStart = script.indexOf('command_started=$(date +%s%N)');
    expect(sourceCheck).toBeGreaterThan(-1);
    expect(sourceCheck).toBeLessThan(install);
    expect(install).toBeLessThan(preparation);
    expect(preparation).toBeLessThan(preparedEvidence);
    expect(preparedEvidence).toBeLessThan(commandStart);
  } finally {
    cleanup(fixture);
  }
});

test('the generated source verifier rejects frozen candidate content, mode, link, and path changes', () => {
  const content = createFixture();
  try {
    writeFileSync(join(content.root, 'src/main.ts'), 'export const value = 2;\n');
    const result = runSource(content);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source bytes mismatch: src/main.ts');
  } finally {
    cleanup(content);
  }

  const mode = createFixture();
  try {
    chmodSync(join(mode.root, 'src/main.ts'), 0o600);
    const result = runSource(mode);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source mode mismatch: src/main.ts');
  } finally {
    cleanup(mode);
  }

  const link = createFixture();
  try {
    rmSync(join(link.root, 'src/current.ts'));
    symlinkSync('missing.ts', join(link.root, 'src/current.ts'));
    const result = runSource(link);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source link mismatch: src/current.ts');
  } finally {
    cleanup(link);
  }

  const injection = createFixture();
  try {
    const injected: SourceManifest = {
      ...injection.manifest,
      entries: injection.manifest.entries.map((entry, index) =>
        index === 0 ? { ...entry, path: '../outside.json' } : entry,
      ),
    };
    expect(() => validateExpectedSourceManifest(injected, injected.sourceSha256)).toThrow(
      'expected source manifest contains an invalid or reserved entry',
    );
    const result = runSource(injection, injected);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source manifest contains an unsafe path');
  } finally {
    cleanup(injection);
  }

  const extraPath = createFixture();
  try {
    fileEntry(extraPath.root, 'src/injected.ts', 'export {}\n');
    const result = runSource(extraPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('uploaded source file set does not match the frozen candidate');
  } finally {
    cleanup(extraPath);
  }
});

test('the generated source verifier binds deleted paths, HEAD, and the frozen index tree into the source fingerprint', () => {
  const deleted = createFixture();
  try {
    const tampered: SourceManifest = { ...deleted.manifest, deleted: ['another/removed.ts'] };
    const result = runSource(deleted, tampered);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source manifest fingerprint does not match the frozen candidate');
  } finally {
    cleanup(deleted);
  }

  const index = createFixture();
  try {
    const tampered: SourceManifest = { ...index.manifest, indexTree: 'd'.repeat(40) };
    const result = runSource(index, tampered);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source manifest fingerprint does not match the frozen candidate');
  } finally {
    cleanup(index);
  }

  const headMismatch = createFixture();
  try {
    const tampered: SourceManifest = { ...headMismatch.manifest, head: 'e'.repeat(40) };
    const result = runSource(headMismatch, tampered);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source manifest fingerprint does not match the frozen candidate');
  } finally {
    cleanup(headMismatch);
  }
});

test('reserved producer control names fail before staging and cannot masquerade as candidate source', () => {
  const fixture = createFixture();
  try {
    const marker = lstatSync(fixture.controls.supervisor);
    const markerBytes = readFileSync(fixture.controls.supervisor);
    const collision = manifestFor(
      [
        ...fixture.manifest.entries,
        {
          path: '.remote-check-supervisor',
          mode: marker.mode & 0o7777,
          kind: 'file',
          sha256: createHash('sha256').update(markerBytes).digest('hex'),
          target: null,
        },
      ],
      fixture.manifest.deleted,
    );
    expect(() => validateExpectedSourceManifest(collision, collision.sourceSha256)).toThrow('reserved entry');
    const result = runSource(fixture, collision);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'source manifest collides with a reserved producer control: .remote-check-supervisor',
    );

    for (const control of REMOTE_CHECK_PRODUCER_CONTROL_FILES) {
      const candidate = manifestFor([{ ...fixture.manifest.entries[0]!, path: control }]);
      expect(() => validateExpectedSourceManifest(candidate, candidate.sourceSha256)).toThrow('reserved entry');
    }
    const reservedNames = [
      ...REMOTE_CHECK_PRODUCER_CONTROL_FILES,
      ...REMOTE_CHECK_PRODUCER_CONTROL_DIRECTORIES,
      'bun-runtime-transpiler-cache/nested/cache.bin',
      '.temp/check-host/source-manifest-run.json',
      '.temp/node-compile-cache/cache.bin',
    ];
    for (const path of reservedNames)
      expect(() => validateCandidateUploadPaths([path])).toThrow('candidate upload path is invalid or reserved');
    expect(() => validateExpectedSourceManifest(manifestFor([], ['.remote-check-supervisor']))).toThrow(
      'reserved deleted path',
    );
  } finally {
    cleanup(fixture);
  }
});

test('malformed and foreign supervisor control identities are rejected at source verification', () => {
  const malformed = createFixture();
  try {
    writeOwned(malformed.root, '.remote-check-supervisor', '{not-json\n');
    const result = runSource(malformed);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('producer control is malformed: .remote-check-supervisor');
  } finally {
    cleanup(malformed);
  }

  const foreign = createFixture();
  try {
    writeOwned(
      foreign.root,
      '.remote-check-supervisor',
      JSON.stringify({
        schema: 1,
        host: foreign.host,
        run: 'foreign-run',
        pid: process.pid,
        started: '123456789',
        group: process.pid,
        uid,
      }) + '\n',
    );
    const result = runSource(foreign);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('producer supervisor identity is foreign or malformed');
  } finally {
    cleanup(foreign);
  }
});

test('source verification rejects control file type and slot-value tampering', () => {
  const symlink = createFixture();
  try {
    rmSync(symlink.controls.alive);
    symlinkSync('missing-target', symlink.controls.alive);
    const result = runSource(symlink);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('producer control has an invalid file identity: .alive');
  } finally {
    cleanup(symlink);
  }

  const slot = createFixture();
  try {
    writeOwned(slot.root, '.remote-check-slot-count', '0x\n');
    const result = runSource(slot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('producer slot identity is malformed');
  } finally {
    cleanup(slot);
  }
});

test('prepared-input receipt rejects foreign or writable producer controls', () => {
  const foreign = createFixture();
  try {
    addPreparedControls(foreign);
    writeOwned(
      foreign.root,
      '.preparation-started',
      JSON.stringify({ schema: 1, host: 'other-host', run: foreign.run, deadline: 123.456, limitMs: 60_000 }) + '\n',
    );
    const result = runPrepared(foreign, join(foreign.root, '.temp', 'receipt-foreign'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('producer preparation identity is foreign or malformed');
  } finally {
    cleanup(foreign);
  }

  const writable = createFixture();
  try {
    addPreparedControls(writable);
    chmodSync(join(writable.root, 'preparation-install.json'), 0o666);
    const result = runPrepared(writable, join(writable.root, '.temp', 'receipt-writable'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('producer control has an invalid file identity: preparation-install.json');
  } finally {
    cleanup(writable);
  }
});

test('prepared input evidence ignores only validated controls and keeps generated input changes visible', () => {
  const fixture = createFixture();
  try {
    fileEntry(fixture.root, 'generated/prepared.json', '{\"version\":1}\n');
    addPreparedControls(fixture);
    mkdirSync(join(fixture.root, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(join(fixture.root, 'node_modules', 'fixture', 'package.json'), '{}\n');
    mkdirSync(join(fixture.root, '.temp', 'node-compile-cache'), { recursive: true });
    writeFileSync(join(fixture.root, '.temp', 'node-compile-cache', 'cache.bin'), 'temporary\n');

    const firstRoot = join(fixture.root, '.temp', 'receipt-a');
    const first = runPrepared(fixture, firstRoot);
    expect(first.status, first.stderr).toBe(0);
    const firstReceipt = receiptAt(firstRoot, fixture);

    const aliveTime = new Date(Date.now() + 1_000);
    utimesSync(fixture.controls.alive, aliveTime, aliveTime);
    writeOwned(fixture.root, '.remote-check-slot-count', '3\n');
    writeOwned(
      fixture.root,
      '.preparation-started',
      JSON.stringify({
        schema: 1,
        host: fixture.host,
        run: fixture.run,
        deadline: 456.789,
        limitMs: 60_000,
      }) + '\n',
    );
    writeOwned(
      fixture.root,
      'preparation-install.json',
      JSON.stringify({
        schema: 1,
        host: fixture.host,
        run: fixture.run,
        cache: 'hit',
        nativeCache: 'hit',
        key: 'c'.repeat(64),
        packages: [],
        nativeChecks: [],
      }) + '\n',
    );
    writeFileSync(join(fixture.root, 'bun-runtime-transpiler-cache', 'runtime.bin'), 'changed producer cache\n');
    const secondRoot = join(fixture.root, '.temp', 'receipt-b');
    const second = runPrepared(fixture, secondRoot);
    expect(second.status, second.stderr).toBe(0);
    const secondReceipt = receiptAt(secondRoot, fixture);
    expect(secondReceipt.manifestSha256).toBe(firstReceipt.manifestSha256);
    expect(secondReceipt.fileCount).toBe(firstReceipt.fileCount);
    expect(secondReceipt.totalBytes).toBe(firstReceipt.totalBytes);

    writeFileSync(join(fixture.root, 'generated/prepared.json'), '{\"version\":2}\n');
    const thirdRoot = join(fixture.root, '.temp', 'receipt-c');
    const third = runPrepared(fixture, thirdRoot);
    expect(third.status, third.stderr).toBe(0);
    expect(receiptAt(thirdRoot, fixture).manifestSha256).not.toBe(firstReceipt.manifestSha256);
  } finally {
    cleanup(fixture);
  }
});
