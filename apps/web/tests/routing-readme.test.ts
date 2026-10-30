import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const readmePath = resolve(import.meta.dir, '../README.md');
const readme = readFileSync(readmePath, 'utf8');
const routingStart = readme.match(/^## Routing[ \t]*$/m);
const afterHeading = routingStart ? readme.slice(routingStart.index! + routingStart[0].length) : '';
const nextHeading = afterHeading.search(/^## /m);
const routing = nextHeading < 0 ? afterHeading : afterHeading.slice(0, nextHeading);

function rule(label: string, patterns: RegExp[]) {
  test(label, () => {
    const paragraph = (routing.split(/\n\s*\n/).find((part) => patterns[0].test(part)) ?? '').replace(/\n/g, ' ');
    for (const pattern of patterns) expect(paragraph).toMatch(pattern);
  });
}

describe('routing reference', () => {
  test('the SEO link reaches the Routing section and its links resolve', () => {
    const seo = readFileSync(resolve(import.meta.dir, '../../../docs/seo.md'), 'utf8');
    expect(seo).toContain('../apps/web/README.md#routing');
    expect(readme).toMatch(/^## Routing\s*$/m);
    expect(routing).toContain('../../docs/seo.md');
    const links = [...routing.matchAll(/\]\(([^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, target] of links) {
      const [path, anchor] = target.split('#');
      const file = path ? resolve(dirname(readmePath), path) : readmePath;
      expect(existsSync(file)).toBe(true);
      if (anchor) {
        const headings = readFileSync(file, 'utf8').match(/^#{1,6} .+$/gm) ?? [];
        expect(
          headings.some(
            (heading) =>
              heading
                .replace(/^#+\s+/, '')
                .toLowerCase()
                .replace(/[^\w -]/g, '')
                .replace(/ /g, '-') === anchor,
          ),
        ).toBe(true);
      }
    }
  });

  rule('locale URLs', [
    /\*\*Locale URLs\*\*/,
    /every page path.*locale/i,
    /302/,
    /rezics_locale/,
    /Accept-Language/,
    /\ben\b/,
    /Vary: Cookie, Accept-Language/,
    /Cache-Control: private, no-store/,
    /trailing slash.*301/i,
    /x-default.*without the locale/i,
  ]);
  rule('public and signed-in routes', [
    /\*\*Public and signed-in routes\*\*/,
    /server.*without reading.*session.*cookie/i,
    /session.*CSRF token.*library status.*own vote.*reactions.*membership.*edit controls/i,
    /browser.*hydration.*queries/i,
    /beforeLoad/,
    /sign-in.*return path/i,
    /components never check/i,
  ]);
  rule('subject page hydration', [
    /Subject pages and views follow the same boundary/i,
    /server ensures.*public page.*type-frame.*relation-label.*reaction-count.*rating-figure queries/i,
    /library slot.*reading preferences.*own reaction.*own rating queries.*browser-only/i,
    /enabled after the session query reports signed in/i,
    /control space reserved.*first render/i,
    /update or invalidate.*corresponding query after a write/i,
  ]);
  rule('data reads', [
    /\*\*Data reads\*\*/,
    /each kernel read.*queryOptions.*beside.*loader/i,
    /context\.queryClient\.ensureQueryData/,
    /useSuspenseQuery.*public/i,
    /useQuery.*personal.*browser/i,
    /staleTime.*60 s.*personal.*0/i,
    /preloads on intent/i,
  ]);
  rule('search params', [
    /\*\*Search params\*\*/,
    /Valibot.*validateSearch/,
    /defaults.*missing.*invalid/i,
    /loaderDeps/,
  ]);
  rule('head', [
    /\*\*Head\*\*/,
    /every route.*head\(\).*pageHead\(\)/i,
    /apps\/web\/src\/shell\/head\.ts/,
    /title.*description.*card.*robots.*JSON-LD/i,
    /canonical.*hreflang.*once.*root.*leaf.*locale paths/i,
  ]);
  rule('statuses', [
    /\*\*Statuses\*\*/,
    /notFound\(\).*404/,
    /unknown.*unreadable.*removed/i,
    /redirect\(\{ statusCode: 301 \}\)/,
    /moved.*outdated slugs/i,
    /closed page.*403/i,
    /never.*200.*error/i,
  ]);
  rule('caching', [
    /\*\*Caching\*\*/,
    /anonymous.*public routes/i,
    /Cache-Control: public, max-age=0, s-maxage=60(?![\w,=-])/,
    /weak.*ETag/,
    /never.*Set-Cookie/i,
    /server functions.*session.*private, no-store/i,
  ]);
  rule('origin', [/\*\*Origin\*\*/, /absolute URLs.*PUBLIC_ORIGIN.*never.*Host/i]);
  rule('pending and errors', [
    /\*\*Pending and errors\*\*/,
    /pendingComponent/,
    /errorComponent/,
    /notFoundComponent/,
    /differ from.*router defaults/i,
  ]);
});
