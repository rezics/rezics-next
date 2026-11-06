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

function relativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier?.startsWith('.')) specifiers.push(specifier);
  }
  return specifiers;
}

function takeRoute(modules: Record<string, RouteModule>, suffix: string): RouteModule {
  const entry = Object.entries(modules).find(([file]) => file.endsWith(suffix));
  return entry?.[1] ?? {};
}

/**
 * Copied-tree support: keep a globbed file when it exists and every relative specifier in its
 * copied-tree graph resolves. Sibling app files are not walked; selected-module import failures
 * still propagate.
 */
async function availableCopiedFiles(files: string[]): Promise<string[]> {
  const root = import.meta.dir;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const known = new Map<string, boolean>();
  const visiting = new Set<string>();
  const moduleAvailable = async (specifier: string, importerDir: string): Promise<boolean> => {
    if (!specifier.startsWith('.')) return true;
    let resolved: string;
    try {
      resolved = Bun.resolveSync(specifier, importerDir);
    } catch {
      return false;
    }
    const path = resolved.split('?')[0]!;
    if (path !== root && !path.startsWith(prefix)) return true;
    const remembered = known.get(path);
    if (remembered !== undefined) return remembered;
    if (visiting.has(path)) return true;
    visiting.add(path);
    try {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) {
        known.set(path, true);
        return true;
      }
      const source = await Bun.file(path).text();
      const dir = path.replace(/[/\\][^/\\]+$/, '') || path;
      for (const inner of relativeSpecifiers(source)) {
        if (!(await moduleAvailable(inner, dir))) {
          known.set(path, false);
          return false;
        }
      }
      known.set(path, true);
      return true;
    } finally {
      visiting.delete(path);
    }
  };
  const selected: string[] = [];
  for (const file of files) {
    if (await moduleAvailable(`./${file}`, root)) selected.push(file);
  }
  return selected;
}

/** Bun's counterpart to Vite's eager glob imports. Relative `import()` loads the selected inventory in order. */
async function bunFiles<Value>(pattern: string): Promise<Record<string, Value>> {
  const files = await availableCopiedFiles([...new Bun.Glob(pattern).scanSync({ cwd: import.meta.dir })].sort());
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, (await import(`./${file}`)) as Value] as const)),
  );
}

function assemble(
  modules: Record<string, RouteModule>,
  recordings: Record<string, KernelRecording>,
  fixtures: Record<string, FixtureFile>,
): Discovered {
  const threadMediaReuse = takeRoute(modules, '/thread-media-reuse.ts');
  const qualifiedRelations = takeRoute(modules, '/qualified-relations.ts');
  const libraryContinue = takeRoute(modules, '/library-continue.ts');
  const reviewConflicts = takeRoute(modules, '/review-conflicts.ts');
  const libraryLabelAssignments = takeRoute(modules, '/library-label-assignments.ts');
  // Includes fake/view-continuation.ts: subject view owner pages and their refusal fixture.
  return {
    routes: [
      ...(threadMediaReuse.routes ?? []),
      ...(qualifiedRelations.routes ?? []),
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
        './fake/library-continue.ts': libraryContinue,
        './fake/review-conflicts.ts': reviewConflicts,
        './fake/library-label-assignments.ts': libraryLabelAssignments,
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

async function loadDiscovered(): Promise<Discovered> {
  // Vite expands these literal calls at build time. Prefer Bun's inventory in an unbundled Bun process.
  if (typeof Bun !== 'undefined') {
    const [modules, recordings, fixtures] = await Promise.all([
      bunFiles<RouteModule>('fake/*.ts'),
      bunFiles<KernelRecording>('recorded/*.json'),
      bunFiles<FixtureFile>('fixtures/*.json'),
    ]);
    return assemble(modules, recordings, fixtures);
  }
  return assemble(
    import.meta.glob<RouteModule>('./fake/*.ts', { eager: true }),
    import.meta.glob<KernelRecording>('./recorded/*.json', { eager: true, import: 'default' }),
    import.meta.glob<FixtureFile>('./fixtures/*.json', { eager: true, import: 'default' }),
  );
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
