import { ObservedFuseki } from './support/observed-fuseki.ts';
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionUnavailable,
  engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { saveAdmittedContentDraft }
  from '../../../services/main/src/modules/content-publication/draft.ts';
import { CONTENT_PRIVATE_SEARCH_COST, prepareAdmittedPrivateContentPhrase }
  from '../../../services/main/src/modules/content-publication/search-private.ts';
import { contentPrivateUnit }
  from '../../../services/main/src/modules/content-publication/search-private-projection.ts';
import { PrivateSearchSettlement }
  from '../../../services/main/src/modules/contribution/private-search-settlement.ts';
import { ContentSearchReadAccess }
  from '../../../services/main/src/modules/search-disclosure/content-read-lease.ts';
import { activateMetadataWork, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Content test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('SEARCH11: private Content draft uses an Access lease, exact unit and receipt-fenced delivery', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `content-private-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const fuseki = new ObservedFuseki(Bun.env.FUSEKI_URL);
    const env = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: join(state, 'objects') };
    const title = `Private Content ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title, admission: {
      id: randomUUID(), scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `content-private-${randomUUID()}`,
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const principal = { issuer: 'https://qa-content-private.test', subject: randomUUID() };
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
    const draftScope = `content:draft:${created.work}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [draftScope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'content.draft', now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'content.draft', now() + interval '1 hour')`,
    [randomUUID(), actor, draftScope]);
    const bodyTerm = `secret${randomUUID().replaceAll('-', '')}`;
    const body = `${bodyTerm} private Content body`;
    const saved = await saveAdmittedContentDraft(env, content, { verify: async () => principal },
      new AccessAdmissionRegistry(accessPool), new Request('http://main.local/v1/content-drafts',
        { headers: { authorization: 'Bearer qa' } }),
      { resourceId: created.work, variant: { id: variant, resourceId: created.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, body, actingSubject: actor, idempotencyKey: `draft-${randomUUID()}` });
    expect(saved.outcome).toBe('succeeded');
    const searchAccess = new ContentSearchReadAccess(accessPool);
    const readScope = `work:read:${created.work}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await expect(searchAccess.admit(principal, actor, created.work, variant))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.read', now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', now() + interval '1 hour')`,
    [randomUUID(), actor, readScope]);
    const settlement = new PrivateSearchSettlement(accessPool);
    const readStart = fuseki.queries.length + fuseki.healthReads;
    const commandStart = fuseki.commands;
    const queryStart = fuseki.queries.length;
    const session = await prepareAdmittedPrivateContentPhrase(env, content, searchAccess,
      settlement, principal, actor, { resource: created.work, variant, phrase: bodyTerm });
    let frame = '';
    expect(await session.send(message => { frame = message; return 1; })).toBe(1);
    const matchingQueries = fuseki.queries.slice(queryStart)
      .filter(query => query.includes('text:query'));
    expect(matchingQueries).toHaveLength(2);
    expect(matchingQueries.every(query => query.includes(`<${contentPrivateUnit(saved.revisionId!)}>`)))
      .toBe(true);
    expect(fuseki.queries.length + fuseki.healthReads - readStart)
      .toBeLessThanOrEqual(CONTENT_PRIVATE_SEARCH_COST.fusekiReads);
    expect(fuseki.commands - commandStart).toBe(CONTENT_PRIVATE_SEARCH_COST.graphCommands);
    const offered = JSON.parse(frame) as { type: string; leaseId: string; receiptChallenge: string;
      result: { total: number; results: Array<{ variant: string; revision: string }> } };
    expect(offered.type).toBe('private-content-result-v1');
    expect(offered.result).toMatchObject({ total: 1,
      results: [{ variant, revision: saved.revisionId }] });
    expect(frame).not.toContain(body);
    expect(frame).not.toMatch(/score|snippet|facet|population/);
    expect(await session.receipt({ type: 'private-content-receipt-v1',
      leaseId: offered.leaseId, receiptChallenge: offered.receiptChallenge })).toBe(true);
    const lease = (await accessPool.query<{ state: string }>(
      'SELECT state FROM access.search_read_lease WHERE id = $1', [offered.leaseId])).rows[0];
    expect(lease?.state).toBe('delivered');
    const rawPublic = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE {
        GRAPH <urn:rezics:search:public> {
          (?unit ?score) text:query (rv:searchBody ${JSON.stringify(`"${bodyTerm}"`)} 2) .
        }
      }`);
    expect(rawPublic.results?.bindings).toEqual([]);

    // A changed Content head after the Access arm withholds the old match.
    const stale = await prepareAdmittedPrivateContentPhrase(env, content, searchAccess,
      settlement, principal, actor, { resource: created.work, variant, phrase: bodyTerm });
    const nextTerm = `nextsecret${randomUUID().replaceAll('-', '')}`;
    const next = await saveAdmittedContentDraft(env, content, { verify: async () => principal },
      new AccessAdmissionRegistry(accessPool), new Request('http://main.local/v1/content-drafts',
        { headers: { authorization: 'Bearer qa' } }),
      { resourceId: created.work, variant: { id: variant, resourceId: created.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: saved.revisionId, body: `${nextTerm} next private body`,
      actingSubject: actor, idempotencyKey: `edit-${randomUUID()}` });
    expect(next.outcome).toBe('succeeded');
    await expect(stale.send(() => { throw new Error('stale frame was offered'); }))
      .rejects.toThrow('Content private source moved before delivery');
    const staleRows = (await accessPool.query<{ state: string }>(
      `SELECT state FROM access.search_read_lease WHERE target_kind = 'content-variant'
       AND content_variant = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [variant])).rows;
    expect(staleRows[0]?.state).toBe('withheld');

    const fresh = await prepareAdmittedPrivateContentPhrase(env, content, searchAccess,
      settlement, principal, actor, { resource: created.work, variant, phrase: nextTerm });
    let freshFrame = '';
    expect(await fresh.send(message => { freshFrame = message; return 1; })).toBe(1);
    const freshOffer = JSON.parse(freshFrame) as typeof offered;
    expect(freshOffer.result).toMatchObject({ total: 1,
      results: [{ variant, revision: next.revisionId }] });
    expect(await fresh.receipt({ type: 'private-content-receipt-v1',
      leaseId: freshOffer.leaseId, receiptChallenge: freshOffer.receiptChallenge })).toBe(true);
    const oldPosting = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE {
        GRAPH <urn:rezics:search:private> {
          (<${contentPrivateUnit(saved.revisionId!)}> ?score) text:query
            (rv:privateSearchBody ${JSON.stringify('privateBody:*')} 2) .
        }
      }`);
    expect(oldPosting.results?.bindings).toEqual([]);

    const generation = await engageAccessRecoveryFence(accessPool);
    await expect(searchAccess.admit(principal, actor, created.work, variant))
      .rejects.toBeInstanceOf(AdmissionUnavailable);
    await releaseAccessRecoveryFence(accessPool, generation);

    // The installed route verifies Account before upgrading, then carries one
    // result frame and its exact receipt over the socket.
    const app = createMainApp(fuseki, { environment: env,
      account: { verify: async () => principal }, access: new AccessAdmissionRegistry(accessPool),
      contentPrivateSearch: { content, access: searchAccess, settlement } });
    app.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const path = `http://127.0.0.1:${app.server!.port}/v1/private-content-queries`;
      const discovery = await fetch(path, { method: 'POST', headers: {
        authorization: 'Bearer reader', 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'private-content-phrase-v1', resource: created.work,
        variant, actingSubject: actor, phrase: nextTerm }) });
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toEqual({ transport: 'websocket', path: '/v1/private-content-queries' });
      const socketClient = new WebSocket(path.replace('http:', 'ws:'),
        { headers: { authorization: 'Bearer reader' } } as unknown as string[]);
      const delivered = await new Promise<{ frame: string; close: number }>((resolveSocket, reject) => {
        let received = '';
        const timeout = setTimeout(() => reject(new Error('Content private socket timed out')), 15_000);
        socketClient.onopen = () => socketClient.send(JSON.stringify({
          type: 'private-content-query-v1', profile: 'private-content-phrase-v1',
          resource: created.work, variant, actingSubject: actor, phrase: nextTerm }));
        socketClient.onmessage = event => {
          received = String(event.data);
          const value = JSON.parse(received) as typeof offered;
          socketClient.send(JSON.stringify({ type: 'private-content-receipt-v1',
            leaseId: value.leaseId, receiptChallenge: value.receiptChallenge }));
        };
        socketClient.onclose = event => { clearTimeout(timeout);
          resolveSocket({ frame: received, close: event.code }); };
        socketClient.onerror = () => { clearTimeout(timeout); reject(new Error('Content private socket failed')); };
      });
      expect(delivered.close).toBe(1000);
      expect(JSON.parse(delivered.frame)).toMatchObject({ type: 'private-content-result-v1',
        result: { total: 1, results: [{ variant, revision: next.revisionId }] } });
    } finally { await app.stop(); }

    // Two Main replicas can admit the same variant concurrently; strong
    // closure sees both begun deliveries until each reaches a terminal state.
    const replica = new ContentSearchReadAccess(accessPool);
    const [pending, concurrent] = await Promise.all([
      searchAccess.admit(principal, actor, created.work, variant),
      replica.admit(principal, actor, created.work, variant),
    ]);
    expect(pending.id).not.toBe(concurrent.id);
    await Promise.all([
      searchAccess.begin(pending.id, principal, actor, created.work, variant),
      replica.begin(concurrent.id, principal, actor, created.work, variant),
    ]);
    const closure = await new AccessAdmissionRegistry(accessPool).strongCloseScope(readScope, '0');
    expect(closure.pendingReads).toBe(2);
    await Promise.all([searchAccess.finish(pending.id, 'aborted'),
      replica.finish(concurrent.id, 'aborted')]);
    expect((await new AccessAdmissionRegistry(accessPool).strongCloseScope(
      readScope, closure.authorityEpoch)).pendingReads).toBe(0);
  } finally {
    await accessPool.end();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 60_000);
