import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { zoneMemberHref } from '../address/path.ts';
import { workExperience } from '../entity-page/experience.ts';
import type { DisplayObligations } from '../rights-mark/rights-mark.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { iriOf, scopeAt, tabOf, workHref, workNavigationQuery, workTabs, type WorkAt } from './route.ts';
import { WorkKindActions } from './types/actions.tsx';
import { GuideExperience, guideSections } from './types/guide.tsx';
import { RecipeFacts } from './types/recipe.tsx';
import { WorkAbout, WorkHeader } from './work-header.tsx';
import { workReportTargets } from './work-report-targets.ts';
import { workRights } from './work-sources.tsx';

const t = messages.en;
const zone = { ref: fixture.workRef, path: zoneMemberHref('readers', 'library', fixture.workRef), realm: fixture.realmScope.kind === 'realm' ? fixture.realmScope.realm : '' };

describe('public Work navigation', () => {
  for (const at of [fixture.workRef, zone] satisfies WorkAt[]) {
    test(`${typeof at === 'string' ? 'global' : 'Zone'} routes identify every public view and retain reading choices`, () => {
      const params = new URLSearchParams({ scope: 'realm', realm: zone.realm, language: 'zh-Hans',
        open: fixture.workRef, cursor: 'only-this-list', q: 'only-this-search' });
      const scope = scopeAt(at, Object.fromEntries(params));
      const choices = workNavigationQuery(params);
      expect(choices).toEqual({ language: 'zh-Hans', open: fixture.workRef });
      expect(workTabs).toEqual(['overview', 'contents', 'versions', 'editions', 'connections', 'discussion', 'history']);
      for (const tab of workTabs) {
        const url = new URL(workHref(at, tab, scope, choices), 'https://rezics.com');
        expect(tabOf(`/en${url.pathname}`, at)).toBe(tab);
        expect(url.searchParams.get('language')).toBe('zh-Hans');
        expect(url.searchParams.get('open')).toBe(fixture.workRef);
        expect(scopeAt(at, Object.fromEntries(url.searchParams))).toEqual(scope);
        expect(url.searchParams.has('cursor')).toBe(false);
      }
    });
  }

  test('an explicit global view survives a Zone with a default Realm', () => {
    const scope = scopeAt(zone, { scope: 'global' });
    expect(workHref(zone, 'connections', scope)).toBe(`${zone.path}/connections?scope=global`);
  });
});

test('the subject menu carries exact synopsis and cover selections, with the Zone context', () => {
  const work: typeof fixture.work = { ...fixture.work, cover: { kind: 'image', selection: 'b7a5d1e3-9c2f-4e6a-8b0d-2f4a6c8e0b1d',
    url: 'https://example.com/cover.jpg', width: 300, height: 450, mediaType: 'image/jpeg', crop: null, coverCredit: null,
    basis: { policy: 'test', context: 'test' } } };
  expect(workReportTargets(work, zone)).toEqual([
    { target: work.id, kind: 'work', realm: iriOf(zone.realm) },
    { target: work.id, kind: 'text', realm: iriOf(zone.realm),
      selection: { component: 'synopsis', revision: work.metadataRevision ?? work.revision, locator: null } },
    { target: work.id, kind: 'cover', realm: iriOf(zone.realm),
      selection: { component: 'cover', revision: work.cover.kind === 'image' ? work.cover.selection : '', locator: null } },
  ]);
  expect(workReportTargets(fixture.metadataOnlyWork, fixture.workRef)).toEqual([
    { target: fixture.work.id, kind: 'work', realm: null },
  ]);
  const synopsis = workReportTargets({ ...fixture.work, metadataRevision: null }, fixture.workRef)[1];
  expect(synopsis?.selection?.revision).toBe(fixture.work.revision);
});

test('known recipe facts follow the creator before the rating, and the synopsis has no duplicated actions or licences', () => {
  const facts = <RecipeFacts page={{ ingredients: [], occurrences: [], measures: [
    { kind: 'servings', value: { numerator: 4, denominator: 1 } },
    { kind: 'total-duration', value: { numerator: 20, denominator: 1 }, unitText: 'minutes' },
  ] }} messages={t} />;
  const html = renderToStaticMarkup(<WorkHeader work={fixture.work} credits={<p>Creator credit</p>}
    domainFacts={facts} ratingLine={<p>Rating summary</p>} locale="en" messages={t} />);
  expect(html.indexOf('Creator credit')).toBeLessThan(html.indexOf(t.totalTime));
  expect(html.indexOf(t.totalTime)).toBeLessThan(html.indexOf('Rating summary'));
  const about = renderToStaticMarkup(<WorkAbout work={fixture.work} messages={t} />);
  expect(about).toContain('A surveyor maps');
  expect(about).not.toContain('data-report-action');
  expect(about).not.toContain('data-rights-mark');
  expect(renderToStaticMarkup(<WorkAbout work={fixture.metadataOnlyWork} messages={t} />)).toBe('');
});

test('equal displayed fact and synopsis duties share a notice and keep their field labels', () => {
  const rights: DisplayObligations = { status: 'assessed', use: 'wiki_display', instrument: 'https://creativecommons.org/licenses/by/4.0/', obligations: [] };
  expect(workRights({ ...fixture.work, factObligations: rights, descriptionObligations: rights }, t)).toEqual([
    { labels: [t.sourceFacts, t.sourceDescription], rights },
  ]);
  expect(workRights(fixture.work, t)).toEqual([]);
});

test('an unknown Work or unpublished prompt does not invent a primary task or an extra shelf', () => {
  for (const types of [[], ['https://schema.org/VideoGame'], ['https://rezics.com/vocab/PromptTemplate']]) {
    const kind = workExperience(null, types).kind;
    expect(renderToStaticMarkup(<WorkKindActions kind={kind} workId={fixture.work.id} title="Work"
      locale="en" messages={t} />)).toBe('');
  }
});

describe('guide reading', () => {
  test('a short same-title guide retains prose without duplicating its title or contents', () => {
    const body = '# Tide charts\nRead the tide table before entering the harbour.';
    const html = renderToStaticMarkup(<GuideExperience body={body} title="Tide charts" updatedAt={null}
      locale="en" messages={t} />);
    expect(html).toContain('Read the tide table before entering the harbour.');
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('<details');
    expect(html).toContain('max-w-[70ch]');
  });

  test('real headings and multilingual paragraph order survive the accessible contents presentation', () => {
    const body = '# Before departure\nRead the tide table.\nCheck the harbour chart.\n# 到达港口\n请先确认当天的潮汐与天气。';
    expect(guideSections(body, 'A harbour guide')).toEqual([
      { heading: 'Before departure', paragraphs: ['Read the tide table.', 'Check the harbour chart.'], id: 'guide-section-1' },
      { heading: '到达港口', paragraphs: ['请先确认当天的潮汐与天气。'], id: 'guide-section-2' },
    ]);
    const html = renderToStaticMarkup(<GuideExperience body={body} title="A harbour guide" updatedAt={null}
      locale="en" messages={t} />);
    expect(html).toContain('<summary');
    expect(html).toContain('href="#guide-section-2"');
    expect(html.indexOf('<p class="leading-7">Read')).toBeLessThan(html.indexOf('<p class="leading-7">Check'));
    expect(html).toContain('请先确认当天的潮汐与天气。');
  });
});
