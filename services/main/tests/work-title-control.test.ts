import { expect, test } from 'bun:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { AccountAssertionDenied, AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { AccessAdmissionRegistry, AdmissionDenied, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { issueTitleCandidateAdmission, issueHistoricalTitleCandidateAdmission } from '../src/modules/access/title-admission.ts';
import { ObjectIntegrityError, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { type CommandEnvelope, type TitleCandidateCommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody, type VerifiedTitleCandidate } from '../src/modules/outbox/receipt-custody.ts';
import { CONTINUITY, PROFILE, RV, prepareWorkComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { acceptHumanTitleCandidate, cancelTitleControl, checkedTitleCandidateFrame, prepareHumanTitleCandidate, titleControlDigest,
  readTitleControl, TitleControlUnavailable, type TitleControlIntent }
  from '../src/modules/work/title-control.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const expectedHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const control = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const content = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const intent: TitleControlIntent = { work, expectedHead, basis: { head: null, epoch: '0', protection: null },
  action: 'work.edit', title: 'Human confirmation', source: null };

function state(mode: string): WorkActivationEnvironment {
  return { fuseki: { query: async () => ({ results: { bindings: [{
    content: { value: content }, control: { value: control }, epoch: { value: '1' },
    mode: { value: mode }, intent: { value: JSON.stringify(intent) },
  }] } }) } } as unknown as WorkActivationEnvironment;
}

test('LIVE03 unknown or mismatched stored title control modes fail closed', async () => {
  expect((await readTitleControl(state(`${RV}HumanControlled`), work)).mode).toBe('human-controlled');
  await expect(readTitleControl(state(`${RV}Unknown`), work)).rejects.toBeInstanceOf(TitleControlUnavailable);
  await expect(readTitleControl(state(`${RV}SourceManaged`), work)).rejects.toBeInstanceOf(TitleControlUnavailable);
});

// Account/Access/custody authenticity ends at the transport boundary here; native tests consume the frozen signed artifact.
test('private human title custody signs actual claimed SQL actor on a max-one receipt session', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const stateDirectory = join(root, '.temp', `title-custody-${randomUUID()}`);
  const dataDirectory = join(stateDirectory, 'pgdata');
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No SQL fixture port'));
      server.close(() => resolvePort(address.port));
    });
  });
  execFileSync('initdb', ['-D', dataDirectory, '-A', 'trust', '--no-instructions'], { cwd: stateDirectory, stdio: 'pipe' });
  execFileSync('pg_ctl', ['-D', dataDirectory, '-l', join(stateDirectory, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k /tmp`, '-w', 'start'], { cwd: stateDirectory, stdio: 'pipe' });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 1,
    connectionTimeoutMillis: 1000 });
  const issuer = 'https://account.rezics.test', audience = 'rezics-main', accountSubject = randomUUID();
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'title-fixture-key', alg: 'RS256', use: 'sig' };
  const accountToken = await new SignJWT({ scope: 'work:edit' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setAudience(audience).setSubject(accountSubject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  let accountActive = true, accountExchanges = 0;
  const accountServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/jwks') return Response.json({ keys: [jwk] });
    const body = new URLSearchParams(await request.text());
    if (body.get('client_id') !== 'main-resource' || body.get('client_secret') !== 'title-test-secret'
      || body.get('token') !== accountToken) return new Response('Unauthorized', { status: 401 });
    accountExchanges++;
    return Response.json({ active: accountActive, iss: issuer, sub: accountSubject, aud: audience,
      scope: 'work:edit', exp: Math.floor(Date.now() / 1000) + 300 });
  } });
  const account = new AccountAssertionVerifier({ issuer, audience,
    jwksUrl: `http://127.0.0.1:${accountServer.port}/jwks`,
    introspectUrl: `http://127.0.0.1:${accountServer.port}/introspect`,
    clientId: 'main-resource', clientSecret: 'title-test-secret' });
  const request = new Request('https://main.rezics.test/internal-title-test', {
    method: 'POST', headers: { authorization: `Bearer ${accountToken}` } });
  const key = '9'.repeat(64), principalId = randomUUID(), actingSubject = `https://rezics.com/id/${randomUUID()}`;
  const humanIntent = { ...intent, language: 'en' };
  const scope = `work:edit:${work}`, digest = titleControlDigest(humanIntent);
  const bytesByDigest = new Map<string, Uint8Array>(), reads: { digest: string; maximum?: number; bytes: number }[] = [];
  const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const objects: ImmutableObjects = {
    async put(bytes) { const hash = sha(bytes); bytesByDigest.set(hash, new Uint8Array(bytes)); return hash; },
    async get(hash, maximum) {
      const bytes = bytesByDigest.get(hash);
      reads.push({ digest: hash, maximum, bytes: bytes?.byteLength ?? 0 });
      if (!bytes || (maximum !== undefined && bytes.byteLength > maximum)) throw new ObjectIntegrityError('Missing or oversized test object');
      return new Uint8Array(bytes);
    },
  };
  const originalWorkState = { mainVersion: content, continuityProfile: CONTINUITY, title: 'Original title', language: 'en',
    localizedTitle: { value: 'Titre original', language: 'fr' }, description: { value: 'Preserved description', language: 'en' }, semanticTypes: [] };
  let transported: TitleCandidateCommandEnvelope | undefined, loseAcknowledgement = false, nativeCancelled = false;
  const originalManifest = `urn:rezics:sha256:${await prepareWorkComponent(objects, work, originalWorkState, PROFILE)}`;
  const fuseki = {
    async query(query: string) {
      if (query.includes('ASK')) return { boolean: true };
      return { results: { bindings: [{ main: { value: content }, type: { value: 'https://schema.org/CreativeWork' }, manifest: { value: originalManifest } }] } };
    },
    async commandHealth() { return { profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) }; },
    async commandTitleCandidate(command: TitleCandidateCommandEnvelope) {
      transported = structuredClone(command);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Simulated lost acknowledgement at transport boundary'); }
      return nativeCancelled ? { status: 'terminal', receipt: command.receipt, digest: command.digest, outcome: 'cancelled' }
        : { status: command.titleCandidate.mode === 'lookup' ? 'historical' : 'accepted', receipt: command.receipt, digest: command.digest, record: 'urn:rezics:test:private-title-record' };
    },
  };
  const custody = new ReceiptCustody(new PostgresReceiptCustodyStore(pool), objects,
    fuseki as unknown as WorkActivationEnvironment['fuseki'], key, async () => { throw new Error('Private title custody must not retire a proof'); });
  const env = { fuseki, workObjects: objects, receiptCustody: custody, objectDirectory: stateDirectory,
    titleAdmissionKey: key, lineage: { dataEpoch: 'title-authenticated-data', routingEpoch: 'title-authenticated-routing' } } as unknown as WorkActivationEnvironment;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of schemaFiles(root, 'access')) await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
      await client.query('COMMIT');
    } finally { client.release(); }
    await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES($1,$2,$3)', [principalId, issuer, accountSubject]);
    await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES($1,'agent')", [actingSubject]);
    await pool.query('INSERT INTO access.scope_gate(id) VALUES($1)', [scope]);
    await pool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES($1,$2,$3,'work.edit',clock_timestamp()+interval '1 hour')`, [randomUUID(), principalId, actingSubject]);
    await pool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES($1,$2,$2,$3,'work.edit',clock_timestamp()+interval '1 hour')`, [randomUUID(), actingSubject, scope]);
    const wrongPrincipal = randomUUID(), wrongActor = `https://rezics.com/id/${randomUUID()}`;
    await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES($1,$2,$3)', [wrongPrincipal, issuer, randomUUID()]);
    await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES($1,'agent')", [wrongActor]);
    const wrongScope = `work:edit:https://rezics.com/id/${randomUUID()}`;
    await pool.query('INSERT INTO access.scope_gate(id) VALUES($1)', [wrongScope]);
    const registry = new AccessAdmissionRegistry(pool);
    const principal = await account.verify(request, ['work:edit']);
    const registration = { principal, actingSubject, scope, action: 'work.edit', idempotencyKey: 'authentic-native-bridge', requestDigest: digest };
    const registered = await registry.register(registration);
    // This fixture changes only the SQL clock budget before first preparation; issuer rereads its actual original expiry.
    await pool.query("UPDATE access.admission SET expires_at=clock_timestamp()+interval '10000 seconds' WHERE id=$1", [registered.id]);
    const reloaded = await registry.register(registration);
    const claimed = await registry.claim(reloaded.id, digest, principal);
    const frame = await prepareHumanTitleCandidate(env, claimed, humanIntent);
    let token: VerifiedTitleCandidate | undefined;
    const proof = await custody.prepareTitleCandidate(frame, async (verified, sessionClient) => {
      token = verified;
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(0);
      const issued = await issueTitleCandidateAdmission(sessionClient, verified, key);
      expect(await issueHistoricalTitleCandidateAdmission(sessionClient, verified, key)).toEqual(issued);
      const fields = JSON.parse(issued.payload);
      expect(fields).toEqual(['rezics-human-title-candidate-admission-v1', claimed.id, 'work.edit', scope,
        claimed.authorityEpoch, frame.receipt, digest, verified.frameSha256, verified.custodySha256,
        principalId, actingSubject, claimed.expiresAt]);
      expect(issued.signature).toBe(createHmac('sha256', key).update(issued.payload).digest('hex'));
      await expect(issueTitleCandidateAdmission(sessionClient, {} as VerifiedTitleCandidate, key)).rejects.toBeInstanceOf(ObjectIntegrityError);
      for (const [column, wrong] of [['principal_id', wrongPrincipal], ['acting_subject', wrongActor], ['request_digest', '0'.repeat(64)],
        ['authority_epoch', '999'], ['scope_id', wrongScope]] as const) {
        // Temporary SQL changes inside a rolled-back transaction prove issuer's reread, rather than trusting a token cast.
        await sessionClient.query('BEGIN');
        try {
          await sessionClient.query(`UPDATE access.admission SET ${column}=$2 WHERE id=$1`, [claimed.id, wrong]);
          await expect(issueTitleCandidateAdmission(sessionClient, verified, key)).rejects.toBeInstanceOf(AdmissionDenied);
        } finally { await sessionClient.query('ROLLBACK'); }
      }
      await sessionClient.query('BEGIN');
      try {
        await sessionClient.query('UPDATE access.command_custody SET payload=$2 WHERE receipt=$1', [frame.receipt, Buffer.from('{}')]);
        await expect(issueTitleCandidateAdmission(sessionClient, verified, key)).rejects.toBeInstanceOf(AdmissionDenied);
      } finally { await sessionClient.query('ROLLBACK'); }
      return issued;
    });
    const row = (await pool.query<{ payload_sha256: string; payload: Buffer }>('SELECT payload_sha256,payload FROM access.command_custody WHERE receipt=$1', [frame.receipt])).rows[0]!;
    const envelope: TitleCandidateCommandEnvelope = { receipt: frame.receipt, digest, update: '', validations: [], deadlineMs: 10000,
      titleCandidate: { frame: JSON.stringify(JSON.parse(row.payload.toString('utf8')).frame), custodySha256: row.payload_sha256, mode: 'accept' }, titleAdmission: proof };
    expect(sha(envelope.titleCandidate.frame)).toBe(JSON.parse(proof.payload)[7]);
    const bridge = { format: 'rezics-authenticated-title-candidate-fixture-v1', titleKey: key, titleKeyEncoding: 'utf8', envelope,
      historicalEnvelope: { ...envelope, titleCandidate: { ...envelope.titleCandidate, mode: 'lookup' } },
      expectedActor: { principalId, actingSubject }, originalWorkState,
      provenance: { accountIssuer: issuer, accountSubject, admissionId: claimed.id, sqlExpiresAt: claimed.expiresAt, poolMax: 1 } };
    const bridgeDirectory = join(root, '.temp/goal/title-acceptance');
    mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 });
    const afterClient = await pool.connect();
    try { await expect(issueTitleCandidateAdmission(afterClient, token!, key)).rejects.toBeInstanceOf(ObjectIntegrityError); }
    finally { afterClient.release(); }

    const adapterInput = { ...humanIntent, actingSubject, idempotencyKey: registration.idempotencyKey };
    loseAcknowledgement = true;
    await expect(acceptHumanTitleCandidate(env, account, registry, request, adapterInput)).rejects.toThrow('Simulated lost acknowledgement');
    expect((await acceptHumanTitleCandidate(env, account, registry, request, adapterInput)).status).toBe('accepted');
    expect(transported).toEqual(envelope);
    expect((await pool.query('SELECT count(*)::integer AS count FROM access.command_custody')).rows[0]!.count).toBe(1);
    const retained = (await pool.query('SELECT state,expires_at FROM access.admission WHERE id=$1', [claimed.id])).rows[0]!;
    expect(retained.state).toBe('claimed');
    expect(retained.expires_at.toISOString()).toBe(claimed.expiresAt);
    expect((await pool.query('SELECT terminal,outbox,reconciled_at,retired_at FROM access.command_custody')).rows[0])
      .toEqual({ terminal: null, outbox: null, reconciled_at: null, retired_at: null });
    accountActive = false;
    await expect(acceptHumanTitleCandidate(env, account, registry, request, adapterInput)).rejects.toBeInstanceOf(AccountAssertionDenied);
    accountActive = true;
    expect(accountExchanges).toBeGreaterThan(3);
    expect(() => checkedTitleCandidateFrame({ ...frame, callerRecipe: 'untrusted' })).toThrow();
    expect(() => checkedTitleCandidateFrame({ ...frame, actor: { ...frame.actor, callerAuthority: true } })).toThrow();

    const changedRegistration = await registry.register({ ...registration, idempotencyKey: 'changed-non-title-field' });
    const changedClaimed = await registry.claim(changedRegistration.id, digest, principal);
    const changedFrame = await prepareHumanTitleCandidate(env, changedClaimed, humanIntent);
    const changedWorkManifest = await prepareWorkComponent(objects, work, { ...originalWorkState,
      title: humanIntent.title, language: 'en', description: { value: 'Unrequested replacement', language: 'en' } }, PROFILE);
    await expect(custody.prepareTitleCandidate({ ...changedFrame, workManifest: `urn:rezics:sha256:${changedWorkManifest}` },
      (verified, sessionClient) => issueTitleCandidateAdmission(sessionClient, verified, key))).rejects.toBeInstanceOf(ObjectIntegrityError);
    expect((await pool.query('SELECT count(*)::integer AS count FROM access.command_custody WHERE receipt=$1', [changedFrame.receipt])).rows[0]!.count).toBe(0);

    // Any corrupt manifest/payload/shape or SQL custody bytes refuses before signing or transport.
    const manifestDigests = [frame.originalManifest, frame.workManifest, frame.controlManifest].map(manifest => manifest.slice(-64));
    const componentPayloadDigests = manifestDigests.map(hash =>
      (JSON.parse(Buffer.from(bytesByDigest.get(hash)!).toString('utf8')).payload as string).slice(7));
    for (const hash of new Set([row.payload_sha256, ...manifestDigests, ...componentPayloadDigests,
      ...frame.validations.map(validation => validation.sha256)])) {
      const original = bytesByDigest.get(hash)!;
      bytesByDigest.set(hash, Buffer.from('{}'));
      await expect(custody.verifyTitleCandidate(frame.receipt, (verified, sessionClient) => issueTitleCandidateAdmission(sessionClient, verified, key)))
        .rejects.toBeInstanceOf(ObjectIntegrityError);
      bytesByDigest.set(hash, original);
    }
    const originalShape = bytesByDigest.get(frame.validations[0]!.sha256)!;
    bytesByDigest.delete(frame.validations[0]!.sha256);
    let cancellationDispatched = false;
    expect(await custody.guardCancellation(frame.receipt, async () => { cancellationDispatched = true; })).toBeNull();
    expect(cancellationDispatched).toBe(true);
    bytesByDigest.set(frame.validations[0]!.sha256, originalShape);
    const captureCancellation = async (admission: RegisteredAdmission): Promise<CommandEnvelope> => {
      let captured: CommandEnvelope | undefined;
      const sentinel = new Error('Captured genuine cancellation before graph dispatch');
      const cancellationEnv = { ...env, fuseki: { ...fuseki,
        async commandWithReceipt(command: CommandEnvelope) { captured = structuredClone(command); throw sentinel; },
      } } as unknown as WorkActivationEnvironment;
      await expect(cancelTitleControl(cancellationEnv, admission)).rejects.toBe(sentinel);
      expect(captured).toBeDefined();
      return captured!;
    };
    let releaseCandidate!: () => void, signalCandidateEntered!: () => void;
    const candidateEntered = new Promise<void>(resolveEntered => { signalCandidateEntered = resolveEntered; });
    const candidateRelease = new Promise<void>(resolveRelease => { releaseCandidate = resolveRelease; });
    let candidateActive = false, racingCancellationEntered = false;
    let cancellationEnvelope: CommandEnvelope | undefined;
    const heldCandidate = custody.verifyTitleCandidate(frame.receipt, async (verified, sessionClient) => {
      candidateActive = true;
      const issued = await issueTitleCandidateAdmission(sessionClient, verified, key);
      signalCandidateEntered();
      await candidateRelease;
      candidateActive = false;
      return issued;
    });
    await candidateEntered;
    const racingCancellation = custody.guardCancellation(frame.receipt, async () => {
      expect(candidateActive).toBe(false);
      racingCancellationEntered = true;
      cancellationEnvelope = await captureCancellation(claimed);
    });
    try {
      await Promise.resolve();
      expect(candidateActive).toBe(true);
      expect(racingCancellationEntered).toBe(false);
      expect(pool.totalCount).toBe(1);
      expect(pool.waitingCount).toBe(1);
    } finally { releaseCandidate(); }
    expect(await heldCandidate).toEqual(proof);
    expect(await racingCancellation).toBeNull();
    expect(racingCancellationEntered).toBe(true);
    expect(cancellationEnvelope?.receipt).toBe(frame.receipt);
    expect(cancellationEnvelope?.digest).toBe(frame.digest);
    const afterCancellationRace = (await pool.query('SELECT payload_sha256,payload,terminal,outbox FROM access.command_custody WHERE receipt=$1', [frame.receipt])).rows[0]!;
    expect(afterCancellationRace.payload_sha256).toBe(row.payload_sha256);
    expect(Buffer.from(afterCancellationRace.payload)).toEqual(row.payload);
    expect(afterCancellationRace.terminal).toBeNull();
    expect(afterCancellationRace.outbox).toBeNull();
    nativeCancelled = true;
    expect((await acceptHumanTitleCandidate(env, account, registry, request, adapterInput)).status).toBe('terminal');
    expect((await pool.query('SELECT state FROM access.admission WHERE id=$1', [claimed.id])).rows[0]!.state).toBe('claimed');
    nativeCancelled = false;

    // Expiry is observed against the actual SQL clock; no post-preparation refresh supplies historical authority.
    const expiringRegistration = { ...registration, idempotencyKey: 'authentic-expired-history' };
    const expiringRegistered = await registry.register(expiringRegistration);
    await pool.query("UPDATE access.admission SET expires_at=clock_timestamp()+interval '1.5 seconds' WHERE id=$1", [expiringRegistered.id]);
    const expiringReloaded = await registry.register(expiringRegistration);
    const expiringClaimed = await registry.claim(expiringReloaded.id, digest, principal);
    const expiringFrame = await prepareHumanTitleCandidate(env, expiringClaimed, humanIntent);
    const expiringEnvelope = await custody.prepareTitleCandidate(expiringFrame, async (verified, sessionClient): Promise<TitleCandidateCommandEnvelope> => ({
      receipt: expiringFrame.receipt, digest, update: '', validations: [], deadlineMs: 10000,
      titleCandidate: { frame: verified.frameJson, custodySha256: verified.custodySha256, mode: 'accept' },
      titleAdmission: await issueTitleCandidateAdmission(sessionClient, verified, key),
    }));
    await new Promise(resolveExpired => setTimeout(resolveExpired, Math.max(1, Date.parse(expiringClaimed.expiresAt) - Date.now() + 30)));
    const expiredHistory = await custody.verifyTitleCandidate(expiringFrame.receipt, async (verified, sessionClient) => {
      await expect(issueTitleCandidateAdmission(sessionClient, verified, key)).rejects.toBeInstanceOf(AdmissionDenied);
      const historical = await issueHistoricalTitleCandidateAdmission(sessionClient, verified, key);
      expect(historical).toEqual(expiringEnvelope.titleAdmission);
      return { ...expiringEnvelope, titleAdmission: historical,
        titleCandidate: { ...expiringEnvelope.titleCandidate, mode: 'lookup' as const } };
    });
    expect(expiredHistory).not.toBeNull();
    expect((await acceptHumanTitleCandidate(env, account, registry, request,
      { ...humanIntent, actingSubject, idempotencyKey: expiringRegistration.idempotencyKey })).status).toBe('historical');
    expect(transported).toEqual(expiredHistory!);
    expect((await pool.query('SELECT expires_at,state FROM access.admission WHERE id=$1', [expiringClaimed.id])).rows[0])
      .toEqual({ expires_at: new Date(expiringClaimed.expiresAt), state: 'claimed' });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(read => read.maximum !== undefined && read.maximum <= 4194304)).toBe(true);
    expect(reads.some(read => read.maximum === 4194304)).toBe(true);
    const shortLivedRegistration = { ...registration, idempotencyKey: 'authentic-retained-expiry' };
    const shortLivedRegistered = await registry.register(shortLivedRegistration);
    await pool.query("UPDATE access.admission SET expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1", [shortLivedRegistered.id]);
    const shortLivedReloaded = await registry.register(shortLivedRegistration);
    const shortLivedClaimed = await registry.claim(shortLivedReloaded.id, digest, principal);
    const shortLivedFrame = await prepareHumanTitleCandidate(env, shortLivedClaimed, humanIntent);
    const shortLivedEnvelope = await custody.prepareTitleCandidate(shortLivedFrame,
      async (verified, sessionClient): Promise<TitleCandidateCommandEnvelope> => {
        const fresh = await issueTitleCandidateAdmission(sessionClient, verified, key);
        expect(await issueHistoricalTitleCandidateAdmission(sessionClient, verified, key)).toEqual(fresh);
        return { receipt: shortLivedFrame.receipt, digest, update: '', validations: [], deadlineMs: 10000,
          titleCandidate: { frame: verified.frameJson, custodySha256: verified.custodySha256, mode: 'accept' }, titleAdmission: fresh };
      });
    const shortCancellationEnvelope = await captureCancellation(shortLivedClaimed);
    writeFileSync(join(bridgeDirectory, 'authenticated-native-fixture.json'), JSON.stringify({ ...bridge,
      cancellationEnvelope,
      expiredEnvelope: expiringEnvelope, expiredHistoricalEnvelope: expiredHistory,
      expiredProvenance: { admissionId: expiringClaimed.id, sqlExpiresAt: expiringClaimed.expiresAt },
      shortLivedEnvelope,
      shortCancellationEnvelope,
      shortLivedHistoricalEnvelope: { ...shortLivedEnvelope,
        titleCandidate: { ...shortLivedEnvelope.titleCandidate, mode: 'lookup' } },
      shortLivedProvenance: { admissionId: shortLivedClaimed.id, sqlExpiresAt: shortLivedClaimed.expiresAt } }), { mode: 0o600 });
    console.info(JSON.stringify({ titleCustodyAuth: true, accountIntrospections: accountExchanges,
      claimedAdmission: claimed.id, actor: { principalId, actingSubject }, poolMax: pool.options.max,
      immutableReads: reads.length, boundedReads: reads.filter(read => read.maximum !== undefined).length,
      immutableReadBytes: reads.reduce((total, read) => total + read.bytes, 0),
      fixtureSha256: sha(readFileSync(join(bridgeDirectory, 'authenticated-native-fixture.json'))) }));
  } finally {
    await accountServer.stop(true);
    await pool.end();
    execFileSync('pg_ctl', ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop'], { cwd: stateDirectory, stdio: 'pipe' });
  }
}, 60_000);
