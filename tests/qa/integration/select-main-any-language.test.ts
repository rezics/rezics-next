import { expect, test } from 'bun:test';
import { memberFixture } from '../../../services/main/tests/member-reply-fixture.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { iri } from '../../../services/main/src/modules/work/activate.ts';

test('Main selection publishes a Chinese Work without an English title', async () => {
  const h = await memberFixture();
  try {
    const created = await h.post('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
      title: '中文作品', language: 'zh-CN', actingSubject: h.actor });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const work = created.body.work as string;
    const main = created.body.mainVersion as string;
    const draft = await h.post('/v1/contributions', { profile: 'text-contribution-v1',
      work, language: 'zh-CN', body: '正文内容', actingSubject: h.actor });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const published = await h.post('/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.body.contribution, expectedDraftHead: draft.body.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: h.actor });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const selected = await h.post('/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: main }, work,
      contribution: draft.body.contribution, publicationDecision: published.body.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: h.actor });
    expect(selected.status, JSON.stringify(selected.body)).toBe(201);
    const match = (await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?title WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:work ${iri(work)} ; rv:publicTitle ?title }
    } LIMIT 2`)).results?.bindings ?? [];
    expect(match).toHaveLength(1);
    expect(match[0]?.title?.value).toBe('中文作品');
    expect(match[0]?.title?.['xml:lang']).toBe('zh-CN');
    expect((await h.get(`/v1/main-versions/${main.slice(-36)}/selection?language=zh-CN`)).status).toBe(200);
  } finally { await h.close(); }
}, 120_000);
