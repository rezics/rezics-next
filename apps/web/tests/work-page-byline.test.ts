import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { citationAuthors, coverAuthors, WorkCredits } from '../features/work-page/credits.tsx';
import * as fixture from '../features/work-page/fixtures.ts';
import { messages } from '../features/work-page/messages.ts';
import { WorkHeader } from '../features/work-page/work-header.tsx';
import { WorkPageCover } from '../features/work-page/work-frame.tsx';

beforeAll(seedServedTypes);

/** The account that created or imported a catalogue Work. It is not an author. */
const creator = 'catalogue-editor';
const unnamed = (key: string) => `Open Library author ${key}`;

const credits = (agentCredits: typeof fixture.agentCredits, external: typeof fixture.credits) =>
  createElement(WorkCredits, { agentCredits, credits: external, locale: 'en', messages: messages.en });

const header = (agentCredits: typeof fixture.agentCredits, external: typeof fixture.credits) =>
  renderToStaticMarkup(createElement(WorkHeader, {
    work: fixture.work, credits: credits(agentCredits, external), locale: 'en', messages: messages.en,
  }));

const cover = (agentCredits: typeof fixture.agentCredits, external: typeof fixture.credits) =>
  renderToStaticMarkup(createElement(WorkPageCover, {
    work: fixture.work, authors: coverAuthors(agentCredits, external, unnamed),
  }));

describe('Work page byline', () => {
  test('an imported Work with no credits has no byline', () => {
    const html = header(fixture.noAgentCredits, fixture.noCredits);
    expect(coverAuthors(fixture.noAgentCredits, fixture.noCredits, unnamed)).toEqual([]);
    expect(citationAuthors(fixture.noAgentCredits)).toEqual([]);
    expect(html).toContain('The Cartographer of Tides');
    expect(html).not.toContain(creator);
    expect(html).not.toContain('Author');
  });

  test('a credited Work shows its credited author', () => {
    const html = header(fixture.agentCredits, fixture.credits);
    expect(html).toContain('Maren Osei');
    expect(html).toContain('Idris Vale');
    expect(citationAuthors(fixture.agentCredits)).toEqual(['Maren Osei']);
    expect(html).not.toContain(creator);
  });

  test('the cover text never contains the creating account\'s name', () => {
    const imported = cover(fixture.noAgentCredits, fixture.noCredits);
    const credited = cover(fixture.agentCredits, fixture.credits);
    expect(imported).toContain('The Cartographer of Tides');
    expect(imported).not.toContain(creator);
    expect(imported).not.toContain('Maren Osei');
    expect(credited).toContain('Maren Osei');
    expect(credited).toContain('Idris Vale');
    expect(credited).not.toContain(creator);
  });
});
