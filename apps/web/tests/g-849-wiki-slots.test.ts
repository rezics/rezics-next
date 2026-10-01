import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentType, ReactNode } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ZoneLinkProps, ZoneSlotProps } from '@rezics/zone-sdk';
import { uiLocales } from '../i18n/define.ts';
import * as data from '../features/wiki/fixtures.ts';
import { WikiEntity, WikiHome, WikiMemberIndex } from '../zones/official/franchise-wiki/slots.tsx';
import { localeStrings } from '../zones/official/franchise-wiki/strings.ts';

// The class guard for the franchise wiki package (G-849): its slots receive data and never fetch, so a slot can only
// draw a record the host's read returned. The guard renders each slot over fixture reads, strips the words that are
// the package's own, and fails when any text is left that no input carried.

const Link: ComponentType<ZoneLinkProps> = ({ href, children, ...rest }) => createElement('a', { href, ...rest }, children);
const base = (locale: string): Omit<ZoneSlotProps, 'fallback'> & { fallback: ReactNode } =>
  ({ zone: data.zoneFor(locale as never), fallback: null, Link });
const card = (work: { title: { value: string } | null }) => createElement('span', null, work.title?.value);
const renderers = { card, whyHere: () => null, nextVolumes: () => null };

/** Every string an input carries, so words in the output can be traced to the read that supplied them. */
function strings(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') found.add(value);
  else if (Array.isArray(value)) {
    // A count is the length of a list the read returned, nothing else.
    found.add(String(value.length));
    for (const item of value) strings(item, found);
  }
  else if (value && typeof value === 'object' && !('$$typeof' in value)) for (const item of Object.values(value)) strings(item, found);
  return found;
}

/** The package's own words in a locale: strings, and what its functions say around the value they are given. */
function ownWords(locale: string): string[] {
  const words: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') words.push(value);
    else if (typeof value === 'function') words.push(...(value as (...args: string[]) => string)('\u0001').split('\u0001'));
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  };
  walk(localeStrings[locale as keyof typeof localeStrings]);
  return words;
}

const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': '\'', '&#39;': '\'' };
/** Text in `html` that neither an input nor the package's own words account for. */
function leftover(html: string, inputs: unknown[], locale: string): string[] {
  const allowed = [...inputs.flatMap(input => [...strings(input)]), ...ownWords(locale), '·', ':', ',', '.', '—', '+']
    .filter(word => word.length).sort((a, b) => b.length - a.length);
  const lines = html.replace(/<[^>]+>/g, '\n').replace(/&(amp|lt|gt|quot|#x27|#39);/g, match => entities[match]!).split('\n');
  const stray: string[] = [];
  for (const line of lines) {
    let rest = line;
    for (const word of allowed) rest = rest.split(word).join(' ');
    if (/[\p{L}\p{N}]/u.test(rest)) stray.push(line.trim());
  }
  return stray;
}

function slots(locale: string) {
  const common = base(locale);
  return [
    ['home: young', () => createElement(WikiHome, { ...common, ...renderers, ...data.homeProps(data.youngHome, data.atChapter1) }),
      [data.youngHome, data.atChapter1]],
    ['home: full', () => createElement(WikiHome, { ...common, ...renderers, ...data.homeProps(data.fullHome, data.atEverything) }),
      [data.fullHome, data.atEverything]],
    ['home: empty', () => createElement(WikiHome, { ...common, ...renderers, ...data.homeProps(data.emptyHome, data.atChapter1) }),
      [data.emptyHome, data.atChapter1]],
    ['home: no works', () => createElement(WikiHome, { ...common, ...renderers, ...data.homeProps(data.noWorksHome, data.atChapter1) }),
      [data.noWorksHome, data.atChapter1]],
    ['guide', () => createElement(WikiMemberIndex, { ...common, members: data.chapters, more: true,
      mount: { segment: 'chapters', name: data.text('Chapters') }, position: data.atChapter3 }), [data.chapters, data.atChapter3]],
    ['timeline', () => createElement(WikiMemberIndex, { ...common, members: data.events, more: false,
      mount: { segment: 'events', name: data.text('Events') }, position: data.atChapter1 }), [data.events, data.atChapter1]],
    ['character', () => createElement(WikiEntity, { ...common, entity: data.elizabeth, position: data.atChapter3, rest: null,
      mount: { segment: 'characters', name: data.text('Characters'), href: '/r/franchise-wiki/characters' } }),
      [data.elizabeth, data.atChapter3, 'Characters']],
    ['character: quotation withheld', () => createElement(WikiEntity, { ...common, entity: data.elizabethWithheld,
      position: data.atEverything, rest: null, mount: null }), [data.elizabethWithheld, data.atEverything]],
    ['character: young record', () => createElement(WikiEntity, { ...common, entity: data.janeYoung, position: data.atChapter1,
      rest: null, mount: null }), [data.janeYoung, data.atChapter1]],
    ['chapter: reached', () => createElement(WikiEntity, { ...common, entity: data.chapter2, position: data.atChapter3, rest: null,
      mount: null }), [data.chapter2, data.atChapter3]],
    ['chapter: ahead of the reader', () => createElement(WikiEntity, { ...common, entity: data.chapter3Ahead,
      position: data.atChapter1, rest: null, mount: null }), [data.chapter3Ahead, data.atChapter1]],
  ] as const;
}

describe('G-849 wiki slots draw only what the host read', () => {
  const realFetch = globalThis.fetch;
  test('no slot fetches, in any locale', () => {
    globalThis.fetch = (() => { throw new Error('a wiki slot fetched'); }) as unknown as typeof fetch;
    try {
      for (const locale of uiLocales) for (const [, render] of slots(locale)) expect(renderToStaticMarkup(render())).not.toBe('');
    } finally { globalThis.fetch = realFetch; }
  });

  test('every word on a page comes from the reads or from the package’s own strings', () => {
    for (const locale of uiLocales) {
      for (const [name, render, inputs] of slots(locale)) {
        expect({ locale, name, stray: leftover(renderToStaticMarkup(render()), [...inputs], locale) })
          .toEqual({ locale, name, stray: [] });
      }
    }
  });

  test('the guard fails on a slot that invents a record (a deliberate regression)', () => {
    const rogue = () => createElement('ul', null, ...data.characters.map(item => createElement('li', null, item.name.value)),
      createElement('li', null, 'George Wickham'));
    expect(leftover(renderToStaticMarkup(rogue()), [data.characters], 'en')).toEqual(['George Wickham']);
    // A count is only the length of a list it was given.
    expect(leftover('<span>99</span>', [data.characters], 'en')).toEqual(['99']);
  });

  test('a part the read did not return is not drawn: no placeholder rows, passages or lists', () => {
    const html = renderToStaticMarkup(slots('en').find(([name]) => name === 'character: young record')![1]());
    expect(html).not.toContain('data-wiki-relationships');
    expect(html).not.toContain('data-wiki-passages');
    // The infobox holds only what the read returned: its kind and where it first appears, no facts.
    expect(html).not.toContain('<dt>Family</dt>');
    expect(html).not.toContain('data-wiki-aliases');
    const empty = renderToStaticMarkup(slots('en').find(([name]) => name === 'home: empty')![1]());
    expect(empty).toContain('This wiki has no pages yet');
    expect(empty).toContain('/en/r/franchise-wiki/about');
    const characters = /data-wiki-section="characters".*?<\/section>/s.exec(empty)![0];
    expect(characters).toContain('Nothing is revealed here yet at your position.');
    expect(characters).not.toContain('See all');
  });

  test('a withheld quotation shows no text and keeps its source', () => {
    const html = renderToStaticMarkup(slots('en').find(([name]) => name === 'character: quotation withheld')![1]());
    expect(html).not.toContain('<blockquote');
    expect(html).toContain('withheld by a rights restriction');
    expect(html).toContain('text/plain edition');
    expect(html).toContain('public domain');
  });

  test('a chapter beyond the reader lists nothing it reveals', () => {
    const html = renderToStaticMarkup(slots('en').find(([name]) => name === 'chapter: ahead of the reader')![1]());
    expect(html).toContain('data-wiki-unreached');
    expect(html).not.toContain('data-wiki-reveals');
  });
});

describe('G-849 the package is data in, markup out', () => {
  const directory = join(import.meta.dir, '../zones/official/franchise-wiki');
  const sources = readdirSync(directory).filter(file => /\.(ts|tsx)$/.test(file));
  test('it imports only the SDK, the UI kit, icons and React, and calls no network or storage API', () => {
    for (const file of sources) {
      const source = readFileSync(join(directory, file), 'utf8');
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        const specifier = match[1]!;
        expect(['@rezics/zone-sdk', 'lucide-react', 'react'].includes(specifier) || specifier.startsWith('./')
          || specifier.startsWith('@rezics/ui/')).toBe(true);
      }
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|WebSocket/);
    }
  });
});
