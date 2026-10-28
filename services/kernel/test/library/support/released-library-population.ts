import type { LibraryProfile, LibraryProfilePin } from '@rezics/definitions';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';
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
  options: { version: 1 } = { version: releasedLibraryPopulationVersion },
) {
  if (options.version !== releasedLibraryPopulationVersion)
    throw new Error('Unsupported released Library population version');
  const base = await createReleasedDiscoveryFixture({ version: 1 });
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
        throw new AggregateError([error, cleanup], 'Released Library setup and cleanup failed');
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
          'No adopted native mount and dynamic publication producer is exposed by base v1; link projection catchUp proves neither.',
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
