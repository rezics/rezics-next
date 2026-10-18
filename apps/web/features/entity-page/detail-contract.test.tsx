import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { attributed } from '../rights-mark/fixtures.ts';
import { reportHref } from '../safety/report.ts';
import { ReportMenu } from '../safety/report-action.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { ReleaseView } from '../work-levels/release-page.tsx';
import * as editions from '../work-levels/fixtures.ts';
import { copyOf as editionsCopy } from '../work-levels/messages.ts';
import type { Loaded, Realization } from '../work-levels/types.ts';
import { AuthorPage } from '../author/author-page.tsx';
import { authorFollow, prolificAuthor } from '../author/fixtures.ts';
import { messages as authorMessages } from '../author/messages.ts';
import { importedSourceStatements, predicateLabels } from './fixtures.ts';
import { SubjectDescription, SubjectHeader } from './header.tsx';
import { copyOf } from './messages.ts';
import { sourceHref, StatementSourcesView } from './sources.tsx';
import { splitStatementSources } from './statement-groups.ts';
import { StatementsView } from './views.tsx';

const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
const render = (element: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
const t = copyOf('en');
const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000101';

describe('non-Work detail sources', () => {
  test('explicit source identities move to provenance while ordinary URLs and domain identifiers remain facts', () => {
    const page = importedSourceStatements();
    const split = splitStatementSources(page.groups);
    expect(split.sources.map(group => group.predicate)).toEqual(['https://schema.org/identifier']);
    expect(split.facts.flatMap(group => group.items).map(item => item.value)).toContainEqual({ kind: 'string', lexical: 'Domain identifier 24' });
    expect(split.facts.flatMap(group => group.items)).toHaveLength(4);
    expect(split.sources.flatMap(group => group.items)).toHaveLength(1);
    expect(page.groups).toHaveLength(4);
    // A homepage must remain a fact even when the same subject has an external identity.
    const homepage = page.groups.filter(group => group.predicate === 'https://schema.org/url');
    expect(split.facts.filter(group => group.predicate === 'https://schema.org/url')).toEqual(homepage);
    expect(splitStatementSources(homepage)).toEqual({ facts: homepage, sources: [] });
  });

  test('facts keep their continuation; one page-end section owns evidence and assessed rights', () => {
    const page = { ...importedSourceStatements(), factObligations: attributed, nextCursor: 'opaque/+==' };
    const html = render(<>
      <StatementsView page={{ ok: true, data: page }} labels={predicateLabels} ownName="Example Studio"
        names={new Map()} cursor={undefined} hrefFor={link => link.kind === 'continue' ? `?statements=${encodeURIComponent(link.cursor ?? '')}` : '/'}
        locale="en" t={t} messages={workMessages.en} pageEndSources />
      <section id="discussion">Discussion content</section>
      <StatementSourcesView page={{ ok: true, data: page }} locale="en" t={t} />
    </>);
    const facts = html.slice(0, html.indexOf('id="discussion"'));
    expect(facts).toContain('1997');
    expect(facts).toContain('Domain identifier 24');
    expect(facts).toContain('opaque%2F%2B%3D%3D');
    expect(facts).not.toContain('example · organization · studio-42');
    expect(facts).not.toContain('data-rights-mark');
    expect(html.indexOf('data-subject-sources')).toBeGreaterThan(html.indexOf('Discussion content'));
    expect(html).toContain('example · organization · studio-42');
    expect(html).toContain('href="https://example.test/organizations/studio-42/revisions/3"');
    expect(html).toContain('CC BY-SA 3.0');
    expect(html.match(/data-rights-mark/g)).toHaveLength(1);
    expect(html).not.toContain('&quot;provider&quot;');
  });

  test('source-only records disclose the absence of field evidence without inventing a licence', () => {
    const page = importedSourceStatements();
    page.groups = page.groups.filter(group => group.predicate !== 'https://schema.org/foundingDate');
    const html = render(<StatementSourcesView page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(html).toContain(t.fieldEvidenceUnavailable);
    expect(html).not.toContain('data-rights-mark');
    expect(render(<StatementSourcesView page={{ ok: false, failure: 'unavailable' }} locale="en" t={t} />)).toBe('');
  });

  test('stored source values cannot create executable or credential-bearing links', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:secret@example.test/', null, 'not a URL']) {
      expect(sourceHref(value)).toBeNull();
    }
    expect(sourceHref('https://example.test/revisions/3?field=name#value')).toBe('https://example.test/revisions/3?field=name#value');
  });

  test('a name shown in the header keeps its evidence even when the body omits that same name', () => {
    const page = importedSourceStatements();
    const name = page.groups.find(group => group.predicate === 'https://schema.org/name')!;
    name.items[0]!.sources = ['https://example.test/name/revisions/7'];
    const html = render(<StatementSourcesView page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(html).toContain('href="https://example.test/name/revisions/7"');
  });
});

describe('non-Work detail hosts', () => {
  test('an author keeps domain dates and reading links before the Works, with records once at the end', () => {
    const html = render(<AuthorPage author={prolificAuthor} follow={authorFollow(prolificAuthor, 1)}
      reader={{ signedIn: false }} locale="en" messages={authorMessages} alsoEnjoyed={<p>Readers also enjoyed</p>} />);
    const sourcesAt = html.indexOf('data-subject-sources');
    const body = html.slice(0, sourcesAt);
    expect(body).toContain('December 16, 1775');
    expect(body).toContain('https://www.gutenberg.org/ebooks/author/68');
    expect(body).toContain('All works');
    expect(body).not.toContain('https://www.wikidata.org/wiki/Q36322');
    expect(sourcesAt).toBeGreaterThan(html.indexOf('Readers also enjoyed'));
    expect(html.slice(sourcesAt)).toContain('https://www.wikidata.org/wiki/Q36322');
    expect(html.slice(sourcesAt)).toContain('open-library-revision:77');
    expect(html.match(/https:\/\/openlibrary\.org\/authors\/OL21594A\.json/g)).toHaveLength(1);
    expect(html).not.toContain('Report this page'); // External author records have no native report target.
  });

  test('release coverage retains each Work while repeated realizations have unique anchors and page-end evidence', () => {
    if (!editions.releases.ok || !editions.realizations.ok) throw new Error('Expected edition fixtures');
    const release = editions.releases.data.items[1]!;
    const realization = editions.realizations.data.items[0]!;
    const html = render(<ReleaseView release={{ ...release, originalUrl: 'https://example.test/publication/42' }}
      realizations={new Map([[realization.id, { ok: true as const, data: realization }]])}
      sources={[]} names={editions.names} locale="en" t={editionsCopy('en')} />);
    expect(html.match(/data-coverage/g)).toHaveLength(3);
    const anchors = [...html.matchAll(/id="(coverage-[^"]+)"/g)].map(match => match[1]);
    expect(anchors).toHaveLength(3);
    expect(new Set(anchors).size).toBe(3);
    const sourceAt = html.indexOf('data-subject-sources');
    expect(sourceAt).toBeGreaterThan(html.lastIndexOf('data-coverage'));
    expect(html.slice(0, sourceAt)).not.toContain('https://example.com/evidence');
    expect(html.slice(sourceAt)).toContain(realization.revision);
    expect(html.match(/href="https:\/\/example\.com\/evidence"/g)).toHaveLength(1);
    expect(html.match(/href="https:\/\/example\.test\/publication\/42"/g)).toHaveLength(1);
    expect(html).toContain('Open publication');
    expect(html).not.toContain('>Report this page<');
  });

  test('a denied realization and an unavailable realization remain distinct without hiding coverage', () => {
    if (!editions.releases.ok) throw new Error('Expected release fixtures');
    const release = editions.releases.data.items[0]!;
    const realization = release.coverage[0]!.realization!;
    const shown = (failure: 'identity' | 'unavailable') => render(<ReleaseView release={release}
      realizations={new Map<string, Loaded<Realization>>([[realization, { ok: false, failure }]])}
      sources={[]} names={editions.names} locale="en" t={editionsCopy('en')} />);
    expect(shown('identity')).toContain(workMessages.en.regionDenied);
    expect(shown('identity')).not.toContain(workMessages.en.regionUnavailable);
    expect(shown('unavailable')).toContain(workMessages.en.regionUnavailable);
    expect(shown('unavailable')).toContain('data-coverage');
    const empty = render(<ReleaseView release={{ ...release, coverage: [], originalUrl: 'javascript:alert(1)' }}
      realizations={new Map()} sources={[]} names={editions.names} locale="en" t={editionsCopy('en')} />);
    expect(empty).toContain(editionsCopy('en').noCoverage);
    expect(empty).not.toContain('javascript:');
    expect(empty).not.toContain('Open publication');
  });
});

describe('subject identity and reporting', () => {
  test('identity actions precede a long biography, and reporting is offered through the subject menu', () => {
    const biography = 'An account of the author’s life. '.repeat(100);
    const html = render(<SubjectHeader identity={<h1 lang="ar" dir="rtl">اسم طويل</h1>}
      primary={<a href="#works">Browse works</a>}
      actions={<ReportMenu targets={[{ target, kind: 'profile' }]} name="اسم طويل" locale="en" />}>
      <SubjectDescription locale="en"><p>{biography}</p></SubjectDescription>
    </SubjectHeader>);
    expect(html.indexOf('More actions')).toBeLessThan(html.indexOf(biography));
    expect(html.indexOf('Browse works')).toBeLessThan(html.indexOf(biography));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).not.toContain('>Report this profile<');
  });

  test('exact report selections retain component, revision, locator and Realm', () => {
    const revision = 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000202';
    const locator = '00000000-0000-4000-8000-000000000303';
    const href = reportHref(target, target, { component: 'media_use', revision, locator });
    const params = new URL(href, 'https://example.test').searchParams;
    expect(Object.fromEntries(params)).toEqual({ target, realm: target, component: 'media_use', revision, locator });
  });
});
