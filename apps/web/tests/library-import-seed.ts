import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { grantPlatformUse, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { CATALOGUE_IMPORT_SCOPE } from '../../../services/main/src/modules/work/catalogue-import.ts';

// Seed only the title/author matches used by the browser journey. The reader never receives
// catalogue authority; the fixture editor provisions Authors and imports Works through Main's APIs.
// Typeahead searches selected public text, so each Work also receives a published fixture contribution.
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('Library import seed writes only into an isolated QA run');
}
const records = JSON.parse(process.argv[2] ?? 'null') as [string, string][];
if (!Array.isArray(records) || !records.length || records.some(record => !Array.isArray(record)
  || record.length !== 2 || record.some(value => typeof value !== 'string' || !value))) {
  throw new Error('Library import seed needs title and author pairs');
}
const readerPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!readerPath) throw new Error('Library import seed needs the isolated QA reader');
const reader = JSON.parse(readFileSync(readerPath, 'utf8')) as { principalId: string; actingSubject: string };
const stack = await startMediaStack('library-import-seed', { agents: true });
try {
  const workObjects = stack.objects('semantic/work/');
  await workObjects.initialize();
  stack.env.workObjects = workObjects;
  const editor = await stack.member('library-catalogue-editor', { stable: true });
  await editor.grant(CATALOGUE_IMPORT_SCOPE, 'work.create');
  await grantPlatformUse(await platformAdministratorSession(), editor.principalId, 'catalogue-import');
  const creators = new Map<string, string>();
  for (const [, name] of records) {
    if (creators.has(name)) continue;
    const response = await editor.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: name,
    }, `library-import-author:${creators.size}`);
    if (![200, 201].includes(response.status)) throw new Error(`Author seed failed: ${response.status} ${await response.text()}`);
    creators.set(name, (await response.json() as { agent: string }).agent);
  }
  const response = await editor.send('POST', '/v1/work-imports/bulk', {
    actingSubject: editor.actor,
    items: records.map(([title, name], index) => ({ key: `library-import-work:${index}`,
      input: { profile: 'work-catalogue-import-v1', expectedWorkHead: null, title, language: 'en',
        semanticTypes: ['https://schema.org/Book'], aliases: [],
        credits: [{ agent: creators.get(name)!, role: 'author' }], classifications: [],
        evidence: 'Library import browser fixture' } })),
  });
  if (response.status !== 200) throw new Error(`Catalogue seed failed: ${response.status} ${await response.text()}`);
  const result = await response.json() as { complete: boolean; partial: boolean; items: {
    status: string; receipt?: { work: string; mainVersion: string };
  }[] };
  if (!result.complete || result.partial || result.items.length !== records.length
    || result.items.some(item => item.status !== 'succeeded')) {
    throw new Error(`Catalogue seed incomplete: ${JSON.stringify(result)}`);
  }
  const post = async <T>(path: string, body: object, key: string): Promise<T> => {
    const response = await editor.send('POST', path, body, key);
    const text = await response.text();
    const replayed = response.status === 200 && text.includes('"replayed":true');
    if (response.status !== 201 && !replayed) {
      throw new Error(`POST ${path}: expected 201 or replay, got ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  };
  // One write at a time: every selected publication contributes to the search graph.
  for (const [index, item] of result.items.entries()) {
    const work = item.receipt?.work;
    const mainVersion = item.receipt?.mainVersion;
    if (!work || !mainVersion) throw new Error('Catalogue seed omitted the Work receipt');
    const readScope = `work:read:${work}`;
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [readScope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.read',now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actingSubject]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.read',now() + interval '8 hours')`, [randomUUID(), reader.actingSubject, readScope]);
    await editor.grant(`contribution:create:${work}`, 'contribution.create');
    await editor.grant(`publication:select:${mainVersion}`, 'publication.select');
    const draft = await post<{ contribution: string; draftRevision: string }>('/v1/contributions', {
      profile: 'text-contribution-v1', work, language: 'en',
      body: `Library import fixture for ${records[index]![0]}.`, actingSubject: editor.actor,
    }, `library-import-draft:${index}`);
    await editor.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    await editor.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publication = await post<{ publicationDecision: string }>('/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: editor.actor,
    }, `library-import-publication:${index}`);
    await post('/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: mainVersion },
      work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: editor.actor,
    }, `library-import-selection:${index}`);
  }
  console.log(JSON.stringify({ actingSubject: reader.actingSubject, works: result.items.map(item => item.receipt!.work) }));
} finally {
  await stack.stop();
}
