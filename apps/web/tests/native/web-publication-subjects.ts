import { fromPlainText } from '@rezics/document';
import { expect } from 'bun:test';
import { PLATFORM_RESOURCE } from '../../../../services/kernel/src/access/bootstrap-governance.ts';
import type { NativeWebStack } from './stack';
import type { RelationView } from '../../../../specs/web-publication-driver';

type Data = typeof import('../../../../specs/fixtures/web-publication.json');
type Subject = { id: string; type: string; label: string; labels: Record<string, string> };
type Snak = { property: { id: string }; value: { type: 'value'; content: unknown } };
type Statement = Snak & { qualifiers?: Snak[]; references?: { parts: Snak[] }[] };
const globalContext = '00000000-0000-8000-8000-000000000000';
const snak = (property: string, content: unknown): Snak => ({
  property: { id: property },
  value: { type: 'value', content },
});
const date = (value: string) => ({
  time: `+${value}T00:00:00Z`,
  precision: 11,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
});
const position = (value: number) => snak('schema:position', { amount: `+${value}`, unit: '1' });
const reference = (text: string) => [{ parts: [snak('schema:name', { language: 'en', text })] }];

/** API-authored facts, including actual withheld targets. This does not render or copy a read model. */
export async function seedPublicationSubjects(
  kernel: NativeWebStack['kernel'],
  credentials: NativeWebStack['credentials'],
  data: Data,
) {
  const created = new Map<string, Subject>();
  async function json<T>(response: Response, status: number, phase: string): Promise<T> {
    const text = await response.text();
    if (response.status !== status) throw new Error(`${phase}: HTTP ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }
  const post = (path: string, body: unknown, persona: string) =>
    kernel(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(
            typeof body === 'object' && body && 'key' in body ? body.key : crypto.randomUUID(),
          ),
        },
        body: JSON.stringify(body),
      },
      persona,
    );
  async function writer(name: string) {
    const persona = `publication-subject-${name}`;
    const auth = await credentials(persona);
    const payload = JSON.parse(Buffer.from(auth.authorization.slice(7).split('.')[1]!, 'base64url').toString()) as {
      sub: string;
    };
    await json(
      await post(
        '/v1/grants',
        {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'account', id: payload.sub },
          actions: ['subject:create', 'statement:propose', 'context:create', 'context:accept', 'context:adopt'],
          valid: '(,)',
        },
        'governor',
      ),
      201,
      `Grant ${name} fixture writer`,
    );
    await json(
      await post(
        `/v1/accounts/${encodeURIComponent(payload.sub)}:setRateTier`,
        {
          key: crypto.randomUUID(),
          tier: 'trusted',
        },
        'governor',
      ),
      200,
      `Trust ${name} fixture writer`,
    );
    return persona;
  }
  const baseWriter = await writer('base');
  async function create(
    key: string,
    type: string,
    label: string,
    statements: Statement[] = [],
    persona = baseWriter,
    extra: Record<string, unknown> = {},
  ) {
    const grouped: Record<string, Statement[]> = {};
    for (const statement of statements) (grouped[statement.property.id] ??= []).push(statement);
    const labels: Record<string, string> = {
      en: label,
      ...(key === 'book' ? { 'zh-Hans': data.subjects.book.zhHansTitle } : {}),
    };
    const body = await json<{ subject: { id: string } }>(
      await post(
        '/v1/subjects',
        {
          type,
          labels,
          ...extra,
          ...(statements.length ? { statements: grouped } : {}),
        },
        persona,
      ),
      201,
      `Create ${key}`,
    );
    const subject = { id: body.subject.id, type, label, labels };
    created.set(key, subject);
    return subject;
  }
  const form = await create('light-novel', 'skos:Concept', data.subjects.book.form, [], baseWriter, {
    descriptions: { en: 'Public work-form classification for the publication fixture.' },
  });
  const tag = await create('harem', 'skos:Concept', data.subjects.book.tag);
  const pc = await create('pc', 'skos:Concept', data.subjects.game.platform);
  const consolePlatform = await create('switch', 'skos:Concept', data.subjects.release.platform);
  const diet = await create('vegetarian', 'skos:Concept', data.subjects.recipe.diet, [
    snak('schema:sameAs', 'https://schema.org/VegetarianDiet'),
  ]);
  const person = await create('person', 'schema:Person', data.subjects.person.title, [], baseWriter, {
    descriptions: { en: data.subjects.person.description },
  });
  const book = await create(
    'book',
    'schema:Book',
    data.subjects.book.title,
    [
      snak('schema:author', person.id),
      snak('wdt:P7937', form.id),
      snak('schema:keywords', tag.id),
      {
        ...snak('schema:datePublished', date(data.traversal.date.original)),
        references: reference(data.traversal.date.sourceOriginal),
      },
      snak('schema:wordCount', { amount: `+${data.subjects.book.wordCount}`, unit: '1' }),
    ],
    baseWriter,
    { descriptions: { en: data.subjects.book.description } },
  );
  await create(
    'recipe',
    'schema:Recipe',
    data.subjects.recipe.title,
    [
      ...data.subjects.recipe.ingredients.map((text) => snak('schema:recipeIngredient', { language: 'en', text })),
      snak('schema:recipeInstructions', {
        language: 'en',
        licence: 'CC-BY-4.0',
        document: fromPlainText(data.subjects.recipe.instructions.join('\n\n')),
      }),
      snak('schema:suitableForDiet', diet.id),
      snak('schema:cookTime', {
        amount: `+${data.subjects.recipe.cookTimeMinutes}`,
        unit: 'http://www.wikidata.org/entity/Q7727',
      }),
    ],
    baseWriter,
    { descriptions: { en: data.subjects.recipe.description } },
  );
  for (const [key, type] of [
    ['organization', 'schema:Organization'],
    ['automated', 'schema:SoftwareApplication'],
  ] as const)
    await create(key, type, data.subjects[key].title, [], baseWriter, {
      descriptions: { en: data.subjects[key].description },
    });

  const targets = new Map<RelationView, Subject[]>();
  await Promise.all(
    data.traversal.views.map(async (view) => {
      const persona = await writer(view);
      const rows: Subject[] = [];
      // Creation order deliberately differs from native declared date, name or position order.
      for (let index = data.traversal.countPerView + 1; index >= 1; index--) {
        const suffix = index > data.traversal.countPerView ? 'withheld' : String(index).padStart(3, '0');
        const key = `${view}-${suffix}`;
        const type =
          view === 'editions'
            ? 'bf:Instance'
            : view === 'cast'
              ? 'wd:Q95074'
              : view === 'crew'
                ? 'schema:Person'
                : 'schema:Book';
        const statements: Statement[] = [];
        if (view === 'editions')
          statements.push(
            snak('schema:exampleOfWork', book.id),
            snak(
              'schema:datePublished',
              date(
                `2025-${String(1 + Math.floor((index - 1) / 28)).padStart(2, '0')}-${String(1 + ((index - 1) % 28)).padStart(2, '0')}`,
              ),
            ),
          );
        if (view === 'contents') statements.push(snak('wdt:P361', book.id));
        if (view === 'inverse') statements.push({ ...snak('schema:author', person.id), qualifiers: [position(index)] });
        rows.unshift(await create(key, type, `${view} ${suffix}`, statements, persona));
      }
      targets.set(view, rows);
    }),
  );
  for (const [view, property, type] of [
    ['cast', 'schema:character', 'schema:VideoGame'],
    ['crew', 'schema:contributor', 'schema:Book'],
    ['relations', 'rezics:bangumiRelatedTo', 'schema:Book'],
  ] as const) {
    const statements = targets.get(view)!.map((target, index) => ({
      ...snak(property, target.id),
      ...(view === 'crew' ? { qualifiers: [position(index + 1)] } : {}),
    }));
    await create(`${view}-work`, type, `Lantern ${view}`, statements);
  }
  const character = await create('credit-character', 'wd:Q95074', data.traversal.credit.character);
  const spoiler = await create('spoiler-character', 'wd:Q95074', `0 ${data.traversal.credit.spoiler}`);
  const role = await create('credit-role', 'skos:Concept', data.traversal.credit.role);
  const game = await create(
    'game',
    'schema:VideoGame',
    data.subjects.game.title,
    [
      {
        ...snak('wdt:P725', person.id),
        qualifiers: [
          snak('wdt:P453', character.id),
          snak('wdt:P1932', data.traversal.credit.creditedName),
          snak('wdt:P3831', role.id),
          position(Number(data.traversal.credit.position)),
        ],
      },
      snak('schema:character', character.id),
      snak('schema:gamePlatform', pc.id),
      {
        ...snak('schema:character', spoiler.id),
        qualifiers: [snak('rezics:spoilerLevel', { amount: '+1', unit: '1' })],
      },
    ],
    baseWriter,
    { descriptions: { en: data.subjects.game.description } },
  );
  await create(
    'release',
    'wd:Q20631656',
    data.subjects.release.title,
    [
      snak('schema:exampleOfWork', game.id),
      snak('schema:gamePlatform', consolePlatform.id),
      snak('schema:datePublished', date(data.subjects.release.date)),
      snak('schema:inLanguage', data.subjects.release.language),
    ],
    baseWriter,
    { descriptions: { en: data.subjects.release.description } },
  );
  // The hidden target is linked before moderation, so omission proves current authorization.
  for (const view of data.traversal.views)
    await json(
      await post(
        `/v1/subjects/${created.get(`${view}-withheld`)!.id}:hide`,
        { reason: 'Publication fixture withheld target' },
        'governor',
      ),
      200,
      `Withhold ${view} target`,
    );
  for (const [index, title] of [...data.search.matchingBooks].reverse().entries())
    await create(`search-book-${index + 1}`, 'schema:Book', title, [], baseWriter, {
      labels: { en: title, [data.search.locale]: title },
    });
  for (let index = 1; index <= 16; index++)
    await create(
      `sitemap-book-${String(index).padStart(2, '0')}`,
      'schema:Book',
      `Public lantern ${index}`,
      [],
      baseWriter,
      { descriptions: { en: `A public catalogue page ${index}.` } },
    );
  await create('excluded-withheld', 'schema:Book', data.withheld[0]!);
  await create('excluded-private', 'schema:Book', 'Private context lantern');
  await create('excluded-taken-down', 'schema:Book', 'Taken-down lantern');

  // Fresh native readback is distinct from the subsequent served-page traversal.
  const factual = await json<{ subject: { id: string; revision: number } }>(
    await kernel(`/v1/subjects/${book.id}`),
    200,
    'Read publication book facts',
  );
  console.info(
    `web-publication-subjects: subjects=${created.size} book=${factual.subject.id} revision=${factual.subject.revision}`,
  );
  return {
    created,
    async proposeCompetingDate() {
      const path = `/v1/subjects/${book.id}`;
      const proposal = await json<{ candidate: string }>(
        await post(
          `${path}/candidates`,
          {
            statement: {
              ...snak('schema:datePublished', date(data.traversal.date.competing)),
              references: reference(data.traversal.date.sourceCompeting),
            },
          },
          baseWriter,
        ),
        201,
        'Propose competing date',
      );
      const listed = await json<{ candidates: { id: string; head: number | null }[] }>(
        await kernel(`${path}/candidates?property=schema%3AdatePublished`, undefined, baseWriter),
        200,
        'Read competing date candidates',
      );
      const candidate = listed.candidates.find(({ id }) => id === proposal.candidate)!;
      await json(
        await post(
          `${path}/candidates/${candidate.id}:accept`,
          { context: globalContext, expected_head: candidate.head },
          baseWriter,
        ),
        200,
        'Accept competing date without replacing the current selected date',
      );
      const comparison = await json<{
        candidates: {
          id: string;
          decision: string;
          statement: { value: { content: { time: string } }; references: unknown[] };
        }[];
      }>(
        await kernel(`${path}/candidates?property=schema%3AdatePublished`, undefined, baseWriter),
        200,
        'Read accepted competing date evidence',
      );
      const competing = comparison.candidates.find(({ id }) => id === proposal.candidate)!;
      expect(competing.decision).toBe('accepted');
      expect(competing.statement.value.content.time).toBe(date(data.traversal.date.competing).time);
      expect(JSON.stringify(competing.statement.references)).toContain(data.traversal.date.sourceCompeting);
      const current = await json<{
        subject: { statements: Record<string, { value: { content: { time: string } }; references: unknown[] }[]> };
      }>(await kernel(path), 200, 'Read current selection independently of candidate acceptance');
      expect(current.subject.statements['schema:datePublished']!.map(({ value }) => value.content.time)).toEqual([
        date(data.traversal.date.original).time,
      ]);
      expect(JSON.stringify(current.subject.statements['schema:datePublished'])).toContain(
        data.traversal.date.sourceOriginal,
      );
    },
  };
}
