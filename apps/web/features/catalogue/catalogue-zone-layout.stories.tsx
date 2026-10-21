import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ZoneWork } from '@rezics/zone-sdk';
import { workCoverRatio, type WorkCoverKind } from '@rezics/ui/work-cover';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RealmPageStory } from '../realm/story-page.tsx';
import { AppShell } from '../shell/app-shell.tsx';
import { messages } from '../shell/messages.ts';
import { ZoneBrowse } from '../zones/browse.tsx';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { officialBrowseModel, officialZone } from '../zones/official-fixtures.ts';
import { cardRenderer } from '../zones/zone-home.tsx';

const zone = officialZone('books', 'en');
const zoneMessages = zoneMessagesFor('en');
const results = (single: boolean) => officialBrowseModel('books', 'en', {
  view: 'grid', ...(single ? { q: 'Jane Eyre' } : {}),
});

// Exercise the actual shell, facet column and platform Zone cards together.
// These authored fixtures prove layout; recorded catalogue journeys remain separate.
function ZoneCatalogue({ single = false }: { single?: boolean }) {
  return <AppShell locale="en" messages={messages} theme="light" navCollapsed={false}
    account={<a href="/auth/start">Sign in</a>}>
    <RealmPageStory zone={zone} locale="en" site>
      <ZoneBrowse model={results(single)} messages={zoneMessages}
        card={cardRenderer(zone, null, 'en', zoneMessages)} />
    </RealmPageStory>
  </AppShell>;
}

async function assertPreviews(list: HTMLElement, works: readonly ZoneWork[]) {
  await waitFor(() => expect(list).toHaveAttribute('data-masonry', 'true'));
  await waitFor(async () => {
    const bounds = list.getBoundingClientRect();
    const cards = [...list.querySelectorAll('article')];
    await expect(cards).toHaveLength(works.length);
    await expect(cards.length).toBeGreaterThan(0);
    const boxes = cards.map(card => card.getBoundingClientRect());
    for (const [index, card] of cards.entries()) {
      const work = works[index]!;
      const cover = card.querySelector<HTMLElement>('[data-slot="work-cover"]')!;
      const image = cover.getBoundingClientRect();
      const heading = card.querySelector('h3')!;
      const title = heading.getBoundingClientRect();
      await expect(image.width).toBeCloseTo(128, 1);
      await expect(image.width / image.height).toBeCloseTo(workCoverRatio[cover.dataset.kind as WorkCoverKind], 2);
      await expect(title.width).toBeGreaterThanOrEqual(96);
      await expect(Number.parseFloat(getComputedStyle(heading).fontSize)).toBeGreaterThanOrEqual(16);
      await expect(heading).toHaveTextContent(work.title!.value);
      const author = within(card).getByText(work.author!.value,
        { exact: true, selector: ':scope > p *' }).closest('p')!;
      await expect(author.getBoundingClientRect().width).toBeCloseTo(128, 1);
      await expect(Number.parseFloat(getComputedStyle(author).fontSize)).toBeGreaterThanOrEqual(14);
      const box = boxes[index]!;
      await expect(box.left).toBeGreaterThanOrEqual(bounds.left - 0.5);
      await expect(box.right).toBeLessThanOrEqual(bounds.right + 0.5);
      const previous = boxes[index - 1];
      if (previous) {
        await expect(box.top).toBeGreaterThanOrEqual(previous.top - 0.5);
        if (Math.abs(box.top - previous.top) < 0.5) await expect(box.left).toBeGreaterThanOrEqual(previous.right);
      }
    }
  });
  const links = within(list).getAllByRole('link').filter(link => link.tabIndex !== -1);
  links[0]!.focus();
  for (const link of links.slice(1, 5)) {
    await userEvent.tab();
    await expect(link).toHaveFocus();
  }
}

const meta = {
  title: 'Catalogue/Zone available space', component: ZoneCatalogue,
  args: { single: false }, globals: { viewport: { value: 'zone1024' } },
  parameters: {
    route: { pathname: zone.links.browse }, catalogueViewportWidth: 1024,
    viewport: { options: Object.fromEntries([1023, 1024, 1025].map(width => [`zone${width}`, {
      name: `Zone (${width} × 900)`, styles: { width: `${width}px`, height: '900px' }, type: 'desktop',
    }])) },
  },
  async play({ args, canvasElement, parameters }) {
    const canvas = within(canvasElement);
    await expect(window.innerWidth).toBe(parameters.catalogueViewportWidth);
    const list = canvasElement.querySelector<HTMLElement>('[data-slot="catalogue-grid"]')!;
    const works = results(Boolean(args.single)).items;
    if (args.single) await expect(works).toHaveLength(1);
    else await expect(works.length).toBeGreaterThan(1);
    await assertPreviews(list, works);
    const firstTitle = within(list).getByRole('link', { name: works[0]!.title!.value });
    for (const label of ['Collapse navigation', 'Expand navigation']) {
      await userEvent.click(canvas.getByRole('button', { name: label }));
      await assertPreviews(list, works);
      await expect(within(list).getByRole('link', { name: works[0]!.title!.value })).toBe(firstTitle);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
} satisfies Meta<typeof ZoneCatalogue>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeFacetBreakpoint: Story = {
  globals: { viewport: { value: 'zone1023' } }, parameters: { catalogueViewportWidth: 1023 },
};
export const AtFacetBreakpoint: Story = {};
export const AfterFacetBreakpoint: Story = {
  globals: { viewport: { value: 'zone1025' } }, parameters: { catalogueViewportWidth: 1025 },
};
export const SingleResult: Story = { args: { single: true } };
