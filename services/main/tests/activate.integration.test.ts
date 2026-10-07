import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient, type CommandEnvelope, type CommandResult } from '../src/infrastructure/fuseki.ts';
import { createMainApp } from '../src/app.ts';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied } from '../src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import {
  activateMetadataWork, CancelledActivation, IdempotencyConflict, initializeFreshGraph,
  metadataWorkRequestDigest, PendingActivation,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { strongRevokeMetadataWorkScope } from '../src/modules/work/strong-revoke.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

test('IAM07/SYS02/SYS10/SYS14 partial: Work receipt and strong seal races', async () => {
  const fusekiUrl = Bun.env.FUSEKI_URL;
  const accessUrl = Bun.env.ACCESS_DATABASE_URL;
  const dataEpoch = Bun.env.MAIN_DATA_EPOCH;
  const routingEpoch = Bun.env.MAIN_ROUTING_EPOCH;
  if (!Bun.env.REZICS_QA_RUN_ID || !fusekiUrl || !accessUrl || !dataEpoch || !routingEpoch) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `main-integration-${Bun.randomUUIDv7()}`);
  const fuseki = new FusekiClient(fusekiUrl);
  const lineage = { dataEpoch, routingEpoch };
  const env: WorkActivationEnvironment = {
    fuseki, lineage,
    objectDirectory: join(state, 'objects'), candidateDirectory: join(state, 'candidates'),
  };
  const accessPool = new Pool({ connectionString: accessUrl });
  try {
    const app = createMainApp(fuseki);
    const mainPort = await freePort();
    app.listen({ hostname: '127.0.0.1', port: mainPort });
    try {
      const readyResponse = await fetch(`http://127.0.0.1:${mainPort}/health/ready`);
      expect(readyResponse.status).toBe(200);
      expect(await readyResponse.json()).toEqual({ status: 'ready' });
    } finally {
      await app.stop();
    }
    const unavailablePort = await freePort();
    const unavailable = await createMainApp(new FusekiClient(`http://127.0.0.1:${unavailablePort}/rezics`))
      .handle(new Request('http://localhost/health/ready'));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: 'unavailable' });
    await initializeFreshGraph(fuseki, lineage);

    const admissions = new Map<string, {
      id: string; scope: string; action: string; idempotencyKey: string;
      requestDigest: string; authorityEpoch: string; expiresAt: string;
    }>();
    const admit = (key: string, title: string) => {
      let value = admissions.get(key);
      if (!value) {
        value = { id: Bun.randomUUIDv7(), scope: 'work:create:root', action: 'work.create',
          idempotencyKey: key, requestDigest: metadataWorkRequestDigest(title),
          authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() };
        admissions.set(key, value);
      }
      return value;
    };
    const intent = { admission: admit('create-1', 'First metadata Work'), title: 'First metadata Work' };
    const created = await activateMetadataWork(env, intent);
    expect(created.replayed).toBe(false);
    expect(created.sequence).toBe('1');
    expect(created.dataEpoch).toBe(lineage.dataEpoch);
    expect(created.admissionId).toBe(intent.admission.id);
    expect(created.work).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]+$/);
    const replay = await activateMetadataWork(env, intent);
    expect(replay).toEqual({ ...created, replayed: true });
    await expect(activateMetadataWork(env, { ...intent, title: 'Other title' })).rejects.toBeInstanceOf(IdempotencyConflict);

    const graph = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?main ?workRevision ?mainRevision WHERE {
      GRAPH <urn:rezics:graph:current> {
        <${created.work}> rv:mainVersion ?main ; rv:head ?workRevision .
        ?main rv:work <${created.work}> ; rv:head ?mainRevision .
      }
    }`);
    const current = graph.results?.bindings;
    expect(current?.length).toBe(1);
    expect(current?.[0]?.main?.value).toBe(created.mainVersion);
    const textMatch = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?work WHERE { GRAPH <urn:rezics:graph:current> {
        (?work ?score ?literal) text:query (rdfs:label "First" 10) .
        ?work rdfs:label ?literal .
      } }`);
    expect(textMatch.results?.bindings.map((row) => row.work?.value)).toContain(created.work);
    const revision = current?.[0]?.workRevision?.value;
    expect(revision).toBeDefined();
    const manifestResult = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
      GRAPH <urn:rezics:graph:revisions> { <${revision}> rv:manifest ?manifest }
    }`);
    const manifestIri = manifestResult.results?.bindings[0]?.manifest?.value;
    expect(manifestIri).toMatch(/^urn:rezics:sha256:[0-9a-f]{64}$/);
    const manifestHash = manifestIri!.split(':').at(-1)!;
    const manifest = JSON.parse(readFileSync(join(env.objectDirectory, manifestHash), 'utf8'));
    expect(manifest.component).toBe(created.work);
    expect(manifest.payload).toMatch(/^sha256:[0-9a-f]{64}$/);
    const payloadHash = manifest.payload.split(':').at(-1);
    const payload = readFileSync(join(env.objectDirectory, payloadHash));
    expect(createHash('sha256').update(payload).digest('hex')).toBe(payloadHash);

    class LostResponseClient extends FusekiClient {
      override async command(envelope: CommandEnvelope): Promise<CommandResult> {
        await super.command(envelope);
        throw new Error('simulated lost response');
      }
    }
    const lost = await activateMetadataWork({ ...env, fuseki: new LostResponseClient(fusekiUrl) },
      { admission: admit('lost-response', 'Recovered Work'), title: 'Recovered Work' });
    expect(lost.sequence).toBe('2');

    const sameKey = { admission: admit('race', 'Racing Work'), title: 'Racing Work' };
    const raced = await Promise.all([activateMetadataWork(env, sameKey), activateMetadataWork(env, sameKey)]);
    expect(raced[0]?.work).toBe(raced[1]?.work);
    expect(raced[0]?.sequence).toBe('3');
    expect(raced[1]?.sequence).toBe('3');

    await expect(activateMetadataWork({ ...env, lineage: { ...lineage, dataEpoch: Bun.randomUUIDv7() } },
      { admission: admit('stale-epoch', 'Must not exist'), title: 'Must not exist' })).rejects.toBeInstanceOf(PendingActivation);
    await expect(activateMetadataWork(env,
      { admission: admit('invalid-title', 'placeholder'), title: '' })).rejects.toThrow('invalid title');
    await expect(activateMetadataWork(env,
      { admission: { ...admit('expired-admission', 'Expired Work'),
        expiresAt: new Date(Date.now() - 1000).toISOString() }, title: 'Expired Work' }))
      .rejects.toBeInstanceOf(PendingActivation);
    const position = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(position.results?.bindings[0]?.sequence?.value).toBe('3');
    const outbox = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT (COUNT(?batch) AS ?count) WHERE {
      GRAPH <urn:rezics:graph:outbox> { ?batch a rv:OutboxBatch }
    }`);
    expect(outbox.results?.bindings[0]?.count?.value).toBe('3');

    const pool = accessPool;
    const principalId = Bun.randomUUIDv7();
    const actingSubject = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, 'https://account.fixture', 'fixture-account')`, [principalId]);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT (id) DO NOTHING");
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actingSubject]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actingSubject]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actingSubject]);
    const account = {
      async verify(request: Request, scopes: readonly string[]) {
        if (request.headers.get('authorization') !== 'Bearer verified-fixture'
          || scopes.join(' ') !== 'work:create') throw new AccountAssertionDenied('bad fixture assertion');
        return { issuer: 'https://account.fixture', subject: 'fixture-account' };
      },
    };
    const access = new AccessAdmissionRegistry(pool);
    const request = new Request('https://main.rezics.test/works', {
      method: 'POST', headers: { authorization: 'Bearer verified-fixture' },
    });
    const input = { actingSubject, idempotencyKey: 'bridged-create', title: 'Access admitted Work', language: 'en' };
    const bridged = await createAdmittedMetadataWork(env, account, access, request, input);
    expect(bridged.sequence).toBe('4');
    const admission = await pool.query<{ id: string; request_digest: string; authority_epoch: string;
      state: string; graph_outcome: string }>(
      "SELECT id, request_digest, authority_epoch, state, graph_outcome FROM access.admission WHERE idempotency_key = 'bridged-create'");
    expect(admission.rows).toHaveLength(1);
    expect(bridged.admissionId).toBe(admission.rows[0]!.id);
    expect(admission.rows[0]!.request_digest).toBe(metadataWorkRequestDigest(input.title, undefined, input.language));
    expect(admission.rows[0]!.state).toBe('sealed');
    expect(admission.rows[0]!.graph_outcome).toBe('succeeded');
    const bound = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?id ?epoch ?scope WHERE {
      GRAPH <urn:rezics:graph:receipts> {
        <${bridged.receipt}> rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope .
      }
    }`);
    expect(bound.results?.bindings[0]?.id?.value).toBe(bridged.admissionId);
    expect(bound.results?.bindings[0]?.epoch?.value).toBe(admission.rows[0]!.authority_epoch);
    expect(bound.results?.bindings[0]?.scope?.value).toBe('work:create:root');
    expect(await createAdmittedMetadataWork(env, account, access, request, input))
      .toEqual({ ...bridged, replayed: true });
    // These probes bind exact Work receipt positions. Seed the author through
    // the isolated stack's maintenance surface without adding a product command.
    const authorRevision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> { <${actingSubject}> a rv:Agent ; rv:head <${authorRevision}> . }
      GRAPH <urn:rezics:graph:revisions> { <${authorRevision}> a rv:RevisionAnchor ; rv:component <${actingSubject}> . }
    }`);
    const workApp = createMainApp(fuseki, { environment: env, account, access });
    const workPort = await freePort();
    workApp.listen({ hostname: '127.0.0.1', port: workPort });
    try {
      const url = `http://127.0.0.1:${workPort}/v1/works`;
      const body = { profile: 'metadata-only-v1', authoring: 'own-work', title: 'HTTP metadata Work', language: 'en', actingSubject };
      const post = (key: string, value: unknown = body, authorization = 'Bearer verified-fixture') => fetch(url, {
        method: 'POST', headers: { authorization, 'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      const createdResponse = await post('http-create');
      expect(createdResponse.status).toBe(201);
      const createdBody = await createdResponse.json() as Record<string, any>;
      expect(createdBody.replayed).toBe(false);
      expect(createdBody.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: lineage.dataEpoch, sequence: '5' });
      expect(createdBody.work).toMatch(/^https:\/\/rezics\.com\/id\//);
      expect(JSON.stringify(createdBody)).not.toContain(principalId);
      expect(JSON.stringify(createdBody)).not.toContain('admissionId');
      const replayResponse = await post('http-create');
      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.json()).toEqual({ ...createdBody, replayed: true });
      const conflict = await post('http-create', { ...body, title: 'Changed title' });
      expect(conflict.status).toBe(409);
      expect((await conflict.json() as Record<string, any>).code).toBe('idempotency_conflict');
      const denied = await post('http-denied', body, 'Bearer incorrect');
      expect(denied.status).toBe(401);
      expect((await denied.json() as Record<string, any>).code).toBe('account_assertion_denied');
      const invalid = await post('http-invalid', { ...body, title: '' });
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get('content-type')).toContain('application/problem+json');
      const wrongActor = await post('http-wrong-actor', { ...body,
        actingSubject: `https://rezics.com/id/${Bun.randomUUIDv7()}` });
      expect(wrongActor.status).toBe(403);
      expect((await wrongActor.json() as Record<string, any>).code).toBe('authority_denied');
      class UnavailableOnceClient extends FusekiClient {
        unavailable = true;
        override async query(sparql: string) {
          if (this.unavailable) {
            this.unavailable = false;
            throw new Error('simulated graph timeout before dispatch');
          }
          return super.query(sparql);
        }
      }
      const uncertain = createMainApp(fuseki, { environment: { ...env,
        fuseki: new UnavailableOnceClient(fusekiUrl) }, account, access });
      const uncertainPort = await freePort();
      uncertain.listen({ hostname: '127.0.0.1', port: uncertainPort });
      try {
        const unavailableResponse = await fetch(`http://127.0.0.1:${uncertainPort}/v1/works`, {
          method: 'POST', headers: { authorization: 'Bearer verified-fixture',
            'idempotency-key': 'http-pending', 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, title: 'Pending then recovered Work' }),
        });
        expect(unavailableResponse.status).toBe(503);
        const unavailableBody = await unavailableResponse.json() as Record<string, any>;
        expect(unavailableBody.code).toBe('dependency_unavailable');
        expect(JSON.stringify(unavailableBody)).not.toContain(principalId);
        expect((await pool.query("SELECT id FROM access.admission WHERE idempotency_key = 'http-pending'"))
          .rowCount).toBe(0);
      } finally {
        await uncertain.stop();
      }
      const recovered = await post('http-pending', { ...body, title: 'Pending then recovered Work' });
      expect(recovered.status).toBe(201);
      expect((await recovered.json() as Record<string, any>).sourcePosition.sequence).toBe('6');
      let failOutcomeOnce = true;
      const flakyAccess = {
        register: access.register.bind(access), claim: access.claim.bind(access),
        canReadWork: access.canReadWork.bind(access),
        canReadContributionDraft: access.canReadContributionDraft.bind(access),
        canReadStandingRating: access.canReadStandingRating.bind(access),
        canLinkTranslation: access.canLinkTranslation.bind(access),
        canEditWork: access.canEditWork.bind(access),
        activePrincipalId: access.activePrincipalId.bind(access),
        assertRecoveryOpen: access.assertRecoveryOpen.bind(access),
        recordGraphOutcome: async (...args: Parameters<typeof access.recordGraphOutcome>) => {
          if (failOutcomeOnce) {
            failOutcomeOnce = false;
            throw new Error('simulated Access outcome write failure');
          }
          return access.recordGraphOutcome(...args);
        },
      };
      const flaky = createMainApp(fuseki, { environment: env, account, access: flakyAccess });
      const flakyPort = await freePort();
      flaky.listen({ hostname: '127.0.0.1', port: flakyPort });
      try {
        const pendingAfterCommit = await fetch(`http://127.0.0.1:${flakyPort}/v1/works`, {
          method: 'POST', headers: { authorization: 'Bearer verified-fixture',
            'idempotency-key': 'http-after-commit', 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, title: 'Committed but Access uncertain' }),
        });
        expect(pendingAfterCommit.status).toBe(202);
        const afterCommitBody = await pendingAfterCommit.json() as Record<string, any>;
        expect(afterCommitBody.status).toBe('reconciling');
        expect(afterCommitBody.operationId).toMatch(/^urn:rezics:operation:[0-9a-f]{64}$/);
        expect(afterCommitBody.retry).toEqual({ allowed: true, afterMs: 1000 });
      } finally {
        await flaky.stop();
      }
      const afterCommit = await post('http-after-commit', { ...body, title: 'Committed but Access uncertain' });
      expect(afterCommit.status).toBe(200);
      expect((await afterCommit.json() as Record<string, any>).sourcePosition.sequence).toBe('7');
    } finally {
      await workApp.stop();
    }
    const expiredTitle = 'Expired before Work dispatch';
    const expired = await access.register({ principal: { issuer: 'https://account.fixture',
      subject: 'fixture-account' }, actingSubject, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: 'expired-before-dispatch', requestDigest: metadataWorkRequestDigest(expiredTitle, undefined, 'en') });
    await pool.query("UPDATE access.admission SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [expired.id]);
    await expect(createAdmittedMetadataWork(env, account, access, request,
      { actingSubject, idempotencyKey: 'expired-before-dispatch', title: expiredTitle, language: 'en' }))
      .rejects.toBeInstanceOf(CancelledActivation);
    const expiredOutcome = await pool.query<{ state: string; graph_outcome: string }>(
      'SELECT state, graph_outcome FROM access.admission WHERE id = $1', [expired.id]);
    expect(expiredOutcome.rows[0]).toEqual({ state: 'sealed', graph_outcome: 'cancelled' });
    await expect(createAdmittedMetadataWork(env, account, access, request,
      { ...input, title: 'Conflicting title' })).rejects.toBeInstanceOf(AdmissionConflict);
    await expect(createAdmittedMetadataWork(env, account, access,
      new Request(request.url, { method: 'POST' }), { ...input, idempotencyKey: 'unauthenticated' }))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(createAdmittedMetadataWork(env, account, access, request,
      { ...input, idempotencyKey: 'wrong-actor', actingSubject: `https://rezics.com/id/${Bun.randomUUIDv7()}` }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const after = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(after.results?.bindings[0]?.sequence?.value).toBe('8');

    const delayedTitle = 'Cancelled before delayed graph dispatch';
    const pending = await access.register({ principal: { issuer: 'https://account.fixture',
      subject: 'fixture-account' }, actingSubject, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: 'delayed-dispatch', requestDigest: metadataWorkRequestDigest(delayedTitle) });
    const claimedPending = await access.claim(pending.id, pending.requestDigest);
    const winningTitle = 'Claimed work wins before cancellation seal';
    const winning = await access.register({ principal: { issuer: 'https://account.fixture',
      subject: 'fixture-account' }, actingSubject, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: 'wins-after-close', requestDigest: metadataWorkRequestDigest(winningTitle) });
    const claimedWinning = await access.claim(winning.id, winning.requestDigest);
    let signalUpdate!: () => void;
    let releaseUpdate!: () => void;
    const updateStarted = new Promise<void>(resolveStart => { signalUpdate = resolveStart; });
    const updateReleased = new Promise<void>(resolveRelease => { releaseUpdate = resolveRelease; });
    class DelayedUpdateClient extends FusekiClient {
      override async command(envelope: CommandEnvelope): Promise<CommandResult> {
        signalUpdate();
        await updateReleased;
        return super.command(envelope);
      }
    }
    const delayed = activateMetadataWork({ ...env,
      fuseki: new DelayedUpdateClient(fusekiUrl) },
    { admission: claimedPending, title: delayedTitle }).then(() => null, error => error);
    await Promise.race([updateStarted, Bun.sleep(10_000).then(() => {
      throw new Error('delayed graph update never reached dispatch');
    })]);
    const fence = await access.strongCloseScope('work:create:root', '0');
    expect(fence.pending).toBe(2);
    const unavailableSealPort = await freePort();
    const unavailableSeal = await strongRevokeMetadataWorkScope({ ...env,
      fuseki: new FusekiClient(`http://127.0.0.1:${unavailableSealPort}/rezics`) },
    access, fence.authorityEpoch);
    expect(unavailableSeal).toEqual({ scope: 'work:create:root', authorityEpoch: '1',
      status: 'pending', pending: 2 });
    const wonAfterFence = await activateMetadataWork(env, { admission: claimedWinning, title: winningTitle });
    expect(wonAfterFence.sequence).toBe('9');
    const revoked = await strongRevokeMetadataWorkScope(env, access, fence.authorityEpoch);
    expect(revoked).toEqual({ scope: 'work:create:root', authorityEpoch: '1',
      status: 'complete', pending: 0 });
    releaseUpdate();
    expect(await delayed).toBeInstanceOf(CancelledActivation);
    const sealed = await pool.query<{ state: string; graph_outcome: string; graph_sequence: string }>(
      'SELECT state, graph_outcome, graph_sequence FROM access.admission WHERE id = $1', [pending.id]);
    expect(sealed.rows[0]).toEqual({ state: 'sealed', graph_outcome: 'cancelled', graph_sequence: '10' });
    const winningSeal = await pool.query<{ state: string; graph_outcome: string; graph_sequence: string }>(
      'SELECT state, graph_outcome, graph_sequence FROM access.admission WHERE id = $1', [winning.id]);
    expect(winningSeal.rows[0]).toEqual({ state: 'sealed', graph_outcome: 'succeeded', graph_sequence: '9' });
    await expect(access.claim(pending.id, pending.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect(await createAdmittedMetadataWork(env, account, access, request, input))
      .toEqual({ ...bridged, replayed: true });
    await expect(createAdmittedMetadataWork(env, account, access, request,
      { ...input, idempotencyKey: 'after-strong-close' })).rejects.toBeInstanceOf(AdmissionDenied);
    await pool.query("UPDATE access.permission_grant SET active = false WHERE scope_id = 'work:create:root'");
    await expect(createAdmittedMetadataWork(env, account, access, request, input))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const finalPosition = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(finalPosition.results?.bindings[0]?.sequence?.value).toBe('10');
  } finally {
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
