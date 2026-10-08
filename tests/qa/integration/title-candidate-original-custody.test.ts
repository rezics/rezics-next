import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AccessAdmissionRegistry, AdmissionDenied, type VerifiedPrincipal }
  from '../../../services/main/src/modules/access/admission.ts';
import { issueHistoricalTitleCandidateAdmission, issueTitleCandidateAdmission, signTitleAdmission }
  from '../../../services/main/src/modules/access/title-admission.ts';
import type { TitleCandidateCommandEnvelope, TitleCandidateResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectIntegrityError } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { GRAPHS, iri, lit, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { acceptHumanTitleCandidate, canonicalTitleCandidateFrame, checkedTitleCandidateFrame,
  prepareHumanTitleCandidate, readTitleControl, titleControlDigest, type TitleControlIntent }
  from '../../../services/main/src/modules/work/title-control.ts';
import { startMediaStack } from './media-support.ts';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const REPAIR = 'urn:rezics:projection:public-name-repair';
const RECEIPTS = 'urn:rezics:graph:receipts';
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

/** Actual SQL custody issuer -> authenticated native command -> exact lost-ACK lookup. Nothing here signs
 * authority for the positive path: Account verification, Access register/claim, the immutable original
 * create/edit custody bytes and the title admission issuer are the production implementations. */
test('original SQL-issued human title candidate reaches native acceptance and resolves a lost acknowledgement by exact lookup', async () => {
  const key = Bun.env.FUSEKI_TITLE_ADMISSION_KEY;
  if (!key || !/^[0-9a-f]{64}$/.test(key) || !Bun.env.MAIN_S3_ENDPOINT) throw new Error('Run through the isolated QA integration tier');
  const stack = await startMediaStack('title-candidate-custody');
  const presented = new Map<string, { subject: string; scope: string }>();
  const accountServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
    const body = new URLSearchParams(await request.text());
    const account = presented.get(body.get('token') ?? '');
    if (body.get('client_id') !== 'main-resource' || body.get('client_secret') !== 'title-candidate-secret'
      || !account) return new Response('Unauthorized', { status: 401 });
    return Response.json({ active: true, iss: member.principal.issuer, sub: account.subject, aud: 'rezics-main',
      scope: account.scope, exp: Math.floor(Date.now() / 1000) + 300 });
  } });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'title-candidate-key', alg: 'RS256', use: 'sig' };
  const member = await stack.member('title-candidate-owner');
  const accountToken = await new SignJWT({ scope: 'work:edit' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(member.principal.issuer).setAudience('rezics-main').setSubject(member.principal.subject)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const otherSubject = `title-candidate-other-${randomUUID()}`;
  const otherToken = await new SignJWT({ scope: 'agent:create' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(member.principal.issuer).setAudience('rezics-main').setSubject(otherSubject)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  presented.set(accountToken, { subject: member.principal.subject, scope: 'work:edit' });
  presented.set(otherToken, { subject: otherSubject, scope: 'agent:create' });
  try {
    const account = new AccountAssertionVerifier({ issuer: member.principal.issuer, audience: 'rezics-main',
      jwksUrl: `http://127.0.0.1:${accountServer.port}/jwks`, introspectUrl: `http://127.0.0.1:${accountServer.port}/introspect`,
      clientId: 'main-resource', clientSecret: 'title-candidate-secret' });
    const request = new Request('https://main.rezics.test/internal-title-candidate', {
      method: 'POST', headers: { authorization: `Bearer ${accountToken}` } });
    const principal: VerifiedPrincipal = await account.verify(request, ['work:edit']);
    const registry = new AccessAdmissionRegistry(stack.accessPool);

    // The selected immutable store must hold the Work's evidence: migration-directory fallback cannot supply custody truth.
    const workObjects = stack.objects('semantic/work/');
    await workObjects.initialize();
    Object.assign(stack.env, { workObjects, titleAdmissionKey: key });
    const created = await stack.privateWork(member.actor, `Original title ${randomUUID()}`);
    Object.assign(stack.env, { receiptCustody: new ReceiptCustody(new PostgresReceiptCustodyStore(stack.accessPool),
      workObjects, stack.fuseki, key, async () => { throw new Error('Private title custody must not retire a proof'); }) });
    const env = stack.env as WorkActivationEnvironment;
    // The issuer compares the SQL actor with the signed frame. A missing principal fails the foreign key
    // before that comparison. Register cannot create one, so Agent provisioning admits this Account subject.
    const otherRequest = new Request('https://main.rezics.test/internal-other-principal', {
      method: 'POST', headers: { authorization: `Bearer ${otherToken}` } });
    const admittedOther = await new AgentProvisioning(stack.accessPool, env).provision(account, otherRequest,
      { kind: 'person', displayName: 'Other title principal' }, `title-other-${randomUUID()}`);
    if (admittedOther.state !== 'active') throw new Error('substitute Account principal was not admitted');
    const otherPrincipalId = (await stack.accessPool.query<{ id: string }>(
      `SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2 AND active`,
      [member.principal.issuer, otherSubject])).rows[0]?.id;
    if (!otherPrincipalId || admittedOther.agent === member.actor) throw new Error('substitute Account principal was not admitted');
    const custody = env.receiptCustody!;
    const work = created.work, scope = `work:edit:${work}`;
    await member.grant(scope, 'work.edit');
    const before = await readTitleControl(env, work);
    expect(before.mode).toBe('unestablished');
    const intent: TitleControlIntent = { work, expectedHead: before.contentHead, basis: before.basis, action: 'work.edit',
      title: `Human confirmed ${randomUUID()}`, language: 'en', source: null };
    const digest = titleControlDigest(intent);
    const adapterInput = (idempotencyKey: string) => ({ ...intent, actingSubject: member.actor, idempotencyKey });

    /** Real Account principal, Access register and claim, then the production custody + SQL issuer; no dispatch. */
    const prepare = async (idempotencyKey: string, seconds?: number) => {
      const registration = { principal, actingSubject: member.actor, scope, action: 'work.edit', idempotencyKey, requestDigest: digest };
      const registered = await registry.register(registration);
      // Only the SQL clock budget changes; the issuer rereads this actual original expiry.
      if (seconds !== undefined) await stack.accessPool.query(
        'UPDATE access.admission SET expires_at = clock_timestamp() + make_interval(secs => $2) WHERE id = $1', [registered.id, seconds]);
      const claimed = await registry.claim((await registry.register(registration)).id, digest, principal);
      const frame = await prepareHumanTitleCandidate(env, claimed, intent);
      const envelope = await custody.prepareTitleCandidate(frame, async (verified, client): Promise<TitleCandidateCommandEnvelope> => {
        const fresh = await issueTitleCandidateAdmission(client, verified, key);
        expect(await issueHistoricalTitleCandidateAdmission(client, verified, key)).toEqual(fresh);
        return { receipt: frame.receipt, digest, update: '', validations: [], deadlineMs: 10000,
          titleCandidate: { frame: verified.frameJson, custodySha256: verified.custodySha256, mode: 'accept' }, titleAdmission: fresh };
      });
      expect(JSON.parse(envelope.titleAdmission.payload)).toEqual(['rezics-human-title-candidate-admission-v1', claimed.id, 'work.edit',
        scope, claimed.authorityEpoch, frame.receipt, digest, sha(envelope.titleCandidate.frame), envelope.titleCandidate.custodySha256,
        claimed.principalId, member.actor, claimed.expiresAt]);
      return { claimed, frame, envelope };
    };
    const subject = (receipt: string) => `urn:rezics:title-candidate:${sha(receipt)}`;
    const retained = async (receipt: string) => ((await stack.fuseki.query(`SELECT ?o WHERE { GRAPH ${iri(REPAIR)} {
      ${iri(subject(receipt))} ?p ?o } } ORDER BY ?o`, 262144)).results?.bindings ?? []).map(binding => binding.o!.value);
    const workQuads = async () => ((await stack.fuseki.query(`SELECT ?g ?p ?o WHERE { GRAPH ?g { ${iri(work)} ?p ?o } } ORDER BY ?g ?p ?o`,
      262144)).results?.bindings ?? []).map(binding => `${binding.g!.value} ${binding.p!.value} ${binding.o!.value}`);
    const receiptTerminal = async (receipt: string) => (await stack.fuseki.query(
      `ASK { GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} ?p ?o } }`)).boolean;
    const sendCommand = (envelope: TitleCandidateCommandEnvelope, mode: 'accept' | 'lookup' = envelope.titleCandidate.mode) =>
      stack.fuseki.commandTitleCandidate({ ...envelope, titleCandidate: { ...envelope.titleCandidate, mode } });
    const refused = async (envelope: TitleCandidateCommandEnvelope, label: string) => {
      expect(await sendCommand(envelope), label).toMatchObject({ status: 'conflict' });
      expect(await retained(envelope.receipt), label).toEqual([]);
    };
    const quadsBefore = await workQuads();

    // Authenticity: one original SQL-issued candidate. Every changed byte below is refused before any acceptance exists.
    const original = await prepare('title-candidate-original', 600);
    const { envelope, frame, claimed } = original;
    expect(await retained(frame.receipt)).toEqual([]);
    const parsedFrame = JSON.parse(envelope.titleCandidate.frame);
    const reframe = (change: (value: Record<string, any>) => void) => {
      const value = structuredClone(parsedFrame); change(value);
      return canonicalTitleCandidateFrame(checkedTitleCandidateFrame(value));
    };
    const proofFields = JSON.parse(envelope.titleAdmission.payload) as unknown[];
    const withFrame = (text: string): TitleCandidateCommandEnvelope => ({ ...envelope, titleCandidate: { ...envelope.titleCandidate, frame: text } });
    const otherActor = randomUUID();
    await refused(withFrame(JSON.stringify(parsedFrame, null, 1)), 'non-canonical raw frame bytes');
    await refused(withFrame(reframe(value => { value.intent.title = 'Unrequested title'; value.digest = titleControlDigest(value.intent); })), 'changed title in the signed frame');
    await refused(withFrame(reframe(value => { value.actor.principalId = otherActor; })), 'substituted SQL principal');
    await refused(withFrame(reframe(value => { value.actor.actingSubject = `https://rezics.com/id/${otherActor}`; })), 'substituted acting subject');
    await refused(withFrame(reframe(value => { value.admission.expiresAt = new Date(Date.parse(claimed.expiresAt) + 60_000).toISOString(); })),
      'extended admission expiry in the frame');
    await refused({ ...envelope, titleCandidate: { ...envelope.titleCandidate, custodySha256: sha('another custody') } }, 'different custody hash');
    await refused({ ...envelope, titleAdmission: { ...envelope.titleAdmission, payload: JSON.stringify([...proofFields.slice(0, 11),
      new Date(Date.parse(claimed.expiresAt) + 60_000).toISOString()]) } }, 'extended proof expiry under the original signature');
    await refused({ ...envelope, titleAdmission: { ...envelope.titleAdmission, signature: sha('not the issuer signature') } }, 'wrong signature');
    await refused({ ...envelope, titleAdmission: signTitleAdmission({ id: claimed.id, action: 'work.edit', scope, authorityEpoch: claimed.authorityEpoch },
      { receipt: frame.receipt, digest, update: '', validations: [], deadlineMs: 10000 }, claimed.expiresAt, key) },
    'ordinary v1 title proof is not a candidate proof');
    await refused({ ...envelope, digest: sha('different request') }, 'different request digest');
    expect(await receiptTerminal(frame.receipt)).toBe(false);

    // Tamper with the SQL side of the same original: the issuer rereads actor and retained bytes and signs nothing.
    await custody.verifyTitleCandidate(frame.receipt, async (verified, client) => {
      for (const [column, wrong] of [['principal_id', otherPrincipalId], ['acting_subject', admittedOther.agent]] as const) {
        await client.query('BEGIN');
        try {
          await client.query(`UPDATE access.admission SET ${column} = $2 WHERE id = $1`, [claimed.id, wrong]);
          await expect(issueTitleCandidateAdmission(client, verified, key)).rejects.toBeInstanceOf(AdmissionDenied);
          await expect(issueHistoricalTitleCandidateAdmission(client, verified, key)).rejects.toBeInstanceOf(AdmissionDenied);
        } finally { await client.query('ROLLBACK'); }
      }
      await client.query('BEGIN');
      try {
        await client.query('UPDATE access.command_custody SET payload = $2 WHERE receipt = $1', [frame.receipt, Buffer.from('{}')]);
        await expect(issueTitleCandidateAdmission(client, verified, key)).rejects.toBeInstanceOf(AdmissionDenied);
      } finally { await client.query('ROLLBACK'); }
    });

    // Positive: the lost reply to the first dispatch is resolved by the client's exact lookup, with the original bytes.
    const realFetch = globalThis.fetch, dispatched: TitleCandidateCommandEnvelope[] = [];
    let lostReply = true;
    const intercepted = spyOn(globalThis, 'fetch').mockImplementation((async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (!target.endsWith('/command') || typeof init?.body !== 'string') return realFetch(url, init);
      const sent = JSON.parse(init.body) as TitleCandidateCommandEnvelope;
      if (!sent.titleCandidate) return realFetch(url, init);
      dispatched.push(sent);
      const response = await realFetch(url, init);
      if (!lostReply) return response;
      lostReply = false;
      await response.text();
      throw new TypeError('acceptance committed natively but its reply was lost');
    }) as typeof fetch);
    restores.push(() => intercepted.mockRestore());
    const outcome = await acceptHumanTitleCandidate(env, account, registry, request, adapterInput('title-candidate-original'));
    intercepted.mockRestore();
    expect(dispatched).toEqual([envelope, { ...envelope, titleCandidate: { ...envelope.titleCandidate, mode: 'lookup' } }]);
    expect(outcome.status).toBe('historical');
    const record = (outcome as Extract<TitleCandidateResult, { record: string }>).record;
    expect(await retained(frame.receipt)).toEqual([record]);
    const parsedRecord = JSON.parse(record);
    expect(parsedRecord).toMatchObject({ format: 'rezics-human-title-candidate-record-v1', frame: envelope.titleCandidate.frame,
      proof: envelope.titleAdmission, frameSha256: sha(envelope.titleCandidate.frame), custodySha256: envelope.titleCandidate.custodySha256 });
    expect(Object.keys(parsedRecord.captured).sort()).toEqual(['adoption', 'dataEpoch', 'qualification', 'routingEpoch', 'source', 'store']);

    // Lookups and acceptance replays are read-only: same retained bytes, no terminal receipt, no Work or Access change.
    const graphAfterAcceptance = await workQuads();
    expect(graphAfterAcceptance).toEqual(quadsBefore);
    for (const mode of ['lookup', 'accept', 'lookup'] as const) {
      const result = await sendCommand(envelope, mode);
      expect(result).toEqual({ status: mode === 'accept' ? 'accepted' : 'historical', receipt: frame.receipt, digest, record });
      expect(await retained(frame.receipt)).toEqual([record]);
    }
    expect(await workQuads()).toEqual(quadsBefore);
    expect(await receiptTerminal(frame.receipt)).toBe(false);
    expect((await readTitleControl(env, work)).mode).toBe('unestablished');
    expect(((await stack.fuseki.query(`SELECT ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} <http://www.w3.org/2000/01/rdf-schema#label> ?label . FILTER(STR(?label) = ${lit(intent.title)}) } }`)).results?.bindings ?? []))
      .toHaveLength(0);
    expect((await stack.accessPool.query('SELECT state FROM access.admission WHERE id = $1', [claimed.id])).rows[0]!.state).toBe('claimed');
    expect((await stack.accessPool.query('SELECT terminal, outbox, reconciled_at, retired_at FROM access.command_custody WHERE receipt = $1',
      [frame.receipt])).rows[0]).toEqual({ terminal: null, outbox: null, reconciled_at: null, retired_at: null });

    // Expiry: an accepted original stays recoverable by exact lookup; an unaccepted one can never become fresh.
    const accepted = await prepare('title-candidate-expiring-accepted', 20);
    expect((await sendCommand(accepted.envelope)).status).toBe('accepted');
    const unaccepted = await prepare('title-candidate-expiring-unaccepted', 20);
    const acceptedRecord = await retained(accepted.frame.receipt);
    expect(acceptedRecord).toHaveLength(1);
    // A tampered custody row must fail closed before any signing or transport on the retained path.
    const originalPayload = (await stack.accessPool.query<{ payload: Buffer }>(
      'SELECT payload FROM access.command_custody WHERE receipt = $1', [unaccepted.frame.receipt])).rows[0]!.payload;
    const guard = spyOn(globalThis, 'fetch').mockImplementation((async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (target.endsWith('/command')) throw new Error('tampered custody must not reach native');
      return realFetch(url, init);
    }) as typeof fetch);
    restores.push(() => guard.mockRestore());
    await stack.accessPool.query('UPDATE access.command_custody SET payload = $2 WHERE receipt = $1', [unaccepted.frame.receipt, Buffer.from('{}')]);
    try {
      await expect(acceptHumanTitleCandidate(env, account, registry, request, adapterInput('title-candidate-expiring-unaccepted')))
        .rejects.toBeInstanceOf(ObjectIntegrityError);
    } finally {
      await stack.accessPool.query('UPDATE access.command_custody SET payload = $2 WHERE receipt = $1', [unaccepted.frame.receipt, originalPayload]);
      guard.mockRestore();
    }
    expect(await retained(unaccepted.frame.receipt)).toEqual([]);
    const lastExpiry = Math.max(Date.parse(accepted.claimed.expiresAt), Date.parse(unaccepted.claimed.expiresAt));
    await new Promise(resolve => setTimeout(resolve, Math.max(1, lastExpiry - Date.now() + 100)));
    await custody.verifyTitleCandidate(unaccepted.frame.receipt, async (verified, client) => {
      await expect(issueTitleCandidateAdmission(client, verified, key)).rejects.toBeInstanceOf(AdmissionDenied);
      expect(await issueHistoricalTitleCandidateAdmission(client, verified, key)).toEqual(unaccepted.envelope.titleAdmission);
    });
    await refused(unaccepted.envelope, 'a pre-expiry fresh proof replayed after expiry');
    await refused({ ...unaccepted.envelope, titleCandidate: { ...unaccepted.envelope.titleCandidate, mode: 'lookup' } }, 'lookup without a retained acceptance');
    expect(await acceptHumanTitleCandidate(env, account, registry, request, adapterInput('title-candidate-expiring-unaccepted')))
      .toMatchObject({ status: 'conflict' });
    expect(await retained(unaccepted.frame.receipt)).toEqual([]);
    const historical = await acceptHumanTitleCandidate(env, account, registry, request, adapterInput('title-candidate-expiring-accepted'));
    expect(historical).toEqual({ status: 'historical', receipt: accepted.frame.receipt, digest, record: acceptedRecord[0]! });
    expect(await retained(accepted.frame.receipt)).toEqual(acceptedRecord);
    expect(await workQuads()).toEqual(quadsBefore);
    expect(await receiptTerminal(accepted.frame.receipt)).toBe(false);
  } finally {
    await accountServer.stop(true);
    await stack.stop();
  }
}, 240_000);
