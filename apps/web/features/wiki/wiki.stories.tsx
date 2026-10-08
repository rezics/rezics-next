import { realmHref, siteHref } from '../realm/route.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { HomeSlotProps, ZoneEntity, ZonePositionState } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import franchiseWiki from '../../zones/official/franchise-wiki/index.tsx';
import { WikiEntity, WikiHome, WikiMemberIndex } from '../../zones/official/franchise-wiki/slots.tsx';
import { cardRenderer, workRenderers } from '../zones/zone-home.tsx';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { RealmPageStory } from '../realm/story-page.tsx';
import * as data from './fixtures.ts';
import { copyOf } from './messages.ts';
import { PositionControl } from './position-control.tsx';

// The franchise wiki Zone at each state of its reads: empty, young and full; a page withheld by position, a quotation
// withheld by rights, and the position control. Phone and desktop, light and dark, as the readers of this Zone see them.

const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

function Control({ locale, at, current }: { locale: UiLocale; at: 'all' | 'chapter3'; current: number | null }) {
  const t = copyOf(locale);
  return <PositionControl
    copy={{ region: t.region, upTo: t.upTo, upToEverything: t.upToEverything, showEverything: t.showEverything,
      sheetTitle: t.sheetTitle, sheetBody: t.sheetBody, progressOption: t.progressOption, progressNote: t.progressNote,
      progressNoneNote: t.progressNoneNote, everythingOption: t.everythingOption, everythingNote: t.everythingNote,
      moreChapters: t.moreChapters, close: t.close }}
    at={at === 'all' ? { kind: 'all' } : { kind: 'position', label: data.text('Volume 1 · Chapter 3'), note: t.yourProgress }}
    options={data.options.map((option, index) => ({ ...option, current: index === current }))}
    progress={{ href: data.wikiSiteHref(), current: at !== 'all' && current === null, resolved: data.text('Volume 1 · Chapter 3') }}
    everything={{ href: data.wikiSiteHref([], { position: 'all' }), current: at === 'all' }} more={false} />;
}

function Page({ locale, children, at = 'chapter3' }: { locale: UiLocale; children: React.ReactNode; at?: 'all' | 'chapter3' }) {
  return <RealmPageStory zone={data.zoneFor(locale)} pkg={franchiseWiki} locale={locale}
    execution={{ mode: 'package', slug: 'franchise-wiki' }} position={<Control locale={locale} at={at} current={null} />}>
    {children}
  </RealmPageStory>;
}

const common = (locale: UiLocale) => {
  const zone = data.zoneFor(locale);
  return { zone, fallback: null, Link: LocalizedLink,
    ...workRenderers(cardRenderer(zone, franchiseWiki, locale, zoneMessagesFor(locale)), locale, zoneMessagesFor(locale)) };
};

function Home({ locale, sections, position }: { locale: UiLocale; sections: HomeSlotProps['sections']; position: ZonePositionState }) {
  return <Page locale={locale}><WikiHome {...common(locale)} sections={sections} position={position} /></Page>;
}

function EntityPage({ locale, entity, position }: { locale: UiLocale; entity: ZoneEntity; position: ZonePositionState }) {
  return <Page locale={locale}><WikiEntity {...common(locale)} entity={entity} position={position} rest={null}
    mount={{ segment: 'characters', name: data.text('Characters'), href: data.wikiSiteHref(['characters']) }} /></Page>;
}

function Index({ locale, segment, members }: { locale: UiLocale; segment: string; members: typeof data.chapters }) {
  return <Page locale={locale}><WikiMemberIndex {...common(locale)} members={members} more={false}
    mount={{ segment, name: data.text(segment) }} position={data.atChapter3} /></Page>;
}

/** The component the stories share their `locale` argument through; each story renders its own page. */
function Wiki(_: { locale: UiLocale }) { return null; }

const meta = {
  title: 'Zones/Franchise wiki',
  component: Wiki,
  parameters: { route: { pathname: siteHref('en', 'franchise-wiki', []) } },
  args: { locale: 'en' },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof Wiki>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing published: it says what exists (the Work) and how holders build the rest, and invents no page. */
export const HomeEmpty: Story = {
  render: ({ locale }) => <Home locale={locale} sections={data.emptyHome} position={data.atChapter1} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'This wiki has no pages yet' })).toBeVisible();
    await expect(canvas.getByText('It covers the Works above, but no characters, places, events or chapters have been published yet.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'How this wiki is run' })).toHaveAttribute('href', realmHref('en', 'franchise-wiki', 'about'));
    await expect(canvas.queryByText('Elizabeth Bennet')).toBeNull();
    await fits();
  },
};

/** A young wiki on a phone: the lists that have pages, the ones that do not yet, and the way to build more. */
export const HomeYoungPhone: Story = {
  globals: { viewport: { value: 'phone' } },
  render: ({ locale }) => <Home locale={locale} sections={data.youngHome} position={data.atChapter1} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'This wiki is just beginning' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Jane Bennet Character' })).toBeVisible();
    await expect(canvas.queryByText('Fitzwilliam Darcy')).toBeNull();
    await fits();
  },
};

/** The full home at the end of the story: works, characters, places, a chapter guide and a timeline. */
export const HomeFull: Story = {
  render: ({ locale }) => <Home locale={locale} sections={data.fullHome} position={data.atEverything} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const heading of [/^Works/, /^Main characters/, /^Places/, /^Chapter guide/, /^Timeline/]) {
      await expect(canvas.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(canvas.getByText('Includes records from chapters you may not have read.')).toBeVisible();
    await expect(canvas.getAllByRole('list').some(list => list.classList.contains('fw-guide'))).toBe(true);
    await fits();
  },
};

export const HomeFullDarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  render: HomeFull.render,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: /^Timeline/ })).toBeVisible();
    await fits();
  },
};

/** At chapter 1 the later records are not here, and the page says which position it is showing and offers everything. */
export const HomeWithheldByPosition: Story = {
  render: ({ locale }) => <Home locale={locale} sections={data.youngHome} position={data.atChapter1} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Showing what is revealed up to Chapter 1\./)).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Show everything' }).length).toBeGreaterThan(0);
    await expect(canvas.queryByText('Fitzwilliam Darcy')).toBeNull();
  },
};

/** A character: names by language, an infobox from recorded facts, relationships as rows and a quotation with its source. */
export const Character: Story = {
  render: ({ locale }) => <EntityPage locale={locale} entity={data.elizabeth} position={data.atChapter3} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Elizabeth Bennet' })).toBeVisible();
    await expect(canvas.getByText('Lizzy')).toBeVisible();
    await expect(canvas.getByText('エリザベス・ベネット')).toHaveAttribute('lang', 'ja');
    const infobox = canvas.getByRole('complementary', { name: 'At a glance' });
    await expect(within(infobox).getByText('Bennet family')).toBeVisible();
    await expect(within(infobox).getByRole('link', { name: 'Chapter 1' })).toBeVisible();
    const relationships = canvas.getByRole('heading', { name: 'Relationships' }).closest('section')!;
    await expect(within(relationships).getByRole('link', { name: 'Jane Bennet' })).toBeVisible();
    const quote = canvas.getByRole('heading', { name: 'Passages and sources' }).closest('section')!;
    await expect(within(quote).getByText('The Bennet family')).toBeVisible();
    await expect(within(quote).getByText(/text\/plain edition · extracted by Holder extraction agent · public domain/)).toBeVisible();
    await fits();
  },
};

/** A withheld credit keeps the role and the public name, and says the credited name is not shown. */
export const WithheldCredit: Story = {
  render: ({ locale }) => <EntityPage locale={locale} entity={data.elizabethCreditWithheld} position={data.atEverything} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const relationships = canvas.getByRole('heading', { name: 'Relationships' }).closest('section')!;
    await expect(within(relationships).getByText('Translator')).toBeVisible();
    await expect(within(relationships).getByRole('link', { name: 'Arthur' })).toBeVisible();
    const hidden = within(relationships).getByRole('link', { name: 'Name not shown' });
    await expect(hidden).toBeVisible();
    await expect(hidden.getAttribute('href') ?? '').not.toContain('https://rezics.com/id/');
    await expect(within(relationships).getByText('Lizzy')).toBeVisible();
    await expect(canvasElement.textContent ?? '').not.toContain('Hidden Alias');
    await fits();
  },
};

/** Contradictory claims each say which continuity they belong to, by a link to that Work, so neither reads as the truth. */
export const ClaimsByContinuity: Story = {
  render: ({ locale }) => <EntityPage locale={locale} entity={data.elizabethContinuities} position={data.atEverything} />,
  async play({ canvasElement }) {
    const infobox = within(canvasElement).getByRole('complementary', { name: 'At a glance' });
    await expect(within(infobox).getByRole('link', { name: 'Pride and Prejudice' })).toBeVisible();
    await expect(within(infobox).getByRole('link', { name: 'Pride and Prejudice: an alternate telling' })).toBeVisible();
    await expect(within(infobox).getByText('Longbourn').closest('li')).toHaveTextContent('Longbourn (Pride and Prejudice)');
    await expect(within(infobox).getByText('Netherfield').closest('li')).toHaveTextContent('(Pride and Prejudice: an alternate telling)');
    await fits();
  },
};

export const CharacterDarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  render: Character.render,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: 'Elizabeth Bennet' })).toBeVisible();
    await fits();
  },
};

/** A quotation under a rights restriction: no passage is drawn, and its source stays. */
export const QuotationWithheldByRights: Story = {
  render: ({ locale }) => <EntityPage locale={locale} entity={data.elizabethWithheld} position={data.atEverything} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('The quotation is withheld by a rights restriction. Its source is still recorded.')).toBeVisible();
    await expect(canvas.queryByText('The Bennet family', { selector: 'blockquote p' })).toBeNull();
    await expect(canvas.getByText(/text\/plain edition/)).toBeVisible();
  },
};

/** A record with only a name so far: no rows, passages or aliases are invented. */
export const CharacterYoung: Story = {
  globals: { viewport: { value: 'phone' } },
  render: ({ locale }) => <EntityPage locale={locale} entity={data.janeYoung} position={data.atChapter1} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Jane Bennet' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Relationships' })).toBeNull();
    await expect(canvas.queryByRole('heading', { name: 'Passages and sources' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Open the full record' })).toBeVisible();
    await fits();
  },
};

/** A chapter the reader has reached: what it adds to each list, and the neighbouring chapters. */
export const ChapterReached: Story = {
  render: ({ locale }) => <Page locale={locale}><WikiEntity {...common(locale)} entity={data.chapter2} position={data.atChapter3}
    rest={null} mount={{ segment: 'chapters', name: data.text('Chapters'), href: data.wikiSiteHref(['chapters']) }} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Revealed in this chapter' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Fitzwilliam Darcy Character' })).toBeVisible();
    await expect(canvas.getByText('This list may be incomplete.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Previous chapter/ })).toHaveAttribute('rel', 'prev');
    await expect(canvas.getByRole('link', { name: /Next chapter/ })).toHaveAttribute('rel', 'next');
    await fits();
  },
};

/** A chapter ahead of the reader on a phone: it lists nothing, and says why. */
export const ChapterAheadPhone: Story = {
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
  render: ({ locale }) => <Page locale={locale}><WikiEntity {...common(locale)} entity={data.chapter3Ahead} position={data.atChapter1}
    rest={null} mount={null} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/This chapter is beyond your reading position/)).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Revealed in this chapter' })).toBeNull();
    await fits();
  },
};

/** The chapter guide and the timeline, as lists of the pages Main returned. */
export const Guide: Story = {
  render: ({ locale }) => <Index locale={locale} segment="chapters" members={data.chapters} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelectorAll('.fw-guide li')).toHaveLength(3);
    await expect(canvas.getByRole('link', { name: 'Chapter 2' })).toBeVisible();
  },
};

export const Timeline: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  render: ({ locale }) => <Index locale={locale} segment="events" members={data.events} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: /The Meryton assembly/ })).toBeVisible();
  },
};

/** The control in the frame: what the reader is up to, and a sheet of the choices that works by keyboard. */
export const PositionSheet: Story = {
  globals: { viewport: { value: 'phone' } },
  render: ({ locale }) => <Page locale={locale}><WikiHome {...common(locale)} sections={data.fullHome} position={data.atChapter3} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole('region', { name: 'Reading position' });
    await expect(within(bar).getByRole('button', { name: /^Up to:|^Showing everything/ })).toHaveTextContent('Up to: Volume 1 · Chapter 3');
    await expect(within(bar).getByText('your progress')).toBeVisible();
    await userEvent.click(within(bar).getByRole('button', { name: /^Up to:|^Showing everything/ }));
    const sheet = within(document.body);
    await waitFor(() => expect(sheet.getByRole('dialog')).toBeVisible());
    const options = within(sheet.getByRole('dialog')).getAllByRole('link');
    await expect(options.map(option => option.textContent)).toEqual([
      'Your own progressCurrently Volume 1 · Chapter 3', 'Chapter 1', 'Chapter 2', 'Chapter 3',
      'Show everythingIncludes records revealed in chapters you have not read.']);
    await expect(options[3]).toHaveAttribute('href', siteHref('en', 'franchise-wiki', [], { position: 'c3' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(sheet.queryByRole('dialog')).toBeNull());
    await expect(within(bar).getByRole('button', { name: /^Up to:|^Showing everything/ })).toHaveFocus();
  },
};

/** Showing everything: the control says so, and offers the way back to the reader's own progress. */
export const PositionEverything: Story = {
  render: ({ locale }) => <RealmPageStory zone={data.zoneFor(locale)} pkg={franchiseWiki} locale={locale}
    execution={{ mode: 'package', slug: 'franchise-wiki' }} position={<Control locale={locale} at="all" current={null} />}>
    <WikiHome {...common(locale)} sections={data.fullHome} position={data.atEverything} /></RealmPageStory>,
  async play({ canvasElement }) {
    const bar = within(canvasElement).getByRole('region', { name: 'Reading position' });
    await expect(within(bar).getByRole('button', { name: /^Up to:|^Showing everything/ })).toHaveTextContent('Showing everything');
    await expect(within(bar).queryByRole('link', { name: 'Show everything' })).toBeNull();
  },
};

/** The Japanese reading of a character page, for names in their own script and the Zone's own words. */
export const CharacterJapanese: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  render: Character.render,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('別名:')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: '引用と出典' })).toBeVisible();
    await fits();
  },
};
