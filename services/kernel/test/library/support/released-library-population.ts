import type { LibraryProfile, LibraryProfilePin } from '@rezics/definitions';
import type { MemberSource } from '@rezics/composition';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';
import type { SavedDynamicCollectionView } from '../../../src/library/collection-reads.ts';
import type { CollectionPublication } from '../../../src/library/collection-publication.ts';
import type { CollectionRule } from '../../../src/library/collection-rules.ts';
import type { NativeCollectionMetadata } from '../../../src/library/collection-source-native.ts';
import type {
  CollectionOutputPublication,
  CollectionOutputRef,
} from '../../../src/library/collection-source-output.ts';
import outputHead from '../../../src/library/collection-source-output-head.sql';
import { routeOf } from '../../../src/route/route.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../../support/released-discovery.ts';

export const releasedLibraryPopulationVersion = 1 as const;
type Owner = 'alice' | 'bob';
export type NativeCall = Readonly<{
  persona: DiscoveryPersona;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
  headers: Readonly<Record<string, string>>;
  response: HttpResponse;
}>;
export type EntryHandle = Readonly<{
  subjectId: string;
  state: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type LabelHandle = Readonly<{ id: string; revision: number }>;
export type AssignmentHandle = Readonly<{ id: string; revision: number }>;
export type SessionHandle = Readonly<{
  id: string;
  subjectId: string;
  mode: 'scalar_amount' | 'cursor_position' | 'completed_units';
  unit: string;
  state: 'active' | 'completed' | 'abandoned';
  revision: number;
  completedAt: string | null;
}>;
export type CopyHandle = Readonly<{ id: string; subjectId: string; status: string; revision: number }>;
export type OccurrenceHandle = Readonly<{ id: string; subjectId: string; note: string | null; addedAt: string }>;
export type SourceHandle = Readonly<{
  id: string;
  revision: number;
  visibility: 'public' | 'unlisted' | 'private';
}>;
export type AcceptedProfile = Readonly<{ profile: LibraryProfile; pin: LibraryProfilePin }>;
export type Boundary = Readonly<{ state: 'prerequisite'; required: string }>;

/** One explicit selected0..100 publication, never a whole-query snapshot or a Zone proof. */
export type ReleasedDynamicSelection = Readonly<{
  created: Readonly<{ collection: SavedDynamicCollectionView; response: HttpResponse }>;
  collection: SavedDynamicCollectionView;
  publication: CollectionPublication;
  response: HttpResponse;
  current: Readonly<{ collection: SavedDynamicCollectionView; response: HttpResponse }>;
  source: Extract<MemberSource, { kind: 'collection' }>;
  nativeHeader: Pick<
    NativeCollectionMetadata,
    | 'route'
    | 'collectionId'
    | 'curatorAccountId'
    | 'revision'
    | 'sourceGeneration'
    | 'state'
    | 'visibility'
    | 'membershipKind'
  >;
  output: Readonly<{ ref: CollectionOutputRef; receipt: CollectionOutputPublication }>;
}>;

/** Native responses are retained verbatim, including failed responses and descriptor headers. */
function requireStatus(response: HttpResponse, expected: number, operation: string): void {
  if (response.status !== expected)
    throw new Error(
      `${operation}: expected HTTP ${expected}, observed ${response.status}: ${JSON.stringify(response.body)}`,
    );
}
function handle<T>(response: HttpResponse, field: string): T {
  const value = response.body[field];
  if (typeof value !== 'object' || value === null) throw new Error(`Native response lacks ${field}`);
  return value as T;
}
function required<T>(value: T | undefined, field: string, digest: string): T {
  if (value === undefined) throw new Error(`Bundled release ${digest} lacks ${field}`);
  return value;
}

/**
 * One owned shared native world. Families are lazy so an absent label route cannot hide a state/copy/session red.
 * No caller transport, registry, policy, resource IDs, released data or membership callback is accepted.
 */
export async function createReleasedLibraryPopulation(
  options: NonNullable<Parameters<typeof createReleasedDiscoveryFixture>[0]> = {
    version: releasedLibraryPopulationVersion,
  },
) {
  if (options.version !== releasedLibraryPopulationVersion)
    throw new Error('Unsupported released Library population version');
  const base = await createReleasedDiscoveryFixture(options);
  const calls: NativeCall[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await base.close();
  };
  const request: ReleasedDiscoveryFixture['request'] = async (persona, method, path, body, headers = {}) => {
    if (closed) throw new Error('Released Library population is closed');
    const response = await base.request(persona, method, path, body, headers);
    calls.push({ persona, method, path, body, headers, response });
    return response;
  };
  // Keep the original error as well as cleanup evidence; never turn a failed family into a successful group.
  const setup = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Released Library setup and cleanup failed', { cause: error });
      }
      throw error;
    }
  };
  const write = async (
    owner: Owner,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    status: number,
  ) => {
    const response = await request(owner, method, path, body, discoveryKey());
    requireStatus(response, status, `${owner} ${method} ${path}`);
    return response;
  };
  const profile = (type: string): AcceptedProfile => {
    const definition = required(base.release.definition.types[type], `types[${type}]`, base.release.digest);
    const binding = required(definition.library, `types[${type}].library`, base.release.digest);
    const value = required(
      base.release.definition.libraryProfiles?.[binding.profileId],
      `libraryProfiles[${binding.profileId}]`,
      base.release.digest,
    );
    return {
      profile: value,
      pin: { provenance: 'profile', releaseDigest: base.release.digest, acceptingType: type, profileId: value.id },
    };
  };
  const entry = async (subject: CreatedSubject, owner: Owner = 'alice') => {
    const accepted = profile('schema:Book');
    const state = required(
      accepted.profile.entryStateSet?.states.find((choice) => choice.role === 'active'),
      'Book active state choice',
      base.release.digest,
    );
    const response = await write(owner, 'PUT', `/v1/libraryEntries/${subject.id}`, { state: state.id }, 201);
    return { subject, accepted, entry: handle<EntryHandle>(response, 'libraryEntry'), response };
  };
  const label = async (name: string, owner: Owner = 'alice') => {
    const response = await write(owner, 'POST', '/v1/libraryLabels', { name }, 201);
    return { label: handle<LabelHandle>(response, 'label'), response };
  };
  const assign = async (label: LabelHandle, subject: CreatedSubject, owner: Owner = 'alice') => {
    const response = await write(owner, 'POST', `/v1/libraryLabels/${label.id}:assign`, { subjectId: subject.id }, 200);
    return { subject, assignment: handle<AssignmentHandle>(response, 'assignment'), response };
  };
  const session = async (subject: CreatedSubject, type: string, owner: Owner, complete: boolean) => {
    const accepted = profile(type);
    const mode = required(
      accepted.profile.progress?.allowed.find((choice) => choice.mode === 'scalar_amount'),
      `${type} scalar progress mode`,
      base.release.digest,
    );
    // Cooking records elapsed time; a page/percent/unit-count is not substituted for minutes.
    const unit = required(
      type === 'schema:Recipe' ? mode.units.find((choice) => choice.id === 'minute') : mode.units[0],
      `${type} declared progress unit`,
      base.release.digest,
    );
    const total = unit.totalPolicy === 'required' ? (unit.maximum ?? unit.minimum ?? '0') : undefined;
    const amount = unit.minimum ?? '0';
    const created = await write(
      owner,
      'POST',
      '/v1/progressSessions',
      { subjectId: subject.id, mode: mode.mode, unit: unit.id, ...(total === undefined ? {} : { total }) },
      201,
    );
    let current = handle<SessionHandle>(created, 'progressSession');
    const recorded = await write(
      owner,
      'POST',
      `/v1/progressSessions/${current.id}:record`,
      { revision: current.revision, amount },
      200,
    );
    current = handle<SessionHandle>(recorded, 'progressSession');
    let completed: HttpResponse | undefined;
    if (complete) {
      completed = await write(
        owner,
        'POST',
        `/v1/progressSessions/${current.id}:complete`,
        { revision: current.revision },
        200,
      );
      current = handle<SessionHandle>(completed, 'progressSession');
    }
    return { subject, accepted, session: current, created, recorded, completed };
  };
  const copy = async (subject: CreatedSubject, owner: Owner = 'alice') => {
    const accepted = profile('schema:Book');
    const kind = required(accepted.profile.copies?.kinds[0], 'Book copy kind', base.release.digest);
    const status = required(kind.statuses[0], 'Book copy status', base.release.digest);
    const response = await write(
      owner,
      'POST',
      '/v1/copies',
      { subjectId: subject.id, kind: kind.id, status: status.id },
      201,
    );
    return { subject, accepted, copy: handle<CopyHandle>(response, 'copy'), response };
  };
  const follow = async (subject: CreatedSubject) => {
    const response = await write('alice', 'PUT', `/v1/follows/${subject.id}`, undefined, 200);
    return { subject, response, follow: handle<{ targetId: string; state: string }>(response, 'follow') };
  };
  const memo = <T>(run: () => Promise<T>) => {
    let result: Promise<T> | undefined;
    return () => (result ??= setup(run));
  };
  const state = memo(async () => entry(await base.createSubject('schema:Book', 'Own state only')));
  const labels = memo(async () => {
    // Catalogue admission is independent of the semantic Book producer and of profile admission.
    const own = await label('vegetarian');
    const books = await base.books();
    const subject = books.subjects['B-long'];
    const assignment = await assign(own.label, subject);
    const bob = await label('Bob private label', 'bob');
    const bobAssignment = await assign(bob.label, subject, 'bob');
    const recipe = await base.createSubject('schema:Recipe', 'Private vegetarian label, unknown public diet');
    const publicBefore = await base.read(recipe);
    requireStatus(publicBefore, 200, 'Read public Recipe before private assignment');
    const recipeAssignment = await assign(own.label, recipe);
    return { subject, ...own, assignment, bob, bobAssignment, recipe, publicBefore, recipeAssignment };
  });
  const sessions = memo(async () => {
    const activeSubject = await base.createSubject('schema:Book', 'Active session only');
    const historySubject = await base.createSubject('schema:Book', 'Completed history only');
    return {
      active: await session(activeSubject, 'schema:Book', 'alice', false),
      history: await session(historySubject, 'schema:Book', 'alice', true),
    };
  });
  const holdings = memo(async () => copy(await base.createSubject('schema:Book', 'No-entry holding only')));
  const curatedSubject = memo(() => base.createSubject('schema:Book', 'Curated occurrence only'));
  const controls = memo(async () => {
    const empty = await base.createSubject('schema:Book', 'Empty subject without support');
    const followed = await follow(await base.createSubject('schema:Book', 'Follow only'));
    const bob = await entry(await base.createSubject('schema:Book', 'Bob state only'), 'bob');
    const curatedOnly = await curatedSubject();
    return { empty, followed, bob, curatedOnly };
  });
  const multiple = memo(async () => {
    const own = await state();
    return {
      ...own,
      holding: await copy(own.subject),
      history: await session(own.subject, 'schema:Book', 'alice', true),
    };
  });
  const recipes = memo(async () => {
    const released = await base.recipes();
    return {
      released,
      alice: await session(released.subjects['R-cooked'], 'schema:Recipe', 'alice', true),
      bob: await session(released.subjects['R-other-cooked'], 'schema:Recipe', 'bob', true),
    };
  });
  const sources = memo(async () => {
    // Base v1 has a prerequisite descriptor, not an existing source producer or successful group to reuse.
    const books = await base.books();
    const recipes = await base.recipes();
    const own = await multiple();
    const labelOnly = await labels();
    const progress = await sessions();
    const holding = await holdings();
    const control = await controls();
    const subjects = [
      ...Object.values(books.subjects),
      books.edition,
      ...Object.values(recipes.subjects),
      own.subject,
      labelOnly.recipe,
      progress.active.subject,
      progress.history.subject,
      holding.subject,
      control.empty,
      control.followed.subject,
      control.bob.subject,
      control.curatedOnly,
    ];
    const result = [];
    for (const visibility of ['public', 'unlisted', 'private'] as const) {
      const response = await write(
        'alice',
        'POST',
        '/v1/collections',
        { title: `Released ${visibility} source`, visibility },
        201,
      );
      const source = handle<SourceHandle>(response, 'collection');
      const occurrences: { member: OccurrenceHandle; response: HttpResponse }[] = [];
      for (const subject of subjects) {
        const added = await write(
          'alice',
          'POST',
          `/v1/collections/${source.id}/members`,
          { subjectId: subject.id, note: 'First controlled occurrence' },
          201,
        );
        occurrences.push({ member: handle<OccurrenceHandle>(added, 'member'), response: added });
      }
      const duplicate = await write(
        'alice',
        'POST',
        `/v1/collections/${source.id}/members`,
        { subjectId: books.subjects['B-long'].id, note: 'Second occurrence with a distinct note' },
        201,
      );
      occurrences.push({ member: handle<OccurrenceHandle>(duplicate, 'member'), response: duplicate });
      result.push({ source, response, occurrences });
    }
    return { subjects, sources: result };
  });
  const publishDynamicSelection = (input: {
    owner: Owner;
    title: string;
    rule: CollectionRule;
    subjectIds: readonly string[];
  }): Promise<ReleasedDynamicSelection> =>
    setup(async () => {
      // The caller selects actual API-created subjects in this world. Admission, identity closure,
      // current authority and CAS remain entirely in the ordinary product commands, including for [].
      const createdResponse = await write(
        input.owner,
        'POST',
        '/v1/collections',
        {
          membershipKind: 'dynamic',
          visibility: 'private',
          title: input.title,
          rule: input.rule,
        },
        201,
      );
      const created = handle<SavedDynamicCollectionView>(createdResponse, 'collection');
      const response = await write(
        input.owner,
        'POST',
        `/v1/collections/${created.id}:publishSelected`,
        {
          revision: created.revision,
          subjectIds: input.subjectIds,
        },
        200,
      );
      const collection = handle<SavedDynamicCollectionView>(response, 'collection');
      const publication = handle<CollectionPublication>(response, 'publication');
      if (
        typeof publication.generation !== 'string' ||
        publication.state !== 'complete' ||
        !Number.isSafeInteger(publication.itemCount) ||
        publication.itemCount < 0 ||
        publication.itemCount > 100
      )
        throw new Error('Native selected publication lacks a complete bounded result');

      // Never use a creation revision as the current post-write source header.
      const currentResponse = await request(input.owner, 'GET', `/v1/collections/${created.id}`);
      requireStatus(currentResponse, 200, 'Read current selected Collection');
      const current = handle<SavedDynamicCollectionView>(currentResponse, 'collection');
      const route = routeOf(created.id);
      if (route === null) throw new Error('Native Collection creation lacks a routed ID');
      // Reuse the exact committed-output evidence used by readNativeCollectionMetadata. One fixed
      // header point and its output-head/receipt comparison share base.inspect's read-only snapshot.
      // This is provenance, not another Source, capture engine, or permission decision.
      const evidence = (
        await base.inspect<{
          header: ReleasedDynamicSelection['nativeHeader'];
          receipt: CollectionOutputPublication | null;
        }>(
          `
      WITH header AS (
        SELECT route, collection_id::text AS "collectionId", curator_account_id::text AS "curatorAccountId",
               revision, source_generation::text AS "sourceGeneration", state, visibility,
               membership_kind AS "membershipKind"
        FROM library.collection WHERE route=$1 AND collection_id=$2
      )
      SELECT row_to_json(header) AS header, row_to_json(receipt) AS receipt
      FROM header LEFT JOIN LATERAL (
        ${outputHead.sql.trim().replace(/;$/, '').replaceAll('$3', 'header."sourceGeneration"::bigint')}
      ) receipt ON true`,
          [route, created.id],
        )
      ).rows[0];
      if (!evidence?.receipt) throw new Error('Native selected publication lacks an actual committed output receipt');
      const { header, receipt } = evidence;
      if (
        created.membershipKind !== 'dynamic' ||
        created.visibility !== 'private' ||
        collection.id !== created.id ||
        current.id !== created.id ||
        header.collectionId !== created.id ||
        header.route !== route ||
        header.curatorAccountId !== base.personas[input.owner].accountId ||
        collection.membershipKind !== 'dynamic' ||
        current.membershipKind !== 'dynamic' ||
        header.membershipKind !== 'dynamic' ||
        header.state !== 'active' ||
        collection.visibility !== 'public' ||
        current.visibility !== 'public' ||
        header.visibility !== 'public' ||
        current.revision !== collection.revision ||
        header.revision !== current.revision ||
        receipt.generation !== publication.generation ||
        receipt.sourceGeneration !== header.sourceGeneration ||
        BigInt(receipt.members) !== BigInt(publication.itemCount)
      )
        throw new Error('Native selected publication response, current header and committed receipt disagree');
      return {
        created: { collection: created, response: createdResponse },
        collection,
        publication,
        response,
        current: { collection: current, response: currentResponse },
        source: { kind: 'collection', id: collection.id },
        nativeHeader: header,
        output: {
          ref: { route: header.route, collectionId: header.collectionId, generation: receipt.generation },
          receipt,
        },
      };
    });
  return {
    version: releasedLibraryPopulationVersion,
    base,
    calls: calls as readonly NativeCall[],
    request,
    profile,
    state,
    labels,
    sessions,
    holdings,
    controls,
    multiple,
    recipes,
    sources,
    publishDynamicSelection,
    prerequisites: {
      shell: {
        state: 'prerequisite',
        required:
          'No adopted HTTP operation admits an empty entry shell: PUT requires a declared state; an empty subject is not a shell.',
      } as Boundary,
      ownerReadonly: {
        state: 'prerequisite',
        required:
          'Base v1 exposes unscoped, not an Alice bearer with read-only scopes. Its internal identity factory is not exported.',
      } as Boundary,
      publishedDynamicAndZone: {
        state: 'prerequisite',
        required:
          'publishDynamicSelection exposes explicit selected0..100 only. Whole-query dynamic generation/lifecycle/C5 and native Zone mount/page/TypeList composition remain prerequisites; catchUp and catalogue-only Source proof establish neither.',
      } as Boundary,
      historicalProfiles: base.profiles,
      cookedQuery: {
        state: 'prerequisite',
        required: 'Generic completed-session owner-query wire awaits adoption. No notCooked request is defined here.',
      } as Boundary,
    },
    close,
  };
}

export type ReleasedLibraryPopulation = Awaited<ReturnType<typeof createReleasedLibraryPopulation>>;
