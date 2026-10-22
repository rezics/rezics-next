import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js';
import { zoneMemberHref } from '../address/path.ts';
import { workExperience } from '../entity-page/experience.ts';
import { SubjectSources } from '../entity-page/sources.tsx';
import type { DisplayObligations } from '../rights-mark/rights-mark.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { iriOf, scopeAt, tabOf, workHref, workNavigationQuery, workTabs, workTaskHref, type WorkAt } from './route.ts';
import { WorkKindActions } from './types/actions.tsx';
import { shownLine } from './types/recipe.tsx';
import { GuideExperience, guideSections } from './types/guide.tsx';
import { RecipeFacts, RecipeReadFailure } from './types/recipe.tsx';
import { WorkAbout, WorkHeader } from './work-header.tsx';
import { workReportTargets } from './work-report-targets.ts';
import { WorkFactsView, WorkSources, sourceHref, workFactsSelection, workRights, workSourceGroups } from './work-sources.tsx';
import * as entity from '../entity-page/fixtures.ts';
import { copyOf as entityCopy } from '../entity-page/messages.ts';
import type { StatementPage } from '../entity-page/types.ts';
import * as levels from '../work-levels/fixtures.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { ConnectionsPreviewView, PartsPreviewView } from '../work-levels/previews.tsx';
import { connectionsHref, editionsHref } from '../work-levels/route.ts';
import { RegionFailure } from './region.tsx';
import { WorkTabs } from './work-tabs.tsx';
import { WorkTaskLink } from './work-nav.tsx';

const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);

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

  test('Connections and Editions render one current view and an Overview in the same scope', () => {
    const mounted = { ...zone, path: zoneMemberHref('readers', 'library', 'the-cartographer-of-tides') };
    const labels = { overview: 'Overview', contents: 'Contents', versions: 'Versions', editions: 'Editions',
      connections: 'Connections', discussion: 'Discussion', history: 'History' };
    for (const at of [fixture.workRef, mounted] satisfies WorkAt[]) {
      for (const current of ['connections', 'editions'] as const) {
        for (const selection of [{ scope: 'global' }, { scope: 'realm', realm: levels.current }]) {
          const params = new URLSearchParams({ scope: selection.scope, language: 'ja', open: 'releases' });
          if (selection.realm) params.set('realm', selection.realm);
          const scope = scopeAt(at, Object.fromEntries(params));
          const choices = workNavigationQuery(params);
          const html = render(<PathnameContext value={`/en${workHref(at, current)}`}>
            <SearchParamsContext value={params}>
              <WorkTabs workRef={at} labels={labels} label="Work sections" />
              <WorkTaskLink workRef={at} anchor="contents">Read chapters</WorkTaskLink>
            </SearchParamsContext>
          </PathnameContext>);
          const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
          expect(links).toHaveLength(8);
          expect(html.match(/aria-current="page"/g)).toHaveLength(1);
          workTabs.forEach((tab, index) => {
            const [, attributes, caption] = links[index]!;
            const href = attributes!.match(/\bhref="([^"]*)"/)?.[1]?.replaceAll('&amp;', '&');
            expect(href).toBe(`/en${workHref(at, tab, scope, choices)}`);
            expect(caption).toBe(labels[tab]);
            expect(attributes!.includes('aria-current="page"')).toBe(tab === current);
          });
          const task = links[7]![1]!.match(/\bhref="([^"]*)"/)?.[1]?.replaceAll('&amp;', '&');
          expect(task).toBe(`/en${workHref(at, 'overview', scope, choices)}#contents`);
        }
      }
    }
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
  const html = render(<WorkHeader work={fixture.work} credits={<p>Creator credit</p>}
    domainFacts={facts} ratingLine={<p>Rating summary</p>} locale="en" messages={t} />);
  expect(html.indexOf('Creator credit')).toBeLessThan(html.indexOf(t.totalTime));
  expect(html.indexOf(t.totalTime)).toBeLessThan(html.indexOf('Rating summary'));
  const about = render(<WorkAbout work={fixture.work} messages={t} />);
  expect(about).toContain('A surveyor maps');
  expect(about).not.toContain('data-report-action');
  expect(about).not.toContain('data-rights-mark');
  expect(render(<WorkAbout work={fixture.metadataOnlyWork} messages={t} />)).toBe('');
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
    expect(render(<WorkKindActions kind={kind} workId={fixture.work.id} title="Work"
      locale="en" messages={t} />)).toBe('');
  }
});

describe('guide reading', () => {
  test('a short same-title guide retains prose without duplicating its title or contents', () => {
    const body = '# Tide charts\nRead the tide table before entering the harbour.';
    const html = render(<GuideExperience body={body} title="Tide charts" updatedAt={null}
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
    const html = render(<GuideExperience body={body} title="A harbour guide" updatedAt={null}
      locale="en" messages={t} />);
    expect(html).toContain('<summary');
    expect(html).toContain('href="#guide-section-2"');
    expect(html.indexOf('<p class="leading-7">Read')).toBeLessThan(html.indexOf('<p class="leading-7">Check'));
    expect(html).toContain('请先确认当天的潮汐与天气。');
  });
});

test('overview tasks stay completable from all seven views, including a Zone with explicit global scope', () => {
  for (const at of [fixture.workRef, zone]) {
    for (const tab of workTabs) {
      const params = new URLSearchParams({ scope: 'global', language: 'zh-Hans', open: fixture.workRef, cursor: 'list-only' });
      const href = workTaskHref(at, workHref(at, tab), params, 'guide-experience');
      if (tab === 'overview') expect(href).toBe('#guide-experience');
      else {
        const url = new URL(href, 'https://rezics.com');
        expect(url.pathname).toBe(workHref(at));
        expect(url.hash).toBe('#guide-experience');
        expect(url.searchParams.get('language')).toBe('zh-Hans');
        expect(url.searchParams.get('open')).toBe(fixture.workRef);
        expect(url.searchParams.has('cursor')).toBe(false);
        expect(scopeAt(at, Object.fromEntries(url.searchParams))).toEqual({ kind: 'global' });
      }
    }
  }
  expect(connectionsHref(zone)).toBe(`${zone.path}/connections`);
  expect(editionsHref(zone)).toBe(`${zone.path}/editions`);
});

const sourcePage = (): StatementPage => ({ ...entity.statements(), factObligations: {
  status: 'assessed', use: 'wiki_display', instrument: 'https://creativecommons.org/licenses/by/4.0/', obligations: [],
}, groups: [
  { predicate: 'https://schema.org/identifier', items: [{ ...entity.componentStatements.groups[0]!.items[0]!, kind: 'component-property',
    predicate: 'https://schema.org/identifier', value: { kind: 'external', provider: 'Open Library', namespace: 'works', key: 'OL123W' },
    sources: ['https://openlibrary.org/works/OL123W?revision=7', 'javascript:alert(1)'] }] },
  ...entity.statements().groups,
] });

test('facts continuation retains the exact Work/Zone view, scope and opaque cursor and can restart', () => {
  for (const at of [fixture.workRef, zone]) {
    const path = workHref(at, 'contents');
    const selection = workFactsSelection(at, `https://rezics.com${path}?scope=global&language=ja&statements=first%2Bpage`);
    expect(selection.cursor).toBe('first+page');
    expect(selection.invalid).toBe(false);
    const next = new URL(selection.hrefFor({ kind: 'continue', section: 'statements', cursor: 'opaque+/=' }), 'https://rezics.com');
    expect(next.pathname).toBe(path);
    expect(next.searchParams.get('statements')).toBe('opaque+/=');
    expect(next.searchParams.get('scope')).toBe('global');
    expect(next.searchParams.get('language')).toBe('ja');
    expect(next.hash).toBe('#statements');
    const restart = new URL(selection.hrefFor({ kind: 'continue', section: 'statements', cursor: null }), next);
    expect(restart.searchParams.has('statements')).toBe(false);
    expect(restart.pathname).toBe(path);
  }
  expect(workFactsSelection(fixture.workRef, `${workHref(fixture.workRef)}?statements=a&statements=b`).invalid).toBe(true);
  expect(workFactsSelection(fixture.workRef, `${workHref(fixture.workRef)}?statements=${'a'.repeat(2049)}`).invalid).toBe(true);
});

test('field evidence preserves the exact supplied selection and never exposes a withheld quote', () => {
  const page = sourcePage();
  const item = page.groups.flatMap(group => group.items).find(item => item.kind === 'statement')!;
  if (item.kind !== 'statement') throw new Error('Expected a statement');
  const evidence = { id: iriOf('00000000-0000-4000-8000-000000000020'), sourceWork: fixture.work.id,
    representationSha256: 'a'.repeat(64), locator: { pointer: '/characters/0/name' },
    quote: 'Kirito is the retained character name.', quoteWithheld: false, method: { kind: 'manual' },
    modality: 'text', submitter: iriOf('00000000-0000-4000-8000-000000000021'), rightsBasis: 'quotation' };
  item.evidence = [evidence];
  const props = { work: fixture.work, locale: 'en' as const, messages: t, statements: { ok: true as const, data: page } };
  const html = render(<WorkSources {...props} />);
  expect(html).toContain(`data-fact-revision="${item.revision}"`);
  expect(html).toContain(`data-source-key="${evidence.id}"`);
  expect(html).toContain(`${t.evidence}: ${evidence.id}`);
  expect(html).not.toContain(`href="${evidence.id}"`);
  expect(html).toContain('/characters/0/name');
  expect(html).toContain(evidence.representationSha256);
  expect(html).toContain(evidence.quote);
  expect(html).toContain('quotation');
  expect(html).toContain('href="/w/');
  expect(html).toContain(item.revision);
  item.evidence = [{ ...evidence, quoteWithheld: true }];
  const withheld = render(<WorkSources {...props} />);
  expect(withheld).not.toContain(evidence.quote);
  expect(withheld).toContain(t.evidenceQuoteWithheld);
  expect(withheld).toContain(evidence.representationSha256);
  expect(withheld).toContain(`data-source-key="${evidence.id}"`);
  item.evidence = [{ ...evidence, quote: null }];
  expect(render(<WorkSources {...props} />)).toContain(t.evidenceQuoteWithheld);
});

test('Work footer renders retained native supports with their exact records, locators and quotation fences', () => {
  const page = entity.retainedSourceStatements();
  const html = render(<WorkSources work={fixture.work} locale="en" messages={t} statements={{ ok: true, data: page }} />);
  expect(html.match(/data-retained-source-citation/g)).toHaveLength(2);
  expect(html).toContain('/organization/founded');
  expect(html).toContain('/history/0/year');
  expect(html).toContain('Registry facts under CC BY 4.0');
  expect(html.match(/Example Studio was founded in 1997\./g)).toHaveLength(1);
  expect(html).toContain(entityCopy('en').quotationWithheld);
  expect(html).not.toContain('data-field-evidence');
  const item = page.groups[3]!.items[0]!;
  if (item.kind !== 'component-property') throw new Error('Expected a component property');
  for (const citation of item.citations!) {
    expect(html).toContain(citation.supportIdentity);
    expect(html).toContain(citation.record);
    expect(html).not.toContain(`href="${citation.record}"`);
  }
});

test('source records leave the fact list while domain facts, applicability and opaque continuation remain', () => {
  const page = sourcePage();
  expect(workSourceGroups(page.groups).sources).toHaveLength(1);
  const html = render(<WorkFactsView page={{ ok: true, data: { ...page, nextCursor: 'opaque-next' } }}
    labels={entity.predicateLabels} names={new Map()} hrefFor={() => '/next-facts'} locale="en" t={entityCopy('en')} messages={t} />);
  expect(html).toContain('Kirito');
  expect(html).not.toContain('OL123W');
  expect(html).not.toContain('data-rights-mark');
  expect(html).toContain('href="/next-facts"');
  expect(render(<WorkFactsView page={{ ok: true, data: entity.noStatements }} names={new Map()}
    hrefFor={() => '/next-facts'} locale="en" t={entityCopy('en')} messages={t} />)).toContain(entityCopy('en').noStatementsBody);
  const failed = render(<WorkFactsView page={{ ok: false, failure: 'missing' }} names={new Map()}
    hrefFor={() => '/retry-facts'} locale="en" t={entityCopy('en')} messages={t} />);
  expect(failed).toContain('role="status"');
  expect(failed).toContain(t.regionMissing);
  expect(failed).toContain(t.retry);
  expect(failed).not.toContain(entityCopy('en').noStatementsBody);
});

test('missing resources stay explicit and retryable while read faults retain their alert', () => {
  for (const failure of ['missing', 'budget', 'unavailable'] as const) {
    const html = render(<RegionFailure title="Parts unavailable" failure={failure} messages={t} />);
    expect(html).toContain(`role="${failure === 'missing' ? 'status' : 'alert'}"`);
    expect(html).toContain('Parts unavailable');
    expect(html).toContain(t.retry);
    expect(html).toContain(failure === 'missing' ? t.regionMissing : failure === 'budget' ? t.budget : t.regionUnavailable);
    expect(html).not.toContain(levelsCopy('en').noPartsBody);
  }
});

test('one source section retains record identity, exact evidence, missing evidence and one copy of equal legal duties', () => {
  const page = sourcePage();
  const work = { ...fixture.work, factObligations: page.factObligations, descriptionObligations: page.factObligations };
  const html = render(<WorkSources work={work} locale="en" messages={t}
    statements={{ ok: true, data: page }} labels={entity.predicateLabels} factObligations={[page.factObligations]} />);
  expect(html.match(/data-work-sources/g)).toHaveLength(1);
  expect(html.match(/data-subject-sources/g)).toHaveLength(1);
  expect(html).toContain('aria-labelledby="sources"');
  expect(html.match(/data-rights-mark/g)).toHaveLength(1);
  expect(html).toContain('Open Library · works · OL123W');
  expect(html).toContain('href="https://openlibrary.org/works/OL123W?revision=7"');
  expect(html).toContain(page.groups[0]!.items[0]!.revision);
  expect(html).toContain(t.fieldEvidenceUnavailable);
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('&quot;provider&quot;');
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com', '/unresolved']) {
    expect(sourceHref(unsafe)).toBeNull();
  }
});

test('a publication source links once while every distinct attribution and licence remains readable', () => {
  const url = 'https://www.gutenberg.org/ebooks/59047';
  const source = { record: 'publication-record', observation: 'publication-observation',
    provider: 'gutenberg', externalId: '59047', url, license: null, author: null, transcriber: fixture.work.id };
  const facts: Extract<DisplayObligations, { status: 'assessed' }> = {
    status: 'assessed', use: 'wiki_display', instrument: 'https://creativecommons.org/licenses/by/4.0/',
    obligations: [{ kind: 'attribution', instrument: 'https://creativecommons.org/licenses/by/4.0/',
      appliesTo: 'display', notice: `Project Gutenberg facts ${url}` }] };
  const description: Extract<DisplayObligations, { status: 'assessed' }> = {
    status: 'assessed', use: 'wiki_display', instrument: 'https://creativecommons.org/licenses/by-sa/4.0/',
    obligations: [{ kind: 'attribution', instrument: 'https://creativecommons.org/licenses/by-sa/4.0/',
      appliesTo: 'display', notice: `Distinct synopsis credit ${url}` }] };
  const work = { ...fixture.work, rights: { basis: 'public-domain' as const, source },
    factObligations: facts, descriptionObligations: description };
  const html = render(<WorkSources work={work} locale="en" messages={t} />);
  expect(html.match(/href="https:\/\/www.gutenberg.org\/ebooks\/59047"/g)).toHaveLength(1);
  expect(html).toContain('gutenberg · 59047');
  expect(html).toContain('Project Gutenberg facts');
  expect(html).toContain('Distinct synopsis credit');
  expect(html).toContain('CC BY 4.0');
  expect(html).toContain('CC BY-SA 4.0');
  expect(html.match(/data-rights-mark/g)).toHaveLength(2);
  const other = 'https://www.gutenberg.org/ebooks/65061';
  const different = { ...work, factObligations: { ...facts, obligations: [
    { ...facts.obligations[0]!, notice: `Different publication ${other}` },
  ] } };
  expect(render(<WorkSources work={different} locale="en" messages={t} />)).toContain(`href="${other}"`);
  const standalone = { ...work, rights: undefined };
  expect(render(<WorkSources work={standalone} locale="en" messages={t} />)).toContain(`href="${url}"`);
});

test('empty continued previews still lead to the complete list while completed empty reads stay compact', () => {
  if (!levels.parts.ok || !levels.wholes.ok || !levels.relations.ok) throw new Error('Expected successful fixtures');
  const props = { workRef: zone, pageMessages: t, t: levelsCopy('en') };
  const parts = { ok: true as const, data: { ...levels.parts.data, parts: [], next: 'opaque-part' } };
  const wholes = { ok: true as const, data: { ...levels.wholes.data, wholes: [], next: null } };
  expect(render(<PartsPreviewView {...props} parts={parts} wholes={wholes} names={new Map()} />))
    .toContain(`${zone.path}/connections#parts`);
  expect(render(<PartsPreviewView {...props} parts={{ ...parts, data: { ...parts.data, next: null } }}
    wholes={wholes} names={new Map()} />)).toBe('');
  const relations = { ok: true as const, data: { ...levels.relations.data, items: [], next: '/opaque-relations-link' } };
  expect(render(<ConnectionsPreviewView {...props} relations={relations} locale="en" />))
    .toContain(`${zone.path}/connections#relations`);
});

test("recipe reading keeps Main's complete line when an older occurrence names a different source line", () => {
  const occurrence = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const item = { occurrence, originalText: '200 g butter, softened', line: '200 g butter, softened', amount: { numerator: 200, denominator: 1 } };
  const page = { occurrences: [{ occurrence, parent: occurrence, role: 'ingredient', labels: [], qualifier: {
    type: 'ingredient-line', originalText: { value: '2 cups flour', language: 'en' },
  } }], ingredients: [item], measures: [] };
  expect(shownLine(item, 'written', page)).toBe('200 g butter, softened');
});


test('a failed Recipe owner read preserves the named task and explanation alongside its real failure and Retry', () => {
  const html = render(<RecipeReadFailure failure="unavailable" messages={t} />);
  expect(html).toContain('aria-labelledby="recipe-experience"');
  expect(html).toContain(t.recipeMethod);
  expect(html).toContain(t.recipeUnavailable);
  expect(html).toContain('role="alert"');
  expect(html).toContain(t.regionUnavailable);
  expect(html).toContain(t.retry);
});


test('source footer is a named contentinfo landmark and preserves supplied evidence without fabricating identity', () => {
  const html = render(<SubjectSources locale="en"><p>Exact permitted source notice</p></SubjectSources>);
  expect(html).toContain('<footer role="contentinfo" aria-labelledby="sources"');
  expect(html).toContain('id="sources"');
  expect(html).toContain('Sources and licenses');
  expect(html).toContain('Exact permitted source notice');
  expect(html).not.toContain('data-source-key');
  expect(render(<SubjectSources locale="zh-Hans"><p>原始来源说明</p></SubjectSources>)).toContain('来源与许可');
});
