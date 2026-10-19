import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { MediaImageProvider, mediaImageKey, type CoverCredit, type MediaImageMetadata } from '@rezics/ui/media-image';
import { FeedProvider } from '../feed/feed-context.tsx';
import { memoryFeed } from '../feed/fixtures.ts';
import { messages as feedMessages } from '../feed/messages.ts';
import { memoryThreads, storyRealm, storyThread, THREAD_NOW } from '../feed/thread-fixtures.ts';
import { resourceHref } from '../address/path.ts';
import { ThreadView } from '../realm/thread-view.tsx';
import { attributed } from '../rights-mark/fixtures.ts';
import { reportHref } from '../safety/report.ts';
import { ReportMenu } from '../safety/report-action.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { ReleaseView } from '../work-levels/release-page.tsx';
import { RealizationRow } from '../work-levels/editions.tsx';
import * as editions from '../work-levels/fixtures.ts';
import { copyOf as editionsCopy } from '../work-levels/messages.ts';
import type { Loaded, Realization } from '../work-levels/types.ts';
import { AuthorPage } from '../author/author-page.tsx';
import { authorFollow, prolificAuthor } from '../author/fixtures.ts';
import { messages as authorMessages } from '../author/messages.ts';
import { citationNames, citedStatements, importedSourceStatements, predicateLabels } from './fixtures.ts';
import { SubjectDescription, SubjectHeader } from './header.tsx';
import { copyOf } from './messages.ts';
import { sourceHref, StatementSourcesView } from './sources.tsx';
import { standaloneHrefFor } from './route.ts';
import { splitStatementSources } from './statement-groups.ts';
import { StatementsView } from './views.tsx';

const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
const render = (element: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
const t = copyOf('en');
const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000101';
const hrefFor = standaloneHrefFor({}, resourceHref('/e/', target));

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
      <StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }} locale="en" t={t} />
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
    const html = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(html).toContain(t.fieldEvidenceUnavailable);
    expect(html).not.toContain('data-rights-mark');
    expect(render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: false, failure: 'unavailable' }} locale="en" t={t} />)).toBe('');
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
    const html = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(html).toContain('href="https://example.test/name/revisions/7"');
    expect(html).toContain('Example Studio');
    expect(html).toContain(name.items[0]!.revision);
  });

  test('each citation retains its exact value, applicability and revision, including the header name', () => {
    const page = citedStatements();
    const html = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }}
      labels={predicateLabels} names={citationNames} locale="en" t={t} />);
    const citations = html.split('data-fact-citation').slice(1);
    expect(citations).toHaveLength(4);
    expect(citations[0]).toContain('Example Studio');
    expect(citations[0]).toContain('href="https://example.test/studio/name"');
    expect(citations[1]).toContain('>24</span>');
    expect(citations[1]).toContain('Annual report 1997');
    expect(citations[1]).not.toContain('Annual report 2001');
    expect(citations[1]).not.toContain('href="https://example.test/studio/annual-report/2001"');
    expect(citations[2]).toContain('>31</span>');
    expect(citations[2]).toContain('Annual report 2001');
    expect(citations[2]).not.toContain('Annual report 1997');
    expect(citations[2]).toContain('href="https://example.test/studio/annual-report/2001"');
    expect(citations[3]).toContain(t.noEvidence);
    // Unlabelled predicates remain distinguishable instead of becoming identical "Other facts" headings.
    expect(citations[1]).toContain('https://schema.org/numberOfEmployees');
    expect(citations[3]).toContain('https://schema.org/foundingDate');
    for (const [index, item] of page.groups.flatMap(group => group.items).entries()) {
      expect(citations[index]).toContain(item.revision);
    }
  });

  test('native evidence stays a reference while the retained representation, locator and rights remain readable', () => {
    const page = { ...citedStatements(), factObligations: attributed };
    const item = page.groups[1]!.items[0]!;
    if (item.kind !== 'statement' || !item.evidence?.[0]) throw new Error('Expected structured evidence');
    const evidence = item.evidence[0];
    const html = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }}
      labels={predicateLabels} names={citationNames} locale="en" t={t} />);
    expect(sourceHref(evidence.id)).toBeNull();
    expect(html).toContain(evidence.id);
    expect(html).not.toContain(`href="${evidence.id}"`);
    expect(html.match(new RegExp(evidence.id, 'g'))).toHaveLength(1);
    for (const value of [evidence.sourceWork, evidence.representationSha256, evidence.submitter,
      evidence.modality, evidence.rightsBasis, 'ByteRangeSelector', '>128<', '>256<', 'Checked against the annual report']) {
      expect(html).toContain(value);
    }
    expect(html).toContain(t.factRevision);
    expect(html).toContain(item.revision);
    expect(html).toContain(t.sourceRepresentation);
    expect(evidence.representationSha256).not.toBe(item.revision);
    expect(html).toContain('<blockquote');
    expect(html).toContain(evidence.quote!);
    expect(html).not.toContain(t.quotationWithheld);
    expect(html).not.toContain(t.fieldEvidenceUnavailable);
    expect(html.match(/data-rights-mark/g)).toHaveLength(1);
    // Structured evidence is useful even if the legacy reference list is empty.
    item.sources = [];
    const withoutReferences = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(withoutReferences).toContain('data-claim-evidence');
    expect(withoutReferences).toContain(evidence.representationSha256);
  });

  test('withheld quotes cannot reappear through the locator while provenance and honest absence remain', () => {
    const page = citedStatements(true);
    const item = page.groups[1]!.items[0]!;
    if (item.kind !== 'statement' || !item.evidence?.[0]) throw new Error('Expected structured evidence');
    const evidence = item.evidence[0];
    // The public flag is authoritative even if an older serialization retained quote fields.
    evidence.quote = 'WITHHELD passage';
    evidence.locator = { selector: { type: 'TextQuoteSelector', exact: 'WITHHELD exact',
      prefix: 'WITHHELD prefix', suffix: 'WITHHELD suffix' }, quote: { exact: 'WITHHELD locator' }, page: 7 };
    const html = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(html).toContain(t.quotationWithheld);
    expect(html).toContain(evidence.id);
    expect(html).toContain(evidence.representationSha256);
    expect(html).toContain('>7<');
    expect(html).not.toContain('WITHHELD');
    expect(html).not.toContain('<blockquote');
    expect(html).toContain(t.noEvidence);
  });

  test('withheld compound locators use the safe public CFI without exposing an old assertion fallback', () => {
    const page = citedStatements(true);
    const item = page.groups[1]!.items[0]!;
    if (item.kind !== 'statement' || !item.evidence?.[0]) throw new Error('Expected structured evidence');
    const evidence = item.evidence[0];
    const safeCfi = 'epubcfi(/6/2!/4,/1:0,/1:8)';
    evidence.locator = { selector: { type: 'EpubCfiSelector', cfi: safeCfi } };
    let html = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(html).toContain(safeCfi);
    expect(html).toContain(t.quotationWithheld);
    expect(html).toContain(evidence.representationSha256);
    evidence.locator = { selector: { type: 'EpubCfiSelector', cfi: 'epubcfi(/6/2!/4,/1:0[WITHHELD,],/1:8[,WITHHELD])' } };
    evidence.method = { agent: 'tool', model: 'epubcfi(/6/2!/4,/1:0[WITHHELD,],/1:8[,WITHHELD])', inference: 'local' };
    html = render(<StatementSourcesView hrefFor={hrefFor} page={{ ok: true, data: page }} locale="en" t={t} />);
    expect(html).not.toContain('WITHHELD');
    expect(html).toContain(evidence.id);
    expect(html).toContain(evidence.representationSha256);
    expect(html).not.toContain('<blockquote');
  });
});

describe('non-Work detail hosts', () => {
  test('the thread resolves current cover credit after a null snapshot and places it once after comments', () => {
    const representationId = '00000000-0000-4000-8000-000000009901';
    const credit: CoverCredit = { kind: 'copyright', holder: 'Current holder', text: '© Current holder',
      source: { name: 'Current source', href: 'https://example.test/current-cover' }, permittedRole: 'cover' };
    const read = { ...storyThread, work: { ...storyThread.work, cover: { kind: 'image' as const,
      selection: target, url: `/v1/media/representations/${representationId}/bytes`, mediaType: 'image/png',
      width: 400, height: 600, crop: null, basis: { policy: 'story', context: 'story' }, coverCredit: null } } };
    const metadata: MediaImageMetadata = { representationId, nsfw: 'sfw', ageRating: { status: 'unassessed' }, coverCredit: credit };
    const shown = (image: MediaImageMetadata | null) => render(<MediaImageProvider
      viewer={{ ready: true, signedIn: false, age: 'unknown', optIns: { general: true, r15: false, sexual: false, grotesque: false } }}
      images={{ [mediaImageKey({ representationId })]: image }}>
      <FeedProvider locale="en" messages={feedMessages} now={THREAD_NOW} signedIn={false} actingSubject={null}
        signInHref="/auth/start" avatarQuery="" tab="all" followedRealms={null} api={memoryFeed()}>
        <ThreadView read={read} realm={storyRealm} sort="best" sortHrefs={{ best: '/', top: '/', new: '/' }}
          replyMode="open" threadApi={memoryThreads()} />
      </FeedProvider>
    </MediaImageProvider>);
    const html = shown(metadata);
    expect(html.match(/data-cover-credit/g)).toHaveLength(1);
    expect(html).toContain('© Current holder');
    expect(html).toContain('href="https://example.test/current-cover"');
    expect(html.indexOf('data-cover-credit')).toBeGreaterThan(html.indexOf('id="comments"'));
    expect(html.lastIndexOf('data-reply')).toBeLessThan(html.indexOf('data-subject-sources'));
    for (const hidden of [null, { ...metadata, ageRating: { status: 'assessed' as const, labels: ['r18'] as const } }]) {
      const suppressed = shown(hidden);
      expect(suppressed).not.toContain('data-cover-credit');
      expect(suppressed).not.toContain('data-subject-sources');
      expect(suppressed).not.toContain('Current holder');
    }
  });

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

  test('a Release keeps null and native-reference evidence records, including distinct revisions of one realization', () => {
    if (!editions.releases.ok || !editions.realizations.ok) throw new Error('Expected edition fixtures');
    const release = editions.releases.data.items[0]!;
    const selected = { ...editions.realizations.data.items[0]!, evidence: null };
    const retained = { ...selected, revision: target, evidence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000220' };
    const html = render(<ReleaseView release={release}
      realizations={new Map([[selected.id, { ok: true as const, data: selected }]])} sources={[retained, retained]}
      names={editions.names} locale="en" t={editionsCopy('en')} />);
    const footer = html.slice(html.indexOf('data-subject-sources'));
    expect(footer).toContain(`${t.releaseRevision}: ${release.revision}`);
    expect(footer).toContain(`${t.realizationRevision}: ${selected.revision}`);
    expect(footer).toContain(`${t.realizationRevision}: ${retained.revision}`);
    expect(footer).toContain(t.noEvidence);
    expect(footer).toContain(retained.evidence);
    expect(footer).not.toContain(`href="${retained.evidence}"`);
    expect(footer.match(/data-realization-record/g)).toHaveLength(2);
  });

  test('source continuity selects the pinned revision and keeps a refused source revision visible', () => {
    if (!editions.releases.ok || !editions.realizations.ok) throw new Error('Expected edition fixtures');
    const pin = editions.realizations.data.items[0]!;
    const head = { ...pin, revision: target, language: 'en' };
    const follower: Realization = { ...pin, id: editions.iri('r9'), language: 'fr',
      source: { kind: 'realization', work: pin.work, realization: pin.id, revision: pin.revision } };
    const row = render(<ul><RealizationRow realization={follower} all={[head, pin]} releases={[]}
      names={editions.names} locale="en" t={editionsCopy('en')} /></ul>);
    expect(row).toContain('Japanese');
    expect(row).not.toContain('English');
    const html = render(<ReleaseView release={editions.releases.data.items[0]!}
      realizations={new Map([[follower.id, { ok: true as const, data: follower }]])} sources={[]}
      sourceReads={[{ work: pin.work, id: pin.id, revision: pin.revision,
        read: { ok: false, failure: 'unavailable', status: 503 } }]}
      names={editions.names} locale="en" t={editionsCopy('en')} />);
    const refusal = html.slice(html.indexOf('data-unavailable-source'));
    expect(refusal).toContain(pin.id);
    expect(refusal).toContain(`${t.realizationRevision}: ${pin.revision}`);
    expect(refusal).toContain(workMessages.en.regionUnavailable);
    expect(refusal).not.toContain(workMessages.en.regionDenied);
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
