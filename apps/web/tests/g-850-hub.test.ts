import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { messages } from '../features/work-page/messages.ts';
import { ACTION_ATTRIBUTE, type HubSection, hubAnchors, hubPlan, hubSections } from '../features/work-page/hub.ts';
import { character, characterRelations, wikiRealm, wikiStatements } from '../features/work-page/hub-fixtures.ts';
import { nextAction } from '../features/work-page/primary-action.tsx';
import { mainCharacters, wikiHref, wikiRealmOf } from '../features/work-page/wiki.ts';
import { RegionFailure } from '../features/work-page/region.tsx';
import { WikiSectionView } from '../features/work-page/wiki.tsx';
import { OverviewLayout } from '../features/work-page/work-frame.tsx';
import { iri } from '../features/work-levels/fixtures.ts';

const t = messages.en;
type Section = { id: 'statements' | 'releases' | 'contents' | 'relations' | 'credits' | 'ratings' | 'reviews' | 'discussion' | 'lists' };
const listing = (...ids: Section['id'][]) => ({ target: { base: 'work' as const }, sections: ids.map(id => ({ id })) });
const everything = listing('statements', 'releases', 'contents', 'relations', 'credits', 'ratings', 'reviews', 'discussion');

describe('the Work page plan follows the projection', () => {
  test('a Work binding every section draws the documented seven, in order', () => {
    expect(hubPlan(everything)).toEqual(['about', 'availability', 'parts', 'wiki', 'ratings', 'discussion', 'lists']);
    expect(hubPlan(null)).toEqual(hubSections);
  });

  test('the order is the projection-independent documented one, whatever order the projection lists', () => {
    const shuffled = listing('discussion', 'reviews', 'relations', 'releases', 'statements', 'ratings', 'contents');
    expect(hubPlan(shuffled)).toEqual(['about', 'availability', 'parts', 'wiki', 'ratings', 'discussion', 'lists']);
  });

  test('a section the projection does not bind is omitted', () => {
    expect(hubPlan(listing('statements', 'discussion'))).toEqual(['about', 'discussion', 'lists']);
    expect(hubPlan(listing('statements', 'releases', 'ratings'))).toEqual(['about', 'availability', 'ratings', 'lists']);
    // Relations bind the wiki and the connections; contents alone bind only the parts.
    expect(hubPlan(listing('contents'))).toEqual(['parts', 'lists']);
    expect(hubPlan(listing('relations'))).toEqual(['parts', 'wiki', 'lists']);
    // Discovery rides on the Work base; another base has no lists and discovery.
    expect(hubPlan({ target: { base: 'release' }, sections: [{ id: 'statements' }] })).toEqual(['about']);
    expect(hubPlan({ target: { base: 'work' }, sections: [{ id: 'lists' }] })).toEqual(['lists']);
  });

  test('the sections are named as docs/plan/frontend.md names them, in its order', () => {
    const docs = readFileSync(new URL('../../../docs/plan/frontend.md', import.meta.url), 'utf8');
    const section = docs.slice(docs.indexOf('## Work page'), docs.indexOf('## Zones'));
    const listed = [...section.matchAll(/^\d\. \*\*(.+?)\*\*/gm)].map(match => match[1]);
    expect(listed.slice(1)).toEqual([t.sectionAbout, t.sectionAvailability, t.sectionParts, t.sectionWiki,
      t.sectionRatings, t.sectionDiscussion, t.sectionLists]);
    expect(hubSections).toHaveLength(listed.length - 1);
  });
});

const slot = (name: string) => createElement('i', { 'data-slot': name });
const overview = (plan: readonly HubSection[], scoped = true) => renderToStaticMarkup(createElement(OverviewLayout, {
  plan, messages: t, type: slot('type'), about: slot('about'), facts: slot('facts'), classification: slot('classification'),
  availability: slot('availability'), parts: slot('parts'), wiki: slot('wiki'), scopeBar: slot('scope-bar'),
  ratings: scoped ? slot('ratings') : null, reviews: slot('reviews'), adoption: slot('adoption'),
  discussion: slot('discussion'), alsoEnjoyed: slot('also-enjoyed'), author: slot('author'), record: slot('record') }));
const drawn = (html: string) => [...html.matchAll(/data-hub-section="(\w+)"/g)].map(match => match[1]);

describe('the overview draws only what the plan lists, in the documented order', () => {
  test('every planned section appears once, in order, under its stable anchor', () => {
    const html = overview(hubSections);
    expect(drawn(html)).toEqual([...hubSections]);
    for (const section of hubSections) expect(html).toContain(`id="${hubAnchors[section]}"`);
    expect(html.indexOf('data-slot="record"')).toBeGreaterThan(html.indexOf('data-slot="author"'));
  });

  test('a section the plan omits is not drawn even when its slot holds content', () => {
    const html = overview(['about', 'ratings']);
    expect(drawn(html)).toEqual(['about', 'ratings']);
    for (const omitted of ['availability', 'parts', 'wiki', 'discussion', 'adoption', 'also-enjoyed', 'author']) {
      expect(html).not.toContain(`data-slot="${omitted}"`);
    }
    // Details and identifiers belong to the page, below whatever sections it has.
    expect(html).toContain('data-slot="record"');
  });

  test('a plan handed over out of order is still drawn in the documented order', () => {
    expect(drawn(overview(['lists', 'wiki', 'about', 'ratings']))).toEqual(['about', 'wiki', 'ratings', 'lists']);
  });

  test('an unknown scope reports itself in the ratings section instead of showing anyone’s view', () => {
    const html = overview(['about', 'ratings', 'discussion'], false);
    expect(html).toContain('data-slot="scope-bar"');
    expect(html).not.toContain('data-slot="ratings"');
    expect(html).not.toContain('data-slot="classification"');
    expect(html).not.toContain('data-slot="adoption"');
  });
});

describe('the one primary action', () => {
  const part = (label: string) => ({ occurrence: iri('o1'), work: iri('a1'), displayLabel: label, inclusion: 'required',
    available: true });
  const series = (overrides: Record<string, unknown>) => ({ ok: true as const, data: { scope: 'disclosed-composition',
    counts: { required: 3, completed: 0, completedRequired: 0 }, furthestCompleted: null, preference: null,
    next: { part: part('Volume 1'), reason: 'next_available_required_part' },
    primaryAction: { work: iri('a1'), edition: { kind: 'release', resource: iri('p1'), revision: iri('p2') }, language: 'en' },
    ...overrides } }) as never;
  const none = { start: null, progress: null, preference: null, releases: 0 };
  const href = `/w/${iri('a1').slice(-36)}`;

  test('hosted text leads, then the next part Main names, then choosing an edition', () => {
    expect(nextAction({ ...none, start: { kind: 'continue', href: '/w/x/chapters/1', chapter: 'Ch 1' } })?.kind).toBe('read');
    expect(nextAction({ ...none, progress: series({}), releases: 2 })).toEqual({ kind: 'part', mode: 'start', href,
      part: 'Volume 1' });
    expect(nextAction({ ...none, progress: series({ furthestCompleted: { part: {} } }) })).toMatchObject({ kind: 'part',
      mode: 'continue' });
    expect(nextAction({ ...none, releases: 2 })).toEqual({ kind: 'choose', href: '#availability', part: null });
  });

  test('a reader with no edition and no preference is asked to choose one, on the part’s own page', () => {
    const edition = { edition: null };
    expect(nextAction({ ...none, progress: series({ primaryAction: { work: iri('a1'), ...edition, language: 'en' } }) }))
      .toEqual({ kind: 'choose', href: `${href}#availability`, part: 'Volume 1' });
    // A language-only preference is a choice: "any edition in Japanese".
    expect(nextAction({ ...none, progress: series({ primaryAction: { work: iri('a1'), ...edition, language: 'ja' },
      preference: { language: 'ja', edition: null, version: 1 } }) })).toMatchObject({ kind: 'part' });
  });

  test('a chosen edition, a part with no text in the reader’s language and nothing to choose', () => {
    expect(nextAction({ ...none, releases: 2, preference: { ok: true, data: { edition: { kind: 'release' } } as never } })).toBeNull();
    const awaiting = series({ next: { part: part('Volume 2'), reason: 'awaiting_chosen_language' } });
    expect(nextAction({ ...none, progress: awaiting, releases: 1 })).toMatchObject({ kind: 'choose', part: 'Volume 2' });
    // Main has no next part: nothing leads.
    expect(nextAction({ ...none, progress: series({ next: null, primaryAction: null }) })).toBeNull();
    expect(nextAction(none)).toBeNull();
  });

  test('every action link is marked so the sticky bar can repeat it', () => {
    expect(ACTION_ATTRIBUTE).toBe('data-next-action');
  });
});

describe('Explore the wiki', () => {
  const kirito = character('Kirito', 'c1');
  const asuna = character('Asuna', 'c2');
  const labelOf = (html: string, name: string) => html.includes(name);
  const view = (zone: string | null, characters = characterRelations([kirito, asuna])) => renderToStaticMarkup(
    createElement(WikiSectionView, { wiki: { zone: { ok: true, data: zone }, characters: zone ? characters : null },
      locale: 'en', messages: t }));

  test('the Zone is read from the Work’s statement, and only from it', () => {
    expect(wikiRealmOf(wikiStatements())).toBe(wikiRealm);
    expect(wikiRealmOf([])).toBeNull();
    expect(wikiRealmOf([{ predicate: 'https://schema.org/name', items: [] }] as never)).toBeNull();
  });

  test('present: main characters and the Zone’s characters, chapter guide and timeline', () => {
    const html = view(wikiRealm);
    expect(labelOf(html, 'Kirito') && labelOf(html, 'Asuna')).toBe(true);
    expect(html).toContain(`href="/en${wikiHref(wikiRealm, 'characters')}"`);
    expect(html).toContain(`href="/en${wikiHref(wikiRealm, 'chapters')}"`);
    expect(html).toContain(`href="/en${wikiHref(wikiRealm, 'events')}"`);
    expect(html).toContain(t.wikiPosition);
  });

  test('absent: one line says there is no wiki and how holders build one', () => {
    const html = view(null);
    expect(html).toContain(t.wikiNone);
    expect(html).toContain(t.wikiBuild);
    expect(html).not.toContain('data-wiki-characters');
  });

  test('withheld by position: the wiki exists but nothing is revealed yet, and no character leaks', () => {
    const html = view(wikiRealm, characterRelations([]));
    expect(html).toContain('data-wiki-withheld');
    expect(html).toContain(t.wikiWithheld);
    expect(labelOf(html, 'Kirito')).toBe(false);
  });

  test('only characters are listed, at most eight, each once', () => {
    const many = Array.from({ length: 12 }, (_, index) => character(`Hero ${index}`, `d${index}`));
    const page = characterRelations([...many, many[0]!]);
    expect(page.ok && mainCharacters(page.data, 8).map(item => item.name.value)).toEqual(many.slice(0, 8)
      .map(item => item.status === 'available' ? item.name.value : ''));
  });

  test('a failed read is that section’s own failure, drawn in its region', () => {
    // The failure alert holds a client-only retry button, so the tree is read rather than rendered.
    const region = WikiSectionView({ wiki: { zone: { ok: false, failure: 'unavailable' }, characters: null },
      locale: 'en', messages: t }) as ReactElement<{ id: string; children: ReactElement<{ title: string }> }>;
    expect(region.props.id).toBe('work-wiki');
    expect(region.props.children.type).toBe(RegionFailure);
    expect(region.props.children.props.title).toBe(t.wikiUnavailable);
  });
});
