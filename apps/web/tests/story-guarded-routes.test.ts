import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const app = join(import.meta.dir, '..');

type GuardedRoute = { file: string; path: string };
type StoryViolation = { file: string; exportName: string; guardedPath: string };

async function sourceFiles(directory: string, suffix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path, suffix)
        : entry.isFile() && entry.name.endsWith(suffix)
          ? [path]
          : [];
    }),
  );
  return nested.flat();
}

function routePath(file: string): string {
  const routeName = relative(join(app, 'src/routes'), file)
    .split(sep)
    .join('/')
    .replace(/\.tsx?$/, '');
  const segments = routeName
    .split('/')
    .flatMap((part) => part.split('.'))
    .filter((part) => part !== 'index')
    .map((part) => part.replace(/_$/, ''));
  return segments.length ? `/${segments.join('/')}` : '/';
}

async function guardedRoutes(): Promise<GuardedRoute[]> {
  const files = await sourceFiles(join(app, 'src/routes'), '.tsx');
  const guarded = await Promise.all(files.map(async (file) => ({ file, source: await Bun.file(file).text() })));
  return guarded
    .filter(({ source }) => /beforeLoad\s*:\s*requireSignedIn\b/.test(source))
    .map(({ file }) => ({ file, path: routePath(file) }));
}

function renderedPath(attributes: string): string | undefined {
  const match = attributes.match(/\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*([`'"].*?[`'"])\s*\})/s);
  const direct = match?.[1] ?? match?.[2];
  if (direct !== undefined) return direct;
  const expression = match?.[3];
  if (!expression) return undefined;
  const path = expression.slice(1, -1);
  if (expression.startsWith('`')) return path.replace(/\$\{[^}]+\}/g, 'story-parameter');
  return path.slice(1, -1);
}

function matchingRoute(path: string, routes: GuardedRoute[]): GuardedRoute | undefined {
  const pathname = path.split(/[?#]/, 1)[0] || '/';
  return routes.find(({ path: route }) => {
    const pattern = route
      .split('/')
      .map((segment) => (segment.startsWith('$') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return new RegExp(`^${pattern}/?$`).test(pathname);
  });
}

async function storyViolations(routes: GuardedRoute[]): Promise<StoryViolation[]> {
  const files = await sourceFiles(join(app, 'src/stories'), '.stories.tsx');
  const violations: StoryViolation[] = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    const exports = [...source.matchAll(/export\s+const\s+(\w+)\s*:[^{=]+\s*=\s*\{/g)];
    for (let index = 0; index < exports.length; index++) {
      const current = exports[index]!;
      const end = exports[index + 1]?.index ?? source.length;
      const body = source.slice(current.index, end);
      if (!/visitor\s*=\s*(['"])Signed Out\1/.test(body)) continue;
      const tags = [...body.matchAll(/<PageStory\b([\s\S]*?)\/?\s*>/g)];
      for (const tag of tags) {
        if (!/\bvisitor\s*=\s*(['"])Signed Out\1/.test(tag[1]!)) continue;
        const path = renderedPath(tag[1]!);
        const route = path && matchingRoute(path, routes);
        if (route) {
          violations.push({
            file: relative(join(app, 'src/stories'), file).split(sep).join('/'),
            exportName: current[1]!,
            guardedPath: route.path,
          });
        }
      }
    }
  }
  return violations;
}

function describeViolation(violation: StoryViolation): string {
  return `${violation.file}: export ${violation.exportName} renders a signed-out visitor at guarded path ${violation.guardedPath}`;
}

test('no page story renders a signed-out visitor at a guarded route', async () => {
  const routes = await guardedRoutes();
  const violations = await storyViolations(routes);
  expect(violations.map(describeViolation)).toEqual([]);
});

test('guarded paths are derived from route files that call requireSignedIn', async () => {
  const routes = await guardedRoutes();
  const paths = routes.map(({ path }) => path).sort();

  expect(paths).toContain('/realms');
  expect(paths).toContain('/settings');
  expect(paths).toContain('/library/collections');
  expect(paths).toContain('/boards/$id/new');
});

test('a violation reports the story file, export name, and guarded path', () => {
  expect(describeViolation({ file: 'settings.stories.tsx', exportName: 'SignedOut', guardedPath: '/settings' })).toBe(
    'settings.stories.tsx: export SignedOut renders a signed-out visitor at guarded path /settings',
  );
});
