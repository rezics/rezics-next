import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const routes = join(root, 'apps/web/src/routes');
const stories = join(root, 'apps/web/src/stories');
const documentPath = join(root, 'docs/development/page-stories.md');
const document = existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : '';
const routeFiles = readdirSync(routes, { recursive: true })
  .filter((entry): entry is string => typeof entry === 'string' && /\.(tsx|ts)$/.test(entry))
  // Endpoint routes do not render a page and have no browser stories.
  .filter((entry) => entry !== 'robots[.]txt.ts')
  .map((entry) => `apps/web/src/routes/${entry}`)
  .sort();
const cells = [
  ...document.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm),
];
const references = new Set<string>();
const missingRows = new Set<string>();

function isStoryCell(value: string, hasStoryExport: (reference: string) => boolean): boolean {
  if (value === 'missing' || /^planned:\s+\S.*$/.test(value)) return true;
  if (!/^apps\/web\/src\/stories\/[^#]+\.stories\.tsx#[A-Za-z_$][\w$]*$/.test(value)) return false;
  return hasStoryExport(value);
}

for (const row of cells) {
  const [, route, state, viewer, desktop, phone] = row;
  if (route.startsWith('apps/web/src/routes/')) {
    for (const mode of [desktop, phone]) {
      if (mode.trim() === 'missing')
        missingRows.add(
          `${route.trim()} | ${state.trim()} | ${viewer.trim()} | ${mode === desktop ? 'desktop' : 'phone'}`,
        );
      else if (mode.trim().startsWith('planned:')) continue;
      else references.add(mode.trim());
    }
  }
}

test('page story map has a section for every route file and tabulates states by viewer and device', () => {
  for (const route of routeFiles) {
    expect(document, `missing route section: ${route}`).toContain(`## ${route}`);
    expect(
      cells.some(([, tableRoute]) => tableRoute.trim() === route),
      `no state rows for ${route}`,
    ).toBe(true);
  }
  expect(document).toMatch(/\|\s*Route\s*\|\s*State\s*\|\s*Viewer\s*\|\s*Desktop\s*\|\s*Phone\s*\|/);
  expect(document).toContain('Every route has page stories on recorded or fake API responses');
  expect(document).toContain('Primitive component stories (shadcn wrappers) are not required.');
  for (const row of cells) {
    const [, route, , , desktop, phone] = row;
    if (!route.startsWith('apps/web/src/routes/')) continue;
    for (const value of [desktop.trim(), phone.trim()])
      expect(
        isStoryCell(value, (reference) => references.has(reference)),
        `${route}: invalid story cell ${value}`,
      ).toBe(true);
  }
  for (const reference of references) {
    const [file, exportName] = reference.split('#');
    const source = readFileSync(join(root, file), 'utf8');
    expect(source, `story file does not exist: ${file}`).toBeTruthy();
    expect(source, `story export does not exist: ${reference}`).toMatch(
      new RegExp(`export\\s+(?:const|function|class)\\s+${exportName}\\b`),
    );
  }
  expect(routeFiles.length).toBeGreaterThan(0);
});

test('page story cells accept planned dependencies and reject incomplete or unresolved cells', () => {
  const hasStoryExport = (reference: string) =>
    reference === 'apps/web/src/stories/library-entries.stories.tsx#SignedIn';
  expect(isStoryCell('planned: member library export API', hasStoryExport)).toBe(true);
  expect(isStoryCell('planned:', hasStoryExport)).toBe(false);
  expect(isStoryCell('apps/web/src/stories/library-entries.stories.tsx#MissingExport', hasStoryExport)).toBe(false);
  expect(isStoryCell('', hasStoryExport)).toBe(false);
});

test('complex route sections include the required control and state rows', () => {
  const requirements = [
    'tracked entries list in grid, list and table',
    'each grid size',
    'state filter active',
    'selection mode',
    'Continue with fraction progress',
    'Continue with position-only progress',
    'Continue with no progress',
    'Collection shortcuts: none',
    'Collection shortcuts: some',
    'Collection shortcuts: many',
    'Liked Collections',
    'pinned Collections',
    'curated',
    'dynamic',
    'private',
    'unlisted',
    'public',
    'curator',
    'reader',
    'empty',
    'one page',
    'many pages',
    'notes',
    'duplicate occurrences',
    'editing',
    'reordering',
    'following',
    'overview section populated',
    'overview section empty',
    'overview section closed by a gate',
    'spoilers hidden',
    'spoilers shown',
    'view tab',
    'Realm context',
    'merged subject',
    'redirected subject',
    'agent subject',
    'cover viewer',
    'empty query',
    'results',
    'no results',
    'facet type active',
    'sort changed',
    'facet index not ready',
    'phone filter layout',
    'Zone home',
    'private owner page',
    'configured static Zone page',
    'direct source route closed',
    'unavailable (503)',
    'member',
    'visitor',
  ];
  for (const requirement of requirements) expect(document.toLowerCase()).toContain(requirement.toLowerCase());
});

test('missing cells are listed by surface in the required order and exactly once', () => {
  const headings = [
    '## Missing cells — library',
    '## Missing cells — Collections',
    '## Missing cells — subject page',
    '## Missing cells — search',
    '## Missing cells — Zones',
    '## Missing cells — remaining surfaces',
  ];
  const positions = headings.map((heading) => document.indexOf(heading));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(new Set(document.match(/^\| missing: .*$/gm) ?? []).size).toBe(
    (document.match(/^\| missing: .*$/gm) ?? []).length,
  );
  expect(missingRows.size).toBeGreaterThan(0);
  const listedMissing = (document.match(/^- apps\/web\/src\/routes\/.*$/gm) ?? []).filter((line) =>
    / — (desktop|phone)$/.test(line),
  );
  const tableMissing = new Set(
    [
      ...document.matchAll(
        /^\|\s*(apps\/web\/src\/routes\/[^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*$/gm,
      ),
    ].flatMap(([, route, state, viewer, desktop, phone]) => [
      ...(desktop.trim() === 'missing' ? [`- ${route.trim()} — ${state.trim()} — ${viewer.trim()} — desktop`] : []),
      ...(phone.trim() === 'missing' ? [`- ${route.trim()} — ${state.trim()} — ${viewer.trim()} — phone`] : []),
    ]),
  );
  expect(new Set(listedMissing).size).toBe(listedMissing.length);
  expect(new Set(listedMissing)).toEqual(tableMissing);
  expect(relative(root, stories)).toBe('apps/web/src/stories');
});
