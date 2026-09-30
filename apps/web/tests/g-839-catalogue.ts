// The records the G-839 e2e edits, written once into the isolated QA stack through Main's public
// routes: the Index subseries whose "22 Reverse" volume is not yet one of its parts, Genesis
// Testament, Sword Art Online volumes 1-3 with their English texts, and a Work the signed-in
// member may read but not edit. The browser signs in as the stack's web member, who is granted
// edit authority on the Works an editor maintains.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import type { MediaStack } from '../../../tests/qa/integration/media-support.ts';

const ID = 'https://rezics.com/id/';
const short = (iri: string) => iri.slice(-36);
const types = ['https://schema.org/Book'];

/** The real web member the browser signs in as. */
export interface SeedReader { principalId: string; actor: string }
interface Work { work: string; mainVersion: string; mainRevision: string; title: string }
interface Composition { structure: string; revision: string }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

export interface EditCatalogue {
  index: { newTestament: Work; genesisTestament: Work; reverse: Work; twentyTwo: Work };
  sao: { volumes: Work[] };
  readOnly: Work;
}

export async function seedEditCatalogue(stack: MediaStack, reader: SeedReader, scratch: string): Promise<EditCatalogue> {
  const editor = await stack.member('catalogue');
  const structureObjects = stack.objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });

  /** The web member's own grant: self-issued, like the reads the G-837 records give it. */
  const grantReader = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.actor, scope, action]);
  };

  /** A public Work the member reads; `editable` also lets the member edit it. */
  const work = async (title: string, editable: boolean): Promise<Work> => {
    const created = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
      editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    const text = await stack.contribution(created.work, editor.actor, 'ja', `${title}（本文）`);
    const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
      `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
    if (selected.outcome !== 'succeeded') throw new Error(`Main selection failed for ${title}`);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    await editor.grant(`work:read:${created.work}`, 'work.read');
    await grantReader(`work:read:${created.work}`, 'work.read');
    if (editable) await grantReader(`work:edit:${created.work}`, 'work.edit');
    return { work: created.work, mainVersion: created.mainVersion, mainRevision: created.mainRevision, title };
  };

  // The relation kinds the edit page offers, in every interface language.
  const kinds = new Set(['rewrite', 'reboot', 'adaptation', 'spin-off', 'sequel', 'correspondence-equivalent',
    'correspondence-partial', 'correspondence-revised']);
  await editor.grant('semantic:create:root', 'semantic.change');
  mkdirSync(scratch, { recursive: true });
  await seedRelationLexicon({
    post: async <T>(path: string, body: object, key: string) => json<T>(await editor.send('POST', path, body, key), 201),
    authorizeDefinition: async receipt => {
      await editor.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      await editor.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
      await grantReader(`semantic:read:${receipt.component}`, 'semantic.read');
    } }, editor.actor, `g839-${randomUUID()}`, relationLexiconSeed.filter(item => kinds.has(item.key)),
  resolve(scratch, 'lexicon.json'));

  // Index: New Testament holds volumes 1, 2 and 22; "22 Reverse" exists but is not a part yet.
  const newTestament = await work('A Certain Magical Index: New Testament', true);
  const genesisTestament = await work('A Certain Magical Index: Genesis Testament', true);
  const ntVolumes = await Promise.all(['1', '2', '22'].map(label => work(`New Testament ${label}`, true)));
  const reverse = await work('New Testament 22 Reverse', true);
  let composition = await json<Composition>(await editor.send('POST', '/v1/compositions', { profile: 'work-composition',
    work: newTestament.work, mainVersion: newTestament.mainVersion, actingSubject: editor.actor }), 201);
  composition = await json<Composition>(await editor.send('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
    profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor,
    operations: ntVolumes.map((volume, index) => ({ op: 'insert', parent: composition.structure, position: 'last', role: 'part',
      target: volume.work, displayLabel: ['1', '2', '22'][index], inclusion: 'required' })) }));

  // Sword Art Online volumes 1-3, each with an English text the omnibus will cover.
  const volumes = await Promise.all([1, 2, 3].map(number => work(`Sword Art Online, Vol. ${number}`, true)));
  const yen = `${ID}${randomUUID()}`;
  for (const volume of volumes) {
    const id = `${ID}${randomUUID()}`;
    await json(await editor.send('PUT', `/v1/works/${short(volume.work)}/realizations/${short(id)}`, { profile: 'realization-v1',
      expectedHead: null, actingSubject: editor.actor, id, language: 'en', kind: 'translation', translators: [editor.actor],
      publishers: [yen], source: { kind: 'unresolved', work: volume.work }, status: 'official', verification: 'verified',
      evidence: 'https://example.com/evidence' }));
  }

  // The member reads this Work but has no edit authority on it.
  const readOnly = await work('A Certain Scientific Railgun (manga)', false);
  return { index: { newTestament, genesisTestament, reverse, twentyTwo: ntVolumes[2]! }, sao: { volumes }, readOnly };
}
