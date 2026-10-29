import type { Fixtures, KernelRecording } from './fake.ts';
import * as libraryContinue from './fake/library-continue.ts';
import * as reviewConflicts from './fake/review-conflicts.ts';
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
type RouteModule = { routes: FakeRoute[] };
type Discovered = {
  routes: FakeRoute[];
  recordings: Record<string, KernelRecording>;
  fixtures: FixtureFile[];
};

let discovered: Discovered | undefined;
const recordingOverrides = new WeakMap<Record<string, KernelRecording>, Record<string, KernelRecording>>();

function ordered<Value>(files: Record<string, Value>): [string, Value][] {
  return Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Bun's synchronous counterpart to Vite's eager glob imports. Runs only in an unbundled Bun process. */
function bunFiles<Value>(pattern: string): Record<string, Value> {
  return Object.fromEntries(
    [...new Bun.Glob(pattern).scanSync({ cwd: import.meta.dir })]
      .sort()
      .map((file) => [file, require(`${import.meta.dir}/${file}`) as Value]),
  );
}

function discover(): Discovered {
  if (discovered) return discovered;
  let modules: Record<string, RouteModule>;
  let recordings: Record<string, KernelRecording>;
  let fixtures: Record<string, FixtureFile>;
  // Vite expands these literal calls at build time. Its browser/Worker runtimes do not expose Bun.
  if (typeof Bun !== 'undefined' && typeof import.meta.glob !== 'function') {
    modules = bunFiles('fake/*.ts');
    recordings = bunFiles('recorded/*.json');
    fixtures = bunFiles('fixtures/*.json');
  } else {
    modules = import.meta.glob<RouteModule>('./fake/*.ts', { eager: true });
    recordings = import.meta.glob<KernelRecording>('./recorded/*.json', { eager: true, import: 'default' });
    fixtures = import.meta.glob<FixtureFile>('./fixtures/*.json', { eager: true, import: 'default' });
  }
  discovered = {
    routes: ordered({
      ...Object.fromEntries(Object.entries(modules).filter(([file]) => !file.endsWith('/library-continue.ts'))),
      './fake/library-continue.ts': libraryContinue,
      './fake/review-conflicts.ts': reviewConflicts,
    }).flatMap(([, module]) => module.routes),
    recordings: Object.fromEntries(
      ordered(recordings).map(([file, recording]) => [file.split('/').at(-1)!.slice(0, -5), recording]),
    ),
    fixtures: [
      ...ordered(fixtures).map(([, fixture]) => fixture),
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
  return discovered;
}

export function discoveredRecordings(): Record<string, KernelRecording> {
  return discover().recordings;
}

/** Append file contributions after the caller's fixtures and default demo cast, without mutating either. */
export function mergeFakeFixtures(fixtures: Fixtures): Fixtures {
  const files = discover().fixtures;
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
  const registered = discover();
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
