import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { sharedRatio } from './cover.tsx';
import { CoverCard, CoverGrid, CoverRow } from './cover-card.tsx';

const subjects = [
  { id: 'book', title: 'A very long book title that continues over more than two lines', types: ['schema:Book'] },
  { id: 'album', title: '夜空中最亮的星與漫長旅途的故事', types: ['schema:MusicAlbum'] },
  { id: 'other', title: 'A short title', types: ['schema:Book'] },
  { id: 'four', title: '四季', types: ['schema:MusicAlbum'] },
];
const ratio = sharedRatio(subjects);
const cards = () =>
  subjects.map((subject, index) => (
    <CoverCard
      key={subject.id}
      href={`/${subject.id}`}
      title={subject.title}
      titleLang={index % 2 ? 'zh' : 'en'}
      cover={{ subject, cover: null, src: () => '' }}
      secondary={index < 2 ? 'A creator' : undefined}
      progress={index === 0 ? { value: 0.42, label: '42%' } : undefined}
      state={index === 1 ? 'Reading' : undefined}
      menuEntries={index === 0 ? [{ type: 'destructive', label: 'Remove', onSelect: () => {} }] : undefined}
    />
  ));
const meta = {
  title: 'Components/Cover Card',
  component: CoverCard,
  decorators: [withSurface],
  args: { href: '/book', title: subjects[0]!.title, cover: { subject: subjects[0]!, cover: null, src: () => '' } },
} satisfies Meta<typeof CoverCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Grid: Story = {
  render: () => <CoverGrid ratio={ratio}>{cards()}</CoverGrid>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const container = canvasElement.querySelector<HTMLElement>('.\\@container')!;
    container.style.width = '390px';
    const articles = [...canvasElement.querySelectorAll('article')];
    await expect(articles[0]!.getBoundingClientRect().top).toBe(articles[1]!.getBoundingClientRect().top);
    await expect(articles[2]!.getBoundingClientRect().top).toBeGreaterThan(articles[0]!.getBoundingClientRect().top);
    container.style.width = '1280px';
    await expect(articles[2]!.getBoundingClientRect().top).toBe(articles[0]!.getBoundingClientRect().top);
    container.style.width = '';
    const ratios = articles.map((article) => article.querySelector('[data-slot=cover]')?.getAttribute('data-ratio'));
    await expect(ratios).toEqual(['3:4', '1:1', '3:4', '1:1']);
    const articleRadius = getComputedStyle(articles[0]!).borderTopLeftRadius;
    const frame = articles[0]!.querySelector('[data-slot=aspect-ratio]')!;
    const frameRadius = getComputedStyle(frame).borderTopLeftRadius;
    await expect(articleRadius).toBe('0px');
    await expect(frameRadius).not.toBe('0px');
    await expect(getComputedStyle(frame).borderTopRightRadius).toBe(frameRadius);
    await expect(getComputedStyle(frame).borderBottomLeftRadius).toBe(frameRadius);
    await expect(getComputedStyle(frame).borderBottomRightRadius).toBe(frameRadius);
    const titleLink = within(articles[0]!).getByRole('link');
    for (const slot of ['cover', 'cover-card-secondary']) {
      const box = articles[0]!.querySelector(`[data-slot=${slot}]`)!.getBoundingClientRect();
      await expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(titleLink);
    }
    const button = canvas.getByRole('button', { name: /More actions for/ });
    await userEvent.click(button);
    await expect(
      within(await settled(await screen.findByRole('menu'))).getByRole('menuitem', { name: 'Remove' }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await dismissed('menu');
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect(
      within(await settled(await screen.findByRole('menu'))).getByRole('menuitem', { name: 'Remove' }),
    ).toBeVisible();
  },
};
export const Row: Story = {
  parameters: { padded: false },
  render: () => (
    <CoverRow ratio={ratio} label="Continue">
      {cards()}
    </CoverRow>
  ),
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Continue' });
    await expect(region).toHaveAttribute('tabindex', '0');
    region.style.width = '390px';
    const cards = region.querySelectorAll('article');
    const rowRadius = getComputedStyle(region).borderTopLeftRadius;
    const frameRadius = getComputedStyle(cards[0]!.querySelector('[data-slot=aspect-ratio]')!).borderTopLeftRadius;
    await expect(rowRadius).toBe(frameRadius);
    const third = cards[2]!.getBoundingClientRect();
    await expect(region.getBoundingClientRect().right - third.left).toBeGreaterThan(third.width / 2);
    region.style.width = '';
  },
};

export const Shelf: Story = {
  render: () => (
    <div className="space-y-6">
      {(['small', 'medium', 'large'] as const).map((density) => (
        <CoverGrid key={density} ratio="2:3" density={density}>
          {subjects.map((subject, index) => (
            <CoverCard
              key={subject.id}
              href={`/${subject.id}`}
              title={subject.title}
              cover={{ subject, cover: null, src: () => '' }}
              status={{ label: 'Reading' }}
              badge={<span className="rounded bg-primary px-1 text-xs text-primary-foreground">2</span>}
              meta="Finished yesterday"
              progress={{ value: 0.42, label: '42%' }}
              selectable={index === 1}
              selected={index === 1}
              onSelectedChange={() => {}}
              onSelect={() => {}}
            />
          ))}
        </CoverGrid>
      ))}
    </div>
  ),
};

function SelectionExample() {
  const [selectable, setSelectable] = useState(false);
  const [selected, setSelected] = useState(false);
  return (
    <CoverGrid ratio="2:3" density="medium">
      <CoverCard
        href="/book"
        title="A book"
        cover={{ subject: subjects[0]!, cover: null, src: () => '' }}
        status={{ label: 'Reading' }}
        selectable={selectable}
        selected={selected}
        onSelect={() => {
          setSelectable(true);
          setSelected(true);
        }}
        onSelectedChange={setSelected}
      />
    </CoverGrid>
  );
}
export const Selection: Story = {
  render: () => <SelectionExample />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const article = canvasElement.querySelector('article')!;
    await userEvent.hover(article);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'A book' }));
    const control = canvas.getByRole('button', { name: 'A book' });
    await expect(control).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Tab}');
    control.focus();
    await userEvent.keyboard('{Enter}');
    await expect(control).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(control);
    await expect(control).toHaveAttribute('aria-pressed', 'true');
  },
};

const statusCards = () => (
  <CoverGrid ratio="2:3" density="medium">
    <CoverCard
      href="/book"
      title="A book with status and progress"
      cover={{ subject: subjects[0]!, cover: null, src: () => '' }}
      status={{ label: 'In progress', href: '/library?status=active' }}
      progress={{ value: 0.4, label: '40%' }}
      menuEntries={[{ type: 'destructive', label: 'Remove', onSelect: () => {} }]}
    />
    <CoverCard
      href="/album"
      title="A tile without status or progress"
      cover={{ subject: subjects[1]!, cover: null, src: () => '' }}
    />
    <CoverCard
      href="/other"
      title="Long localized status"
      cover={{ subject: subjects[2]!, cover: null, src: () => '' }}
      status={{ label: '非常に長い翻訳済みのライブラリ状態ラベルを一行で省略します' }}
      progress={{ value: null, label: 'Ep 3/12' }}
    />
    <CoverCard
      href="/four"
      title="Planned without progress"
      cover={{ subject: subjects[3]!, cover: null, src: () => '' }}
      status={{ label: 'Planned', href: '/library?status=planned' }}
    />
  </CoverGrid>
);

export const Status: Story = {
  render: () => statusCards(),
  async play({ canvasElement }) {
    const cards = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="cover-card"]')];
    const first = cards[0]!;
    const statusLink = first.querySelector<HTMLAnchorElement>('[data-slot="cover-card-status"]')!;
    const titleLink = first.querySelector<HTMLAnchorElement>('[data-slot="cover-card-title"]')!;
    await expect(first.querySelectorAll('[data-slot="cover-card-status"]')).toHaveLength(1);
    await expect(statusLink).toHaveAttribute('href', '/library?status=active');
    await expect(statusLink.closest('[data-slot="cover-card-title"]')).toBeNull();
    await expect(cards[1]!.querySelector('[data-slot="cover-card-status-row"]')).toBeNull();
    await expect(statusLink.className).toContain('text-muted-foreground');
    const color = getComputedStyle(statusLink).color;
    await expect(color).toBeTruthy();
    await expect(statusLink.className).not.toContain('text-primary');
    await expect(statusLink.className).not.toContain('bg-primary');
    const brandProbe = document.createElement('span');
    brandProbe.className = 'text-primary';
    canvasElement.append(brandProbe);
    const brandColor = getComputedStyle(brandProbe).color;
    brandProbe.remove();
    await expect(color).not.toBe(brandColor);
    const longStatus = cards[2]!.querySelector<HTMLElement>('[data-slot="cover-card-status"]')!;
    const longCard = cards[2]!;
    longCard.parentElement!.style.width = '390px';
    await expect(longStatus.scrollWidth).toBeGreaterThan(longStatus.clientWidth);
    await expect(longStatus.clientWidth).toBeLessThan(longCard.clientWidth);
    longCard.parentElement!.style.width = '';
    titleLink.focus();
    await userEvent.tab();
    await expect(document.activeElement).toBe(statusLink);
    await userEvent.tab();
    await expect(document.activeElement).toBe(first.querySelector('button'));

    const container = canvasElement.querySelector<HTMLElement>('.\\@container')!;
    for (const width of [390, 1280]) {
      container.style.width = `${width}px`;
      const rows = new Map<number, number[]>();
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        const top = Math.round(rect.top);
        rows.set(top, [...(rows.get(top) ?? []), rect.height]);
      }
      await expect([...rows.values()].every((heights) => Math.max(...heights) - Math.min(...heights) < 1)).toBe(true);
    }
    container.style.width = '';
  },
};

export const Density: Story = {
  render: () => (
    <div>
      {(['small', 'medium', 'large'] as const).map((density) => (
        <CoverGrid key={density} ratio="2:3" density={density}>
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} />
          ))}
        </CoverGrid>
      ))}
    </div>
  ),
  async play({ canvasElement }) {
    const widths = [390, 800, 1100, 1400, 1600];
    const counts = [
      [2, 5, 8, 10, 11],
      [2, 5, 7, 9, 10],
      [2, 4, 6, 8, 9],
    ];
    const containers = canvasElement.querySelectorAll<HTMLElement>('.\\@container');
    for (let density = 0; density < containers.length; density++) {
      for (let index = 0; index < widths.length; index++) {
        containers[density]!.style.width = `${widths[index]}px`;
        const grid = containers[density]!.firstElementChild!;
        await expect(getComputedStyle(grid).gridTemplateColumns.split(' ').length).toBe(counts[density]![index]);
      }
    }
  },
};

const placeholderSubjects = [
  { id: 'norwegian', title: 'Norwegian Wood', types: ['schema:Book'] },
  { id: 'single-word', title: 'Supercalifragilisticexpialidocious', types: ['schema:Book'] },
  subjects[0]!,
  subjects[1]!,
  subjects[2]!,
  subjects[3]!,
];
const sampleImage =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#435c67"/><circle cx="100" cy="100" r="48" fill="#e2d3af"/></svg>',
  );

/** The phone grid widths, including the two word-boundary regressions and each last-row combination. */
export const SharedPlaceholders: Story = {
  render: () => (
    <div className="w-[390px] max-w-full space-y-8">
      {(['small', 'medium', 'large'] as const).map((density) => (
        <section key={density} data-density={density} className="space-y-2">
          <h2>{density}</h2>
          <CoverGrid ratio="2:3" density={density} fixedDensity>
            {placeholderSubjects.map((subject, index) => (
              <CoverCard
                key={subject.id}
                title={subject.title}
                href={`/${subject.id}`}
                cover={{
                  subject,
                  cover:
                    index === 4
                      ? {
                          media: 'sample',
                          focalPoint: null,
                          credit: null,
                          width: 200,
                          height: 300,
                          placeholder: { color: '#435c67', thumbhash: '' },
                          variants: [{ format: 'webp', width: 320 }],
                        }
                      : null,
                  src: () => sampleImage,
                }}
                meta={index % 2 === 0 ? 'Finished yesterday' : undefined}
                state={index === 1 || index === 5 ? 'Reading' : undefined}
                progress={index === 0 ? { value: 0.42, label: '42%' } : undefined}
                menuEntries={index < 3 ? [{ type: 'item', label: 'Remove', onSelect: () => {} }] : undefined}
              />
            ))}
          </CoverGrid>
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    await document.fonts.ready;
    for (const section of canvasElement.querySelectorAll('section')) {
      const tiles = [...section.querySelectorAll('article')];
      for (const tile of tiles) {
        const row = tile.querySelector('[data-slot=cover-card-actions-row]');
        if (row)
          await expect(Math.abs(row.getBoundingClientRect().bottom - tile.getBoundingClientRect().bottom)).toBeLessThan(
            1,
          );
        const title = tile.querySelector<HTMLElement>('[data-slot=cover-placeholder-title]');
        if (!title) continue;
        await expect(getComputedStyle(title).wordBreak).toBe('normal');
        await expect(getComputedStyle(title).overflowWrap).toBe('normal');
        if (title.textContent === 'Norwegian Wood' || title.textContent === 'Supercalifragilisticexpialidocious') {
          const range = document.createRange();
          range.setStart(title.firstChild!, 0);
          range.setEnd(title.firstChild!, title.textContent.indexOf(' ') < 0 ? title.textContent.length : 9);
          const rects = [...range.getClientRects()];
          await expect(rects.every((rect) => Math.abs(rect.top - rects[0]!.top) < 1)).toBe(true);
          await expect(rects[0]!.width).toBeLessThanOrEqual(title.clientWidth + 1);
        }
      }
      for (const tile of tiles) {
        const top = tile.getBoundingClientRect().top;
        const peers = tiles.filter((peer) => Math.abs(peer.getBoundingClientRect().top - top) < 1);
        await expect(
          peers.every(
            (peer) => Math.abs(peer.getBoundingClientRect().bottom - tile.getBoundingClientRect().bottom) < 1,
          ),
        ).toBe(true);
      }
    }
    await waitFor(() => expect(canvasElement.querySelector('[data-state=loading]')).toBeNull());
  },
};
