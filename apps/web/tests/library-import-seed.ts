import { platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';

// The recorded QA account provisions fixture authors and creates their own Works through public APIs.
// Controller and author baselines supply authority; the reader receives no catalogue-import platform use.
// Typeahead searches selected public text, so each Work also receives a published fixture contribution.
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('Library import seed writes only into an isolated QA run');
}
const records = JSON.parse(process.argv[2] ?? 'null') as [string, string][];
if (!Array.isArray(records) || !records.length || records.some(record => !Array.isArray(record)
  || record.length !== 2 || record.some(value => typeof value !== 'string' || !value))) {
  throw new Error('Library import seed needs title and author pairs');
}
const session = await platformAdministratorSession(process.env,
  'openid agent:create work:create work:edit work:read');
const post = async <T>(path: string, body: object, key: string): Promise<T> => {
  const response = await fetch(new URL(path, session.mainOrigin), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json',
      'idempotency-key': key },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const replayed = response.status === 200 && text.includes('"replayed":true');
  if (response.status !== 201 && !replayed) {
    throw new Error(`POST ${path}: expected 201 or replay, got ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
};
const authors = new Map<string, string>();
for (const [, name] of records) {
  if (authors.has(name)) continue;
  const author = await post<{ agent: string }>('/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: name,
  }, `library-import-author:${authors.size}`);
  authors.set(name, author.agent);
}
const works: string[] = [];
// One write at a time: every selected publication contributes to the search graph.
for (const [index, [title, name]] of records.entries()) {
  const actingSubject = authors.get(name)!;
  const work = await post<{ work: string; mainVersion: string }>('/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
    semanticTypes: ['https://schema.org/Book'], actingSubject,
  }, `library-import-work:${index}`);
  const draft = await post<{ contribution: string; draftRevision: string }>('/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en',
    body: `Library import fixture for ${title}.`, actingSubject,
  }, `library-import-draft:${index}`);
  const publication = await post<{ publicationDecision: string }>('/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution,
    expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
  }, `library-import-publication:${index}`);
  await post('/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject,
  }, `library-import-selection:${index}`);
  works.push(work.work);
}
console.log(JSON.stringify({ actingSubject: session.actingSubject, works }));
