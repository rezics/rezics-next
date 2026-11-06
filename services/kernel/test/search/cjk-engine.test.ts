import { afterAll, expect, test } from 'bun:test';
import { createCurrentTextDisclosure } from '../../src/search/disclosure/current-text.ts';
import { applySubjectKeys } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { compileMatchEvidence, projectMatchEvidence } from '../../src/search/match-evidence.ts';
import { projectHit } from '../../src/search/hits.ts';
import { analyzeInstalled, CJK_ANALYZER, requireDevelopmentAnalyzer } from '../../src/search/engine-analysis.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import {
  EVIDENCE_HIT_TEMPLATE,
  EVIDENCE_SEARCH_TEMPLATE,
  HIT_TEMPLATE,
  SEARCH_TEMPLATE,
  SCOPE_HIT_TEMPLATE,
  SUGGEST_TEMPLATE,
  installTemplates,
  searchSubjects,
  suggestSubjects,
} from '../../src/search/query.ts';
import { subjectPartition, type SubjectListingSource } from '../../src/search/source.ts';
import { compileText, parseText } from '../../src/search/text.ts';
import { createFakeSource } from './support/fake-source.ts';
import {
  RELEASED_CURRENT_PUBLICATION,
  RELEASED_DECOY_ID,
  RELEASED_NAME_ID,
  releasedDecoySubject,
  releasedMultilingualSubject,
} from './support/released-names.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefixes: string[] = [];
const listing: SubjectListingSource = { read: async () => new Map() };

afterAll(async () => {
  for (const prefix of prefixes) {
    await search.request('DELETE', `/${subjectIndexName(prefix, 1)}`).catch(() => undefined);
    for (const name of [
      SEARCH_TEMPLATE,
      HIT_TEMPLATE,
      EVIDENCE_SEARCH_TEMPLATE,
      EVIDENCE_HIT_TEMPLATE,
      SCOPE_HIT_TEMPLATE,
      SUGGEST_TEMPLATE,
      'subjects-suggest-v2',
      'subjects-facets-v1',
    ]) {
      await search.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
    }
  }
});

async function tokens(index: string, text: string): Promise<string[]> {
  return (await analyzeInstalled(search, index, { analyzer: CJK_ANALYZER, text })).map(({ token }) => token);
}

async function publish(prefix: string, source: ReturnType<typeof createFakeSource>, obligation: bigint) {
  const index = subjectIndexName(prefix, 1);
  const subject = (await source.read(10, [RELEASED_NAME_ID])).subjects[0];
  const ids = subject ? [RELEASED_NAME_ID, RELEASED_DECOY_ID] : [RELEASED_DECOY_ID];
  await applySubjectKeys({ search, source, listing, index }, 10, ids, obligation);
}

test('the documented development analyzer is OpenSearch 3.x with analysis-icu and owner CJK tokens', async () => {
  const { version } = await requireDevelopmentAnalyzer(search);
  expect(version).toMatch(/^3\./);
  const prefix = `cjk-an-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  await createSubjectIndex(search, prefix, 1);
  const index = subjectIndexName(prefix, 1);
  const mapping = await search.request<
    Record<string, { mappings: { properties: { names: { index_options?: string } } } }>
  >('GET', `/${index}/_mapping`);
  expect(mapping.body[index]!.mappings.properties.names.index_options).toBe('offsets');
  expect(await tokens(index, '魔法禁書目錄')).toEqual(['魔法', '法禁', '禁书', '书目', '目录']);
  expect(await tokens(index, '命運石之門')).toEqual(await tokens(index, '命运石之门'));
  expect(await tokens(index, 'ｶﾞﾗｽ')).toEqual(['ガラ', 'ラス']);
  expect(await tokens(index, ' Shutage ')).toEqual(['shutage']);
  expect(await tokens(index, 'シュタインズ・ゲート')).toEqual(await tokens(index, 'しゅたいんず・げーと'));
  const folded = await analyzeInstalled(search, index, {
    char_filter: ['nfkc_cf'],
    tokenizer: 'keyword',
    filter: ['han_kana_fold'],
    text: '命運石之門ｶﾞﾗｽ',
  });
  expect(folded.map(({ token }) => token)).toEqual(['命运石之门ガラス']);
});

test('released names go through the ordinary writer into the physical index and keep current evidence across locales', async () => {
  const prefix = `cjk-wr-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  await createSubjectIndex(search, prefix, 1);
  await installTemplates(search, prefix);
  const index = subjectIndexName(prefix, 1);
  await search.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  const source = createFakeSource();
  const original = releasedMultilingualSubject();
  source.put(original);
  source.put(releasedDecoySubject());
  expect(subjectPartition(original.id)).toBe(10);
  await publish(prefix, source, 1n);

  const stored = await search.request<{ _source: { names: string[] } }>('GET', `/${index}/_doc/${RELEASED_NAME_ID}`);
  for (const value of ['命运石之门', '命運石之門', 'Shutage', 'シュタインズ・ゲート', 'Mingyun Shi zhi Men', '石头门'])
    expect(stored.body._source.names).toContain(value);
  expect(stored.body._source.names.filter((value) => value === '命運石之門')).toHaveLength(1);
  expect(stored.body._source.names.filter((value) => value === 'シュタインズ・ゲート')).toHaveLength(1);

  async function evidence(query: string) {
    const plan = compileMatchEvidence(compileText(parseText(query), { field: 'search_text', prefix: 't' }));
    const page = await searchSubjects(search, prefix, {
      query: plan.query,
      sort: 'id',
      size: 10,
      matchEvidence: plan,
    });
    const hit = page.hits.find((entry) => entry.id === RELEASED_NAME_ID);
    const current = hit ? (await source.read(10, [RELEASED_NAME_ID])).subjects[0]! : undefined;
    return {
      ids: page.hits.map((entry) => entry.id),
      plan,
      evidence: current ? projectMatchEvidence(current, hit!.engineEvidence, plan) : { state: 'unavailable' as const },
      subject: current,
    };
  }

  const simplified = await evidence('命运石之门');
  expect(simplified.ids).toEqual([RELEASED_NAME_ID]);
  expect(simplified.evidence).toMatchObject({
    state: 'current',
    source: { id: RELEASED_NAME_ID, revision: 7 },
    reasons: expect.arrayContaining([
      expect.objectContaining({ field: 'title', language: 'zh-Hant', text: '命運石之門' }),
    ]),
  });
  const traditional = await evidence('命運石之門');
  expect(traditional.ids).toEqual([RELEASED_NAME_ID]);
  expect(traditional.evidence).toMatchObject({ state: 'current', source: { revision: 7 } });
  const kana = await evidence('シュタインズ・ゲート');
  expect(kana.ids).toEqual([RELEASED_NAME_ID]);
  expect(kana.evidence).toMatchObject({
    state: 'current',
    reasons: [expect.objectContaining({ field: 'alias', language: 'und', text: 'シュタインズ・ゲート' })],
  });
  const romanization = await evidence('Mingyun Shi zhi Men');
  expect(romanization.ids).toEqual([RELEASED_NAME_ID]);
  expect(romanization.evidence).toMatchObject({
    state: 'current',
    reasons: [expect.objectContaining({ field: 'title', language: 'zh-Latn', text: 'Mingyun Shi zhi Men' })],
  });
  const alias = await evidence('shutage');
  expect(alias.ids).toEqual([RELEASED_NAME_ID]);
  expect(alias.evidence).toMatchObject({
    state: 'current',
    reasons: [expect.objectContaining({ field: 'alias', language: 'und', text: 'Shutage' })],
  });
  expect(await evidence('魔法禁書目錄外伝')).toMatchObject({ ids: [] });
  expect(await evidence('魔法禁书索引')).toMatchObject({ ids: [RELEASED_DECOY_ID] });

  for (const language of ['en', 'zh-Hant', 'ja'] as const) {
    const hit = projectHit(original, {
      descriptions: false,
      languages: [language],
      matchEvidence: alias.evidence,
    });
    expect(hit.labels).toEqual({
      [language]: original.labels.find((name) => name.language === language)!.value,
    });
    expect(hit.matchEvidence).toMatchObject({
      state: 'current',
      reasons: [{ field: 'alias', language: 'und', text: 'Shutage' }],
    });
  }

  const prefixHits = await suggestSubjects(search, prefix, { text: '命运', size: 10 });
  expect(prefixHits.map((hit) => hit.id)).toEqual([RELEASED_NAME_ID]);
  const kanaPrefix = await suggestSubjects(search, prefix, { text: 'シュタ', size: 10 });
  expect(kanaPrefix.map((hit) => hit.id)).toEqual([RELEASED_NAME_ID]);
  const latinPrefix = await suggestSubjects(search, prefix, { text: 'Shut', size: 10 });
  expect(latinPrefix.map((hit) => hit.id)).toEqual([RELEASED_NAME_ID]);
  const disclosure = createCurrentTextDisclosure(search, index);
  expect(await disclosure.matchesPrefix(original, '命运')).toBe(true);
  expect(await disclosure.matchesPrefix(original, 'Shut')).toBe(true);
  expect(await disclosure.matchesText(original, parseText('shutage'))).toBe(true);
  expect(await disclosure.matchesText(original, parseText('魔法禁書目錄外伝'))).toBe(false);

  source.put(RELEASED_CURRENT_PUBLICATION);
  await publish(prefix, source, 1n);
  const retired = await evidence('shutage');
  expect(retired.ids).toEqual([]);
  const elite = await evidence('命运石之门 Elite');
  expect(elite.ids).toEqual([RELEASED_NAME_ID]);
  expect(elite.evidence).toMatchObject({
    state: 'current',
    source: { id: RELEASED_NAME_ID, revision: 8 },
    reasons: expect.arrayContaining([
      expect.objectContaining({ field: 'title', language: 'zh-Hans', text: '命运石之门 Elite' }),
    ]),
  });
  expect(
    projectHit(RELEASED_CURRENT_PUBLICATION, {
      descriptions: false,
      languages: ['zh-Hant'],
      matchEvidence: elite.evidence,
    }).labels,
  ).toEqual({ 'zh-Hant': '命運石之門 Elite' });
  expect(await disclosure.matchesText(RELEASED_CURRENT_PUBLICATION, parseText('shutage'))).toBe(false);
});
