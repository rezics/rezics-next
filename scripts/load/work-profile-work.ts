import type { CorpusApi } from './work-profile-corpus.ts';

/** One public searchable Work, through authoring, publication and selection APIs.
 * The caller provisions an authorized author once; no storage fixtures bypass these commands. */
export async function seedPublicProfileWork(
  api: CorpusApi,
  key: string,
  input: {
    actingSubject: string;
    title: string;
    body: string;
    language?: string;
  },
) {
  const language = input.language ?? 'en';
  const created = await api.command<{ work: string; mainVersion: string }>(`${key}:work`, {
    method: 'POST',
    path: '/v1/works',
    body: {
      profile: 'metadata-only-v1',
      authoring: 'own-work',
      title: input.title,
      language,
      actingSubject: input.actingSubject,
    },
  });
  const draft = await api.command<{ contribution: string; draftRevision: string }>(`${key}:draft`, {
    method: 'POST',
    path: '/v1/contributions',
    body: {
      profile: 'text-contribution-v1',
      work: created.work,
      body: input.body,
      language,
      actingSubject: input.actingSubject,
    },
  });
  const published = await api.command<{ publicationDecision: string }>(`${key}:publish`, {
    method: 'POST',
    path: '/v1/contribution-publications',
    body: {
      profile: 'text-publication-v1',
      contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: input.actingSubject,
    },
  });
  const selected = await api.command<{ selection: string }>(`${key}:select`, {
    method: 'POST',
    path: '/v1/publication-selections',
    body: {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: created.mainVersion },
      work: created.work,
      contribution: draft.contribution,
      publicationDecision: published.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: input.actingSubject,
    },
  });
  return { ...created, ...draft, ...published, ...selected, language };
}
