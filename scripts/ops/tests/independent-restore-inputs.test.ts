import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { artifactNames, RecoveryRefusal } from '../recovery-set.ts';
import { isOwnerTransientFailure } from '../../../services/main/src/infrastructure/owner-failure.ts';
import {
  assertCurrentRelayTransfer,
  assertIndependentRestoreTransfer,
  createIndependentRestoreChildEnvironment,
  currentRelayTransferForDump,
  importCurrentRelay,
  preserveRestoreCleanup,
  findRecoveryRefusal,
  recordIndependentRestoreChildFailure,
  readIndependentRestoreChildFailure,
  resolveIndependentRestoreInputs,
  serializeIndependentRestoreTransfer,
  type IndependentRestoreTransfer,
} from '../../../tests/qa/fault-recovery/independent-restore-support.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const opsTemp = join(repositoryRoot, '.temp', 'ops');

mkdirSync(opsTemp, { recursive: true, mode: 0o700 });

test('restore verification stays primary when worker shutdown also fails', async () => {
  const transport = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
  const primary = new Error('verification failed', { cause: transport });
  const shutdown = new Error('Production worker shutdown exceeded 15 seconds');
  let failure: unknown;
  try {
    await preserveRestoreCleanup(async () => { throw primary; }, () => { throw shutdown; });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).cause).toBe(primary);
  expect((failure as AggregateError).errors).toEqual([primary, shutdown]);
  expect(isOwnerTransientFailure(failure)).toBe(true);
  await expect(preserveRestoreCleanup(async () => {}, () => { throw shutdown; })).rejects.toBe(shutdown);
  await expect(preserveRestoreCleanup(async () => { throw primary; }, () => {})).rejects.toBe(primary);
});

test('missing-custody refusal is found through wrappers and cleanup without treating plain messages as refusals', () => {
  const refusal = new RecoveryRefusal('owner-reconciliation-refused', 'custody unavailable');
  const wrapped = new Error('Full restore finish failed', { cause: refusal });
  expect(findRecoveryRefusal(new AggregateError([wrapped, new Error('shutdown')], 'cleanup', { cause: wrapped }))).toBe(refusal);
  expect(findRecoveryRefusal(new Error('owner-reconciliation-refused'))).toBeUndefined();
  const cycle = new Error('cycle');
  cycle.cause = cycle;
  expect(findRecoveryRefusal(cycle)).toBeUndefined();
});

test.each(['ECONNRESET', 'ECONNREFUSED'])('restore child transfers %s through a structured failure cause chain', async code => {
  const directory = mkdtempSync(join(opsTemp, 'restore-failure-'));
  try {
    const failureFile = join(directory, 'failure.json');
    const childScript = join(directory, 'failure-child.ts');
    const support = resolve(repositoryRoot, 'tests/qa/fault-recovery/independent-restore-support.ts');
    writeFileSync(childScript, `import { recordIndependentRestoreChildFailure } from ${JSON.stringify(support)};\nawait recordIndependentRestoreChildFailure(process.argv[2]!, async () => { throw new Error('restore verification failed', { cause: Object.assign(new Error('transport failed'), { code: process.argv[3] }) }); });\n`);
    expect(() => execFileSync('bun', [childScript, failureFile, code], { timeout: 30_000, stdio: 'pipe' })).toThrow();
    const record = JSON.parse(readFileSync(failureFile, 'utf8'));
    expect(record).toMatchObject({ name: 'Error', message: 'restore verification failed',
      cause: { name: 'Error', message: 'transport failed', code } });
    const rebuilt = readIndependentRestoreChildFailure(failureFile);
    expect(isOwnerTransientFailure(new Error('child failed', { cause: rebuilt }))).toBe(true);
    expect(rebuilt.cause).toMatchObject({ code });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('child records input and cleanup failures and retains deterministic failures', async () => {
  const directory = mkdtempSync(join(opsTemp, 'restore-failure-'));
  try {
    const failureFile = join(directory, 'failure.json');
    const primary = new RecoveryRefusal('owner-reconciliation-refused', 'custody missing');
    await expect(recordIndependentRestoreChildFailure(failureFile, () =>
      preserveRestoreCleanup(async () => { throw primary; }, () => { throw new Error('cleanup failed'); }),
    )).rejects.toBeInstanceOf(AggregateError);
    const failure = readIndependentRestoreChildFailure(failureFile) as AggregateError;
    expect(failure.cause).toMatchObject({ name: 'RecoveryRefusal', code: primary.code });
    expect(findRecoveryRefusal(failure)).toBeInstanceOf(RecoveryRefusal);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBeInstanceOf(RecoveryRefusal);
    expect(isOwnerTransientFailure(failure)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function preparedInputs() {
  const directory = mkdtempSync(join(opsTemp, 'independent-inputs-'));
  const recoverySet = join(directory, 'set');
  const keyCustody = join(directory, 'recipient-key-custody');
  mkdirSync(recoverySet, { mode: 0o700 });
  mkdirSync(keyCustody, { mode: 0o700 });
  writeFileSync(join(keyCustody, 'private-key-custody'), 'opaque transferred key material', { mode: 0o600 });
  for (const name of [...artifactNames, 'set.json']) writeFileSync(join(recoverySet, name), 'artifact');
  writeFileSync(join(directory, 'frontier.json'), 'frontier');
  writeFileSync(join(directory, 'current-authority.json'), 'signed current capture');
  mkdirSync(join(directory, 'native-access-custody'), { mode: 0o700 });
  writeFileSync(join(directory, 'native-access-custody', 'attachment.gpg'), 'encrypted native additions', {
    mode: 0o600,
  });
  writeFileSync(join(directory, 'relay.dump'), 'dump');
  writeFileSync(join(directory, 'recovery-hmac.key'), 'hmac', { mode: 0o600 });
  writeFileSync(join(directory, 'native-signing.key'), 'signing', { mode: 0o600 });
  writeFileSync(
    join(directory, 'expectations.json'),
    JSON.stringify({
      format: 'rezics-independent-restore-expectations-v1',
      samples: [{ name: 'exactContent', id: 'revision-1' }],
      values: [{ name: 'title', value: 'Retained sample' }],
      originalReceiptTuples: [['receipt-1', 'content-published', 'digest-1']],
    }),
  );
  const relativeRoot = directory.slice(repositoryRoot.length + 1).split(/[/\\]/).join('/');
  const transfer: IndependentRestoreTransfer = {
    format: 'rezics-independent-restore-inputs-v1',
    root: relativeRoot,
    inputs: {
      recoverySet: 'set',
      currentFrontier: 'frontier.json',
      currentAuthorityCoverage: 'current-authority.json',
      nativeAccessAttachment: 'native-access-custody/attachment.gpg',
      currentRelayDump: 'relay.dump',
      recipientPrivateKeyCustody: 'recipient-key-custody',
      recoveryHmacKey: 'recovery-hmac.key',
      retainedNativeSigningMaterial: 'native-signing.key',
    },
    expectations: 'expectations.json',
  };
  return { directory, transfer };
}

test('independent restore transfer fails closed when a required retained input is missing', () => {
  const fixture = preparedInputs();
  try {
    expect(() => resolveIndependentRestoreInputs(fixture.transfer)).not.toThrow();
    const requiredFiles = [
      join(fixture.directory, 'frontier.json'),
      join(fixture.directory, 'current-authority.json'),
      join(fixture.directory, 'native-access-custody', 'attachment.gpg'),
      join(fixture.directory, 'relay.dump'),
      join(fixture.directory, 'recipient-key-custody', 'private-key-custody'),
      join(fixture.directory, 'recovery-hmac.key'),
      join(fixture.directory, 'native-signing.key'),
      join(fixture.directory, 'expectations.json'),
      join(fixture.directory, 'set', 'postgres.tar.gpg'),
    ];
    for (const file of requiredFiles) {
      const content = readFileSync(file);
      unlinkSync(file);
      expect(() => resolveIndependentRestoreInputs(fixture.transfer)).toThrow();
      writeFileSync(file, content, { mode: 0o600 });
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('current authority and native Access custody round-trip separately from the immutable base', () => {
  const fixture = preparedInputs();
  try {
    const baseBytes = new Map(
      [...artifactNames, 'set.json'].map((name) => [
        name,
        readFileSync(join(fixture.directory, 'set', name)),
      ]),
    );
    const transfer = assertIndependentRestoreTransfer(
      JSON.parse(serializeIndependentRestoreTransfer(fixture.transfer)) as unknown,
    );
    const resolved = resolveIndependentRestoreInputs(transfer);
    expect(resolved.currentAuthorityCoverage).toBe(join(fixture.directory, 'current-authority.json'));
    expect(resolved.nativeAccessAttachment).toBe(
      join(fixture.directory, 'native-access-custody', 'attachment.gpg'),
    );
    expect(readFileSync(resolved.currentAuthorityCoverage, 'utf8')).toBe('signed current capture');
    expect(readFileSync(resolved.nativeAccessAttachment, 'utf8')).toBe('encrypted native additions');
    for (const [name, bytes] of baseBytes) {
      expect(readFileSync(join(resolved.recoverySet, name))).toEqual(bytes);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('current transfer inputs are required, strictly allowlisted data paths', () => {
  const fixture = preparedInputs();
  try {
    for (const name of ['currentAuthorityCoverage', 'nativeAccessAttachment'] as const) {
      const inputs: Record<string, unknown> = { ...fixture.transfer.inputs };
      delete inputs[name];
      expect(() => assertIndependentRestoreTransfer({ ...fixture.transfer, inputs })).toThrow(
        'not allowlisted',
      );
      for (const path of [
        null,
        {},
        () => 'source',
        '',
        '/source/current',
        'C:\\source\\current',
        '../current',
        'custody/../../current',
        './current',
        'custody//current',
        'custody\\current',
        'current\0',
        ' current',
      ]) {
        expect(() =>
          serializeIndependentRestoreTransfer({
            ...fixture.transfer,
            inputs: { ...fixture.transfer.inputs, [name]: path },
          }),
        ).toThrow('relative path');
      }
    }
    for (const name of [
      'sourcePool',
      'sourceEnvironment',
      'sourceKeyring',
      'decryptAttachment',
      'authorityOverride',
    ]) {
      expect(() =>
        serializeIndependentRestoreTransfer({
          ...fixture.transfer,
          inputs: { ...fixture.transfer.inputs, [name]: '/source/custody' },
        }),
      ).toThrow('not allowlisted');
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('current capture and attachment refuse empty, non-file, linked or escaped custody', () => {
  const fixture = preparedInputs();
  const outside = mkdtempSync(join(opsTemp, 'outside-inputs-'));
  try {
    const outsideFile = join(outside, 'current');
    writeFileSync(outsideFile, 'outside custody');
    mkdirSync(join(fixture.directory, 'not-a-file'));
    symlinkSync(outsideFile, join(fixture.directory, 'file-link'));
    symlinkSync(outside, join(fixture.directory, 'directory-link'));
    symlinkSync(
      join(fixture.directory, 'current-authority.json'),
      join(fixture.directory, 'internal-link'),
    );
    writeFileSync(join(fixture.directory, 'empty'), '');
    for (const name of ['currentAuthorityCoverage', 'nativeAccessAttachment'] as const) {
      for (const [path, error] of [
        ['empty', 'is empty'],
        ['not-a-file', 'regular file'],
        ['file-link', 'symbolic link'],
        ['internal-link', 'symbolic link'],
        ['directory-link/current', 'outside the recovery root'],
        ['set/postgres.tar.gpg', 'outside the recovery set'],
      ]) {
        expect(() =>
          resolveIndependentRestoreInputs({
            ...fixture.transfer,
            inputs: { ...fixture.transfer.inputs, [name]: path },
          }),
        ).toThrow(error);
      }
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('independent restore transfer rejects source paths and source environment while child env stays allowlisted', () => {
  const fixture = preparedInputs();
  try {
    expect(() =>
      serializeIndependentRestoreTransfer({
        ...fixture.transfer,
        inputs: { ...fixture.transfer.inputs, currentFrontier: '/source/config/frontier.json' },
      }),
    ).toThrow('relative path');
    expect(() =>
      serializeIndependentRestoreTransfer({
        ...fixture.transfer,
        sourceEnvironment: { DATABASE_URL: 'postgresql://source.invalid/source' },
      }),
    ).toThrow('not allowlisted');
    const roundTripped = assertIndependentRestoreTransfer(
      JSON.parse(serializeIndependentRestoreTransfer(fixture.transfer)) as unknown,
    );
    const resolved = resolveIndependentRestoreInputs(roundTripped);
    const child = createIndependentRestoreChildEnvironment(
      {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: '/source/home',
        GNUPGHOME: '/source/keyring',
        DATABASE_URL: 'postgresql://source.invalid/source',
        POSTGRES_PASSWORD: 'source-password',
        REZICS_CONFIG_PATH: '/source/configuration.json',
        NODE_OPTIONS: '--require=/source/bootstrap.js',
      },
      resolved,
    );
    expect(child.PATH).toBe('/usr/bin:/bin');
    expect(child.HOME).toBe(join(resolved.root, 'child-home'));
    expect(child.GNUPGHOME).toBe(resolved.recipientPrivateKeyCustody);
    expect(child.DATABASE_URL).toBeUndefined();
    expect(child.POSTGRES_PASSWORD).toBeUndefined();
    expect(child.REZICS_CONFIG_PATH).toBeUndefined();
    expect(child.NODE_OPTIONS).toBeUndefined();
    expect(Object.values(child)).not.toContain('/source/home');
    expect(Object.values(child)).not.toContain('/source/keyring');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('copied relay dump imports with a fresh identity after transfer serialization and source shutdown', async () => {
  const directory = mkdtempSync(join(opsTemp, 'independent-relay-'));
  let sourceCluster: Awaited<ReturnType<typeof startPostgresCluster>> | undefined;
  let sourcePool: Pool | undefined;
  let retained: Awaited<ReturnType<typeof importCurrentRelay>> | undefined;
  try {
    sourceCluster = await startPostgresCluster({ role: 'postgres' });
    const sourcePort = sourceCluster.port;
    const sourceClusterDirectory = sourceCluster.directory;
    const sourceUrl = `postgresql://postgres@127.0.0.1:${sourcePort}/postgres`;
    sourcePool = new Pool({ connectionString: sourceUrl, max: 1 });
    await sourcePool.query('CREATE SCHEMA relay');
    await sourcePool.query(`CREATE TABLE relay.checkpoint (
      consumer text PRIMARY KEY CHECK (length(consumer) BETWEEN 1 AND 128),
      data_epoch text NOT NULL CHECK (data_epoch <> ''),
      sequence numeric NOT NULL DEFAULT 0 CHECK (sequence >= 0 AND sequence = trunc(sequence)),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      stream_scope text NOT NULL DEFAULT 'urn:rezics:stream:main-rdf' CHECK (stream_scope <> '')
    )`);
    await sourcePool.query(
      "INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ('retained', 'latest relay copy', 42)",
    );
    await sourcePool.end();
    sourcePool = undefined;

    const dump = join(directory, 'relay.dump');
    execFileSync('pg_dump', ['-Fc', '-f', dump, `--dbname=${sourceUrl}`], {
      timeout: 60_000,
      stdio: 'pipe',
    });
    const serialized = JSON.stringify(currentRelayTransferForDump(dump));
    const transfer = assertCurrentRelayTransfer(JSON.parse(serialized) as unknown);

    sourceCluster.remove();
    sourceCluster = undefined;
    retained = await importCurrentRelay(transfer);
    expect(retained.identity).toEqual({
      host: '127.0.0.1',
      port: expect.any(Number),
      user: 'postgres',
      database: 'relay',
      clusterDirectory: expect.any(String),
    });
    expect(retained.identity.clusterDirectory).not.toBe(sourceClusterDirectory);
    await expect(
      retained.relayPool.query("SELECT data_epoch FROM relay.checkpoint WHERE consumer = 'retained'"),
    ).resolves.toMatchObject({ rows: [{ data_epoch: 'latest relay copy' }] });
  } finally {
    await sourcePool?.end();
    await retained?.close();
    sourceCluster?.remove();
    rmSync(directory, { recursive: true, force: true });
  }
});
