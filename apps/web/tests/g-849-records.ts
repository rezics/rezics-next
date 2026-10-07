// The records the G-849 e2e reads, written through Main's public routes on an isolated QA stack: the franchise wiki
// Zone made from `config/zones/franchise-wiki.json` (an official route segment, its package approved for exactly the
// digest this build carries), a Work with three chapters, and a reviewed wiki bundle that a steward applies. The
// wiki seed in `scripts/dev/seed` is G-909's; this is the same journey for the browser test, with the data it asserts.
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { packageDigest } from '@rezics/zone-sdk';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { grantPlatformUse, platformAdministratorSession, type PlatformGrantSession }
  from '../../../tests/qa/fixtures/platform-grant.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import { activateMetadataWork, GRAPHS, metadataWorkRequestDigest, RV } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { ZONE_PRESETS } from '../../../services/main/src/modules/zone/presentation-format.ts';
import type { startMediaStack } from '../../../tests/qa/integration/media-support.ts';

type Stack = Awaited<ReturnType<typeof startMediaStack>>;

const ID = 'https://rezics.com/id/';
const short = (iri: string) => iri.slice(-36);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixtureUuid(name: string): string {
  const hex = createHash('sha256').update(`rezics-wiki-fixture:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const fixtureId = (name: string) => `${ID}${fixtureUuid(name)}`;
const fixtureKey = (name: string) => `wiki-fixture:${name}`;
const root = resolve(import.meta.dir, '../../..');

let administratorSession: Promise<PlatformGrantSession> | undefined;
const openedGroups = new Set<string>();

/** The stack's first platform administrator opens one exposure group for a fixture
 * principal. A process that has no web-auth fixture leaves the group closed. */
async function openFixturePlatformGroup(principalId: string, group: string): Promise<void> {
  if (!process.env.REZICS_WEB_AUTH_PRIVATE_PATH) return;
  const key = `${principalId}:${group}`;
  if (openedGroups.has(key)) return;
  administratorSession ??= platformAdministratorSession();
  await grantPlatformUse(await administratorSession, principalId, group);
  openedGroups.add(key);
}

interface Manifest {
  id: string; name: string; language: string; routeSegment: string; preset: 'editorial';
  navigation: { label: string; href: string }[]; mounts: { id: string; name: string; routeSegment: string }[];
}
export const manifest = (): Manifest => JSON.parse(readFileSync(join(root, 'config/zones/franchise-wiki.json'), 'utf8')) as Manifest;

/** The digest the web build computes for a package: `packageDigest` over every file of its directory. */
export function sourceDigest(slug: string): Promise<string> {
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

export interface WikiSeed {
  /** The Zone's Realm and Zone IRIs. */
  realm: string; zone: string;
  work: string; structure: string; chapters: string[];
  /** Entities by local id: their native IRIs. */
  entities: Record<string, string>;
  /** The names a page is asserted to show, by the chapter that reveals them. */
  evidence: string[];
}

interface Reader { principalId: string; actingSubject: string }

/** A Main app with the wiki owners attached (the reviewed-bundle journey and reader progress need them). */
function wikiApp(stack: Stack, tokens: Map<string, { issuer: string; subject: string }>) {
  const objects = stack.objects('semantic/structure/');
  const deps: MainWorkDependencies = { environment: stack.env, access: stack.access,
    account: { verify: async request => {
      const principal = tokens.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new Error('QA bearer is missing');
      return principal;
    } }, structureObjects: objects, wikiEvidence: new WikiEvidenceStore(stack.contentPool),
    wikiQuotations: new WikiQuotationStore(stack.contentPool), media: stack.media, mediaAccess: stack.mediaAccess,
    readingPositions: new ReadingPositionStore(stack.contentPool), editorialReview: new EditorialReviewStore(stack.accessPool),
    progress: new StructureProgressStore(stack.contentPool),
    platformAccess: new AccessExposure(stack.accessPool),
    rights: { store: new RightsStore(stack.contentPool, stack.accessPool) } };
  return { objects, app: createMainApp(stack.fuseki, deps) };
}

/** The token the QA app accepts for the web member, so a script can write the reading progress they would. */
async function readerToken(stack: Stack, reader: Reader, tokens: Map<string, { issuer: string; subject: string }>) {
  const row = (await stack.accessPool.query<{ account_issuer: string; account_subject: string }>(
    'SELECT account_issuer, account_subject FROM access.principal WHERE id = $1', [reader.principalId])).rows[0];
  if (!row) throw new Error('The web member has no Access principal');
  const token = randomUUID();
  tokens.set(token, { issuer: row.account_issuer, subject: row.account_subject });
  return token;
}

/** Marks one chapter of the seeded Work finished as the web member, through the progress route. */
export async function markChapterRead(stack: Stack, reader: Reader, seed: Pick<WikiSeed, 'structure' | 'chapters'>, index: number) {
  const tokens = new Map<string, { issuer: string; subject: string }>();
  const token = await readerToken(stack, reader, tokens);
  const { objects, app } = wikiApp(stack, tokens);
  await objects.initialize();
  const occurrence = seed.chapters[index];
  if (!occurrence) throw new Error(`The Work has no chapter ${index + 1}`);
  const path = `/v1/compositions/${short(seed.structure)}/occurrences/${short(occurrence)}/progress`;
  const send = (method: string, body?: object) => app.handle(new Request(`http://main.local${path}${method === 'GET'
    ? `?actingSubject=${encodeURIComponent(reader.actingSubject)}` : ''}`, { method, headers: { authorization: `Bearer ${token}`,
    'idempotency-key': `g849-progress-${index}-${randomUUID()}`, ...body ? { 'content-type': 'application/json' } : {} },
  ...body ? { body: JSON.stringify(body) } : {} }));
  const current = await send('GET');
  const version = current.status === 200 ? (await current.json() as { version: number }).version : 0;
  const written = await send('PUT', { actingSubject: reader.actingSubject, expectedVersion: version, completed: true, position: null });
  if (written.status !== 200) throw new Error(`progress: ${written.status} ${await written.text()}`);
}

/** The seed, and a Main app with the wiki owners attached for reads (`token` null reads as an anonymous reader). */
export type SeededWiki = WikiSeed & { read: (path: string, token?: string | null) => Promise<Response>; holderToken: string; holderActor: string;
  /** Bearer tokens the app accepts, so a script can add a reader it made. */
  tokens: Map<string, { issuer: string; subject: string }> };

export async function seedWiki(stack: Stack, reader: Reader | null): Promise<SeededWiki> {
  const spec = manifest();
  const holder = await stack.member('wiki-holder', { stable: true });
  const steward = await stack.member('wiki-steward', { stable: true });
  const reviewer = await stack.member('wiki-theme-reviewer', { stable: true });
  const tokens = new Map([[holder.token, holder.principal], [steward.token, steward.principal],
    [reviewer.token, reviewer.principal]]);
  const { objects, app } = wikiApp(stack, tokens);
  await objects.initialize();
  const json = async <T>(response: Response, status = 200, label = response.url): Promise<T> => {
    const text = await response.text();
    // A stable key replays the first admission as 200 instead of creating the resource again.
    const replayed = status === 201 && response.status === 200 && text.includes('"replayed":true');
    if (response.status !== status && !replayed) throw new Error(`${label}: expected ${status}, got ${response.status}: ${text.slice(0, 600)}`);
    return JSON.parse(text) as T;
  };
  const wiki = (method: string, path: string, body?: object, token = holder.token, key = fixtureKey(path)) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
      ...body ? { 'content-type': 'application/json' } : {} }, ...body ? { body: JSON.stringify(body) } : {} }));
  /** Commands Main settles in the background answer 202 until they finish. */
  const settle = async <T>(send: (key: string) => Promise<Response>, status: number, label: string): Promise<T> => {
    const key = fixtureKey(label.replace(/[^A-Za-z0-9:_./-]/g, '-'));
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await send(key);
      if (response.status !== 202) return json<T>(response, status, label);
      await response.text();
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error(`${label} stayed pending`);
  };
  const grantReader = async (scope: string, action: string) => {
    if (!reader) return;
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actingSubject, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.actingSubject, scope, action]);
  };
  for (const member of [holder, steward]) await stack.accessPool.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,'agent.control','infinity') ON CONFLICT DO NOTHING`,
  [randomUUID(), member.principalId, member.actor]);

  // The Work, in English and French, with three chapters.
  const types = ['https://schema.org/Book'];
  const title = 'Pride and Prejudice';
  const created = await activateMetadataWork(stack.env, { title, language: 'en', semanticTypes: types,
    admission: stack.stableAdmission(holder.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types, 'en'), 'wiki-work') });
  const english = await stack.contribution(created.work, holder.actor, 'en', 'Pride and Prejudice, chapters 1–3', 'wiki-en');
  await stack.contribution(created.work, holder.actor, 'fr', 'Orgueil et Préjugés, chapitres 1–3', 'wiki-fr');
  const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
    contribution: english.contribution, publicationDecision: english.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: holder.actor };
  await selectMainDefault(stack.env, stack.stableAdmission(holder.actor, `publication:select:${created.mainVersion}`,
    'publication.select', mainSelectionDigest(selection), 'wiki-selection'), selection);
  const work = created.work;
  await holder.grant(`work:read:${work}`, 'work.read'); await holder.grant(`work:edit:${work}`, 'work.edit');
  await steward.grant(`work:read:${work}`, 'work.read'); await steward.grant(`work:review:${work}`, 'work.review');
  await steward.grant(`work:edit:${work}`, 'work.edit');
  await grantReader(`work:read:${work}`, 'work.read');
  const composition = await json<{ structure: string; revision: string }>(await wiki('POST', '/v1/compositions', {
    profile: 'book-composition', work, mainVersion: created.mainVersion, actingSubject: holder.actor }), 201);
  const inserted = await json<{ occurrences: string[] }>(await wiki('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
    profile: 'book-composition', expectedHead: composition.revision, actingSubject: holder.actor,
    operations: [1, 2, 3].map(n => ({ op: 'insert', parent: composition.structure, role: 'chapter', position: 'last',
      target: 'https://schema.org/DigitalDocument', label: { value: `Chapter ${n}`, language: 'en' } })) }));

  // The Zone, from the starter manifest: a Collection and a mount for each of its lists.
  await holder.grant('space:create:root', 'space.create');
  const space = await json<{ space: string; realm: string }>(await wiki('POST', '/v1/spaces', { profile: 'space-realm-v2',handle: spec.routeSegment,
    name: spec.name, capabilities: ['realm'], actingSubject: holder.actor }), 201);
  const zone = fixtureId('wiki-zone');
  await holder.grant(`zone:edit:${zone}`, 'zone.edit'); await holder.grant(`semantic:read:${zone}`, 'semantic.read');
  await holder.grant(`zone:official:${zone}`, 'zone.official');
  let navigation = await json<{ revision: string }>(await wiki('POST', '/v1/zones', { zone, space: space.space,
    disclosure: 'public', name: spec.name, language: spec.language, actingSubject: holder.actor }), 201);
  const collections: Record<string, string> = {};
  for (const mount of spec.mounts) {
    const collection = fixtureId(`wiki-collection:${mount.id}`);
    collections[mount.id] = collection;
    await holder.grant(`collection:edit:${collection}`, 'collection.edit'); await steward.grant(`collection:edit:${collection}`, 'collection.edit');
    await holder.grant(`semantic:read:${collection}`, 'semantic.read');
    const made = await json<{ structure: string; revision: string }>(await wiki('POST', '/v1/collections', { collection,
      name: mount.name, language: spec.language, disclosure: 'public', actingSubject: holder.actor }, holder.token,
    fixtureKey(`collection:${mount.id}`)), 201);
    if (mount.id === 'franchise') {
      const membersBody = { expectedHead: made.revision, actingSubject: holder.actor, operations: [{ op: 'insert', parent: made.structure, role: 'member',
        position: 'last', target: work }] };
      const membersPath = `/v1/collections/${short(collection)}/changes`;
      // A write still moving the graph cancels this insert. The same key would replay that cancellation,
      // and a moved head has to be read again before the insert is offered.
      let members = await wiki('POST', membersPath, membersBody, holder.token, fixtureKey('franchise-members'));
      if (members.status === 409) {
        const detail = await members.clone().text();
        if (detail.includes('read_basis_changed') || detail.includes('collection_conflict')) {
          await new Promise(done => setTimeout(done, 1_000));
          const current = await json<{ revision: string }>(await wiki('GET',
            `/v1/collections/${short(collection)}?actingSubject=${encodeURIComponent(holder.actor)}`));
          members = await wiki('POST', membersPath, { ...membersBody, expectedHead: current.revision },
            holder.token, fixtureKey('franchise-members-again'));
        }
      }
      await json(members);
    }
    navigation = await json(await wiki('POST', `/v1/zones/${short(zone)}/mounts`, { expectedHead: navigation.revision,
      target: collection, routeSegment: mount.routeSegment, position: 'last', disclosure: 'public', actingSubject: holder.actor },
    holder.token, fixtureKey(`mount:${mount.id}`)));
  }

  // Definitions the bundle's claims use: a property, and two relations with labels in English and Japanese.
  // Lexicon presentation writes are closed under platform-admin.
  await openFixturePlatformGroup(holder.principalId, 'platform-admin');
  await holder.grant('semantic:create:root', 'semantic.change'); await steward.grant('semantic:create:root', 'semantic.change');
  await steward.grant('relation:create:root', 'relation.change');
  await steward.grant(`statement:speak:${steward.actor}`, 'statement.record');
  await steward.grant(`statement:speak:${steward.actor}`, 'statement.withdraw');
  const stamp = 'fixture';
  const property = await json<{ component: string; revision: string }>(await wiki('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: holder.actor,
    state: { component: 'definition', kind: 'property' } }, holder.token, fixtureKey('property')), 201);
  await holder.grant(`semantic:read:${property.component}`, 'semantic.read');
  const relation = async (key: string, labels: Record<string, [string, string]>) => {
    const made = await json<{ component: string; revision: string }>(await wiki('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: holder.actor,
      state: { component: 'definition', kind: 'relation', notation: `wiki-${key}-${stamp}`, roles: [
        { key: 'subject', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'object', minParticipants: 1, maxParticipants: 1, ordered: false }] } }, holder.token,
    fixtureKey(`relation:${key}`)), 201);
    await holder.grant(`semantic:read:${made.component}`, 'semantic.read');
    await holder.grant(`semantic:edit:${made.component}`, 'lexicon.presentation.change');
    for (const [language, [noun, heading]] of Object.entries(labels)) {
      for (const [fromRole, toRole] of [['subject', 'object'], ['object', 'subject']] as const) {
        await json(await wiki('POST', '/v1/lexicon/presentations', { profile: 'definition-presentation-v1', actingSubject: holder.actor,
          expectedHead: null, state: { definition: made.component, meaningRevision: made.revision, fromRole, toRole, language,
            noun, heading, plurals: { ...language === 'en' ? { one: noun } : {}, other: heading }, grammaticalForms: [],
            source: 'https://rezics.com/definition/relation-lexicon-seed-v1',
            licence: 'https://creativecommons.org/publicdomain/zero/1.0/', reviewStatus: 'draft' } }, holder.token,
        fixtureKey(`lexicon:${key}:${language}:${fromRole}:${toRole}`)), 201);
      }
    }
    return made;
  };
  const sister = await relation('sister', { en: ['Sister', 'Sisters'], ja: ['姉妹', '姉妹'] });
  const acquaintanceDefinition = await relation('acquaintance', { en: ['Acquaintance', 'Acquaintances'], ja: ['知人', '知人'] });

  // The bundle: chapters 1 to 3 of the novel, as a holder's agent would submit it.
  const source = { representationSha256: 'a'.repeat(64), mediaType: 'text/plain', language: 'en', rightsBasis: 'public_domain' as const,
    method: { agent: 'Holder extraction agent', model: 'local', inference: 'local' as const } };
  const evidenceFor = (quote: string) => ({ quote, locator: { version: 'rezics-locator-v1' as const,
    source: { type: 'external' as const, representationSha256: source.representationSha256, mediaType: source.mediaType },
    selector: { type: 'TextQuoteSelector' as const, exact: quote } } });
  const name = (value: string, language: string, kind: 'primary' | 'alias', revealedAt: string) => ({ value, language, kind, revealedAt });
  const bundle: WikiExtraction = { profile: 'wiki-extraction-v1', target: work, continuity: work, zone, source,
    units: inserted.occurrences.map((occurrence, index) => ({ id: `ch${index + 1}`, ordinal: index, label: `Chapter ${index + 1}`, occurrence })),
    entities: [
      { id: 'elizabeth', type: `${RV}Character`, names: [name('Elizabeth Bennet', 'en', 'primary', 'ch1'),
        name('エリザベス・ベネット', 'ja', 'primary', 'ch1'), name('Lizzy', 'en', 'alias', 'ch2')] },
      { id: 'jane', type: `${RV}Character`, names: [name('Jane Bennet', 'en', 'primary', 'ch1'), name('ジェーン・ベネット', 'ja', 'primary', 'ch1')] },
      { id: 'darcy', type: `${RV}Character`, names: [name('Fitzwilliam Darcy', 'en', 'primary', 'ch3')] }],
    claims: [
      { subject: 'elizabeth', predicate: property.component, object: { kind: 'literal', value: 'Bennet family' }, modality: 'narrated',
        continuity: work, revealedAt: 'ch1', evidence: [evidenceFor('The Bennet family')] },
      { subject: 'elizabeth', predicate: sister.component, object: { kind: 'entity', ref: 'jane' }, modality: 'narrated',
        continuity: work, revealedAt: 'ch1', evidence: [evidenceFor('Elizabeth and Jane were sisters')] },
      { subject: 'elizabeth', predicate: acquaintanceDefinition.component, object: { kind: 'entity', ref: 'darcy' }, modality: 'narrated',
        continuity: work, revealedAt: 'ch3', evidence: [evidenceFor('Elizabeth heard Mr. Darcy')] }] };
  const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH <${GRAPHS.current}> {
    <${work}> rv:head ?head } }`)).results?.bindings?.[0]?.head?.value;
  if (!head) throw new Error('The Work has no head');
  const proposal = await json<{ proposal: string }>(await wiki('POST', '/v1/editorial/proposals', { profile: 'editorial-proposal-create-v1',
    kind: 'wiki-bundle', target: { resource: work, revision: head, context: 'urn:rezics:context:global' }, candidate: bundle,
    baseHeads: [{ component: work, head }], evidence: [], actingSubject: holder.actor }), 201);
  await json(await wiki('POST', `/v1/editorial/proposals/${proposal.proposal}/reviews`, { profile: 'editorial-proposal-review-v1',
    revision: 1, outcome: 'approve', message: 'Checked the chapter citations', actingSubject: steward.actor }, steward.token));
  const applyKey = fixtureKey('wiki-bundle-apply');
  let receipt: OwnerReceipt | null = null;
  for (let attempt = 0; attempt < 200 && !receipt; attempt++) {
    const response = await wiki('POST', `/v1/editorial/proposals/${proposal.proposal}/decisions`, { profile: 'editorial-proposal-decide-v1',
      revision: 1, outcome: 'applied', approve: true, message: 'Checked the chapter citations', actingSubject: steward.actor },
    steward.token, applyKey);
    const result = await json<{ receipt?: OwnerReceipt }>(response, response.status === 202 ? 202 : 200);
    receipt = result.receipt ?? null;
  }
  if (!receipt) throw new Error('The bundle did not finish applying');
  const resultOf = (suffix: string) => (receipt!.commands!.find(command => command.key.endsWith(`:${suffix}`))!.result as { component: string });
  const entities = Object.fromEntries(bundle.entities.map(entity => [entity.id, resultOf(`entity:${entity.id}`).component]));
  // Relation occurrences and their definitions are semantic resources a reader needs the grant to read; the web member
  // gets it as the G-847 fixture's reader does, so the rows and the passages behind them can be asserted in the browser.
  for (const component of [sister.component, acquaintanceDefinition.component, resultOf('claim:1').component, resultOf('claim:2').component]) {
    await grantReader(`semantic:read:${component}`, 'semantic.read');
  }

  // The Zone is official under its route segment, and its package runs once Main reports the approval.
  const theme = fixtureId('wiki-theme');
  const digest = await sourceDigest(spec.routeSegment);
  for (const [scope, action] of [['theme:create:root', 'theme.create'], [`theme:revise:${short(theme)}`, 'theme.revise'],
    [`theme:activate:${short(theme)}`, 'theme.activate']] as const) await holder.grant(scope, action);
  await reviewer.grant(`theme:review:${short(theme)}`, 'theme.review');
  // Theme routes on the stack app have no exposure reader, so a grant there never opens them.
  // This app does, and it accepts the reviewer's bearer as well as the holder's.
  const themeCall = (method: string, path: string, options: { token: string; body?: unknown; key?: string }) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${options.token}`,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }));
  await openFixturePlatformGroup(holder.principalId, 'executable-themes');
  await openFixturePlatformGroup(reviewer.principalId, 'executable-themes');
  const post = <T>(path: string, body: object, status = 201, method = 'POST', keyInBody = true) => settle<T>(key => themeCall(method,
    path, { token: holder.token, body: keyInBody ? { ...body, idempotencyKey: key } : body, key }), status, `${method} ${path}`);
  await post('/v1/themes', { theme: short(theme), owner: holder.actor, hostZone: zone, actingSubject: holder.actor });
  const entry = `assets/${spec.routeSegment}/main.js`;
  const revision = await post<{ operation: string }>(`/v1/themes/${short(theme)}/revisions`, { expectedRevision: null,
    bundle: { profile: 'first-party-bundle-v1', hostZone: zone, packageDigest: digest, entry,
      files: [{ path: entry, digest: sha(`${spec.routeSegment}:${digest}`), gzipBytes: 1000 }], slots: ['home', 'entity', 'memberIndex'],
      connectOrigins: [], imageOrigins: [], fontOrigins: [] }, actingSubject: holder.actor });
  await settle(key => themeCall('POST', `/v1/themes/${short(theme)}/revisions/${short(revision.operation)}/reviews`, {
    token: reviewer.token, key, body: { decision: 'approved', reviewEvidenceDigest: sha(`reviewed ${digest}`),
      actingSubject: reviewer.actor, idempotencyKey: key } }), 201, 'theme review');
  const activationKey = fixtureKey('theme-activation');
  // Approval must fall inside 90 days of admission, and both seeds of one run must send the same instant.
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  const activationBody = { revision: revision.operation, expectedActivation: null,
    approvalExpiresAt: new Date(noon.getTime() + 30 * 86_400_000).toISOString(),
    actingSubject: holder.actor, idempotencyKey: activationKey };
  const activation = await themeCall('POST', `/v1/themes/${short(theme)}/first-party-activations`, {
    token: holder.token, body: activationBody, key: activationKey });
  const activationText = await activation.text();
  const replayedActivation = activation.status === 200 && activationText.includes('"replayed":true');
  if (activation.status !== 201 && !replayedActivation) {
    throw new Error(`theme activation: expected 201, got ${activation.status}: ${activationText.slice(0, 400)}`);
  }
  const current = await json<{ revision: string }>(await wiki('GET', `/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(holder.actor)}`));
  // The head moves when the presentation is first stored, so a second seed's body is not the first request.
  // The same key then conflicts; the stored presentation is the one this fixture already wrote.
  const configPath = `/v1/zones/${short(zone)}/configuration`;
  const configKey = fixtureKey('zone-configuration');
  const configBody = { expectedHead: current.revision, actingSubject: holder.actor,
    name: spec.name, language: spec.language, defaultRealm: space.realm, official: {},
    presentation: { profile: 'zone-presentation-v2', preset: spec.preset, tokens: ZONE_PRESETS[spec.preset],
      navigation: spec.navigation, slides: [], official: { theme },
      modules: [{ id: 'works', type: 'shelf', title: 'Works', source: { kind: 'collection', collection: collections.franchise! },
        options: { layout: 'covers', limit: 12 } }] } };
  const configured = await stack.call('PUT', configPath, { token: holder.token, body: configBody, key: configKey });
  const configuredText = await configured.text();
  if (configured.status === 202) {
    await settle(key => stack.call('PUT', configPath, { token: holder.token, body: configBody, key }), 200, 'PUT configuration');
  } else if (!(configured.status === 200 || (configured.status === 409 && configuredText.includes('idempotency_conflict')))) {
    throw new Error(`PUT configuration: expected 200, got ${configured.status}: ${configuredText.slice(0, 400)}`);
  }

  return { realm: space.realm, zone, work, structure: composition.structure, chapters: inserted.occurrences, entities,
    evidence: (receipt.owner as { evidence: string[] }).evidence, holderToken: holder.token, holderActor: holder.actor, tokens,
    read: (path, token = null) => app.handle(new Request(`http://main.local${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })) };
}
