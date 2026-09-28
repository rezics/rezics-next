import { expect, test } from 'bun:test';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { checkedFilter, type Condition, type FilterGroup } from '../src/modules/facets/schema.ts';
import { searchRoutes } from '../src/routes/search.ts';

// Each public search profile in routes/search.ts, written as a Query over admitted Facets:
// the first templates the Query compiler binds (docs/contracts/queries.md#moving-to-this-contract).
// Every request field must be read by the mapping, so a new selector fails here until it has a Facet.

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const realm = id(1), author = id(2), sense = id(3), ratingContext = id(4), actor = id(5);
const relationRevision = id(6), interpretationContext = id(7), semanticRevision = id(8), scope = id(9);
const female = id(10), red = id(11);

// Named terms resolve to exact definitions before a Query compiles. A v1 Classification Sense
// names one Concept under its exact revision; a relation revision names its definition,
// whose roles are `<definition>/role/<key>` Resources (modules/relation/change.ts).
const senses = new Map([[sense, { concept: id(20), revision: id(21) }]]);
const relations = new Map([[relationRevision, id(22)]]);
const role = (revision: string, key: string) => `${relations.get(revision)}/role/${key}`;

interface Query {
  template: string;
  text?: { phrase: string } | { title: string; body: string };
  /** Whose accepted Statements and publication selections the Query reads. */
  context: 'global' | { realm: string };
  actingSubject?: string;
  filter?: FilterGroup;
  controls?: { countGrain?: unknown; facetMode?: unknown };
  page?: { size?: unknown; continuation?: unknown };
}

type GroupedRequest = { definition: string; workRole: string; participantRole: string };
type GroupedCondition = { predicate: string; relationDefinition: string; value: string; context: string;
  semanticRevision: string; applicability: string[] };

const minimum = (timesTen: number) => ({ min: `${Math.trunc(timesTen / 10)}.${timesTen % 10}` });

/** One profile request as a Query, and the request fields it read. */
function asQuery(body: Record<string, unknown>): { query: Query; read: Set<string> } {
  const read = new Set<string>();
  const take = <T>(field: string) => { read.add(field); return body[field] as T | undefined; };
  const profile = take<string>('profile')!;
  // Multi-dataset and historical selection stay typed refusals (422), in a Query as in today's profiles.
  if (take('sourcePolicy') !== undefined || take('asOf') !== undefined) throw new Error('refused selector');
  const conditions: Condition[] = [];
  const include = take<string[]>('includeTypes');
  if (include?.length) conditions.push({ facet: 'type', any: include });
  const exclude = take<string[]>('excludeTypes');
  if (exclude?.length) conditions.push({ facet: 'type', none: exclude });
  const language = take<string | null>('language');
  if (language) conditions.push({ facet: 'language', any: [language] });
  // Today's `author` is the selected Contribution's author, not the Work's primary credit.
  const contributor = take<string>('author');
  if (contributor) conditions.push({ facet: 'contributor', any: [contributor] });
  const named = take<string>('sense');
  if (named) {
    const resolved = senses.get(named)!;
    conditions.push({ facet: 'concept', any: [resolved.concept], interpretation: { definition: resolved.revision } });
  }
  const rated = take<string>('ratingContext');
  const threshold = take<number>('minimumMeanTimes10');
  if (rated) conditions.push({ facet: 'rating', bind: { ratingContext: rated }, range: minimum(threshold!) });
  const relation = take<GroupedRequest>('relation');
  const statements = take<GroupedCondition[]>('conditions') ?? [];
  if (relation) {
    conditions.push({ facet: 'relation', bind: { definition: relation.definition,
      role: role(relation.definition, relation.workRole) }, where: { all: [
      { facet: 'role', any: [role(relation.definition, relation.participantRole)] },
      ...statements.map((statement): Condition => ({ facet: 'statement', any: [statement.value],
        bind: { predicate: statement.predicate, relationDefinition: statement.relationDefinition },
        interpretation: { context: statement.context, semanticRevision: statement.semanticRevision },
        applicability: statement.applicability })),
    ] } });
  }
  const groupedRating = take<{ context: string; minimumMeanTimes10: number }>('rating');
  if (groupedRating) {
    conditions.push({ facet: 'rating', bind: { ratingContext: groupedRating.context },
      range: minimum(groupedRating.minimumMeanTimes10) });
  }
  const phrase = take<string>('phrase'), title = take<string>('titleTerm'), textBody = take<string>('bodyTerm');
  const realmContext = take<{ kind: 'realm-local'; id: string }>('context');
  const acting = take<string>('actingSubject');
  const countGrain = take('countGrain'), facetMode = take('facetMode');
  const size = take('pageSize'), continuation = take('continuation');
  return { read, query: {
    template: profile.replace(/-page-v1$/, '-v1'),
    ...(phrase ? { text: { phrase } } : title && textBody ? { text: { title, body: textBody } } : {}),
    context: realmContext ? { realm: realmContext.id } : 'global',
    ...(acting ? { actingSubject: acting } : {}),
    ...(conditions.length ? { filter: { all: conditions } } : {}),
    ...(countGrain || facetMode ? { controls: { countGrain, facetMode } } : {}),
    ...(size ? { page: { size, continuation } } : {}),
  } };
}

// Complete requests: every selector a profile admits, as a client may send it.
const types = { includeTypes: ['https://schema.org/Book'], excludeTypes: ['https://schema.org/Recipe'] };
const text = { phrase: 'pride and prejudice', language: 'en', author, ...types };
const inRealm = { context: { kind: 'realm-local', id: realm } };
const requests: Record<string, Record<string, unknown>> = {
  'public-main-phrase-v1': text,
  'public-realm-phrase-v1': { ...text, ...inRealm },
  'public-main-classified-phrase-v1': { ...text, sense },
  'public-realm-classified-phrase-v1': { ...text, ...inRealm, sense },
  'public-realm-classified-rated-phrase-v1': { ...text, ...inRealm, sense, ratingContext, minimumMeanTimes10: 75 },
  'public-main-title-body-v1': { titleTerm: 'pride', bodyTerm: 'darcy', language: 'en', author, ...types },
  'public-grouped-statement-phrase-v1': { actingSubject: actor, ...inRealm, phrase: '学园', language: 'zh',
    relation: { definition: relationRevision, workRole: 'work', participantRole: 'lead' },
    conditions: [
      { predicate: 'https://rezics.com/vocab/gender', relationDefinition: 'https://rezics.com/definition/gender-v1',
        value: female, context: interpretationContext, semanticRevision, applicability: [scope] },
      { predicate: 'https://rezics.com/vocab/hairColor', relationDefinition: 'https://rezics.com/definition/hair-color-v1',
        value: red, context: interpretationContext, semanticRevision, applicability: [] }],
    countGrain: 'occurrence', facetMode: 'self-filter-excluding', rating: { context: ratingContext, minimumMeanTimes10: 70 } },
};
for (const [profile, request] of Object.entries({ ...requests })) {
  if (profile.startsWith('public-grouped')) continue;
  requests[profile.replace(/-v1$/, '-page-v1')] = { ...request, pageSize: 20 };
}

/** Profiles whose queried Resource is not a Work; their selectors are not Work Facets. */
const outside: Record<string, { reason: string; fields: string[] }> = {
  'public-content-phrase-v1': { reason: 'queries Content variants, whose own language needs a Content Facet',
    fields: ['profile', 'sourcePolicy', 'asOf', 'phrase', 'language'] },
  'public-content-phrase-page-v1': { reason: 'the paged Content variant query',
    fields: ['profile', 'sourcePolicy', 'asOf', 'phrase', 'language', 'pageSize', 'continuation'] },
  'public-disclosed-fields-phrase-v1': { reason: 'reads disclosed fields of Resources and Statements named by ID',
    fields: ['profile', 'sourcePolicy', 'asOf', 'phrase', 'contexts', 'statements', 'resources', 'mediaContext', 'language'] },
};

function profileSchemas(): Map<string, TSchema & { properties: Record<string, TSchema> }> {
  const app = searchRoutes({} as never, {} as never);
  const schemas = new Map<string, TSchema & { properties: Record<string, TSchema> }>();
  for (const path of ['/v1/queries', '/v1/queries/page']) {
    const route = app.routes.find(item => item.method === 'POST' && item.path === path) as
      { hooks: { body: { anyOf: (TSchema & { properties: Record<string, TSchema & { const?: string }> })[] } } };
    for (const member of route.hooks.body.anyOf) schemas.set(member.properties.profile!.const!, member);
  }
  return schemas;
}

test('Facets: every public search profile is a Query over admitted Facets or names why it is not', () => {
  const schemas = profileSchemas();
  expect([...schemas.keys()].sort()).toEqual([...Object.keys(requests), ...Object.keys(outside)].sort());
  for (const [profile, { fields }] of Object.entries(outside)) {
    expect(Object.keys(schemas.get(profile)!.properties).sort()).toEqual([...fields].sort());
  }
  const facetsUsed = new Set<string>();
  for (const [profile, request] of Object.entries(requests)) {
    const schema = schemas.get(profile)!;
    const body: Record<string, unknown> = { profile, ...request };
    expect({ profile, valid: Value.Check(schema, body) }).toEqual({ profile, valid: true });
    const { query, read } = asQuery(body);
    // No request field goes unread: each is a Condition, the text, the Context, a control or the page.
    expect({ profile, unread: Object.keys(schema.properties).filter(field => !read.has(field)) })
      .toEqual({ profile, unread: [] });
    expect(query.filter).toBeDefined();
    for (const ref of checkedFilter(query.filter!)) facetsUsed.add(ref.replace(/^.*\/facet-|-v\d+$/g, ''));
    // Each selector a client sends changes the Query; none is silently dropped.
    for (const field of Object.keys(request)) {
      const { [field]: _, ...without } = body;
      if (!Value.Check(schema, without)) continue;
      expect({ profile, field, changed: JSON.stringify(asQuery(without).query) !== JSON.stringify(query) })
        .toEqual({ profile, field, changed: true });
    }
  }
  // Primary credit (`author`) and Realm population (`realm`) serve Discovery and Zone scopes, not these profiles.
  expect([...facetsUsed].sort()).toEqual(['concept', 'contributor', 'language', 'rating', 'relation', 'role',
    'statement', 'type']);
});

test('Facets: the rated, classified Realm profile reads as its Conditions in the Realm Context', () => {
  const { query } = asQuery({ profile: 'public-realm-classified-rated-phrase-v1',
    ...requests['public-realm-classified-rated-phrase-v1'] });
  expect(query).toEqual({ template: 'public-realm-classified-rated-phrase-v1', text: { phrase: 'pride and prejudice' },
    context: { realm }, filter: { all: [
      { facet: 'type', any: ['https://schema.org/Book'] },
      { facet: 'type', none: ['https://schema.org/Recipe'] },
      { facet: 'language', any: ['en'] },
      { facet: 'contributor', any: [author] },
      { facet: 'concept', any: [id(20)], interpretation: { definition: id(21) } },
      { facet: 'rating', bind: { ratingContext }, range: { min: '7.5' } },
    ] } });
});

test('Facets: the grouped Statement read binds its role and Statements to one occurrence', () => {
  const { query } = asQuery({ profile: 'public-grouped-statement-phrase-v1',
    ...requests['public-grouped-statement-phrase-v1'] });
  const relation = (query.filter as { all: Condition[] }).all.find(condition => condition.facet === 'relation');
  expect(relation).toMatchObject({ facet: 'relation',
    bind: { definition: relationRevision, role: `${id(22)}/role/work` } });
  expect((relation!.where as { all: Condition[] }).all.map(condition => [condition.facet, condition.any])).toEqual([
    ['role', [`${id(22)}/role/lead`]], ['statement', [female]], ['statement', [red]]]);
  expect(query).toMatchObject({ context: { realm }, actingSubject: actor,
    controls: { countGrain: 'occurrence', facetMode: 'self-filter-excluding' } });
});
