import type { Fixtures, KernelRecording } from './fake.ts';
import { storySubjects } from './story-subjects';

type RouteContext = {
  request: Request;
  recordings: Record<string, KernelRecording>;
  /** Captures from a regular expression path, or null for an exact string path. */
  match: RegExpExecArray | null;
};
type Answer<Context> = (
  context: Context,
) => KernelRecording | undefined | void | Promise<KernelRecording | undefined | void>;

/** A module exports `routes`; an absent or declining answer falls through to the next route. */
export type FakeRoute = {
  method: string;
  /** Exact pathname or a regular expression, without the query string. */
  path: string | RegExp;
  story?: Answer<RouteContext>;
  fixture?: Answer<RouteContext & { fixtures: Fixtures }>;
};

type FixtureFile = Pick<Partial<Fixtures>, 'subjects' | 'accounts'>;
// The glob also includes fixture helpers. Only modules exporting routes contribute HTTP handlers.
type RouteModule = { routes?: FakeRoute[] };
type Discovered = {
  routes: FakeRoute[];
  recordings: Record<string, KernelRecording>;
  fixtures: FixtureFile[];
};

let discovered: Discovered | undefined;
let discovering: Promise<Discovered> | undefined;
const recordingOverrides = new WeakMap<Record<string, KernelRecording>, Record<string, KernelRecording>>();

function ordered<Value>(files: Record<string, Value>): [string, Value][] {
  return Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Bun `import` of JSON may add a synthetic default; Vite glob already imports default. */
function jsonModule<Value>(loaded: Value): Value {
  if (!loaded || typeof loaded !== 'object' || !('default' in loaded)) return loaded;
  const value = (loaded as { default: Value }).default;
  return value && typeof value === 'object' ? value : loaded;
}

/** True when a specifier is absent, including a kernel-only sandbox that does not copy sibling app files. */
function isUnresolvedModule(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /Cannot find module|Failed to resolve import|Failed to fetch dynamically imported module|ERR_MODULE_NOT_FOUND/i.test(
    text,
  );
}

async function loadResolved<Value>(
  entries: Iterable<readonly [string, () => Promise<Value>]>,
): Promise<Record<string, Value>> {
  return Object.fromEntries(
    (
      await Promise.all(
        [...entries].map(async ([file, load]) => {
          try {
            return [[file, await load()] as const];
          } catch (error) {
            if (isUnresolvedModule(error)) return [];
            throw error;
          }
        }),
      )
    ).flat(),
  );
}

/** Bun's counterpart to Vite's glob imports. Relative `import()` loads async modules and shares the static graph. */
async function bunFiles<Value>(pattern: string): Promise<Record<string, Value>> {
  const files = [...new Bun.Glob(pattern).scanSync({ cwd: import.meta.dir })].sort();
  return loadResolved(files.map((file) => [file, () => import(`./${file}`) as Promise<Value>] as const));
}

async function optionalRoute(load: () => Promise<RouteModule>): Promise<RouteModule> {
  try {
    return await load();
  } catch (error) {
    if (isUnresolvedModule(error)) return {};
    throw error;
  }
}

type OrderedRouteModules = {
  libraryContinue: RouteModule;
  qualifiedRelations: RouteModule;
  reviewConflicts: RouteModule;
  threadMediaReuse: RouteModule;
  libraryLabelAssignments: RouteModule;
};

function assemble(
  modules: Record<string, RouteModule>,
  recordings: Record<string, KernelRecording>,
  fixtures: Record<string, FixtureFile>,
  orderedRoutes: OrderedRouteModules,
): Discovered {
  // Includes fake/view-continuation.ts: subject view owner pages and their refusal fixture.
  return {
    routes: [
      ...(orderedRoutes.threadMediaReuse.routes ?? []),
      ...(orderedRoutes.qualifiedRelations.routes ?? []),
      ...ordered({
        ...Object.fromEntries(
          Object.entries(modules).filter(
            ([file]) =>
              !file.endsWith('/library-continue.ts') &&
              !file.endsWith('/qualified-relations.ts') &&
              !file.endsWith('/thread-media-reuse.ts') &&
              !file.endsWith('/library-label-assignments.ts'),
          ),
        ),
        './fake/library-continue.ts': orderedRoutes.libraryContinue,
        './fake/review-conflicts.ts': orderedRoutes.reviewConflicts,
        './fake/library-label-assignments.ts': orderedRoutes.libraryLabelAssignments,
      }).flatMap(([, module]) => module.routes ?? []),
    ],
    recordings: Object.fromEntries(
      ordered(recordings).map(([file, recording]) => [file.split('/').at(-1)!.slice(0, -5), jsonModule(recording)]),
    ),
    fixtures: [
      ...ordered(fixtures).map(([, fixture]) => jsonModule(fixture)),
      {
        subjects: storySubjects.map((subject) => ({
          id: subject.id,
          type: subject.type,
          labels: { ...subject.labels },
          descriptions: {},
          aliases: {},
          statements: {
            'schema:inLanguage': [
              {
                id: `${subject.id}:story-language`,
                rank: 'normal',
                property: { id: 'schema:inLanguage', data_type: 'string' },
                value: { type: 'value', content: subject.originalLanguage },
                qualifiers: [],
                references: [],
              },
            ],
          },
          ...(subject.cover ? { cover: subject.cover } : {}),
        })) as unknown as Fixtures['subjects'],
      },
    ],
  };
}

async function loadOrderedRoutes(): Promise<OrderedRouteModules> {
  const [libraryContinue, qualifiedRelations, reviewConflicts, threadMediaReuse, libraryLabelAssignments] =
    await Promise.all([
      optionalRoute(() => import('./fake/library-continue.ts')),
      optionalRoute(() => import('./fake/qualified-relations.ts')),
      optionalRoute(() => import('./fake/review-conflicts.ts')),
      optionalRoute(() => import('./fake/thread-media-reuse.ts')),
      optionalRoute(() => import('./fake/library-label-assignments.ts')),
    ]);
  return { libraryContinue, qualifiedRelations, reviewConflicts, threadMediaReuse, libraryLabelAssignments };
}

async function loadDiscovered(): Promise<Discovered> {
  // Vite expands these literal calls at build time. Its browser/Worker runtimes do not expose Bun.
  if (typeof Bun !== 'undefined' && typeof import.meta.glob !== 'function') {
    const [modules, recordings, fixtures, orderedRoutes] = await Promise.all([
      bunFiles<RouteModule>('fake/*.ts'),
      bunFiles<KernelRecording>('recorded/*.json'),
      bunFiles<FixtureFile>('fixtures/*.json'),
      loadOrderedRoutes(),
    ]);
    return assemble(modules, recordings, fixtures, orderedRoutes);
  }
  const [modules, recordings, fixtures, orderedRoutes] = await Promise.all([
    loadResolved(Object.entries(import.meta.glob<RouteModule>('./fake/*.ts'))),
    loadResolved(Object.entries(import.meta.glob<KernelRecording>('./recorded/*.json', { import: 'default' }))),
    loadResolved(Object.entries(import.meta.glob<FixtureFile>('./fixtures/*.json', { import: 'default' }))),
    loadOrderedRoutes(),
  ]);
  return assemble(modules, recordings, fixtures, orderedRoutes);
}

async function discover(): Promise<Discovered> {
  if (discovered) return discovered;
  discovering ??= loadDiscovered().then(
    (value) => {
      discovered = value;
      return value;
    },
    (error: unknown) => {
      discovering = undefined;
      throw error;
    },
  );
  return discovering;
}

export async function discoveredRecordings(): Promise<Record<string, KernelRecording>> {
  return (await discover()).recordings;
}

/** Append file contributions after the caller's fixtures and default demo cast, without mutating either. */
export async function mergeFakeFixtures(fixtures: Fixtures): Promise<Fixtures> {
  const files = (await discover()).fixtures;
  const subjects = new Map<string, Fixtures['subjects'][number]>();
  for (const subject of [...fixtures.subjects, ...files.flatMap((file) => file.subjects ?? [])])
    subjects.set(subject.id, subject);
  return {
    ...fixtures,
    subjects: [...subjects.values()],
    accounts: [...(fixtures.accounts ?? []), ...files.flatMap((file) => file.accounts ?? [])],
  };
}

/** One ordered pass over module routes before the original fake kernel chain. */
export async function answerFakeRoute(
  mode: 'story' | 'fixture',
  request: Request,
  given?: Record<string, KernelRecording>,
  fixtures?: Fixtures,
): Promise<KernelRecording | undefined> {
  const registered = await discover();
  let recordings = registered.recordings;
  if (given) {
    let combined = recordingOverrides.get(given);
    if (!combined) {
      combined = { ...recordings, ...given };
      recordingOverrides.set(given, combined);
    }
    recordings = combined;
  }
  const pathname = new URL(request.url).pathname;
  for (const route of registered.routes) {
    if (route.method !== request.method) continue;
    let match: RegExpExecArray | null = null;
    if (typeof route.path === 'string') {
      if (route.path !== pathname) continue;
    } else {
      route.path.lastIndex = 0;
      match = route.path.exec(pathname);
      if (!match) continue;
    }
    // A declining answer may read the body; keep it available to later modules and the original chain.
    const context = { request: request.clone() as Request, recordings, match };
    const answer =
      mode === 'story'
        ? await route.story?.(context)
        : fixtures
          ? await route.fixture?.({ ...context, fixtures })
          : undefined;
    if (answer) return answer;
  }
  return undefined;
}
