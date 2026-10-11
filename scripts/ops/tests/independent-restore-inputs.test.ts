import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { artifactNames } from '../recovery-set.ts';
import {
  assertCurrentRelayTransfer,
  assertIndependentRestoreTransfer,
  createIndependentRestoreChildEnvironment,
  currentRelayTransferForDump,
  importCurrentRelay,
  resolveIndependentRestoreInputs,
  serializeIndependentRestoreTransfer,
  type IndependentRestoreTransfer,
} from '../../../tests/qa/fault-recovery/independent-restore-support.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const opsTemp = join(repositoryRoot, '.temp', 'ops');

mkdirSync(opsTemp, { recursive: true, mode: 0o700 });

function preparedInputs() {
  const directory = mkdtempSync(join(opsTemp, 'independent-inputs-'));
  const recoverySet = join(directory, 'set');
  const keyCustody = join(directory, 'recipient-key-custody');
  mkdirSync(recoverySet, { mode: 0o700 });
  mkdirSync(keyCustody, { mode: 0o700 });
  writeFileSync(join(keyCustody, 'private-key-custody'), 'opaque transferred key material', { mode: 0o600 });
  for (const name of [...artifactNames, 'set.json']) writeFileSync(join(recoverySet, name), 'artifact');
  writeFileSync(join(directory, 'frontier.json'), 'frontier');
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
    await sourcePool.query('CREATE TABLE relay.custody_marker (id text PRIMARY KEY, value text NOT NULL)');
    await sourcePool.query("INSERT INTO relay.custody_marker VALUES ('retained', 'latest relay copy')");
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
      retained.relayPool.query("SELECT value FROM relay.custody_marker WHERE id = 'retained'"),
    ).resolves.toMatchObject({ rows: [{ value: 'latest relay copy' }] });
  } finally {
    await sourcePool?.end();
    await retained?.close();
    sourceCluster?.remove();
    rmSync(directory, { recursive: true, force: true });
  }
});
