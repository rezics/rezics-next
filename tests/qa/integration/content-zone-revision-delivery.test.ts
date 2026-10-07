import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readZoneConfiguration, type ZoneSitePublicationReceipt }
  from '../../../services/main/src/modules/zone/configuration.ts';
import { isZonePublishedPageRevision } from '../../../services/main/src/modules/zone/publication.ts';
import { startMediaStack } from './media-support.ts';

interface Draft { revisionId: string; variantId: string; byteDigest: string }
interface Exact { reference: { resourceId: string; revisionId: string; byteDigest: string };
  serializedJson: string; body: { body: string; document: unknown } }

async function json<T>(response: Response, expected = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function gate() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, pause: async () => { entered(); await released; } };
}

async function fixture() {
  const stack = await startMediaStack('content-zone-delivery', { library: true, agents: true });
  try {
    const member = await stack.member('site-editor');
    const principal = { ...member.principal, emailVerified: true as const };
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    Object.assign(stack.env, { structureObjects: objects });
    let paused: ReturnType<typeof gate> | undefined;
    const access = new Proxy(stack.access, { get(target, property) {
      if (property === 'assertRecoveryOpen') return async () => {
        await target.assertRecoveryOpen();
        const pending = paused;
        paused = undefined;
        if (pending) await pending.pause();
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = createMainApp(stack.fuseki, { environment: stack.env, access,
      structureObjects: objects,
      content: stack.content, contentAuthoring: stack.content,
      account: { verify: async () => ({ ...principal, currentAssertion: async () => principal }) } });
    const person = async (displayName: string) => (await json<{ agent: string }>(await member.send('POST',
      '/v1/agents', { profile: 'agent-provision-v1', kind: 'person', displayName }), 201)).agent;
    const actor = await person('Site author');
    const otherActor = await person('Other site identity');
    // Withdrawing the reader's mandate must leave the Agent's controller floor intact.
    const backup = await stack.member('remaining-controller');
    await stack.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity'::timestamptz)`,
    [randomUUID(), backup.principalId, actor]);
    const call = (method: string, path: string, body?: unknown, authenticated = true) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { ...(authenticated ? { authorization: `Bearer ${member.token}` } : {}),
          'idempotency-key': randomUUID(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    const created = await json<{ space: string; zone: string; navigationRevision: string }>(await call('POST',
      '/v1/spaces', { profile: 'space-zone-v1', name: 'Exact document site',
        capabilities: ['zone'], actingSubject: actor }), 201);
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = async (document: DocumentSnapshot, expectedHead: string | null) => json<Draft>(await call('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: created.zone, variantId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead, document, actingSubject: actor }), 201);
    const firstDocument = fromPlainText('Selected exact site document');
    const first = await draft(firstDocument, null);
    const later = await draft(fromPlainText('Unpublished replacement document'), first.revisionId);
    const publish = async (saved: Draft) => json<ZoneSitePublicationReceipt>(await call('POST',
      `/v1/zones/${created.zone.slice(-36)}/site-publications`, {
        pages: [{ page: created.zone, variantId, revisionId: saved.revisionId }],
        routesRevision: created.navigationRevision, navigationRevision: created.navigationRevision,
        expectedHead: (await readZoneConfiguration(stack.env, created.zone)).revision, actingSubject: actor,
      }), 201);
    const read = (saved: Draft, editor = false) => call('GET', `/v1/content-revisions/${saved.revisionId}`
      + (editor ? `?actingSubject=${encodeURIComponent(actor)}` : ''), undefined, editor);
    const pauseRead = (saved: Draft, editor = false) => {
      const barrier = gate();
      paused = barrier;
      const pending = Promise.resolve(read(saved, editor));
      const reached = Promise.race([barrier.reached, pending.then(response => {
        throw new Error(`Exact request returned HTTP ${response.status} before deliverability pause`);
      })]);
      return { pending, reached, release: barrier.release };
    };
    return { ...stack, ...created, actor, otherActor, editorPrincipalId: member.principalId,
      firstDocument, first, later, publish, read, pauseRead };
  } catch (error) { await stack.stop(); throw error; }
}

test('exact Zone delivery refuses actual bundle, controller and owner withdrawal after paused deliverability; recovery keeps exact bytes', async () => {
  const f = await fixture();
  try {
    const privateExact = await json<Exact>(await f.read(f.first, true));
    expect(privateExact.reference).toMatchObject({ resourceId: f.zone,
      revisionId: f.first.revisionId, byteDigest: f.first.byteDigest });
    expect(privateExact.body.document).toEqual(f.firstDocument);
    expect((await f.read(f.first)).status).toBe(404);
    await f.publish(f.first);
    const healthy = f.pauseRead(f.first);
    try { await healthy.reached; } finally { healthy.release(); await healthy.pending; }
    expect(await json<Exact>(await healthy.pending)).toEqual(privateExact);
    expect(await isZonePublishedPageRevision(f.env, f.zone, f.zone, f.first.revisionId)).toBe(true);

    const bundle = f.pauseRead(f.first);
    try {
      await bundle.reached;
      await f.publish(f.later);
      expect(await isZonePublishedPageRevision(f.env, f.zone, f.zone, f.first.revisionId)).toBe(false);
    } finally { bundle.release(); await bundle.pending; }
    const withdrawn = await bundle.pending;
    expect(withdrawn.status).toBe(404);
    expect(await withdrawn.text()).not.toContain(privateExact.serializedJson);
    expect((await f.read(f.first)).status).toBe(404);
    expect(await json<Exact>(await f.read(f.first, true))).toEqual(privateExact);

    for (const withdrawal of ['controller', 'owner'] as const) {
      const privateRead = f.pauseRead(f.first, true);
      let revokedIds: string[] = [];
      let changedOwner = false;
      try {
        try {
          await privateRead.reached;
          if (withdrawal === 'controller') {
            const revoked = await f.accessPool.query<{ id: string }>(`UPDATE access.representation SET active = false
              WHERE subject_id = $1 AND principal_id = $2 AND action = 'agent.control' AND active RETURNING id`,
            [f.actor, f.editorPrincipalId]);
            revokedIds = revoked.rows.map(row => row.id);
            expect(revokedIds.length).toBeGreaterThan(0);
          } else {
            await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
              DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:owner ${iri(f.actor)} } }
              INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:owner ${iri(f.otherActor)} } }
              WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:owner ${iri(f.actor)} } }`);
            changedOwner = true;
          }
        } finally { privateRead.release(); await privateRead.pending; }
        const refused = await privateRead.pending;
        expect(refused.status).toBe(404);
        const body = await refused.text();
        expect(body).not.toContain('Selected exact site document');
        expect(body).not.toContain('serializedJson');
        // Editor withdrawal does not withdraw the distinct live public bundle.
        expect((await f.read(f.later)).status).toBe(200);
      } finally {
        if (revokedIds.length) await f.accessPool.query(`UPDATE access.representation
          SET active = true WHERE id = ANY($1::uuid[])`, [revokedIds]);
        if (changedOwner) await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
          DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:owner ${iri(f.otherActor)} } }
          INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:owner ${iri(f.actor)} } }
          WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:owner ${iri(f.otherActor)} } }`);
      }
      expect(await json<Exact>(await f.read(f.first, true))).toEqual(privateExact);
      expect((await f.read(f.first)).status).toBe(404);
    }
    await f.publish(f.first);
    expect(await json<Exact>(await f.read(f.first))).toEqual(privateExact);
  } finally { await f.stop(); }
}, 240_000);
