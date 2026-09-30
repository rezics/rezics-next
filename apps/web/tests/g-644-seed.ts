// Seeds the G-644 resources into the isolated QA stack the e2e harness started and prints their IDs as JSON:
// a Sword Art Online web Work with a chapter occurrence and a release, a character named in two scripts, a resource of a
// type nobody registered (named in Arabic), and a Realm the signed-in member may post in. The browser signs in as the
// stack's web member, so reads and the two write scopes the composer needs are granted to their Agent.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest, RV } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-644 seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!objectDirectory || !path) throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
const reader = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };

const short = (iri: string) => iri.slice(-36);
const id = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

const stack = await startMediaStack('g644-e2e');
const workObjects = stack.objects('semantic/work/');
const structureObjects = stack.objects('semantic/structure/');
await Promise.all([workObjects.initialize(), structureObjects.initialize()]);
Object.assign(stack.env, { objectDirectory, workObjects, structureObjects });
try {
  const editor = await stack.member('catalogue');
  const grantReader = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actingSubject, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.actingSubject, scope, action]);
  };
  const types = ['https://schema.org/Book'];
  const title = 'Sword Art Online (web)';
  const created = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
    editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
  const text = await stack.contribution(created.work, editor.actor, 'ja', `${title}（本文）`);
  const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
    contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
  const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
    `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
  if (selected.outcome !== 'succeeded') throw new Error('Main selection failed');
  await editor.grant(`work:edit:${created.work}`, 'work.edit');
  await editor.grant(`work:read:${created.work}`, 'work.read');
  await grantReader(`work:read:${created.work}`, 'work.read');

  // One chapter occurrence of the web serial.
  const structure = await json<{ structure: string; revision: string }>(await editor.send('POST', '/v1/compositions',
    { profile: 'book-composition', work: created.work, mainVersion: created.mainVersion, actingSubject: editor.actor }), 201);
  const chapter = await json<{ occurrences: string[] }>(await editor.send('POST',
    `/v1/compositions/${short(structure.structure)}/changes`, { profile: 'book-composition',
      expectedHead: structure.revision, actingSubject: editor.actor, operations: [{ op: 'insert',
        parent: structure.structure, position: 'last', role: 'chapter', target: 'https://schema.org/DigitalDocument',
        label: { value: 'Aincrad, chapter one', language: 'en' } }] }));
  const occurrence = chapter.occurrences[0]!;

  // A release of it.
  const release = id();
  await json(await editor.send('PUT', `/v1/works/${short(created.work)}/releases/${short(release)}`, {
    profile: 'release-v1', expectedHead: null, actingSubject: editor.actor, id: release, kind: 'formal', status: 'official',
    contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
    title: { value: 'Sword Art Online 1: Aincrad (paperback)', language: 'en' }, editionStatement: null,
    publisher: 'Yen Press', publicationYear: 2014, isbn13: null, originalUrl: null, fixedRelease: null,
    coverage: null, evidence: null }));

  // Semantic resources: a character, and one of a type the registry does not know.
  await editor.grant('semantic:create:root', 'semantic.change');
  const semantic = async (type: string, names: { lexical: string; language: string; direction: 'ltr' | 'rtl' }[]) => {
    const made = await json<{ component: string }>(await editor.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: editor.actor,
      state: { component: 'resource', types: [type], properties: names.map(name => ({
        predicate: 'https://schema.org/name', value: { kind: 'language-string', ...name } })) } }), 201);
    await editor.grant(`semantic:read:${made.component}`, 'semantic.read');
    await grantReader(`semantic:read:${made.component}`, 'semantic.read');
    return made.component;
  };
  const character = await semantic('https://rezics.com/vocab/Character', [
    { lexical: 'Kirito', language: 'en', direction: 'ltr' }, { lexical: 'キリト', language: 'ja', direction: 'ltr' }]);
  const hologram = await semantic('https://example.com/vocab/HologramExhibit',
    [{ lexical: 'معرض الهولوغرام', language: 'ar', direction: 'rtl' }]);

  // A community the member may post in; the composer roots the post at the occurrence.
  await editor.grant('space:create:root', 'space.create');
  const realm = await json<{ realm: string }>(await editor.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
    name: 'Aincrad readers', capabilities: ['realm'], actingSubject: editor.actor }), 201);
  // A new community reviews every post; this one takes them directly, as the composer needs. The realm's review mode
  // lives in the graph (what its page reads) and in Access (what admits a placement).
  await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(realm.realm)} rv:reviewMode ?mode } } INSERT { GRAPH ${iri(GRAPHS.current)} {
    ${iri(realm.realm)} rv:reviewMode "open" } } WHERE { OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
    ${iri(realm.realm)} rv:reviewMode ?mode } } }`);
  await stack.accessPool.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1) ON CONFLICT DO NOTHING', [realm.realm]);
  await stack.accessPool.query(`INSERT INTO access.realm_admin_settings (realm, who_may_submit, visibility, review_mode, self_join)
    VALUES ($1, 'granted', 'public', 'open', false) ON CONFLICT (realm) DO UPDATE SET review_mode = 'open'`, [realm.realm]);
  await grantReader(`reply:place:${realm.realm}`, 'reply.place');
  for (const root of [occurrence, release, character, created.work]) await grantReader(`reply:create:${root}`, 'reply.create');

  console.log(JSON.stringify({ work: created.work, occurrence, release, character, hologram, realm: realm.realm }));
} finally {
  await stack.stop();
}
