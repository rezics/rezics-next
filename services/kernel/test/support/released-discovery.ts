import { createImportTransport } from '../../../importer/src/import-client.ts';
import type { ReviewedCandidatePage } from '../../../importer/src/import-client.ts';
import type { BatchWriteRequest, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import type { PublicFilterDependency } from '../../src/semantic/public-filter-source-contract.ts';
import { Importer, type ImporterOptions } from '../../../importer/src/importer.ts';
import {
  seedReviewedCatalogue,
  readReviewedBangumiBinding,
  createReviewedCatalogueLookup,
} from '../../../importer/src/reviewed-catalogue.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import pinnedBangumi from '../../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sourceTuple } from '../../src/semantic/fences.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentsForSubjects } from '../../src/semantic/agents.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { setLabelAssignment } from '../../src/library/label-assignment-store.ts';
import {
  readStoredLabelAssignment,
  unassignStoredLabelAssignment,
  restoreStoredLabelAssignment,
} from '../../src/library/label-assignment-lifecycle-store.ts';
import { testReceiptKeys } from './receipt-keys.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Release } from '@rezics/definitions';
import { fromPlainText } from '@rezics/document';
import type { FilterDocument as Filter } from '@rezics/filter';
import { randomUUID } from 'node:crypto';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { HttpResponse, Persona, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { systemClock, type KernelClock } from '../../src/clock.ts';
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
import {
  releasedDiscoveryRuntime,
  type ReleasedDiscoveryRuntime,
} from '../search/support/released-discovery-runtime.ts';

export const releasedDiscoveryVersion = 1 as const;
type Account = Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
export type DiscoveryPersona = Persona | 'alice' | 'bob' | 'outsider' | 'unscoped';
export type DiscoveryAccountName = 'alice' | 'bob' | 'outsider' | 'unscoped';
export type ReleasedDiscoveryClock = Readonly<{
  now(): Date;
  freeze(): Date;
  advanceBy(milliseconds: number): Date;
}>;
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

/** Native command observations and current selection; the tuple is data, never FOREIGN completion. */
export type ImportedHaremControl = Readonly<{
  subject: string;
  candidate: string;
  sourceConcept: string;
  source: Source;
  bulk: readonly Readonly<{ request: BatchWriteRequest; result: BatchWriteResult }>[];
  current: ReviewedCandidatePage;
  dependency: Extract<PublicFilterDependency, { kind: 'sourceTuple' }>;
  takedown(reason?: string): Promise<HttpResponse>;
}>;

/** Native statement disclosure is one-way; retract() is the production terminal command. */
export type StatementConsentControl = Readonly<{
  dependency: Extract<PublicFilterDependency, { kind: 'consent' }>;
  target: string;
  subject: string;
  candidate: string;
  disclose(): Promise<HttpResponse>;
  retract(): Promise<HttpResponse>;
}>;

/** Closed extension points name missing owner data without pretending an API exists. */
export interface ReleasedDiscoveryFixture {
  readonly version: 1;
  readonly clock: ReleasedDiscoveryClock;
  readonly search?: ReleasedDiscoveryRuntime;
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
    realmCreation(persona: DiscoveryAccountName): Promise<void>;
  };
  reviewedCatalogueOperator(persona: 'alice' | 'bob'): Promise<ReturnType<typeof createImportTransport>>;
  importedHarem(): Promise<ImportedHaremControl>;
  statementConsent(): Promise<StatementConsentControl>;
  nativeLabelAssignment(
    persona: 'alice' | 'bob',
    labelId: string,
    subjectId: string,
    operation?: 'set' | 'unassign' | 'restore',
  ): Promise<void>;
  scoped(persona: 'alice' | 'bob', scopes: readonly string[]): Promise<DiscoveryScopedTransport>;
  signIn(persona: DiscoveryAccountName | 'suspended'): Promise<HttpResponse>;
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
function requireBinding(value: unknown, binding: string): asserts value {
  if (!value) throw new Error(`Released discovery missing native binding: ${binding}`);
}

/** Owns a native driver; never accepts a transport, truth callback or replacement release. */
export async function createReleasedDiscoveryFixture(
  options: { version: 1; kernelPool?: (url: string) => Pool | Promise<Pool>; search?: 'native' } = {
    version: releasedDiscoveryVersion,
  },
): Promise<ReleasedDiscoveryFixture> {
  if (options.version !== releasedDiscoveryVersion) throw new Error('Unsupported released discovery fixture version');
  let closed = false;
  const requireOpen = () => {
    if (closed) throw new Error('Released discovery fixture is closed');
  };
  let frozenAt: number | undefined;
  // This same function remains callable by native cleanup after the public controls close.
  const kernelClock: KernelClock = () => new Date(frozenAt ?? systemClock().getTime());
  const clock: ReleasedDiscoveryClock = {
    now: kernelClock,
    freeze() {
      requireOpen();
      frozenAt ??= systemClock().getTime();
      native?.onClockChange(new Date(frozenAt));
      return kernelClock();
    },
    advanceBy(milliseconds) {
      requireOpen();
      if (frozenAt === undefined) throw new Error('Released discovery clock must be frozen before advancing');
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
        throw new Error('Clock advance must be a finite nonnegative safe integer');
      const next = frozenAt + milliseconds;
      if (!Number.isSafeInteger(next) || next > 8_640_000_000_000_000)
        throw new Error('Released discovery clock overflow');
      frozenAt = next;
      native?.onClockChange(new Date(next));
      return kernelClock();
    },
  };
  const native = options.search === 'native' ? releasedDiscoveryRuntime(options.kernelPool) : undefined;
  let nativeStart: Promise<void> | undefined;
  const flushNativeClock = async () => {
    // Setup sends precede start(); join the actual lifecycle only after it exists.
    if (nativeStart) {
      await nativeStart;
      await native!.flushClock();
    }
  };
  const driver = await createSemanticDriver(
    (config) =>
      createKernel({
        receiptKeys: testReceiptKeys(),
        ...config,
        ...(config.onAccessReady || native
          ? {
              onAccessReady(access, viewerActions) {
                config.onAccessReady?.(access, viewerActions);
                native?.onAccessReady(access);
              },
            }
          : {}),
        ...(native ? { search: native.service(config) } : {}),
        writeRate: createWriteRateLimiter({
          secret: 'released-discovery-native-test-rate-secret',
          overrides: JSON.stringify({ 'new-account': { write: { maximum: 1000, seconds: 60 } } }),
        }),
      }),
    {
      strictCleanup: true,
      clock: kernelClock,
      ...(options.kernelPool ? { kernelPool: options.kernelPool } : {}),
      ...(native
        ? {
            isolatedAuth: true,
            linkProjection: 'external',
            beforeClose: () => native.close(),
          }
        : {}),
    },
  );
  try {
    await driver.grant('steward', ['gate:definition_publication'], driver.globalContext);
    const [alice, bob, outsider, unscoped] = await Promise.all([
      driver.fixtures.person('discovery-alice'),
      driver.fixtures.person('discovery-bob'),
      driver.fixtures.person('discovery-outsider'),
      driver.fixtures.person('discovery-unscoped', { scopes: [] }),
    ]);
    const personas = { alice, bob, outsider, unscoped };
    const request: ReleasedDiscoveryFixture['request'] = async (persona, method, path, body, headers) => {
      await flushNativeClock();
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
    let classification: Promise<ClassificationGroup> | undefined;
    let diet: Promise<DietGroup> | undefined;
    let books: Promise<BookGroup> | undefined;
    let recipes: Promise<RecipeGroup> | undefined;
    // Cache the operation, including failure, so concurrent consumers cannot create a second import or holder.
    let importedHarem: Promise<ImportedHaremControl> | undefined;
    let statementConsent: Promise<StatementConsentControl> | undefined;
    const fixture: ReleasedDiscoveryFixture = {
      version: releasedDiscoveryVersion,
      clock,
      ...(native ? { search: native.control } : {}),
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
        'Native suspension fences and advances the authentication floor, revoking the existing driver bearer (401). Raw native correct-password sign-in of the retained suspended account must return account_suspended 403 with code ACCOUNT_SUSPENDED and no session. Content moderation/source fences/consent and delegated actors must also produce withheld harem, hidden original/readable terminal and foreign repair.',
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
      async signIn(persona) {
        requireOpen();
        if (persona === 'suspended') return driver.fixtures.signIn(await driver.fixtures.person('suspended'));
        if (!Object.hasOwn(personas, persona)) throw new Error('Sign-in requires a named discovery account');
        return driver.fixtures.signIn(personas[persona]);
      },
      async reviewedCatalogueOperator(persona) {
        requireOpen();
        // The explicit test operator receives real native Access grants, never an importer default.
        await driver.fixtures.grantAccount(personas[persona], [
          'subject:batch_write',
          'subject:create',
          'statement:propose',
          'source_fence:read',
          'context:accept',
          'context:adopt',
        ]);
        const account = personas[persona];
        return createImportTransport({
          origin: 'https://reviewed.discovery.test',
          tokenProvider: async () => account.bearer,
          fetch: (async (input, init) => {
            requireOpen();
            const req = new Request(input, init);
            const url = new URL(req.url);
            const method = req.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
            const bytes = await req.text();
            await flushNativeClock();
            const response = await driver.fixtures.send(
              account,
              method,
              url.pathname + url.search,
              bytes ? JSON.parse(bytes) : undefined,
              Object.fromEntries(req.headers),
            );
            if (response.status >= 400)
              console.error(
                'Reviewed import HTTP failure',
                method,
                url.pathname,
                response.status,
                JSON.stringify(response.body).slice(0, 1024),
              );
            return Response.json(response.body, { status: response.status, headers: response.headers });
          }) as typeof fetch,
        });
      },
      async importedHarem() {
        requireOpen();
        return (importedHarem ??= (async () => {
          const port = await fixture.reviewedCatalogueOperator('alice');
          const directory = await mkdtemp(join(tmpdir(), 'released-discovery-import-'));
          const path = join(directory, 'state.sqlite');
          let importer: Importer | undefined;
          try {
            // The existing producer resolves already-created native claims on replay; no second vocabulary world.
            await seedReviewedCatalogue({ path, port });
            const bulk: ImportedHaremControl['bulk'][number][] = [];
            const options: ImporterOptions = {
              path,
              transport: {
                batchWrite: (request) => port.batch(request),
                setSourceRecordMetadata: port.setSourceRecordMetadata,
                readFence: (tuple) =>
                  port.fence({
                    source: tuple.source,
                    externalId: tuple.external_id,
                    fieldGroup: tuple.field_group,
                  }),
              },
              // This hook runs after real bulk success and before the importer's local ACK.
              afterBulkSuccess(request, result) {
                bulk.push(structuredClone({ request, result }));
              },
            };
            importer = new Importer(options);
            const binding = await readReviewedBangumiBinding(importer.session.bindings, port);
            requireBinding(binding, 'current reviewed Bangumi source-harem lookup');
            options.identifierLookup = createReviewedCatalogueLookup(importer.session.bindings, port);
            const run = await importer.runRecords(
              createSourceRegistration('bangumi'),
              (async function* () {
                yield { source: 'bangumi' as const, key: '498', revision: null, payload: pinnedBangumi };
              })(),
            );
            requireBinding(run.status === 'committed', `Bangumi import committed (${run.status})`);
            const observations = bulk.flatMap(({ request, result }) =>
              request.commands.map((command) => {
                const matches = result.results.filter((entry) => entry.key === command.key);
                requireBinding(matches.length === 1, `bulk result for command.key ${command.key}`);
                return { command, result: matches[0]! };
              }),
            );
            const keywords = observations.filter(
              ({ command }) =>
                command.op === 'propose' &&
                command.statement.property.id === 'schema:keywords' &&
                command.statement.value.type === 'value' &&
                command.statement.value.content === binding.sourceConcept,
            );
            requireBinding(keywords.length === 1, 'one imported source-harem keyword proposal');
            const proposal = keywords[0]!;
            requireBinding(proposal.command.op === 'propose', 'imported keyword command');
            requireBinding(
              'value' in proposal.result && 'candidate' in proposal.result.value,
              `native propose.candidate for ${proposal.command.key}`,
            );
            const subject = proposal.command.subject;
            const candidate = proposal.result.value.candidate;
            const creations = observations.filter(
              ({ command, result }) =>
                command.op === 'create' &&
                command.subject.type === 'schema:Book' &&
                isDeepStrictEqual(command.source, proposal.command.source) &&
                'value' in result &&
                'id' in result.value &&
                result.value.id === subject,
            );
            requireBinding(creations.length === 1, 'matching imported Book create.id and native Source');
            const query = {
              property: 'schema:keywords',
              target: binding.sourceConcept,
              context: driver.globalContext,
              limit: 100,
            };
            let page = await port.reviewedCandidates(subject, query);
            const row = page.candidates.find((entry) => entry.id === candidate);
            requireBinding(
              page.next === null && row && 'statement' in row,
              'exact native imported candidate in the keyword slot',
            );
            requireBinding(
              row.source && 'source' in row.source && isDeepStrictEqual(row.source, proposal.command.source),
              'candidate Source equals captured keyword command.source',
            );
            const verifiedNativeSource = row.source;
            requireBinding(
              row.statement.property.id === query.property &&
                row.statement.value.type === 'value' &&
                row.statement.value.content === query.target &&
                row.retracted === null &&
                row.retraction === null &&
                row.decision !== 'rejected' &&
                row.rank !== 'deprecated' &&
                (!page.adoption || (page.adoption.mode === 'replace' && row.rank !== null)) &&
                !page.candidates.some((entry) => 'statement' in entry && entry.id !== candidate && entry.rank !== null),
              'live unconflicted imported keyword candidate',
            );
            const accepted = await port.acceptReviewedCandidate(
              subject,
              candidate,
              { context: driver.globalContext, expected_head: row.head },
              randomUUID(),
            );
            requireBinding(
              accepted.acceptance.candidate === candidate && accepted.acceptance.decision === 'accept',
              'native keyword acceptance',
            );
            page = await port.reviewedCandidates(subject, query);
            requireBinding(
              page.next === null &&
                !page.candidates.some(
                  (entry) => 'statement' in entry && entry.id !== candidate && entry.rank !== null,
                ) &&
                (!page.adoption ||
                  (page.adoption.mode === 'replace' &&
                    page.candidates.some(
                      (entry) => 'statement' in entry && entry.id === candidate && entry.rank !== null,
                    ))),
              'bounded unconflicted native keyword adoption head',
            );
            const adopted = await port.adoptReviewedCandidates(
              subject,
              {
                context: query.context,
                property: query.property,
                target: query.target,
                mode: 'replace',
                selection: [{ candidate, rank: 'preferred' }],
                expected_head: page.adoption?.head ?? null,
              },
              randomUUID(),
            );
            requireBinding(
              adopted.adoption.selection.some((entry) => entry.candidate === candidate && entry.rank === 'preferred'),
              'native keyword adoption selection',
            );
            const current = await port.reviewedCandidates(subject, query);
            const selected = current.candidates.find((entry) => entry.id === candidate);
            requireBinding(
              current.next === null &&
                current.adoption?.mode === 'replace' &&
                current.adoption.head === adopted.adoption.head &&
                selected &&
                'statement' in selected &&
                selected.decision === 'accepted' &&
                selected.head === accepted.acceptance.head &&
                selected.rank === 'preferred' &&
                selected.retracted === null &&
                selected.retraction === null &&
                isDeepStrictEqual(selected.source, verifiedNativeSource),
              'current native selected keyword and retained Source',
            );
            const readback = await port.readReviewedSubject(subject);
            requireBinding(
              'subject' in readback &&
                readback.subject.id === subject &&
                readback.subject.statements[query.property]?.some(
                  (entry) =>
                    entry.id === candidate && entry.value.type === 'value' && entry.value.content === query.target,
                ),
              'current imported Book keyword readback',
            );
            // Equivalent retained native selection evidence above, using Content's real tuple constructor.
            // This locator is not Source projection/reduction, dispatch, repair ACK or FOREIGN visibility proof.
            const dependency: ImportedHaremControl['dependency'] = {
              kind: 'sourceTuple',
              tuple: sourceTuple(Buffer.from(driver.fixtures.runtime.routeKey, 'base64url'), verifiedNativeSource),
            };
            const { source, external_id, field_group } = verifiedNativeSource;
            await driver.fixtures.grantAccount(personas.alice, ['source_fence:takedown']);
            return {
              subject,
              candidate,
              sourceConcept: binding.sourceConcept,
              source: structuredClone(verifiedNativeSource),
              bulk,
              current,
              dependency,
              async takedown(reason = 'Released discovery imported keyword control') {
                requireOpen();
                return request(
                  'alice',
                  'POST',
                  '/v1/sourceFences:takedown',
                  {
                    source,
                    externalId: external_id,
                    fieldGroup: field_group,
                    reason,
                  },
                  discoveryKey(),
                );
              },
            };
          } finally {
            try {
              await importer?.close();
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          }
        })());
      },
      async statementConsent() {
        requireOpen();
        return (statementConsent ??= (async () => {
          const editor = await driver.fixtures.person('editor');
          await flushNativeClock();
          const agent = await ensureAccountAgent(driver.fixtures.pool, {
            account: editor,
            kind: 'person',
            name: 'Released discovery consent owner',
          });
          const holder = await createSubject('schema:Organization', 'Native statement consent holder');
          const proposed = await request(
            'editor',
            'POST',
            `/v1/subjects/${holder.id}/candidates`,
            {
              statement: { ...snak('rezics:penNameOf', agent.subject.id), references: [] },
            },
            discoveryKey(),
          );
          expectStatus(proposed, 201, 'Propose owner-authored unsourced pen name');
          const candidate = proposed.body.candidate;
          requireBinding(typeof candidate === 'string', 'native statement consent candidate');
          const point = await withReadTransaction(driver.fixtures.pool, async (client) => {
            // Only this exact committed point; routing is returned from storage, not the account's route.
            const result = await client.query<{
              route: number;
              account_id: string;
              subject_id: string;
              candidate_id: string;
              target_id: string;
            }>(
              `SELECT route, account_id::text, subject_id::text, candidate_id::text, target_id::text
               FROM semantic.statement_disclosure WHERE route = $1 AND subject_id = $2 AND candidate_id = $3`,
              [routeOf(candidate), holder.id, candidate],
            );
            requireBinding(result.rows.length === 1, 'exact committed statement_disclosure point');
            const row = result.rows[0]!;
            requireBinding(
              row.route === routeOf(candidate) &&
                row.route === routeOf(holder.id) &&
                row.account_id === editor.accountId &&
                row.subject_id === holder.id &&
                row.candidate_id === candidate &&
                row.target_id === agent.subject.id,
              'stored disclosure route/account/subject/candidate/target linkage',
            );
            const links = await accountAgentsForSubjects(client, [row.target_id]);
            requireBinding(
              links.get(row.target_id)?.account === row.account_id &&
                links.get(row.target_id)?.subject === row.target_id,
              'current native target-account agent relationship',
            );
            return row;
          });
          return {
            dependency: {
              kind: 'consent',
              route: point.route,
              account: point.account_id,
              subject: point.subject_id,
              candidate: point.candidate_id,
            },
            target: point.target_id,
            subject: point.subject_id,
            candidate: point.candidate_id,
            async disclose() {
              requireOpen();
              return request('editor', 'POST', `/v1/statements/${point.candidate_id}/disclose`, {}, discoveryKey());
            },
            async retract() {
              requireOpen();
              return request('editor', 'POST', `/v1/statements/${point.candidate_id}/retract`, {}, discoveryKey());
            },
          };
        })());
      },
      async nativeLabelAssignment(persona, labelId, subjectId, operation = 'set') {
        requireOpen();
        // Delivered DAO seam: authenticate the real bearer, then use the real scoped owner command runner.
        const actor = await driver.fixtures.authenticatedAccount(personas[persona]);
        await createLibraryCommandRunner({ pool: driver.fixtures.pool, clock: kernelClock }).ownAccount(
          actor,
          {
            action: 'library_entry:update',
            kind: `library_label.${operation}`,
            requestKey: randomUUID(),
            input: { labelId, subjectId },
          },
          async (tx, command) => {
            const tuple = { route: routeOf(actor.accountId)!, accountId: actor.accountId, labelId, subjectId };
            const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
            const value = await (async () => {
              if (operation === 'set') return setLabelAssignment(tx, tuple, context);
              const current = await readStoredLabelAssignment(tx, tuple);
              if (!current?.id) throw new Error('Missing native assignment identity');
              return (operation === 'unassign' ? unassignStoredLabelAssignment : restoreStoredLabelAssignment)(
                tx,
                { ...tuple, assignmentId: current.id, revision: current.revision },
                context,
              );
            })();
            if (value.kind !== 'applied' && value.kind !== 'existing')
              throw new Error(`Native label setup: ${value.kind}`);
            return {
              value: null,
              events: [{ type: 'com.rezics.library.label.changed.v1', subject: actor.accountId, data: { labelId } }],
            };
          },
        );
      },
      setup: {
        openFeatures: (groups) => driver.fixtures.openFeatures(groups),
        async spaceCreation(persona) {
          requireOpen();
          if (!Object.hasOwn(personas, persona)) throw new Error('Space setup requires a named discovery account');
          await driver.fixtures.grantAccount(personas[persona], ['space:create']);
        },
        async realmCreation(persona) {
          requireOpen();
          if (!Object.hasOwn(personas, persona)) throw new Error('Realm setup requires a named discovery account');
          await driver.fixtures.grantAccount(personas[persona], ['realm:create']);
        },
      },
      async scoped(persona, scopes) {
        requireOpen();
        if (persona !== 'alice' && persona !== 'bob') throw new Error('Scope variants require Alice or Bob');
        const account = await driver.fixtures.scopeVariant(personas[persona], scopes);
        return Object.freeze({
          accountId: account.accountId,
          request: async (method, path, body, headers) => {
            requireOpen();
            await flushNativeClock();
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
        return (classification ??= (async () => {
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
          const group = { formScheme, sourceScheme, lightNovel, otherForm, harem, facts };
          await fixture.catchUp([formScheme, sourceScheme, lightNovel, otherForm, harem]);
          return group;
        })());
      },
      async diet() {
        return (diet ??= (async () => {
          const scheme = await createSubject('skos:ConceptScheme', 'Dietary suitability');
          const vegetarian = await createSubject('skos:Concept', 'VegetarianDiet');
          const nonvegetarian = await createSubject('skos:Concept', 'Explicit nonvegetarian control');
          const facts = [
            await adopt(vegetarian, discoveryStatement('skos:inScheme', scheme.id)),
            await adopt(nonvegetarian, discoveryStatement('skos:inScheme', scheme.id)),
            await adopt(vegetarian, discoveryStatement('schema:sameAs', fixture.meaning.vegetarian)),
          ];
          const group = { scheme, vegetarian, nonvegetarian, facts };
          await fixture.catchUp([scheme, vegetarian, nonvegetarian]);
          return group;
        })());
      },
      async words() {
        const { subjects, characterMeasurement, measurementAssociation } = await fixture.books();
        return { subjects, characterMeasurement, measurementAssociation };
      },
      async books() {
        return (books ??= (async () => {
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
          facts.push(
            await adopt(edition, discoveryStatement('schema:numberOfPages', { amount: '+1400000', unit: '1' })),
          );
          const group = {
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
          return group;
        })());
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
        return (recipes ??= (async () => {
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
          const group = {
            subjects,
            facts,
            completedCooking: pending(
              'commerce',
              'Adopt completed cooking session and not-cooked owner-query wire; R-cooked requires Alice completion, R-other-cooked only Bob completion. No state!=cooked substitution.',
            ),
          };
          await fixture.catchUp(Object.values(subjects));
          return group;
        })());
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
        if (native) return native.control.converge(subjects);
        const projection = linkProjection(driver.fixtures.pool);
        for (const partition of new Set(subjects.map((subject) => partitionOf(routeOf(subject.id)!)))) {
          let done = false;
          for (let step = 0; step < 200; step++) {
            const result = await projection.run(partition);
            if (result.status === 'stopped')
              throw new Error(`Native link projection stopped in partition ${partition}: ${result.reason}`);
            if (result.status === 'read' && result.envelopes === 0) {
              done = true;
              break;
            }
            if (result.status === 'busy') await Bun.sleep(5);
          }
          if (!done) throw new Error(`Native link projection did not catch up in partition ${partition}`);
        }
      },
      close: async () => {
        closed = true;
        const errors: unknown[] = [];
        await Promise.allSettled([
          importedHarem,
          statementConsent,
          nativeStart,
          classification,
          diet,
          books,
          recipes,
        ]);
        try {
          await driver.close();
        } catch (cleanup) {
          errors.push(cleanup);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'Released discovery cleanup failed');
      },
    };
    if (native) {
      nativeStart = native.start(driver.fixtures.runtime, (path, body) =>
        request('anonymous', body === undefined ? 'GET' : 'POST', path, body),
      );
      await nativeStart;
    }
    return fixture;
  } catch (error) {
    const errors: unknown[] = [];
    await Promise.allSettled([nativeStart]);
    try {
      await driver.close();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    if (errors.length) throw new AggregateError([error, ...errors], 'Released discovery setup and cleanup failed', { cause: error });
    throw error;
  }
}
