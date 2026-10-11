import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { captureErasureJournalCoreCoverage, scanErasureJournalCore } from
  '../../../services/main/src/modules/erasure/core-journal-coverage.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { assertNativeAccessErasureBaseBinding, assertRecoveryCoverage, type RecoveryCoverage } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { encryptRecoveryAttachment, fileDigest } from '../../../scripts/ops/recovery-set.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

test('OPS: native Access capture binds a paged relay journal and publishes only complete encrypted custody', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated fault/recovery QA tier');
  const root = resolve(import.meta.dir, '../../..');
  const suffix = randomBytes(6).toString('hex');
  const directory = join(root, '.temp', `native-access-custody-${suffix}`);
  const encryptHome = join(directory, 'gpg-encrypt');
  const decryptHome = join(directory, 'gpg-decrypt');
  const attachments = join(directory, 'attachments');
  mkdirSync(encryptHome, { recursive: true, mode: 0o700 });
  mkdirSync(decryptHome, { recursive: true, mode: 0o700 });
  mkdirSync(attachments, { recursive: true, mode: 0o700 });
  const databases = await cloneQaOwnerDatabases(runId, ['relay'], 'owner');
  const relay = new Pool({ connectionString: databases.urls.relay, max: 1, connectionTimeoutMillis: 2000 });
  const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const rowCoverage = (count: string, digest: string) => ({ count, digest });
  const recoveryKey = 'c7'.repeat(32);
  const consumer = `native-access-custody-${suffix}`;
  const dataEpoch = randomUUID();
  const stateDigestBase = sha('base Access state'), stateDigestCurrent = sha('current Access state');
  const outboxDigestBase = sha('base Access outbox'), outboxDigestCurrent = sha('current Access outbox');
  const baseState = rowCoverage('0', stateDigestBase), currentState = rowCoverage('1', stateDigestCurrent);
  const baseOutbox = rowCoverage('0', outboxDigestBase), currentOutbox = rowCoverage('1', outboxDigestCurrent);
  const relayCut = {
    streamScope: MAIN_RELAY_STREAM_SCOPE, consumer, dataEpoch, sequence: '0', batchCount: '0',
    batchDigest: sha('relay batches'), eventCount: '0', eventDigest: sha('relay events'),
  };
  const makeCoverage = (journal: Awaited<ReturnType<typeof captureErasureJournalCoreCoverage>>,
    generation: string, state: { count: string; digest: string },
    outbox: { count: string; digest: string }): RecoveryCoverage => ({
    priorDataEpoch: dataEpoch, priorSequence: '0',
    accountPg: { systemIdentifier: '1', flushedLsn: '0/0', walFile: '000000000000000000000001' },
    account: { rowCount: '0', rowDigest: sha('account rows') },
    accessStateCount: state.count, accessStateDigest: state.digest,
    accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest,
    accessFenceGeneration: generation, erasureJournal: journal, relay: relayCut,
    commerce: { version: 1 } as RecoveryCoverage['commerce'],
  });

  try {
    const gpg = (home: string, args: string[], encoding: 'utf8' | null = 'utf8') => spawnSync(
      'gpg', ['--homedir', home, '--batch', ...args], { encoding, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const generated = gpg(decryptHome, ['--pinentry-mode', 'loopback', '--passphrase', '',
      '--quick-generate-key', `Native Access custody ${suffix} <native-access-${suffix}@example.test>`,
      'rsa2048', 'encr', '1d']);
    if (generated.status !== 0) throw new Error('custody test could not create its isolated decryption key');
    const listed = gpg(decryptHome, ['--with-colons', '--list-secret-keys']);
    const fingerprint = listed.stdout.split('\n').find((line: string) => line.startsWith('fpr:'))?.split(':')[9];
    if (!fingerprint || !/^[0-9A-F]{40}(?:[0-9A-F]{24})?$/i.test(fingerprint)) {
      throw new Error('custody test could not read its isolated key fingerprint');
    }
    const publicKey = join(directory, 'recipient.asc');
    const exported = gpg(decryptHome, ['--armor', '--output', publicKey, '--export', fingerprint]);
    if (exported.status !== 0) throw new Error('custody test could not export its public key');
    const imported = gpg(encryptHome, ['--import', publicKey]);
    if (imported.status !== 0) throw new Error('custody test could not import its public key');
    const encryptionEnvironment = { ...process.env, GNUPGHOME: encryptHome };

    await initializeRelayCheckpoint(relay, consumer, dataEpoch);
    const baseJournal = await captureErasureJournalCoreCoverage(relay);
    const baseCoverage = makeCoverage(baseJournal, '0', baseState, baseOutbox);
    const baseEnvelope = JSON.stringify(sealRecoveryPayload(baseCoverage, recoveryKey, 'graph-recovery-coverage'));
    const priorEpoch = BigInt((await relay.query<{ epoch: string | null }>(
      'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]?.epoch ?? '0');
    const journalRows = Array.from({ length: 101 }, () => ({ erasureId: randomUUID(), admissionId: randomUUID(),
      principalId: randomUUID(), target: randomUUID(), requestDigest: sha(randomUUID()) }));
    await relay.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest, kind,
        authority, principal_id, admission_id, authority_epoch)
      SELECT row.erasure_id, row.epoch, 'erasure:' || row.admission_id::text, row.request_digest,
        'revision', 'access_admission', row.principal_id, row.admission_id, 0
      FROM unnest($1::uuid[], $2::bigint[], $3::uuid[], $4::uuid[], $5::text[])
        AS row(erasure_id, epoch, admission_id, principal_id, request_digest)`, [
      journalRows.map(row => row.erasureId),
      journalRows.map((_, index) => (priorEpoch + BigInt(index + 1)).toString()),
      journalRows.map(row => row.admissionId), journalRows.map(row => row.principalId),
      journalRows.map(row => row.requestDigest),
    ]);
    await relay.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
      SELECT row.erasure_id, 1, 'content', 'content_revision', row.target
      FROM unnest($1::uuid[], $2::uuid[]) AS row(erasure_id, target)`, [
      journalRows.map(row => row.erasureId), journalRows.map(row => row.target),
    ]);
    const sourceJournal = await captureErasureJournalCoreCoverage(relay);
    expect(BigInt(sourceJournal.count) - BigInt(baseJournal.count)).toBe(101n);
    expect(BigInt(sourceJournal.epoch!)).toBe(priorEpoch + 101n);
    const scanned = [];
    for await (const entry of scanErasureJournalCore(relay, sourceJournal.epoch)) scanned.push(entry);
    const added = scanned.filter(entry => BigInt(entry.epoch) > priorEpoch);
    expect(added).toHaveLength(101);
    expect(added[0]?.facts).toBeDefined();
    expect(added[100]?.epoch).toBe(sourceJournal.epoch);

    const plaintext = Buffer.from(`${scanned.map(entry => JSON.stringify(entry.facts)).join('\n')}\n`, 'utf8');
    const encrypted = await encryptRecoveryAttachment(fingerprint, attachments, async write => {
      for (let offset = 0; offset < plaintext.byteLength; offset += 1024) {
        await write(plaintext.subarray(offset, offset + 1024));
      }
      return sha(plaintext);
    }, encryptionEnvironment);
    expect(encrypted.value).toBe(sha(plaintext));
    expect(encrypted.ciphertextDigest).toBe(await fileDigest(encrypted.path));
    expect(encrypted.ciphertextBytes).not.toBe('0');
    const decrypted = gpg(decryptHome, ['--decrypt', encrypted.path], null);
    if (decrypted.status !== 0) throw new Error('custody test could not decrypt its attachment');
    expect(Buffer.from(decrypted.stdout)).toEqual(plaintext);

    const currentCoverage = makeCoverage(sourceJournal, '2', currentState, currentOutbox);
    currentCoverage.nativeAccessErasure = {
      profile: 'rezics-native-access-erasure-reference-v1', version: 1,
      baseCoverageDigest: sha(baseEnvelope), sourceDataEpoch: dataEpoch, consumer,
      baseErasureJournal: baseJournal, sourceErasureJournal: sourceJournal,
      summary: {
        profile: 'rezics-access-erasure-recovery-v1', version: 1,
        catalogDigest: sha('native Access catalog'), baseFenceGeneration: '0', sourceFenceGeneration: '2',
        baseState, sourceState: currentState, baseOutbox, sourceOutbox: currentOutbox,
        rowCount: '1', rowDigest: sha(plaintext), plaintextBytes: String(plaintext.byteLength),
        plaintextDigest: sha(plaintext),
      },
      ciphertextDigest: encrypted.ciphertextDigest, ciphertextBytes: encrypted.ciphertextBytes,
      recipientFingerprint: encrypted.recipientFingerprint,
    };
    assertRecoveryCoverage(currentCoverage);
    assertNativeAccessErasureBaseBinding(currentCoverage, baseCoverage, baseEnvelope);
    expect(() => assertNativeAccessErasureBaseBinding(currentCoverage, baseCoverage,
      `${baseEnvelope}\n`)).toThrow('not bound to signed C0');
    const sealedCurrent = JSON.stringify(sealRecoveryPayload(currentCoverage, recoveryKey, 'graph-recovery-coverage'));

    const incompleteCoverage = { ...currentCoverage, nativeAccessErasure: {
      ...currentCoverage.nativeAccessErasure!, ciphertextDigest: sha('missing ciphertext'),
    } };
    await expect(retainRecoveryCoverageHead(relay,
      JSON.stringify(sealRecoveryPayload(incompleteCoverage, recoveryKey, 'graph-recovery-coverage')),
      recoveryKey, { attachmentDirectory: attachments })).rejects.toThrow('encrypted native Access attachment is incomplete');

    const signedEnvelope = JSON.parse(sealedCurrent) as {
      format: string; kind: string; payload: string; mac: string;
    };
    const tamperedCoverage = JSON.parse(Buffer.from(signedEnvelope.payload, 'base64url').toString('utf8')) as
      RecoveryCoverage;
    tamperedCoverage.nativeAccessErasure!.ciphertextDigest = '0'.repeat(64);
    const tampered = JSON.stringify({ ...signedEnvelope,
      payload: Buffer.from(JSON.stringify(tamperedCoverage)).toString('base64url') });
    expect(tampered).not.toBe(sealedCurrent);
    await expect(retainRecoveryCoverageHead(relay, tampered, recoveryKey,
      { attachmentDirectory: attachments })).rejects.toThrow();

    const movedJournal = { ...sourceJournal, epoch: (BigInt(sourceJournal.epoch!) + 1n).toString() };
    const orphanCoverage = { ...currentCoverage, erasureJournal: movedJournal,
      nativeAccessErasure: { ...currentCoverage.nativeAccessErasure!, sourceErasureJournal: movedJournal } };
    await expect(retainRecoveryCoverageHead(relay,
      JSON.stringify(sealRecoveryPayload(orphanCoverage, recoveryKey, 'graph-recovery-coverage')),
      recoveryKey, { attachmentDirectory: attachments })).rejects.toThrow('journal moved after current coverage capture');
    expect(existsSync(encrypted.path)).toBe(true);
    expect((await relay.query('SELECT 1 FROM relay.recovery_coverage_head WHERE consumer = $1', [consumer])).rowCount).toBe(0);

    await retainRecoveryCoverageHead(relay, sealedCurrent, recoveryKey, { attachmentDirectory: attachments });
    const head = (await relay.query<{ epoch: string | null }>(
      'SELECT erasure_epoch::text AS epoch FROM relay.recovery_coverage_head WHERE consumer = $1', [consumer])).rows[0];
    const pointer = (await relay.query<{ consumer: string; coverage_digest: string }>(
      'SELECT consumer, coverage_digest FROM relay.current_authority_coverage WHERE id = true')).rows[0];
    expect(head?.epoch).toBe(sourceJournal.epoch);
    expect(pointer?.consumer).toBe(consumer);
  } finally {
    await relay.end();
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
