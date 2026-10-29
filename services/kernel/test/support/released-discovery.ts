import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Release } from '@rezics/definitions';
import { fromPlainText } from '@rezics/document';
import type { FilterDocument as Filter } from '@rezics/filter';
import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import type { HttpResponse, Persona, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { isRelationProperty } from '../../src/semantic/item.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createSemanticDriver,
  type ReleasedDiscoveryFeature,
  type SemanticOutcomeDriver,
} from '../semantic/outcome-driver.ts';
export { releasedDiscoveryFeatures, type ReleasedDiscoveryFeature } from '../semantic/outcome-driver.ts';

export const releasedDiscoveryVersion = 1 as const;
type Account = Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
export type DiscoveryPersona = Persona | 'alice' | 'bob' | 'outsider' | 'unscoped';
export type DiscoveryAccountName = 'alice' | 'bob' | 'outsider' | 'unscoped';
export type DiscoveryScopedTransport = Readonly<{
  accountId: string;
  request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
}>;
export type Prerequisite = Readonly<{
  state: 'prerequisite';
  owner: 'semantic' | 'commerce' | 'content' | 'accounts';
  required: string;
}>;
export type CreatedSubject = Readonly<{ id: string; release: string; revision: number }>;
type Statement = Omit<StatementInput, 'value'> & {
  value: StatementInput['value'] | { type: 'somevalue' } | { type: 'novalue' };
};
export type AdoptedFact = Readonly<{
  subject: string;
  candidate: string;
  property: string;
  release: string;
  acceptanceHead: number;
  adoptionHead: number;
  revision: number;
}>;
export type ClassificationGroup = Readonly<{
  formScheme: CreatedSubject;
  sourceScheme: CreatedSubject;
  lightNovel: CreatedSubject;
  otherForm: CreatedSubject;
  harem: CreatedSubject;
  facts: readonly AdoptedFact[];
}>;
export type DietGroup = Readonly<{
  scheme: CreatedSubject;
  vegetarian: CreatedSubject;
  nonvegetarian: CreatedSubject;
  facts: readonly AdoptedFact[];
}>;
export type BookName = 'B-long' | 'B-edge' | 'B-short' | 'B-unknown' | 'B-characters' | 'B-tag-only' | 'B-form-only';
export type RecipeName = 'R-quick' | 'R-edge' | 'R-slow' | 'R-meat' | 'R-unknown' | 'R-cooked' | 'R-other-cooked';
export type BookGroup = Readonly<{
  subjects: Readonly<Record<BookName, CreatedSubject>>;
  edition: CreatedSubject;
  facts: readonly AdoptedFact[];
  characterMeasurement: Prerequisite;
  measurementAssociation: Prerequisite;
}>;
export type RecipeGroup = Readonly<{
  subjects: Readonly<Record<RecipeName, CreatedSubject>>;
  facts: readonly AdoptedFact[];
  completedCooking: Prerequisite;
}>;

/** Closed extension points name missing owner data without pretending an API exists. */
export interface ReleasedDiscoveryFixture {
  readonly version: 1;
  readonly release: { digest: string; definition: Release; activeHead: number };
  readonly personas: Readonly<Record<'alice' | 'bob' | 'outsider' | 'unscoped', Account>>;
  readonly meaning: {
    form: 'wdt:P7937';
    words: 'schema:wordCount';
    diet: 'schema:suitableForDiet';
    time: 'schema:cookTime';
    minuteStorage: 'http://www.wikidata.org/entity/Q7727';
    minuteFilter: 'http://www.wikidata.org/entity/Q7727';
    lightNovel: 'http://www.wikidata.org/entity/Q747381';
    vegetarian: 'https://schema.org/VegetarianDiet';
    harem: { source: 'bangumi'; field: 'meta_tags'; member: '后宫'; canonicalRelation: 'close' };
  };
  readonly personal: Prerequisite;
  readonly sources: Prerequisite;
  readonly privacy: Prerequisite;
  readonly profiles: Prerequisite;
  readonly platform: Prerequisite;
  readonly setup: {
    openFeatures(groups: readonly ReleasedDiscoveryFeature[]): Promise<void>;
    spaceCreation(persona: DiscoveryAccountName): Promise<void>;
  };
  scoped(persona: 'alice' | 'bob', scopes: readonly string[]): Promise<DiscoveryScopedTransport>;
  /** Trusted test SQL on the owned kernel database, within the existing native read-only transaction. */
  inspect<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  request(
    persona: DiscoveryPersona,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
  createSubject(type: string, name: string, statements?: Record<string, Statement[]>): Promise<CreatedSubject>;
  adopt(subject: CreatedSubject, statement: Statement): Promise<AdoptedFact>;
  read(subject: CreatedSubject, persona?: DiscoveryPersona): Promise<HttpResponse>;
  classification(): Promise<ClassificationGroup>;
  diet(): Promise<DietGroup>;
  words(): Promise<Pick<BookGroup, 'subjects' | 'characterMeasurement' | 'measurementAssociation'>>;
  books(): Promise<BookGroup>;
  recipes(): Promise<RecipeGroup>;
  /** An independent admitted time/document control, even when diet release data is absent. */
  authoredRecipe(name: string, minutes: number): Promise<CreatedSubject>;
  filters(
    classification: ClassificationGroup,
    diet: DietGroup,
  ): Readonly<{
    words: Filter;
    formHarem: Filter;
    combined: Filter;
    dietTime: Filter;
  }>;
  catchUp(subjects: readonly CreatedSubject[]): Promise<void>;
  /** Existing native grant administration, for current-disclosure acceptance controls. */
  grant(persona: Persona, actions: string[], resourceId: string): Promise<void>;
  close(): Promise<void>;
}

export const discoveryKey = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const pending = (owner: Prerequisite['owner'], required: string): Prerequisite => ({
  state: 'prerequisite',
  owner,
  required,
});
const snak = (property: string, content: StatementInput['value']['content']) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
});
export const discoveryStatement = (property: string, content: StatementInput['value']['content']): StatementInput => ({
  ...snak(property, content),
  rank: 'preferred',
  references: [{ parts: [snak('schema:url', 'https://example.org/released-discovery/v1/controlled-assertions')] }],
});
const expectStatus = (response: HttpResponse, status: number, operation: string) => {
  if (response.status !== status)
    throw new Error(
      `${operation}: expected HTTP ${status}, observed ${response.status}: ${JSON.stringify(response.body)}`,
    );
};

/** Owns a native driver; never accepts a transport, truth callback or replacement release. */
export async function createReleasedDiscoveryFixture(
  options: { version: 1 } = { version: releasedDiscoveryVersion },
): Promise<ReleasedDiscoveryFixture> {
  if (options.version !== releasedDiscoveryVersion) throw new Error('Unsupported released discovery fixture version');
  const driver = await createSemanticDriver(
    (config) =>
      createKernel({
        ...config,
        writeRate: createWriteRateLimiter({
          secret: 'released-discovery-native-test-rate-secret',
          overrides: JSON.stringify({ 'new-account': { write: { maximum: 1000, seconds: 60 } } }),
        }),
      }),
    { strictCleanup: true },
  );
  try {
    const [alice, bob, outsider, unscoped] = await Promise.all([
      driver.fixtures.person('discovery-alice'),
      driver.fixtures.person('discovery-bob'),
      driver.fixtures.person('discovery-outsider'),
      driver.fixtures.person('discovery-unscoped', { scopes: [] }),
    ]);
    const personas = { alice, bob, outsider, unscoped };
    let closed = false;
    const requireOpen = () => {
      if (closed) throw new Error('Released discovery fixture is closed');
    };
    const request: ReleasedDiscoveryFixture['request'] = (persona, method, path, body, headers) => {
      if (persona === 'alice' || persona === 'bob' || persona === 'outsider' || persona === 'unscoped')
        return driver.fixtures.send(personas[persona], method, path, body, headers);
      if (method === 'DELETE') throw new Error('Semantic persona transport does not expose DELETE');
      return driver.request(persona, method, path, body, headers);
    };
    const active = await request('anonymous', 'GET', '/v1/definitions/active');
    expectStatus(active, 200, 'Read actual active release');
    if (active.body.digest !== bundledDigest)
      throw new Error(`Active release ${active.body.digest} differs from bundled ${bundledDigest}`);
    const published = await request(
      'steward',
      'POST',
      '/v1/definitions/releases',
      { release: bundledRelease },
      discoveryKey(),
    );
    expectStatus(published, 200, 'Republish identical bundled release');
    const read = await request('anonymous', 'GET', `/v1/definitions/releases/${bundledDigest}`);
    expectStatus(read, 200, 'Read actual bundled definition');
    if (
      published.body.digest !== bundledDigest ||
      JSON.stringify(read.body.release) !== JSON.stringify(bundledRelease)
    ) {
      // JSON object member order is immaterial; compare canonical immutable release digests below.
      const { releaseDigest } = await import('@rezics/definitions');
      if (published.body.digest !== bundledDigest || releaseDigest(read.body.release as Release) !== bundledDigest)
        throw new Error('Definition HTTP response disagrees with @rezics/definitions/bundled');
    }
    const createSubject: ReleasedDiscoveryFixture['createSubject'] = async (type, name, statements = {}) => {
      const response = await request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type,
          labels: { en: `${name} — controlled discovery test case` },
          statements,
        },
        discoveryKey(),
      );
      expectStatus(response, 201, `Create ${name} using bundled ${bundledDigest}`);
      const subject = response.body.subject as Subject;
      if (!subject.id || subject.release !== bundledDigest)
        throw new Error(`Invalid native creation receipt for ${name}`);
      return { id: subject.id, revision: subject.revision, release: subject.release };
    };
    const adopt: ReleasedDiscoveryFixture['adopt'] = async (subject, statement) => {
      const response = await request(
        'editor',
        'POST',
        `/v1/subjects/${subject.id}/candidates`,
        { statement },
        discoveryKey(),
      );
      expectStatus(response, 201, `Propose ${statement.property.id} on ${subject.id}`);
      const candidate = response.body.candidate as string;
      const acceptance = await request(
        'acceptor',
        'POST',
        `/v1/subjects/${subject.id}/candidates/${candidate}:accept`,
        {
          context: driver.globalContext,
          expected_head: null,
        },
        discoveryKey(),
      );
      expectStatus(acceptance, 200, `Accept ${candidate}`);
      const target =
        isRelationProperty(bundledRelease, statement.property.id) &&
        statement.value.type === 'value' &&
        typeof statement.value.content === 'string'
          ? statement.value.content
          : undefined;
      const adoption = await request(
        'acceptor',
        'POST',
        `/v1/subjects/${subject.id}:adopt`,
        {
          context: driver.globalContext,
          property: statement.property.id,
          ...(target ? { target } : {}),
          mode: 'replace',
          selection: [{ candidate, rank: statement.rank ?? 'normal' }],
          expected_head: null,
        },
        discoveryKey(),
      );
      expectStatus(adoption, 200, `Adopt ${candidate}`);
      return {
        subject: subject.id,
        candidate,
        property: statement.property.id,
        release: subject.release,
        acceptanceHead: (acceptance.body.acceptance as { head: number }).head,
        adoptionHead: (adoption.body.adoption as { head: number }).head,
        revision: adoption.body.revision as number,
      };
    };
    let classification: ClassificationGroup | undefined;
    let diet: DietGroup | undefined;
    let books: BookGroup | undefined;
    let recipes: RecipeGroup | undefined;
    const fixture: ReleasedDiscoveryFixture = {
      version: releasedDiscoveryVersion,
      release: {
        digest: bundledDigest,
        definition: read.body.release as Release,
        activeHead: active.body.head as number,
      },
      personas,
      meaning: {
        form: 'wdt:P7937',
        words: 'schema:wordCount',
        diet: 'schema:suitableForDiet',
        time: 'schema:cookTime',
        minuteStorage: 'http://www.wikidata.org/entity/Q7727',
        minuteFilter: 'http://www.wikidata.org/entity/Q7727',
        lightNovel: 'http://www.wikidata.org/entity/Q747381',
        vegetarian: 'https://schema.org/VegetarianDiet',
        harem: { source: 'bangumi', field: 'meta_tags', member: '后宫', canonicalRelation: 'close' },
      },
      personal: pending(
        'commerce',
        'Native support union: state-only, label-only, active session, completed history, holding; empty/follow-only/Bob-only controls.',
      ),
      sources: pending(
        'commerce',
        'Adopted common Collection producer and published dynamic generation; curated occurrence notes/duplicates and overlapping mounted Zone.',
      ),
      privacy: pending(
        'accounts',
        'Native suspension fences and advances the authentication floor, revoking the existing driver bearer (401). Accounts must provide a current verified suspended bearer for account_suspended 403 without treating revoked credentials as valid. Content moderation/source fences/consent and delegated actors must also produce withheld harem, hidden original/readable terminal and foreign repair.',
      ),
      profiles: pending(
        'semantic',
        'Bundled accepting profiles plus two immutable actual releases preserving renamed/retired choices; native owner consumer writes.',
      ),
      platform: pending(
        'semantic',
        'Adopt released same-statement platform/language/date qualifier grammar: inLanguage currently string, not a Concept or credit role.',
      ),
      request,
      setup: {
        openFeatures: (groups) => driver.fixtures.openFeatures(groups),
        async spaceCreation(persona) {
          requireOpen();
          if (!Object.hasOwn(personas, persona)) throw new Error('Space setup requires a named discovery account');
          await driver.fixtures.grantAccount(personas[persona], ['space:create']);
        },
      },
      async scoped(persona, scopes) {
        requireOpen();
        if (persona !== 'alice' && persona !== 'bob') throw new Error('Scope variants require Alice or Bob');
        const account = await driver.fixtures.scopeVariant(personas[persona], scopes);
        return Object.freeze({
          accountId: account.accountId,
          request: (method, path, body, headers) => {
            requireOpen();
            return driver.fixtures.send(account, method, path, body, headers);
          },
        } satisfies DiscoveryScopedTransport);
      },
      async inspect(sql, values) {
        requireOpen();
        return withReadTransaction(driver.fixtures.pool, (client) => client.query(sql, values ? [...values] : []));
      },
      grant: (persona, actions, resourceId) => driver.grant(persona, actions, resourceId),
      createSubject,
      adopt,
      read: (subject, persona = 'anonymous') => request(persona, 'GET', `/v1/subjects/${subject.id}`),
      async classification() {
        if (classification) return classification;
        const formScheme = await createSubject('skos:ConceptScheme', 'Work forms');
        const sourceScheme = await createSubject('skos:ConceptScheme', 'Bangumi public meta_tags');
        const lightNovel = await createSubject('skos:Concept', 'Light novel');
        const otherForm = await createSubject('skos:Concept', 'Different literary form');
        const harem = await createSubject('skos:Concept', 'Bangumi public meta_tags: 后宫');
        const facts = [];
        for (const [concept, scheme] of [
          [lightNovel, formScheme],
          [otherForm, formScheme],
          [harem, sourceScheme],
        ] as const)
          facts.push(await adopt(concept, discoveryStatement('skos:inScheme', scheme.id)));
        // These are cited controlled assertions, not an executable Bangumi import or external identity registry.
        facts.push(await adopt(lightNovel, discoveryStatement('schema:sameAs', fixture.meaning.lightNovel)));
        const source = discoveryStatement('schema:url', 'https://bgm.tv/wiki/tag/list?type=1');
        source.references = [{ parts: [snak('schema:url', 'https://bgm.tv/group/topic/406595')] }];
        facts.push(await adopt(harem, source));
        classification = { formScheme, sourceScheme, lightNovel, otherForm, harem, facts };
        await fixture.catchUp([formScheme, sourceScheme, lightNovel, otherForm, harem]);
        return classification;
      },
      async diet() {
        if (diet) return diet;
        const scheme = await createSubject('skos:ConceptScheme', 'Dietary suitability');
        const vegetarian = await createSubject('skos:Concept', 'VegetarianDiet');
        const nonvegetarian = await createSubject('skos:Concept', 'Explicit nonvegetarian control');
        const facts = [
          await adopt(vegetarian, discoveryStatement('skos:inScheme', scheme.id)),
          await adopt(nonvegetarian, discoveryStatement('skos:inScheme', scheme.id)),
          await adopt(vegetarian, discoveryStatement('schema:sameAs', fixture.meaning.vegetarian)),
        ];
        diet = { scheme, vegetarian, nonvegetarian, facts };
        await fixture.catchUp([scheme, vegetarian, nonvegetarian]);
        return diet;
      },
      async words() {
        const { subjects, characterMeasurement, measurementAssociation } = await fixture.books();
        return { subjects, characterMeasurement, measurementAssociation };
      },
      async books() {
        if (books) return books;
        const c = await fixture.classification();
        const subjects = {} as Record<BookName, CreatedSubject>;
        const facts: AdoptedFact[] = [];
        for (const [name, words, form, harem] of [
          ['B-long', 1200001, 'light', true],
          ['B-edge', 1000000, 'light', true],
          ['B-short', 999999, 'light', false],
          ['B-unknown', null, null, true],
          ['B-characters', null, 'light', true],
          ['B-tag-only', null, 'other', true],
          ['B-form-only', null, 'light', false],
        ] as const) {
          const subject = (subjects[name] = await createSubject('schema:Book', name));
          if (words !== null)
            facts.push(
              await adopt(subject, discoveryStatement(fixture.meaning.words, { amount: `+${words}`, unit: '1' })),
            );
          if (form)
            facts.push(
              await adopt(
                subject,
                discoveryStatement(fixture.meaning.form, (form === 'light' ? c.lightNovel : c.otherForm).id),
              ),
            );
          if (harem) facts.push(await adopt(subject, discoveryStatement('schema:keywords', c.harem.id)));
        }
        const edition = await createSubject('bf:Instance', 'Book edition, pages are not work words');
        facts.push(await adopt(edition, discoveryStatement('schema:exampleOfWork', subjects['B-unknown'].id)));
        facts.push(await adopt(edition, discoveryStatement('schema:numberOfPages', { amount: '+1400000', unit: '1' })));
        books = {
          subjects,
          edition,
          facts,
          characterMeasurement: pending(
            'semantic',
            'Release a separate local character-count property (1400000 on B-characters), without an invented external exact mapping.',
          ),
          measurementAssociation: pending(
            'semantic',
            'Adopt measured holder/text/version/language/method/scope/provenance grammar on the same statement/reference before freezing measurement assertions.',
          ),
        };
        await fixture.catchUp([...Object.values(subjects), edition]);
        return books;
      },
      async authoredRecipe(name, minutes) {
        const recipe = await createSubject('schema:Recipe', name);
        await adopt(
          recipe,
          discoveryStatement('schema:cookTime', { amount: `+${minutes}`, unit: fixture.meaning.minuteStorage }),
        );
        await adopt(
          recipe,
          discoveryStatement('schema:recipeIngredient', {
            language: 'en',
            text: 'Controlled authored ingredients; no diet inference.',
          }),
        );
        const instruction = discoveryStatement('schema:recipeInstructions', {
          language: 'en',
          licence: 'CC-BY-4.0',
          document: fromPlainText('Simmer the controlled test ingredients, then serve.'),
        } as unknown as StatementInput['value']['content']);
        // Document snapshots are accepted authored input; the returned public fact is a Content reference.
        await adopt(recipe, instruction);
        return recipe;
      },
      async recipes() {
        if (recipes) return recipes;
        const d = await fixture.diet();
        const subjects = {} as Record<RecipeName, CreatedSubject>;
        const facts = [];
        for (const [name, minutes, kind] of [
          ['R-quick', 25, 'vegetarian'],
          ['R-edge', 30, 'vegetarian'],
          ['R-slow', 31, 'vegetarian'],
          ['R-meat', 20, 'nonvegetarian'],
          ['R-unknown', 20, null],
          ['R-cooked', 20, 'vegetarian'],
          ['R-other-cooked', 20, 'vegetarian'],
        ] as const) {
          const recipe = (subjects[name] = await fixture.authoredRecipe(name, minutes));
          if (kind) facts.push(await adopt(recipe, discoveryStatement(fixture.meaning.diet, d[kind].id)));
        }
        recipes = {
          subjects,
          facts,
          completedCooking: pending(
            'commerce',
            'Adopt completed cooking session and not-cooked owner-query wire; R-cooked requires Alice completion, R-other-cooked only Bob completion. No state!=cooked substitution.',
          ),
        };
        await fixture.catchUp(Object.values(subjects));
        return recipes;
      },
      filters(c, d) {
        const words: Filter = {
          and: [
            { type: { in: ['schema:Book'] } },
            { statement: { property: fixture.meaning.words, range: { gte: 1000001, unit: '1' } } },
          ],
        };
        const formHarem: Filter = {
          and: [
            { type: { in: ['schema:Book'] } },
            { statement: { property: fixture.meaning.form, in: [c.lightNovel.id] } },
            { statement: { property: 'schema:keywords', in: [c.harem.id] } },
          ],
        };
        return {
          words,
          formHarem,
          combined: { and: [words, formHarem] },
          dietTime: {
            and: [
              { type: { in: ['schema:Recipe'] } },
              { statement: { property: fixture.meaning.diet, in: [d.vegetarian.id] } },
              { statement: { property: fixture.meaning.time, range: { lte: 30, unit: fixture.meaning.minuteFilter } } },
            ],
          },
        };
      },
      async catchUp(subjects) {
        const projection = linkProjection(driver.fixtures.pool);
        for (const partition of new Set(subjects.map((subject) => partitionOf(routeOf(subject.id)!)))) {
          let done = false;
          for (let step = 0; step < 200; step++) {
            const result = await projection.run(partition);
            if (result.status !== 'busy' && result.envelopes === 0) {
              done = true;
              break;
            }
            if (result.status === 'busy') await Bun.sleep(5);
          }
          if (!done) throw new Error(`Native link projection did not catch up in partition ${partition}`);
        }
      },
      close: () => {
        closed = true;
        return driver.close();
      },
    };
    return fixture;
  } catch (error) {
    try {
      await driver.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Released discovery setup and cleanup failed');
    }
    throw error;
  }
}
