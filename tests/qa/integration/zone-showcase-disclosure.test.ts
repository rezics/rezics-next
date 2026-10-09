import { afterAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import sharp from 'sharp';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { accountEmailQueue } from '../../../services/account/src/email.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION, type ZoneSlide } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { configureDisclosure } from '../../../services/main/src/modules/disclosure/read.ts';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import { imagePresentation } from '../../../packages/ui/src/components/media-image.tsx';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { requireQa } from './recommendation-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

let started: Promise<MediaStack> | undefined;
const verifiedEditors = new Set<string>();
const stack = () => started ??= (async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  try {
    const fixture = await startMediaStack('zone-showcase-disclosure', { ownerUrls: owners.urls });
    attestVerifiedEditors(fixture.composition.dependencies.account);
    return { ...fixture, stop: async () => { try { await fixture.stop(); } finally { await owners.close(); } } };
  } catch (error) { await owners.close(); throw error; }
})();
afterAll(async () => {
  if (started) await (await started).stop();
  if (accountVerification) await (await accountVerification).close();
});

interface AccountAssertion {
  verify: (request: Request, scopes?: readonly string[]) => Promise<{ issuer: string; subject: string }>;
}
/** The media stack's bearer map is its Account assertion. It reports a verified
 * email only after a person completes Account's own verification link. */
function attestVerifiedEditors(account: AccountAssertion) {
  const verify = account.verify.bind(account);
  account.verify = async (request, scopes) => {
    const principal = await verify(request, scopes);
    if (!verifiedEditors.has(`${principal.issuer}\0${principal.subject}`)) return principal;
    const attested = { ...principal, emailVerified: true as const };
    return { ...attested, currentAssertion: async () => attested };
  };
}

let accountVerification: Promise<{ verifyPerson: () => Promise<void>; close: () => Promise<void> }> | undefined;
function accountVerificationService() {
  return accountVerification ??= startAccountVerification();
}
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account port'));
      server.close(() => resolvePort(address.port));
    });
  });
}
async function startAccountVerification() {
  const secret = Bun.env.ACCOUNT_SECRET ?? '';
  const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
  if (secret.length < 32 || !resource) throw new Error('Account verification needs ACCOUNT_SECRET and ACCOUNT_MAIN_RESOURCE');
  const owners = await cloneQaOwnerDatabases(requireQa(), ['account'], 'privileged');
  const pool = new Pool({ connectionString: owners.urls.account });
  let app: ReturnType<typeof createAccountApp> | undefined;
  const close = async () => {
    await app?.stop();
    await pool.end();
    await owners.close();
  };
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const messages: { to: string; text: string }[] = [];
    const email = accountEmailQueue(pool, secret, async mail => { messages.push(mail); }, base);
    const auth = createAccountAuth({ baseURL: base, secret, resource, pool, operatorUserIds: new Set(), email });
    app = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port });
    const request = (path: string, body?: unknown, cookie?: string) => app!.handle(new Request(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { close, verifyPerson: async () => {
      const address = `showcase-${randomUUID()}@example.test`;
      const password = randomBytes(18).toString('base64url');
      const signedUp = await request('/api/auth/sign-up/email', { ...signupPolicyFixture, name: 'Showcase editor', email: address, password });
      const signedUpText = await signedUp.text();
      expect(signedUp.status, signedUpText).toBe(200);
      await email.drain();
      const mail = [...messages].reverse().find(message => message.to === address);
      const link = mail && /https?:\/\/\S+/.exec(mail.text)?.[0];
      if (!link) throw new Error('Account verification message has no link');
      const verified = await request(link);
      const verifiedText = await verified.text();
      expect(verified.status, verifiedText).toBe(302);
      const signedIn = await request('/api/auth/sign-in/email', { email: address, password });
      const signedInText = await signedIn.text();
      expect(signedIn.status, signedInText).toBe(200);
      const session = await request('/api/auth/get-session', undefined, signedIn.headers.get('set-cookie') ?? '');
      const body = await session.json() as { user?: { emailVerified?: boolean } };
      expect(session.status, JSON.stringify(body)).toBe(200);
      expect(body.user?.emailVerified).toBe(true);
    } };
  } catch (error) { await close(); throw error; }
}
async function json<T = Record<string, unknown>>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}
async function fixture(label: string) {
  const s = await stack();
  const structures = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structures.initialize();
  (s.env as typeof s.env & { structureObjects: ImmutableObjects }).structureObjects = structures;
  const editor = await s.member(label);
  await (await accountVerificationService()).verifyPerson();
  verifiedEditors.add(`${editor.principal.issuer}\0${editor.principal.subject}`);
  await editor.grant('space:create:root', 'space.create');
  // Agent provision mints a new Agent. This editor is already the uploader and
  // the Space owner, so the fixture records the active controller that operation
  // would activate for this same Agent.
  await editor.grant(`agent:control:${editor.actor}`, 'agent.control');
  const control = await s.accessPool.query<{ id: string; epoch: string }>(
    `SELECT r.id, p.enforcement_epoch::text AS epoch
     FROM access.representation r JOIN access.principal p ON p.id = r.principal_id
     WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = 'agent.control' AND r.active
     ORDER BY r.id LIMIT 1`, [editor.principalId, editor.actor]);
  const controlId = control.rows[0]?.id;
  if (!controlId) throw new Error('editor controller is missing');
  await s.accessPool.query(
    `INSERT INTO access.agent_provision
    (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
      display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
    VALUES ($1,$2,$3,$4,$5,'person','Showcase editor',$6,'active',$7,0,$8)`,
    [randomUUID(), editor.principalId, randomUUID(), 'a'.repeat(64), editor.actor,
      control.rows[0]!.epoch, s.env.lineage.dataEpoch, controlId]);
  const space = await json<{ space: string; realm: string }>(await editor.send('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: label, capabilities: ['realm'], actingSubject: editor.actor,
  }), 201);
  const zone = `https://rezics.com/id/${randomUUID()}`;
  await editor.grant(`zone:edit:${zone}`, 'zone.edit');
  await json(await editor.send('POST', '/v1/zones', {
    zone, space: space.space, disclosure: 'public', actingSubject: editor.actor,
  }), 201);
  // Campaign art and the public presentation belong to the Realm Space. The
  // content-draft proof admits the Zone named by that Space's creation receipt,
  // and Realm creation does not name the Zone added afterwards.
  await s.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
    INSERT { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:zone ${iri(zone)} } }
    WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:admittedScope "space:create:root" ; rv:space ${iri(space.space)} ;
        rv:owner ${iri(editor.actor)} .
      FILTER NOT EXISTS { ?receipt rv:zone ?named }
    } }`);
  const path = `/v1/zones/${zone.slice(-36)}`;
  const save = async (slides: ZoneSlide[], key?: string, head?: string) => editor.send('PUT', `${path}/configuration`, {
    expectedHead: head ?? (await readZoneConfiguration(s.env, zone)).revision,
    defaultRealm: space.realm, presentation: { ...DEFAULT_ZONE_PRESENTATION, slides }, actingSubject: editor.actor,
  }, key);
  const campaign = async () => {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer();
    const asset = await editor.upload(bytes);
    const use = await json<{ id: string }>(await editor.send('POST', `${path}/campaign-art`, {
      profile: 'zone-campaign-art-v1', realm: space.realm, asset: asset.asset, role: 'cutout', actingSubject: editor.actor,
    }), 201);
    expect(await s.store.itemDelivery(use.id)).toMatchObject({ target: space.realm, width: 32, height: 32,
      availability: 'available', disclosure: 'public', moderation: 'none', lifecycle: 'active' });
    return { ...asset, use: use.id, art: { cutout: { use: `https://rezics.com/id/${use.id}` } } };
  };
  return { ...s, ...space, zone, path, editor, save, campaign };
}

async function finishRenditions(f: MediaStack, use: string) {
  const worker = new MediaRenditionWorker(f.store.renditions, new LocalImageTransformer(), f.objects);
  // Earlier test cases may have queued art without needing its renditions.
  for (let i = 0; i < 32; i++) {
    const candidates = (await f.store.renditions.candidatesBatch([use])).get(use) ?? [];
    if (candidates.length === 2) return candidates;
    await worker.tick();
  }
  throw new Error(`Renditions did not finish: ${JSON.stringify((await f.contentPool.query(
    'SELECT status,reason,attempt FROM media.transform_job WHERE source_id=(SELECT representation_id FROM media.use WHERE id=$1)', [use])).rows)}`);
}

test('public presentation omits future, ended and unreadable Work slides while the editor retains all saved slides', async () => {
  const f = await fixture('showcase-schedules');
  const reader = await f.member('showcase-reader');
  const privateWork = await f.privateWork(f.editor.actor);
  const publicWork = await f.publicWork(f.editor.actor, ['en'], 'Readable featured Work');
  const art = await f.campaign();
  const slides: ZoneSlide[] = [
    { id: 'future', href: '/future', startsAt: new Date(Date.now() + 3_600_000).toISOString(), art: art.art },
    { id: 'ended', href: '/ended', endsAt: new Date(Date.now() - 1000).toISOString(), art: art.art },
    { id: 'private', work: privateWork.work, title: 'Hidden campaign title', art: art.art },
    { id: 'public', work: publicWork.work }, { id: 'link', href: '/current' },
  ];
  await json(await f.save(slides));
  const read = await f.call('GET', `${f.path}/presentation`);
  expect(read.headers.get('cache-control')).toBe('public, no-cache');
  const publicBody = await json<{ presentation: { slides: ZoneSlide[] }; slideMedia: { id: string }[] }>(read);
  expect(publicBody.presentation.slides.map(slide => slide.id)).toEqual(['public', 'link']);
  expect(publicBody.slideMedia.map(slide => slide.id)).toEqual(['public', 'link']);
  expect(JSON.stringify(publicBody)).not.toContain('Hidden campaign title');
  expect(JSON.stringify(publicBody)).not.toContain(art.use);
  expect((await f.call('GET', `/v1/media/uses/${art.use}`)).status).toBe(404);
  const editorBody = await json<{ configuration: { presentation: { slides: ZoneSlide[] } } }>(
    await f.editor.read(`${f.path}/showcase-editor`));
  expect(editorBody.configuration.presentation.slides).toEqual(slides);
  expect(await json(await f.editor.read(`${f.path}/configuration`))).toMatchObject({
    configuration: { presentation: { slides } },
  });
  await reader.grant(`semantic:read:${f.zone}`, 'semantic.read');
  for (const endpoint of ['showcase-editor', 'configuration']) {
    const hidden = await json(await reader.read(`${f.path}/${endpoint}`), 404);
    const missingPath = `/v1/zones/${randomUUID()}/${endpoint}`;
    expect(await json(await reader.read(missingPath), 404)).toEqual(hidden);
    expect(await json(await f.editor.read(missingPath), 404)).toEqual(hidden);
  }
  await reader.grant(`work:read:${privateWork.work}`, 'work.read');
  const memberBody = await json<{ presentation: { slides: ZoneSlide[] } }>(await reader.read(`${f.path}/presentation`));
  expect(memberBody.presentation.slides.map(slide => slide.id)).toEqual(['private', 'public', 'link']);
  const delivered = await reader.read(`/v1/media/uses/${art.use}`);
  expect(delivered.status).toBe(200);
  await delivered.arrayBuffer();
}, 120_000);

test('campaign originals and renditions stop delivering after slide removal, schedule expiry or private Zone disclosure', async () => {
  const f = await fixture('showcase-revocation');
  const art = await f.campaign();
  const slide: ZoneSlide = { id: 'launch', href: '/launch', art: art.art };
  expect((await f.call('GET', `/v1/media/uses/${art.use}`)).status).toBe(404);
  await json(await f.save([slide]));
  const candidates = await finishRenditions(f, art.use);
  expect(candidates).toHaveLength(2);
  const paths = [`/v1/media/uses/${art.use}`, `/v1/media/representations/${art.representation}/bytes?use=${art.use}`,
    ...candidates.map(candidate => candidate.url)];
  const status = async (expected: number) => {
    for (const path of paths) {
      const response = await f.call('GET', path);
      expect(response.status, path).toBe(expected);
      if (response.ok) await response.arrayBuffer();
    }
  };
  await status(200);
  expect((await f.call('GET', `/v1/media/representations/${art.representation}/bytes`)).status).toBe(404);
  await json(await f.save([]));
  await status(404);
  await json(await f.save([{ ...slide, endsAt: new Date(Date.now() - 1000).toISOString() }]));
  await status(404);
  await json(await f.save([slide]));
  await status(200);
  await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
    DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.zone)} rv:disclosure rv:Public } }
    INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(f.zone)} rv:disclosure rv:Private } }
    WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.zone)} rv:disclosure rv:Public } }`);
  await status(404);
}, 120_000);

test('held campaign art is absent from the public and editor art batch and cannot deliver bytes', async () => {
  const f = await fixture('showcase-held');
  const art = await f.campaign();
  const work = await f.publicWork(f.editor.actor, ['en'], 'Work whose own art remains the fallback');
  await json(await f.save([{ id: 'held', work: work.work, art: art.art }]));
  configureDisclosure(f.env, { read: async targets => targets.map(target =>
    target.owner === 'media' && target.resource.endsWith(art.use) ? 'hidden' : 'visible') });
  try {
    for (const response of [await f.call('GET', `${f.path}/presentation`), await f.editor.read(`${f.path}/showcase-editor`)]) {
      expect(await json(response)).toMatchObject({ slideMedia: [{ id: 'held', art: { cutout: null } }] });
    }
    expect((await f.call('GET', `/v1/media/uses/${art.use}`)).status).toBe(404);
    expect((await f.call('GET', `/v1/media/representations/${art.representation}/bytes?use=${art.use}`)).status).toBe(404);
  } finally { configureDisclosure(f.env, null); }
}, 120_000);

test('a save commits and seals before rendition storage fails, and subsequent text edits request no existing Uses', async () => {
  const f = await fixture('showcase-save');
  const source = await f.editor.upload(await sharp({ create: { width: 32, height: 32, channels: 4,
    background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer());
  const use = randomUUID();
  const basis = (await f.store.publicationBasis([source.asset], f.editor.actor))[0]!;
  await f.store.createPublicationUses(randomUUID(), f.editor.actor, f.realm, [{ ...basis, use }]);
  expect(await f.store.itemDelivery(use)).toMatchObject({ role: 'publication-item', target: f.realm });
  const key = randomUUID();
  const before = (await readZoneConfiguration(f.env, f.zone)).revision;
  const slides: ZoneSlide[] = [{ id: 'launch', href: '/launch', art: { cutout: { use: `https://rezics.com/id/${use}` } } }];
  const requestBasis = f.store.renditions.requestBasis.bind(f.store.renditions);
  let reads = 0;
  let observed: { head: string; admissionState: string } | undefined;
  f.store.renditions.requestBasis = async () => {
    reads++;
    observed = { head: (await readZoneConfiguration(f.env, f.zone)).revision,
      admissionState: (await f.accessPool.query('SELECT state FROM access.admission WHERE idempotency_key=$1', [key])).rows[0].state };
    throw new Error('rendition storage unavailable');
  };
  try {
    const saved = await json<{ revision: string }>(await f.save(slides, key, before));
    expect(saved.revision).not.toBe(before);
    expect(reads).toBe(1);
    expect(observed).toEqual({ head: saved.revision, admissionState: 'sealed' });
    expect(await json(await f.save(slides, key, before))).toMatchObject({ revision: saved.revision, replayed: true });
    await json(await f.save([{ ...slides[0]!, title: 'Copy only' }]));
    expect(reads).toBe(1);
    expect((await f.contentPool.query('SELECT id FROM media.transform_job WHERE source_id=$1', [source.representation])).rows).toHaveLength(0);
  } finally { f.store.renditions.requestBasis = requestBasis; }
}, 120_000);

test('a default-masked rendition becomes visible from source SFW labels and stops deriving each field when labelled itself', async () => {
  const f = await fixture('showcase-labels');
  const art = await f.campaign();
  await f.editor.grant(`media:owner:${f.editor.actor}`, 'media.labels');
  const label = async (representation: string, field: 'nsfw' | 'ageRating', value: unknown) => {
    const metadata = (await f.store.presentation.metadata([{ representation }]))[0]!.metadata;
    const control = metadata.controls[field];
    await json(await f.editor.send('POST', `/v1/media/representations/${representation}/labels`, {
      actingSubject: f.editor.actor, field, value, mode: 'edit',
      expectedValueHead: control.valueHead, basis: control.basis,
    }), 201);
  };
  await label(art.representation, 'nsfw', 'unknown');
  await json(await f.save([{ id: 'launch', href: '/launch', art: art.art }]));
  const candidate = (await finishRenditions(f, art.use))[0]!;
  const representation = new URL(candidate.url, 'http://main.local').pathname.split('/')[4]!;
  const metadata = async () => (await f.store.presentation.metadata([{ representation, use: art.use }]))[0]!.metadata;
  const viewer = { ready: true, signedIn: false, age: 'unknown' as const,
    optIns: { general: true, r15: false, sexual: false, grotesque: false }, nsfwDisplay: 'mask' as const };
  expect(imagePresentation(await metadata(), viewer)).toBe('masked');
  await label(art.representation, 'nsfw', 'sfw');
  expect(await json(await f.call('GET', `/v1/media/representations/${representation}?use=${art.use}`))).toMatchObject({
    nsfw: 'sfw', nsfwSourceId: `https://rezics.com/id/${art.representation}`,
  });
  expect(imagePresentation(await metadata(), viewer)).toBe('visible');
  await label(art.representation, 'ageRating', { status: 'assessed', labels: ['r15'] });
  expect((await metadata()).ageRating).toMatchObject({ basis: 'source', sourceId: `https://rezics.com/id/${art.representation}`, labels: ['r15'] });
  await label(representation, 'nsfw', 'unknown');
  await label(representation, 'ageRating', { status: 'unassessed' });
  expect(await metadata()).toMatchObject({ nsfw: 'unknown', nsfwSourceId: null, ageRating: { status: 'unassessed' } });
}, 120_000);
