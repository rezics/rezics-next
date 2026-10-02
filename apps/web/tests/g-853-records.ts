// The records the G-853 e2e reads, written through Main's public routes on an isolated QA stack: the Light Novels
// and Visual Novels Zones (official route segments, their packages approved for exactly the digest this build
// carries), Sword Art Online as a series of three volumes, and four visual novels whose releases separate
// "English + Windows + complete" from a title that merely looks right.
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { packageDigest } from '@rezics/zone-sdk';
import { applyLnVnZones } from '../../../scripts/dev/seed/ln-vn-zones-step.ts';
import type { SeedPort } from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import type { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import type { ReleaseV2Write } from '../../../services/main/src/modules/release/schema.ts';
import type { RealizationWrite } from '../../../services/main/src/modules/realization/schema.ts';
import { type Catalogue, seedCatalogue } from './g-838-catalogue.ts';

type Stack = Awaited<ReturnType<typeof startMediaStack>>;

const ID = 'https://rezics.com/id/';
const short = (iri: string) => iri.slice(-36);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const id = () => `${ID}${randomUUID()}`;

/** The digest the web build computes for a package: `packageDigest` over every file of its directory. */
function sourceDigest(slug: string): Promise<string> {
  const directory = resolve(import.meta.dir, '../zones/official', slug);
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(directory, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(directory);
  return packageDigest(files);
}

export interface Seed {
  sao: Catalogue['sao'];
  vn: Record<'garden' | 'trial' | 'fable' | 'shared', { work: string }>;
  translator: string;
  zones: { visual: string; light: string };
}

export async function seedZones(stack: Stack, reader: { principalId: string; actingSubject: string },
  scratch: string): Promise<Seed> {
  const { principalId, actingSubject } = reader;
  const json = async <T>(response: Response, status = 200, label = response.url): Promise<T> => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`${label}: expected ${status}, got ${response.status}: ${text.slice(0, 600)}`);
    return JSON.parse(text) as T;
  };
  /** Commands that Main settles in the background answer 202 until they finish. */
  const settle = async (send: (key: string) => Promise<Response>, status: number, label?: string): Promise<unknown> => {
    const key = randomUUID();
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await send(key);
      if (response.status !== 202) return json(response, status, label);
      await response.text();
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error('A command stayed pending');
  };

  const grantReader = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), principalId, actingSubject, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), actingSubject, scope, action]);
  };

  // The series: Sword Art Online, three volumes in English (G-838's records, readable by the web member).
  const catalogue: Catalogue = await seedCatalogue(stack, { principalId, actor: actingSubject }, scratch);

  // The Zone editor: a member and a represented Agent, as the G-852 integration test builds one.
  const editor = await stack.member('zone-editor');
  const provisioned = await json<{ agent: string }>(await editor.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Zone editor' }, 'g853-editor'), 201);
  const zoneActor = provisioned.agent;
  const grant = async (scope: string, action: string) => {
    const client = await stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      const represented = await client.query(`SELECT id FROM access.representation
        WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active AND valid_until > now()`,
      [editor.principalId, zoneActor, action]);
      if (!represented.rowCount) await client.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,now() + interval '4 hours')`,
      [randomUUID(), editor.principalId, zoneActor, action]);
      const allowed = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active AND valid_until > now()`,
      [zoneActor, scope, action]);
      if (!allowed.rowCount) await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '4 hours')`, [randomUUID(), zoneActor, scope, action]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const request: SeedPort['request'] = async (method, path, body, key) => {
    const response = await stack.call(method, path, { token: editor.token, body, key });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) as unknown : null; } catch { /* a text body */ }
    return { status: response.status, body: parsed };
  };
  const port: SeedPort = { actingSubject: zoneActor, request, grant };
  /** `keyInBody` is for the commands that take their idempotency key in the body as well as the header. */
  const post = async <T>(path: string, body: object, status = 201, method = 'POST', keyInBody = true): Promise<T> =>
    settle(key => stack.call(method, path, { token: editor.token, body: keyInBody ? { ...body, idempotencyKey: key } : body,
      key }), status, `${method} ${path}`) as Promise<T>;

  // Visual novels: each one's releases decide the filter. A fan translation is credited to its group.
  const translator = await json<{ agent: string }>(await editor.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Moonlight Translators' }, 'g853-translator'), 201);
  const vnEditor = await stack.member('vn-editor');
  interface Vn { work: string; mainVersion: string; contribution: string; decision: string; title: string }
  const novel = async (title: string): Promise<Vn> => {
    const created = await stack.publicWork(vnEditor.actor, ['ja'], title);
    await vnEditor.grant(`work:edit:${created.work}`, 'work.edit');
    await vnEditor.grant(`work:read:${created.work}`, 'work.read');
    await grantReader(`work:read:${created.work}`, 'work.read');
    await grant(`work:read:${created.work}`, 'work.read');
    return { work: created.work, mainVersion: created.mainVersion, contribution: created.variants[0]!.contribution,
      decision: created.variants[0]!.decision, title };
  };
  const text = async (vn: Vn, language: string, over: Partial<RealizationWrite> = {}) => {
    const body = { profile: 'realization-v1', expectedHead: null, actingSubject: vnEditor.actor, id: id(), language,
      kind: language === 'ja' ? 'original' : 'translation', translators: language === 'ja' ? [] : [vnEditor.actor],
      publishers: [vnEditor.actor], source: { kind: 'unresolved', work: vn.work }, status: 'official',
      verification: 'verified', evidence: id(), ...over } as RealizationWrite;
    const saved = await json<{ revision: string }>(await vnEditor.send('PUT',
      `/v1/works/${short(vn.work)}/realizations/${short(body.id)}`, body));
    return { realization: body.id, revision: saved.revision, completeness: 'complete' as const };
  };
  const release = async (vn: Vn, coverage: ReleaseV2Write['coverage'], platform: string,
    over: Partial<ReleaseV2Write> = {}) => {
    const body: ReleaseV2Write = { profile: 'release-v2', expectedHead: null, actingSubject: vnEditor.actor, id: id(),
      kind: 'formal', status: 'official', title: { value: `${vn.title} release`, language: 'en' }, titleLanguage: 'en',
      tracklistLanguage: null, editionStatement: null, publisher: null, publicationYear: null, isbn13: null,
      originalUrl: null, fixedRelease: null, evidence: null, identifiers: [], platform, territory: 'US', coverage, ...over };
    await json(await vnEditor.send('PUT', `/v1/works/${short(vn.work)}/releases/${short(body.id)}`, body));
    return body.id;
  };
  // One write at a time: each moves the graph the next one is checked against.
  const garden = await novel('Moonlit Garden');
  await release(garden, [await text(garden, 'ja')], 'Windows');
  const gardenEn = await text(garden, 'en');
  await release(garden, [gardenEn], 'Windows');

  const trial = await novel('Trial Only Tale');
  await release(trial, [await text(trial, 'ja')], 'Windows');
  await release(trial, [{ ...await text(trial, 'en'), completeness: 'trial' }], 'Windows');

  const fable = await novel('Fan Translated Fable');
  await release(fable, [await text(fable, 'ja')], 'Windows');
  const fan = await text(fable, 'en', { status: 'unofficial', translators: [translator.agent] });
  await release(fable, [fan], 'Windows', { status: 'unofficial' });

  const shared = await novel('Starlit Crossing');
  await release(shared, [await text(shared, 'ja')], 'Windows');
  await release(shared, [await text(shared, 'en')], 'Switch');

  const zones = await applyLnVnZones({ port, vnWorks: [garden, trial, fable, shared].map(item => ({ vndb: item.title,
    iri: item.work })), showcaseIri: shared.work, extraBooks: [catalogue.sao.series.work,
    ...catalogue.sao.volumes.map(volume => volume.work)] });
  const visual = zones.zones.find(zone => zone.id === 'visual-novels')!;
  const light = zones.zones.find(zone => zone.id === 'light-novels')!;

  // A Zone's release browse looks through the Works its Realm adopted: adopt the novels into theirs.
  await grant(`publication:adopt:${visual.realm}`, 'publication.adopt');
  for (const vn of [garden, trial, fable, shared]) {
    await post('/v1/publication-selections', { profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: visual.realm }, work: vn.work, mainVersion: vn.mainVersion,
      contribution: vn.contribution, publicationDecision: vn.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: zoneActor }, 201, 'POST', false);
  }

  // Each package is approved for exactly the source this build carries, reviewed by another account.
  const reviewer = await stack.member('theme-reviewer');
  const presentationOf = async (zone: string) => {
    const read = await request('GET', `/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(zoneActor)}`);
    if (read.status !== 200) throw new Error(`zone configuration: ${read.status} ${JSON.stringify(read.body)}`);
    return read.body as { revision: string; name: string; language: string;
      configuration: { defaultRealm: string | null; official: Record<string,never> | null; presentation: object } };
  };
  for (const [slug, record, slots] of [['visual-novels', visual, ['footer', 'workCard']],
    ['light-novels', light, ['footer', 'workCard', 'module:shelf', 'index']]] as const) {
    const theme = id();
    const digest = await sourceDigest(slug);
    for (const [scope, action] of [['theme:create:root', 'theme.create'], [`theme:revise:${short(theme)}`, 'theme.revise'],
      [`theme:activate:${short(theme)}`, 'theme.activate']]) await grant(scope, action);
    await reviewer.grant(`theme:review:${short(theme)}`, 'theme.review');
    await post('/v1/themes', { theme: short(theme), owner: zoneActor, hostZone: record.zone, actingSubject: zoneActor });
    const file = `assets/${slug}/main.js`;
    const bundle = { profile: 'first-party-bundle-v1', hostZone: record.zone, packageDigest: digest, entry: file,
      files: [{ path: file, digest: sha(`${slug}:${digest}`), gzipBytes: 1000 }], slots: [...slots],
      connectOrigins: [], imageOrigins: [], fontOrigins: [] };
    const revision = await post<{ operation: string }>(`/v1/themes/${short(theme)}/revisions`,
      { expectedRevision: null, bundle, actingSubject: zoneActor });
    await settle(key => stack.call('POST', `/v1/themes/${short(theme)}/revisions/${short(revision.operation)}/reviews`, {
      token: reviewer.token, key, body: { decision: 'approved', reviewEvidenceDigest: sha(`reviewed ${digest}`),
        actingSubject: reviewer.actor, idempotencyKey: key } }), 201, 'review');
    await post(`/v1/themes/${short(theme)}/first-party-activations`, { revision: revision.operation,
      expectedActivation: null, approvalExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      actingSubject: zoneActor });
    // The Zone names the theme its design comes from.
    const current = await presentationOf(record.zone);
    await post(`/v1/zones/${short(record.zone)}/configuration`, {
      expectedHead: current.revision, actingSubject: zoneActor, name: current.name, language: current.language,
      defaultRealm: current.configuration.defaultRealm, official: current.configuration.official,
      presentation: { ...current.configuration.presentation, official: { theme } } }, 200, 'PUT', false);
  }

  return { sao: catalogue.sao, vn: { garden, trial, fable, shared }, translator: translator.agent,
    zones: { visual: visual.realm, light: light.realm } };
}
