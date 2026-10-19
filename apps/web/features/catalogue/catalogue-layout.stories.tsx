import type { Meta, StoryObj } from '@storybook/react-vite';
import { direction } from '@rezics/main/language';
import { MediaImageProvider, mediaImageKey, type MediaImageMetadata } from '@rezics/ui/media-image';
import { ChoiceSelect } from '@rezics/ui/select';
import { workCoverRatio, type WorkCoverKind } from '@rezics/ui/work-cover';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { browseId, browseResources } from '../discover/browse-fixtures.ts';
import type { ResourceCard } from '../discover/api.ts';
import { ResourceList } from '../discover/resource-list.tsx';
import { resourceWork } from '../discover/resource-card.tsx';
import { chooseOption } from '../stories/choose-option.ts';
import { AlsoEnjoyedRow } from '../work-page/also-enjoyed-row.tsx';
import { WorkGrid, WorkShelf } from './work-shelf.tsx';

const work = (index: number, title: string, type: string): ResourceCard => ({
  ...browseResources[0]!, id: browseId(9600 + index), types: [`https://schema.org/${type}`],
  name: { value: title, language: 'en', direction: direction('en', title), basis: 'requested' },
});
const book = work(0, 'The Lantern Atlas', 'Book');
const game = work(1, 'Minecraft', 'VideoGame');
const items = [book, browseResources[1]!, game, browseResources[3]!,
  work(2, 'A field guide to stars', 'DigitalDocument'), browseResources[4]!,
  work(3, 'Nightfall', 'VideoGame'), browseResources[5]!, work(4, 'Letters after midnight', 'Book'),
  browseResources[2]!, work(5, 'Rainy night recipes', 'Recipe'), work(6, 'The last train', 'Book')];
const works = items.filter(item => item.kind === 'work').map(item => resourceWork(item));
const viewer = { ready: true, signedIn: false, age: 'unknown' as const,
  optIns: { general: true, r15: false, sexual: false, grotesque: false } };
const representationId = browseId(9700).slice(-36);
const image: MediaImageMetadata = { representationId, nsfw: 'sfw', ageRating: { status: 'unassessed' },
  src: URL.createObjectURL(new Blob([
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="900" height="400" fill="#234a62"/><text x="450" y="220" text-anchor="middle" font-size="60" fill="#f4d997">The Lantern Atlas</text></svg>',
  ], { type: 'image/svg+xml' })) };
const imageBook: ResourceCard = { ...book, icon: { kind: 'image',
  url: `/v1/media/representations/${representationId}`, width: 900, height: 400,
  selection: browseId(9701), mediaType: 'image/svg+xml', crop: null, coverCredit: null,
  basis: { policy: 'story', context: browseId(9702) } } };

function MixedCatalogue({ rtl = false }: { rtl?: boolean }) {
  const [visible, setVisible] = useState(items.slice(0, 8));
  const [imageReady, setImageReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return <MediaImageProvider viewer={viewer} images={imageReady ? { [mediaImageKey(image)]: image } : {}}>
    <div dir={rtl ? 'rtl' : 'ltr'} className="p-4">
      <h1 className="mb-4 text-xl">Browse the catalogue</h1>
      <div className="mb-6 flex flex-wrap gap-4">
        <button type="button" onClick={() => setVisible(items)}>Show more</button>
        <button type="button" onClick={() => setVisible(items.slice(4))}>Next results</button>
        <button type="button" onClick={() => setVisible(current => [...current].reverse())}>Reverse results</button>
        <button type="button" onClick={() => setImageReady(true)}>Load selected cover</button>
        <button type="button" onClick={() => setExpanded(value => !value)}>Expand community title</button>
      </div>
      <section aria-labelledby="catalogue-results">
        <h2 id="catalogue-results" className="sr-only">Catalogue results</h2>
        <ResourceList items={visible.map(item => item.id === book.id ? imageBook
          : item.id === browseResources[1]!.id && expanded ? { ...item,
            name: { ...item.name, value: 'Readers of astronomy, natural history, travel and letters from the night train' } }
            : item)} locale="en" />
      </section>
    </div>
  </MediaImageProvider>;
}

async function assertPacked(list: HTMLElement) {
  await waitFor(() => expect(list).toHaveAttribute('data-masonry', 'true'));
  await waitFor(() => {
    const cards = [...list.children].map(item => item.firstElementChild!.getBoundingClientRect());
    const bounds = list.getBoundingClientRect();
    const rtl = getComputedStyle(list).direction === 'rtl';
    cards.forEach((box, index) => {
      expect(box.left).toBeGreaterThanOrEqual(bounds.left - 0.5);
      expect(box.right).toBeLessThanOrEqual(bounds.right + 0.5);
      const previous = cards[index - 1];
      if (previous) {
        expect(box.top).toBeGreaterThanOrEqual(previous.top - 0.5);
        if (Math.abs(box.top - previous.top) < 0.5) {
          expect(rtl ? box.right <= previous.left : box.left >= previous.right).toBe(true);
        }
      }
      const above = cards.slice(0, index).filter(other => Math.abs(other.left - box.left) < 0.5);
      if (above.length) {
        const gap = box.top - Math.max(...above.map(other => other.bottom));
        expect(gap).toBeGreaterThanOrEqual(23.5);
        expect(gap).toBeLessThan(28.1);
      } else expect(box.top).toBeCloseTo(bounds.top, 0);
    });
  });
  for (const cover of list.querySelectorAll<HTMLElement>('[data-slot="work-cover"]')) {
    const box = cover.getBoundingClientRect();
    await expect(box.width).toBeCloseTo(128, 1);
    await expect(box.width / box.height).toBeCloseTo(workCoverRatio[cover.dataset.kind as WorkCoverKind], 2);
  }
}

const meta = { title: 'Catalogue/Responsive reading order', component: MixedCatalogue,
  args: { rtl: false }, globals: { viewport: { value: 'desktop1440' } },
} satisfies Meta<typeof MixedCatalogue>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedCards: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('list');
    await assertPacked(list);
    const before = list.querySelector('[data-slot="work-cover"]')!.getBoundingClientRect();
    await userEvent.click(canvas.getByRole('button', { name: 'Load selected cover' }));
    const art = list.querySelector<HTMLImageElement>('[data-slot="media-image"]');
    await waitFor(() => expect(list.querySelector<HTMLImageElement>('[data-slot="media-image"]')?.naturalWidth).toBe(900));
    await expect(art ?? list.querySelector('[data-slot="media-image"]')).toHaveAttribute('loading', 'lazy');
    await expect(list.querySelector('[data-slot="work-cover"]')!.getBoundingClientRect().height).toBeCloseTo(before.height, 1);
    await userEvent.click(canvas.getByRole('button', { name: 'Expand community title' }));
    await assertPacked(list);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(list.children.length).toBe(items.length));
    await assertPacked(list);
    const headings = [...list.querySelectorAll('h3')].map(heading => heading.textContent);
    await userEvent.click(canvas.getByRole('button', { name: 'Reverse results' }));
    await waitFor(() => expect([...list.querySelectorAll('h3')].map(heading => heading.textContent)).toEqual([...headings].reverse()));
    await assertPacked(list);
    await userEvent.click(canvas.getByRole('button', { name: 'Next results' }));
    await waitFor(() => expect(list.children.length).toBe(items.length - 4));
    await assertPacked(list);
    // Keyboard follows the API/DOM sequence, including each card's author links.
    const links = within(list).getAllByRole('link').filter(link => link.tabIndex !== -1);
    links[0]!.focus();
    for (const link of links.slice(1, 5)) {
      await userEvent.tab();
      await expect(link).toHaveFocus();
    }
  },
};
export const Phone: Story = { ...MixedCards, globals: { viewport: { value: 'phone' } } };
export const SmallPhone: Story = { ...MixedCards,
  parameters: { viewport: { options: { phone320: { name: 'Phone (320 × 844)',
    styles: { width: '320px', height: '844px' }, type: 'mobile' } } } },
  globals: { viewport: { value: 'phone320' } },
};
export const RightToLeft: Story = { ...MixedCards, args: { rtl: true } };

// These are available container widths, including the current shell's padding
// and expanded/collapsed rail. Actual viewport transitions are also a prove journey.
const viewportWidths = [320, 390, 767, 768, 769, 1023, 1024, 1025, 1440, 1920];
const widths = [...new Set(viewportWidths.flatMap(width => [false, true].map(collapsed =>
  Math.min(1152, width - (width >= 768 ? collapsed ? 72 : 256 : 0))
    - (width >= 1024 ? 80 : width >= 640 ? 48 : 32))))];
function AvailableSpace() {
  const [width, setWidth] = useState(widths[0]!);
  const [mixed, setMixed] = useState(true);
  return <div className="p-4">
    <h1 className="mb-4 text-xl">Catalogue previews</h1>
    <ChoiceSelect label="Available width" value={String(width)} className="w-40" portalled={false}
      options={widths.map(value => ({ value: String(value), label: String(value) }))}
      onValueChange={value => setWidth(Number(value))} />
    <button type="button" className="ms-4" onClick={() => setMixed(value => !value)}>Toggle All and Works</button>
    <div data-testid="available-space" style={{ width, maxWidth: '100%' }} className="mt-6">
      <h2 className="sr-only">Catalogue results</h2>
      <ResourceList items={mixed ? items : items.filter(item => item.kind === 'work')} locale="en" />
    </div>
  </div>;
}
export const ContainerBreakpoints: Story = {
  render: () => <AvailableSpace />,
  globals: { viewport: { value: 'desktopWide' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('list');
    const originalTitle = within(list).getByRole('link', { name: book.name.value });
    for (const width of widths) {
      await userEvent.click(canvas.getByRole('combobox', { name: 'Available width' }));
      await chooseOption(canvas, String(width));
      await waitFor(() => expect(list.getBoundingClientRect().width).toBeCloseTo(width, 0));
      const title = within(list).getByRole('link', { name: book.name.value });
      await expect(title).toBe(originalTitle);
      title.focus();
      await assertPacked(list);
      await expect(title).toHaveFocus();
    }
    const title = within(list).getByRole('link', { name: book.name.value });
    const cover = list.querySelector('[data-slot="work-cover"]');
    const box = cover!.getBoundingClientRect();
    await userEvent.click(canvas.getByRole('button', { name: 'Toggle All and Works' }));
    const workList = canvas.getByRole('list');
    await assertPacked(workList);
    await expect(within(workList).getByRole('link', { name: book.name.value })).toHaveAttribute('href', title.getAttribute('href'));
    await expect(workList.querySelector('[data-slot="work-cover"]')!.getBoundingClientRect().width).toBeCloseTo(box.width, 1);
  },
};

export const PreviewConsumers: Story = {
  render: () => <div className="mx-auto grid max-w-4xl gap-8 p-4">
    <h1 className="text-xl">More to read</h1>
    <section aria-label="Single result"><h2 className="mb-4 text-lg">Single result</h2>
      <WorkGrid works={works.slice(0, 1)} locale="en" /></section>
    <section aria-label="Works"><h2 className="mb-4 text-lg">Works</h2>
      <WorkGrid works={works} locale="en" /></section>
    <section aria-label="All"><h2 className="mb-4 text-lg">All</h2>
      <ResourceList items={items} locale="en" /></section>
    <WorkShelf heading={{ title: 'Popular works' }} works={works} locale="en" />
    <AlsoEnjoyedRow id="also-enjoyed" title="Readers also enjoyed" works={works} locale="en" />
  </div>,
  async play({ canvasElement }) {
    for (const cover of canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"][data-kind="book"]')) {
      const box = cover.getBoundingClientRect();
      await expect(box.width).toBeCloseTo(128, 1);
      await expect(box.height).toBeCloseTo(192, 1);
    }
    for (const article of canvasElement.querySelectorAll('article')) {
      const cover = article.querySelector('[data-slot="work-cover"]');
      if (cover) {
        const heading = article.querySelector('h3')!.getBoundingClientRect();
        // Landscape art is followed by its title, without a portrait slot above it.
        await expect(heading.top - cover.getBoundingClientRect().bottom).toBeLessThan(20);
      }
    }
  },
};
