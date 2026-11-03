import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareArtifactRun, parseArtifactManifest } from './check-artifacts.ts';
import {
  KERNEL_CLIENT_OUTPUT as PROFILE,
  OUTPUT_TREE_HEADER_BYTES,
  OUTPUT_TREE_MEMBER_RECORD_BYTES,
  OUTPUT_TREE_TRANSPORT_BYTES,
  collectOutputTree,
  encodeOutputTree,
  outputTreeDigest,
  outputTreeMemberPath,
  outputTreeProfile,
  readOutputTreeFile,
  receiveOutputTrees,
  restoreOutputTree,
  validateOutputTree,
  type OutputTreeAuthority,
  type OutputTreeHeader,
  type OutputTreeMember,
} from './check-output-tree.ts';

const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync('/dev/shm/rezics-output-tree-');
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function isolatedArtifactEnvironment(work: () => Promise<void>): Promise<void> {
  const names = ['REZICS_CHECK_ARTIFACTS_DIR', 'REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID'] as const;
  const prior = names.map((name) => process.env[name]);
  for (const name of names) delete process.env[name];
  try {
    await work();
  } finally {
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      if (prior[index] === undefined) delete process.env[name];
      else process.env[name] = prior[index];
    }
  }
}
const source = { host: 'c', run: 'official-physical-1', sourceSha256: 'a'.repeat(64) };
function put(root: string, path: string, value: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function generated(root: string, count = 282): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  mkdirSync(join(root, PROFILE.root), { recursive: true });
  for (let index = 0; index < count; index++) {
    const name = `module${String(index).padStart(3, '0')}/nested/query.sql.d.ts`;
    const bytes = Buffer.from(`export declare const query${index}: { readonly value: ${index} };\n`);
    files.set(name, bytes);
    put(root, `${PROFILE.root}/${name}`, bytes);
  }
  return files;
}
function authority(bytes: Buffer): OutputTreeAuthority {
  return { ...source, exitCode: 0, bundleSha256: outputTreeDigest(bytes) };
}
function fixture() {
  const producer = workspace();
  const consumer = workspace();
  const expected = generated(producer);
  put(consumer, `${PROFILE.root}/obsolete.d.ts`, 'old');
  put(consumer, 'packages/client/src/unrelated.ts', 'untouched');
  const bytes = encodeOutputTree(producer, source);
  return { producer, consumer, expected, bytes, proof: authority(bytes) };
}
function assertOld(root: string): void {
  expect(readFileSync(join(root, PROFILE.root, 'obsolete.d.ts'), 'utf8')).toBe('old');
  expect(readdirSync(join(root, PROFILE.root))).toEqual(['obsolete.d.ts']);
  expect(readFileSync(join(root, 'packages/client/src/unrelated.ts'), 'utf8')).toBe('untouched');
}
// Deliberately make well-digested hostile catalogues; transport authenticity alone is insufficient.
function bundle(members: OutputTreeMember[], contents: Buffer[], patch: Partial<OutputTreeHeader> = {}): Buffer {
  const catalogue = Buffer.from(members.map((member) => `${JSON.stringify(member)}\n`).join(''));
  const header: OutputTreeHeader = {
    version: 1,
    profile: PROFILE.profile,
    root: PROFILE.root,
    ...source,
    status: 'complete',
    count: members.length,
    totalBytes: contents.reduce((sum, bytes) => sum + bytes.length, 0),
    catalogueSha256: outputTreeDigest(catalogue),
    ...patch,
  };
  return Buffer.concat([
    Buffer.from('REZICS-OUTPUT-TREE/1\n'),
    Buffer.from(`${JSON.stringify(header)}\n`),
    catalogue,
    ...contents,
  ]);
}
const member = (path: string, bytes = Buffer.from('x')): OutputTreeMember => ({
  path,
  size: bytes.length,
  sha256: outputTreeDigest(bytes),
});

test('official-sized 282-member tree returns exact nested bytes and hashes, deletes obsolete output, preserves siblings and repeats one terminal receipt', () => {
  const { producer, consumer, bytes, proof, expected } = fixture();
  expect(encodeOutputTree(producer, source)).toEqual(bytes);
  const members = restoreOutputTree(consumer, bytes, proof);
  expect(members).toHaveLength(282);
  expect(existsSync(join(consumer, PROFILE.root, 'obsolete.d.ts'))).toBe(false);
  for (const item of members) {
    const content = readFileSync(join(consumer, PROFILE.root, item.path));
    expect(content).toEqual(expected.get(item.path)!);
    expect(outputTreeDigest(content)).toBe(item.sha256);
  }
  expect(readFileSync(join(consumer, 'packages/client/src/unrelated.ts'), 'utf8')).toBe('untouched');
  expect(restoreOutputTree(consumer, bytes, proof)).toEqual(members);
  expect(existsSync(join(consumer, 'packages/client/src/.kernel-output-tree/backup'))).toBe(false);
});

test('512 members fit the closed profile; 513 are refused without increasing ordinary limits', () => {
  const producer = workspace();
  generated(producer, 512);
  const bytes = encodeOutputTree(producer, source);
  expect(validateOutputTree(bytes, authority(bytes)).members).toHaveLength(512);
  put(producer, `${PROFILE.root}/overflow.d.ts`, 'overflow');
  expect(() => encodeOutputTree(producer, source)).toThrow('member count');
  const count = bundle([], [], { count: 513 });
  expect(() => validateOutputTree(count, authority(count))).toThrow('manifest count');
  expect(() => outputTreeProfile('arbitrary-directory')).toThrow('unknown output profile');
});

test('decoded per-member and aggregate limits are checked before reading or allocating content', () => {
  const producer = workspace();
  const path = `${PROFILE.root}/large.d.ts`;
  put(producer, path, '');
  truncateSync(join(producer, path), PROFILE.maxMemberBytes);
  expect(encodeOutputTree(producer, source).length).toBeGreaterThan(PROFILE.maxMemberBytes);
  truncateSync(join(producer, path), PROFILE.maxMemberBytes + 1);
  expect(() => encodeOutputTree(producer, source)).toThrow('per-member');
  rmSync(join(producer, path));
  for (let index = 0; index < 16; index++) {
    const name = `${PROFILE.root}/${index}.d.ts`;
    put(producer, name, '');
    truncateSync(join(producer, name), PROFILE.maxMemberBytes);
  }
  expect(encodeOutputTree(producer, source).length).toBeLessThanOrEqual(OUTPUT_TREE_TRANSPORT_BYTES);
  put(producer, `${PROFILE.root}/overflow.d.ts`, 'x');
  expect(() => encodeOutputTree(producer, source)).toThrow('aggregate');
  const oversized = bundle([{ ...member('x'), size: PROFILE.maxMemberBytes + 1 }], []);
  expect(() => validateOutputTree(oversized, authority(oversized))).toThrow('member size');
  const aggregate = bundle([], [], { totalBytes: PROFILE.maxBytes + 1 });
  expect(() => validateOutputTree(aggregate, authority(aggregate))).toThrow('decoded byte');
});

test('component, UTF-8 path, encoded header, record and whole transport bounds are finite', () => {
  expect(outputTreeMemberPath(Array.from({ length: 16 }, () => 'a').join('/'))).toBeDefined();
  expect(() => outputTreeMemberPath(Array.from({ length: 17 }, () => 'a').join('/'))).toThrow('depth');
  expect(outputTreeMemberPath('é'.repeat(512))).toBeDefined();
  expect(() => outputTreeMemberPath('é'.repeat(513))).toThrow('path');
  const producer = workspace();
  put(producer, 'oversize.bin', '');
  truncateSync(join(producer, 'oversize.bin'), OUTPUT_TREE_TRANSPORT_BYTES + 1);
  expect(() => readOutputTreeFile(producer, 'oversize.bin')).toThrow('encoded');
  for (const length of [OUTPUT_TREE_HEADER_BYTES + 1, OUTPUT_TREE_MEMBER_RECORD_BYTES + 1]) {
    const prefix =
      length === OUTPUT_TREE_HEADER_BYTES + 1 ? Buffer.from('REZICS-OUTPUT-TREE/1\n') : bundle([], [], { count: 1 });
    const bytes = Buffer.concat([prefix, Buffer.from(' '.repeat(length) + '\n')]);
    expect(() => validateOutputTree(bytes, authority(bytes))).toThrow('oversized manifest');
  }
});

test.each(['../escape', '/absolute', 'a/../b', 'a//b', 'a\\b', 'a\0b', 'a\nb', 'e\u0301.d.ts', 'a./b'])(
  'unsafe catalogue path %j never mutates the destination',
  (path) => {
    const { consumer } = fixture();
    const bytes = bundle([member(path)], [Buffer.from('x')]);
    expect(() => restoreOutputTree(consumer, bytes, authority(bytes))).toThrow();
    assertOld(consumer);
  },
);

test.each(
  [
    ['same', 'same'],
    ['A.d.ts', 'a.d.ts'],
    ['parent', 'parent/child'],
    ['z', 'a'],
  ].map((paths) => ({ paths })),
)('duplicate, case, ancestor and ordering collisions %j are rejected', ({ paths }) => {
  const { consumer } = fixture();
  const bytes = bundle(
    paths.map((path) => member(path)),
    paths.map(() => Buffer.from('x')),
  );
  expect(() => restoreOutputTree(consumer, bytes, authority(bytes))).toThrow();
  assertOld(consumer);
});

test('symlink ancestors, hard links, member links and unsafe staging cannot be captured or restored', () => {
  const { producer, consumer, bytes, proof } = fixture();
  const first = collectOutputTree(producer).members[0]!.path;
  const full = join(producer, PROFILE.root, first);
  linkSync(full, join(producer, 'hardlink'));
  expect(() => encodeOutputTree(producer, source)).toThrow('unsafe');
  rmSync(join(producer, 'hardlink'));
  symlinkSync(full, join(producer, PROFILE.root, 'link.d.ts'));
  expect(() => encodeOutputTree(producer, source)).toThrow('symlink');
  rmSync(join(consumer, 'packages/client/src'), { recursive: true });
  const outside = workspace();
  symlinkSync(outside, join(consumer, 'packages/client/src'));
  expect(() => restoreOutputTree(consumer, bytes, proof)).toThrow('symlink');
  expect(readdirSync(outside)).toEqual([]);
});

test('wrong physical run, source, profile, root, version, failed command and forged transport receipts cannot publish', () => {
  const { consumer, bytes, proof } = fixture();
  for (const altered of [
    { run: 'previous-run' },
    { sourceSha256: 'b'.repeat(64) },
    { exitCode: 23 },
    { bundleSha256: 'b'.repeat(64) },
  ]) {
    expect(() => restoreOutputTree(consumer, bytes, { ...proof, ...altered })).toThrow();
    assertOld(consumer);
  }
  for (const patch of [
    { version: 2 },
    { profile: 'unknown' },
    { root: 'packages/client/src' },
    { status: 'pending' },
  ]) {
    const changed = bundle([], [], patch as Partial<OutputTreeHeader>);
    expect(() => restoreOutputTree(consumer, changed, authority(changed))).toThrow();
    assertOld(consumer);
  }
});

test('last-member corruption, wrong hashes, truncation, trailing bytes and missing bundle validate wholly before mutation', () => {
  const { consumer, bytes, proof } = fixture();
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  const wrongHash = bundle([{ ...member('x'), sha256: 'f'.repeat(64) }], [Buffer.from('x')]);
  for (const changed of [corrupt, wrongHash, bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from('extra')])]) {
    expect(() => restoreOutputTree(consumer, changed, authority(changed))).toThrow();
    assertOld(consumer);
  }
  expect(() =>
    receiveOutputTrees(consumer, consumer, { status: 'complete', entries: [] }, proof, [PROFILE.transport]),
  ).toThrow('missing authenticated');
  assertOld(consumer);
});

test.each(['backed-up', 'published'] as const)(
  'rename interruption at %s recovers only the same authenticated result',
  (phase) => {
    const { consumer, bytes, proof } = fixture();
    expect(() =>
      restoreOutputTree(consumer, bytes, proof, (point) => {
        if (point === phase) throw new Error('interruption');
      }),
    ).toThrow('interruption');
    expect(() => restoreOutputTree(consumer, bytes, { ...proof, run: 'another-run' })).toThrow();
    expect(restoreOutputTree(consumer, bytes, proof)).toHaveLength(282);
    expect(existsSync(join(consumer, 'packages/client/src/.kernel-output-tree/backup'))).toBe(false);
    expect(readFileSync(join(consumer, 'packages/client/src/unrelated.ts'), 'utf8')).toBe('untouched');
  },
);

test('concurrent receiving is rejected while the original owner holds the exact tree lock', () => {
  const { consumer, bytes, proof } = fixture();
  let concurrentRejected = false;
  restoreOutputTree(consumer, bytes, proof, (phase) => {
    if (phase === 'backed-up') {
      expect(() => restoreOutputTree(consumer, bytes, proof)).toThrow('concurrent');
      concurrentRejected = true;
    }
  });
  expect(concurrentRejected).toBe(true);
});

test('a dead publication owner permits only exact-terminal recovery; replay never overwrites changed published bytes', () => {
  const { consumer, bytes, proof } = fixture();
  expect(() =>
    restoreOutputTree(consumer, bytes, proof, (phase) => {
      if (phase === 'backed-up') throw new Error('interrupted');
    }),
  ).toThrow('interrupted');
  const staging = 'packages/client/src/.kernel-output-tree';
  const journal = JSON.parse(readFileSync(join(consumer, staging, 'journal.json'), 'utf8'));
  put(
    consumer,
    `${staging}/lock/owner.json`,
    JSON.stringify({ ...journal, owner: { ...journal.owner, pid: Number.MAX_SAFE_INTEGER } }),
  );
  expect(() => restoreOutputTree(consumer, bytes, { ...proof, run: 'foreign-run' })).toThrow();
  const members = restoreOutputTree(consumer, bytes, proof);
  expect(members).toHaveLength(282);
  const changed = `${PROFILE.root}/${members[0]!.path}`;
  put(consumer, changed, 'later edit');
  expect(() => restoreOutputTree(consumer, bytes, proof)).toThrow('same-terminal destination changed');
  expect(readFileSync(join(consumer, changed), 'utf8')).toBe('later edit');
});

test('a successful authenticated zero-member tree deletes the old owned tree; missing or failed output cannot mean deletion', () => {
  const { consumer } = fixture();
  const producer = workspace();
  mkdirSync(join(producer, PROFILE.root), { recursive: true });
  const bytes = encodeOutputTree(producer, source);
  expect(() => restoreOutputTree(consumer, bytes, { ...authority(bytes), exitCode: 9 })).toThrow();
  assertOld(consumer);
  expect(restoreOutputTree(consumer, bytes, authority(bytes))).toEqual([]);
  expect(readdirSync(join(consumer, PROFILE.root))).toEqual([]);
});

test('official capture requires physical prepared custody, runs once, and never reuses stale, missing or failed output', () =>
  isolatedArtifactEnvironment(async () => {
    const { withKernelClientOutput } = await import('./check-output-tree.ts');
    const recognize = () => ({
      outcome: 'admitted' as const,
      runId: source.run,
      scope: 'fixture.scope',
      supervisor: { pid: 1, started: '1', group: 1 },
    });
    for (const mode of ['complete', 'empty', 'missing', 'failed', 'stale'] as const) {
      const root = workspace();
      generated(root, 1);
      put(root, PROFILE.transport, 'old successful bundle');
      let runs = 0;
      const work = () =>
        withKernelClientOutput(
          root,
          async () => {
            runs++;
            expect(existsSync(join(root, PROFILE.transport))).toBe(false);
            expect(existsSync(join(root, PROFILE.root))).toBe(false);
            if (mode === 'complete' || mode === 'failed') generated(root);
            if (mode === 'empty') mkdirSync(join(root, PROFILE.root), { recursive: true });
            return mode === 'failed' ? 23 : 0;
          },
          { recognize, prepared: () => ({ ...source, run: mode === 'stale' ? 'earlier-run' : source.run }) },
        );
      if (mode === 'missing' || mode === 'stale') await expect(work()).rejects.toThrow();
      else expect(await work()).toBe(mode === 'failed' ? 23 : 0);
      expect(runs).toBe(mode === 'stale' ? 0 : 1);
      if (mode === 'complete' || mode === 'empty') {
        const bytes = readOutputTreeFile(root, PROFILE.transport);
        expect(validateOutputTree(bytes, authority(bytes)).members).toHaveLength(mode === 'empty' ? 0 : 282);
      } else if (mode !== 'stale') expect(existsSync(join(root, PROFILE.transport))).toBe(false);
    }
    const root = workspace();
    await expect(
      withKernelClientOutput(
        root,
        async () => {
          throw new Error('must not run');
        },
        {
          recognize: () => ({ outcome: 'refused', reason: 'cwd-outside-runs' }),
        },
      ),
    ).rejects.toThrow('physical custody');
  }));

test.each([0, 23])('official capture stages mixed schema output with honest terminal status %i', (code) =>
  isolatedArtifactEnvironment(async () => {
    const { withKernelClientOutput } = await import('./check-output-tree.ts');
    const root = workspace();
    const physical = randomUUID();
    const stage = prepareArtifactRun(root, physical);
    process.env.REZICS_CHECK_ARTIFACTS_DIR = stage;
    process.env.REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID = physical;
    let runs = 0;
    const result = await withKernelClientOutput(
      root,
      async () => {
        runs++;
        generated(root);
        put(root, 'schema.sql', 'CREATE TABLE proof(id int);\n');
        return code;
      },
      {
        recognize: () => ({
          outcome: 'admitted',
          runId: source.run,
          scope: 'fixture.scope',
          supervisor: { pid: 1, started: '1', group: 1 },
        }),
        prepared: () => source,
        returns: [PROFILE.transport, 'schema.sql'],
      },
    );
    expect(result).toBe(code);
    expect(runs).toBe(1);
    const envelope = parseArtifactManifest(readFileSync(join(root, stage, 'manifest.json')), physical)!;
    expect(envelope.declarations).toEqual([PROFILE.transport, 'schema.sql']);
    expect(envelope.entries.find((entry) => entry.path === 'schema.sql')?.status).toBe('returned');
    expect(envelope.entries.find((entry) => entry.path === PROFILE.transport)?.status).toBe(
      code === 0 ? 'returned' : 'missing',
    );
    if (code === 0) {
      const bytes = readOutputTreeFile(root, PROFILE.transport);
      expect(validateOutputTree(bytes, authority(bytes)).members).toHaveLength(282);
    } else expect(existsSync(join(root, PROFILE.transport))).toBe(false);
  }),
);

test('a complete transport catalogue is required even when every bundle byte is valid', () => {
  const { producer, consumer, bytes } = fixture();
  put(producer, PROFILE.transport, bytes);
  const manifest = {
    status: 'complete',
    entries: [{ path: PROFILE.transport, size: bytes.length, sha256: outputTreeDigest(bytes), kind: 'file' as const }],
  };
  for (const status of ['missing', 'failed']) {
    expect(() =>
      receiveOutputTrees(producer, consumer, { ...manifest, status }, { ...source, exitCode: 0 }, [PROFILE.transport]),
    ).toThrow();
    assertOld(consumer);
  }
  expect(() =>
    receiveOutputTrees(producer, consumer, { status: 'complete', entries: [] }, { ...source, exitCode: 0 }, [
      PROFILE.transport,
    ]),
  ).toThrow('missing authenticated');
  assertOld(consumer);
});

test('all mixed transport bytes and finite inventory bounds validate before the owned tree changes', () => {
  const { producer, consumer, bytes } = fixture();
  put(producer, PROFILE.transport, bytes);
  put(producer, 'schema.sql', 'schema');
  const bundleEntry = {
    path: PROFILE.transport,
    size: bytes.length,
    sha256: outputTreeDigest(bytes),
    kind: 'file' as const,
  };
  const schemaEntry = {
    path: 'schema.sql',
    size: 6,
    sha256: outputTreeDigest(Buffer.from('schema')),
    kind: 'file' as const,
  };
  for (const entries of [
    [bundleEntry],
    [bundleEntry, { ...schemaEntry, path: 'unowned.sql' }],
    [bundleEntry, { ...schemaEntry, sha256: 'f'.repeat(64) }],
    [bundleEntry, { ...schemaEntry, size: 7 }],
    [bundleEntry, { ...schemaEntry, path: '../schema.sql' }],
    [bundleEntry, schemaEntry, schemaEntry],
    [bundleEntry, ...Array.from({ length: 64 }, (_, i) => ({ ...schemaEntry, path: `schema${i}.sql` }))],
    [bundleEntry, { ...schemaEntry, size: 256 * 1024 * 1024 }],
    [{ ...bundleEntry, size: OUTPUT_TREE_TRANSPORT_BYTES + 1 }],
  ]) {
    expect(() =>
      receiveOutputTrees(producer, consumer, { status: 'complete', entries }, { ...source, exitCode: 0 }, [
        PROFILE.transport,
        'schema.sql',
      ]),
    ).toThrow();
    assertOld(consumer);
  }
  const schema = join(producer, 'schema.sql');
  rmSync(schema);
  symlinkSync(join(producer, PROFILE.transport), schema);
  expect(() =>
    receiveOutputTrees(
      producer,
      consumer,
      { status: 'complete', entries: [bundleEntry, schemaEntry] },
      { ...source, exitCode: 0 },
      [PROFILE.transport, 'schema.sql'],
    ),
  ).toThrow('symlink');
  assertOld(consumer);
});

test('unowned backup or staging links never gain deletion authority from a new receipt', () => {
  for (const name of ['backup', 'candidate']) {
    const { consumer, bytes, proof } = fixture();
    const path = `packages/client/src/.kernel-output-tree/${name}/keep`;
    put(consumer, path, 'unowned');
    expect(() => restoreOutputTree(consumer, bytes, proof)).toThrow('unowned publication staging');
    expect(readFileSync(join(consumer, path), 'utf8')).toBe('unowned');
    assertOld(consumer);
  }
  const { consumer, bytes, proof } = fixture();
  const outside = workspace();
  symlinkSync(outside, join(consumer, 'packages/client/src/.kernel-output-tree'));
  expect(() => restoreOutputTree(consumer, bytes, proof)).toThrow('symlink');
  expect(readdirSync(outside)).toEqual([]);
  assertOld(consumer);
});
