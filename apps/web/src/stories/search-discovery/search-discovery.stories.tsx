import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { currentLinkRefusal, discoveryExample, factualDiscoveryExample } from '../../kernel/fake/search-discovery';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { DiscoveryResults } from '../../search/discovery-results';
import { isCatalogueHit, type DiscoveryState } from '../../search/discovery';

function Example({ state, yearProperties }: { state: DiscoveryState; yearProperties?: string[] }) {
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <DiscoveryResults state={state} locale={getLocale()} {...(yearProperties ? { yearProperties } : {})} />
    </div>
  );
}

const meta = {
  title: 'Discovery/Mixed results',
  id: 'patterns-discovery-mixed-results',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: { state: { status: 'ready', page: discoveryExample } },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(4);
    const account = canvasElement.querySelector<HTMLElement>('[data-discovery-account]')!;
    const link = within(account).getByRole('link', { name: 'Mira' });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/@mira`);
    link.focus();
    await userEvent.tab();
    await expect(within(account).getByRole('link', { name: m.discovery_verified_as({ name: 'Mira' }) })).toHaveFocus();
  },
};

export const HandlelessAccount: Story = {
  args: {
    state: {
      status: 'ready',
      page: {
        ...discoveryExample,
        hits: discoveryExample.hits.filter((hit) => hit.summary.kind === 'account' && !hit.summary.value.handle),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Mira Reading Room' })).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const PublicSubject: Story = {
  args: {
    state: {
      status: 'ready',
      page: { ...discoveryExample, hits: discoveryExample.hits.filter((hit) => hit.key.kind === 'schema:Book') },
    },
  },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: 'Mira’s Atlas' });
    link.focus();
    await expect(link).toHaveFocus();
    await expect(link.getAttribute('href')).toContain(`/subjects/${discoveryExample.hits[3]!.key.id}/`);
  },
};

// These illustrative supplied summaries mount the same DiscoveryResults/ResultRow as the page.
const completeSubject = factualDiscoveryExample();
completeSubject.hits = completeSubject.hits.filter((hit) => hit.key.kind === 'catalogue:Atlas');
completeSubject.kinds.values.push({ id: 'catalogue:Atlas', labels: { en: 'Atlas', ja: '地図帳' }, icon: 'map' });

export const CompleteSubject: Story = {
  args: { state: { status: 'ready', page: completeSubject }, yearProperties: ['schema:datePublished'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const primary = canvas.getByRole('link', { name: /^Mira Star Atlas$/ });
    const author = canvas.getByRole('link', { name: /^Mira$/ });
    const metadata = canvasElement.querySelector<HTMLElement>('[data-content-item-slot="metadata"]')!;
    const preview = canvasElement.querySelector<HTMLElement>('[data-content-item-slot="preview"]')!;
    await expect(primary.closest('h2')).toHaveAttribute('data-content-item-slot', 'title');
    await expect(primary).toHaveTextContent('Mira Star Atlas');
    await expect(primary.querySelector('.sr-only')).toBeNull();
    await expect(metadata).toHaveTextContent('Maps of Mira');
    await expect(metadata).toHaveTextContent('2026');
    await expect(metadata).not.toHaveTextContent('An atlas of nearby stars.');
    await expect(preview).toHaveTextContent('An atlas of nearby stars.');
    await expect(preview.closest('[data-slot="list-row-control"]')).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="public-rating-figure"]')).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-ratio', '16:9');
    await expect(canvasElement.querySelectorAll('a a, a button')).toHaveLength(0);
    primary.focus();
    await userEvent.tab();
    await expect(author).toHaveFocus();
    await expect(author).toHaveAttribute('href', `/${getLocale()}/subjects/${discoveryExample.hits[0]!.key.id}/mira`);
  },
};

const longSubject = structuredClone(completeSubject);
const longHit = longSubject.hits[0]!;
if (isCatalogueHit(longHit)) {
  longHit.labels = {
    en: 'Mira’s atlas of reading journeys across cities, languages and generations '.repeat(4),
    ja: 'ミラの都市と言語と世代を越える読書の旅の地図帳'.repeat(6),
    de: 'Miras Atlas der Lesereisen durch Städte, Sprachen und Generationen '.repeat(4),
  };
  longHit.aliases = {
    en: ['A guide to reading journeys '.repeat(10), 'Atlas of many languages', 'Maps of Mira'],
    ja: ['いくつもの言語を結ぶ別名'.repeat(12), '読書の旅の地図帳', 'ミラの地図'],
  };
  longHit.facts = {
    'schema:author': [
      {
        kind: 'item',
        id: discoveryExample.hits[0]!.key.id,
        labels: {
          en: 'MiraTheCartographerAndWriter'.repeat(12),
          ja: '地図を描き物語を書く作者'.repeat(12),
        },
      },
    ],
    'schema:datePublished': [{ kind: 'time', year: 2026 }],
  };
  longHit.descriptions = {
    en: 'A short preview of an atlas connecting readers across cities and languages. '.repeat(10),
    ja: '都市と言語を越えて読者をつなぐ地図帳の短い紹介。'.repeat(14),
  };
  longHit.listPresentation = { imageAspect: 'portrait', keyFacts: ['schema:author', 'schema:datePublished'] };
}

export const LongLocalizedSubject: Story = {
  args: { state: { status: 'ready', page: longSubject }, yearProperties: ['schema:datePublished'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(1);
    await expect(canvas.getAllByRole('link')).toHaveLength(2);
    await expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-ratio', '5:7');
    const root = canvasElement.ownerDocument.documentElement;
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    await expect(canvasElement.querySelector('[data-slot="search-result-aliases"]')).toHaveClass('line-clamp-2');
    await expect(canvasElement.querySelector('[data-slot="item-description"]')).toHaveClass('line-clamp-2');
  },
};

const rtlSubject = structuredClone(longSubject);
const rtlHit = rtlSubject.hits[0]!;
if (isCatalogueHit(rtlHit)) {
  rtlHit.labels = { ar: 'أطلس ميرا لرحلات القراءة بين المدن واللغات والأجيال '.repeat(5) };
  rtlHit.aliases = { ar: ['خرائط ميرا', 'دليل القراءة بين المدن', 'أطلس الكتب واللغات'] };
  rtlHit.descriptions = { ar: 'وصف قصير لأطلس يربط القراء عبر المدن واللغات. '.repeat(10) };
}

export const RtlSubject: Story = {
  args: { state: { status: 'ready', page: rtlSubject }, yearProperties: ['schema:datePublished'] },
  play: async ({ canvasElement }) => {
    const heading = within(canvasElement).getByRole('heading', { level: 2 });
    await expect(heading).toHaveAttribute('lang', 'ar');
    await expect(heading).toHaveAttribute('dir', 'auto');
    await expect(within(heading).getByRole('link')).toHaveAttribute('lang', 'ar');
    await expect(canvasElement.querySelector('[data-slot="item-description"]')).toHaveAttribute('dir', 'auto');
    const root = canvasElement.ownerDocument.documentElement;
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  },
};

export const Empty: Story = {
  args: { state: { status: 'ready', page: { ...discoveryExample, hits: [] } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.search_no_results());
  },
};
export const Unavailable: Story = {
  args: { state: { status: 'unavailable' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(m.search_failed());
  },
};
export const NotReady: Story = {
  args: { state: { status: 'not-ready' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.discovery_not_ready());
  },
};
export const Loading: Story = {
  args: { state: { status: 'loading' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  },
};
export const CurrentLinkRefusal: Story = {
  args: { state: { status: 'ready', page: currentLinkRefusal() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Mira' })).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
    await userEvent.tab();
    await expect(canvasElement.querySelector('a:focus')).toBeNull();
  },
};
