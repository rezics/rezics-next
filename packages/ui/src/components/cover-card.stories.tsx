import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { sharedRatio } from './cover.tsx';
import { CoverCard, CoverGrid, CoverRow, type CoverCardLink } from './cover-card.tsx';

const subjects = [
  { id: 'book', title: 'A very long book title that continues over more than two lines', types: ['schema:Book'] },
  { id: 'album', title: '夜空中最亮的星與漫長旅途的故事', types: ['schema:MusicAlbum'] },
  { id: 'other', title: 'A short title', types: ['schema:Book'] },
  { id: 'four', title: '四季', types: ['schema:MusicAlbum'] },
  { id: 'person', title: 'A performer', types: ['schema:Person'] },
  { id: 'organization', title: 'A studio', types: ['schema:Organization'] },
  { id: 'recipe', title: 'Miso soup', types: ['schema:Recipe'] },
  { id: 'screen', title: 'A film with wide artwork', types: ['schema:Movie'] },
];
const ratio = sharedRatio(subjects);
const cards = () =>
  subjects.map((subject, index) => (
    <CoverCard
      key={subject.id}
      href={`/${subject.id}`}
      title={subject.title}
      titleLang={index % 2 ? 'zh' : 'en'}
      cover={{
        subject,
        cover:
          subject.id === 'screen'
            ? {
                media: 'wide-film',
                width: 1600,
                height: 900,
                variants: [{ format: 'webp', width: 640 }],
                placeholder: { color: '#435c67', thumbhash: '' },
                focalPoint: null,
                credit: null,
              }
            : null,
        src: () =>
          'data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#435c67"/><circle cx="800" cy="450" r="300" fill="#e2d3af"/></svg>',
          ),
      }}
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
    await expect(ratios).toEqual(subjects.map(() => '5:7'));
    await expect(articles[7]!.querySelector('[data-slot=cover]')).toHaveAttribute('data-fit', 'contain');
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
  const [destinationCount, setDestinationCount] = useState(0);
  const [selectionCount, setSelectionCount] = useState(0);
  return (
    <div className="space-y-3">
      <CoverGrid ratio="2:3" density="medium">
        <CoverCard
          href="/book"
          title="A book"
          cover={{ subject: subjects[0]!, cover: null, src: () => '' }}
          status={{ label: 'Reading' }}
          selectable={selectable}
          selected={selected}
          onSelect={() => {
            setSelectionCount((count) => count + 1);
            setSelectable(true);
            setSelected(true);
          }}
          onSelectedChange={setSelected}
          onClick={(event) => {
            event.preventDefault();
            setDestinationCount((count) => count + 1);
          }}
        />
      </CoverGrid>
      <p role="status">
        Primary destinations: {destinationCount}; selection actions: {selectionCount}
      </p>
    </div>
  );
}
export const Selection: Story = {
  render: () => <SelectionExample />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const article = canvasElement.querySelector('article')!;
    await userEvent.hover(article);
    await userEvent.click(canvas.getByRole('link', { name: 'A book' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Primary destinations: 1; selection actions: 0');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'A book' }));
    const control = canvas.getByRole('button', { name: 'A book' });
    await expect(canvas.getByRole('status')).toHaveTextContent('Primary destinations: 1; selection actions: 1');
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

function IndependentControlsExample() {
  const [followed, setFollowed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [metadataChecks, setMetadataChecks] = useState(0);
  const [selectionActionCount, setSelectionActionCount] = useState(0);
  return (
    <div className="space-y-3">
      <CoverGrid ratio="2:3" density="small">
        <CoverCard
          href="/works/independent"
          title="A work with independent controls"
          cover={{ subject: subjects[0]!, cover: null, src: () => '' }}
          secondary={
            <>
              <a href="/series/stars" onClick={(event) => event.preventDefault()}>
                The Stars series
              </a>{' '}
              <button type="button" onClick={() => setFollowed((value) => !value)}>
                Follow series
              </button>
              <details>
                <summary>Read supplied note</summary>
                <p>The full supplied note stays available after opening this disclosure.</p>
              </details>
            </>
          }
          state={
            <div className="flex min-w-0 flex-col items-start gap-1">
              <label>
                <input type="checkbox" /> Keep this note private
              </label>
              <select aria-label="Note visibility" defaultValue="private">
                <option value="private">Private</option>
                <option value="shared">Shared</option>
              </select>
              <textarea aria-label="Personal note" defaultValue="" />
              <button type="button" onClick={() => setSaved(true)}>
                Save note
              </button>
            </div>
          }
        />
        <CoverCard
          href="/works/metadata"
          title="A work with supplied metadata"
          cover={{ subject: subjects[1]!, cover: null, src: () => '' }}
          meta={
            <>
              <a href="/people/editor" onClick={(event) => event.preventDefault()}>
                Editor profile
              </a>{' '}
              <button type="button" onClick={() => setMetadataChecks((count) => count + 1)}>
                Check metadata
              </button>
            </>
          }
          state={<button type="button">Refresh supplied status</button>}
        />
        <CoverCard
          href="/works/selection"
          title="Selection keeps controls available"
          cover={{ subject: subjects[2]!, cover: null, src: () => '' }}
          selectable
          selected
          onSelectedChange={() => setSelectionActionCount((count) => count + 1)}
          secondary={<button type="button">Open independent action</button>}
        />
        <CoverCard title="No destination is available" cover={{ subject: subjects[3]!, cover: null, src: () => '' }} />
      </CoverGrid>
      <p role="status">
        Followed: {String(followed)}; saved: {String(saved)}; metadata checks: {metadataChecks}; selection actions:{' '}
        {selectionActionCount}
      </p>
    </div>
  );
}

export const IndependentControls: Story = {
  render: () => <IndependentControlsExample />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const independent = canvas.getByRole('heading', { name: 'A work with independent controls' }).closest('article')!;
    const note = within(independent).getByText('Read supplied note');
    await userEvent.click(within(independent).getByRole('link', { name: 'The Stars series' }));
    await expect(within(independent).getByRole('link', { name: 'The Stars series' })).toHaveAttribute(
      'href',
      '/series/stars',
    );
    await userEvent.click(within(independent).getByRole('button', { name: 'Follow series' }));
    await userEvent.click(note);
    await expect(note.closest('details')).toHaveProperty('open', true);
    const privacy = within(independent).getByRole('checkbox', { name: 'Keep this note private' });
    await userEvent.click(privacy);
    await expect(privacy).toBeChecked();
    await userEvent.selectOptions(within(independent).getByRole('combobox', { name: 'Note visibility' }), 'shared');
    await userEvent.type(within(independent).getByRole('textbox', { name: 'Personal note' }), 'One personal note');
    await userEvent.click(within(independent).getByRole('button', { name: 'Save note' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Followed: true; saved: true');

    const metadata = canvas.getByRole('heading', { name: 'A work with supplied metadata' }).closest('article')!;
    await userEvent.click(within(metadata).getByRole('link', { name: 'Editor profile' }));
    await userEvent.click(within(metadata).getByRole('button', { name: 'Check metadata' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('metadata checks: 1');

    const selected = canvas.getByRole('heading', { name: 'Selection keeps controls available' }).closest('article')!;
    await userEvent.click(within(selected).getByRole('button', { name: 'Open independent action' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('selection actions: 0');
    const unavailable = canvas.getByRole('heading', { name: 'No destination is available' }).closest('article')!;
    await expect(within(unavailable).queryByRole('link')).toBeNull();
    await expect(within(unavailable).getByText('No destination is available')).toBeVisible();
  },
};

const CompatibilityLink: CoverCardLink = ({ href, children, ...props }) => (
  <a href={href} {...props}>
    {children}
  </a>
);

function ComposedCompatibilityExample() {
  const [selected, setSelected] = useState(false);
  const [selectionCount, setSelectionCount] = useState(0);

  return (
    <div className="space-y-8">
      <CoverGrid ratio="2:3" density="medium">
        <CoverCard
          href="/works/book"
          link={CompatibilityLink}
          title="A translated work"
          titleLang="ja"
          linkLabel="Continue A translated work"
          cover={{ subject: subjects[0]!, cover: null, src: () => '' }}
          status={{ label: 'Reading', href: '/library/book' }}
          progress={{ value: null, label: 'Progress unknown' }}
          menuEntries={[{ type: 'item', label: 'Remove', onSelect: () => {} }]}
        />
        <CoverCard
          href="/works/selected"
          title="Selectable work"
          cover={{ subject: subjects[1]!, cover: null, src: () => '' }}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
        />
      </CoverGrid>

      <CoverRow ratio="2:3" label="Qualified credits">
        <CoverCard
          href="/works/qualified"
          link={CompatibilityLink}
          title="Qualified work"
          cover={{ subject: subjects[2]!, cover: null, src: () => '' }}
          essentialCredit={
            <ul className="flex min-w-0 flex-col gap-1 text-sm leading-6">
              <li>
                Writer: <a href="/people/author">A. Author</a>
              </li>
              <li>
                Character: <a href="/subjects/character">Mira</a>
              </li>
            </ul>
          }
          status={{ label: 'Credited', href: '/credits' }}
          menuEntries={[{ type: 'item', label: 'Edit credit', onSelect: () => {} }]}
          onSelect={() => setSelectionCount((count) => count + 1)}
        />
      </CoverRow>
      <p role="status">Separate selection actions: {selectionCount}</p>
    </div>
  );
}

export const ComposedCompatibility: Story = {
  render: () => <ComposedCompatibilityExample />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const linkedArticle = canvas.getByRole('heading', { name: 'A translated work' }).closest('article')!;
    const titleLink = within(linkedArticle).getByRole('link', { name: 'Continue A translated work' });
    const statusLink = within(linkedArticle).getByRole('link', { name: 'Reading' });
    await expect(titleLink).toHaveAttribute('href', '/works/book');
    await expect(titleLink.tagName).toBe('A');
    await expect(titleLink.querySelector('a, button, input')).toBeNull();
    await expect(statusLink).toHaveAttribute('href', '/library/book');
    await expect(titleLink.contains(statusLink)).toBe(false);
    titleLink.focus();
    await userEvent.tab();
    await expect(statusLink).toHaveFocus();

    const menuButton = within(linkedArticle).getByRole('button', {
      name: 'More actions for A translated work',
    });
    await expect(menuButton.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await userEvent.click(menuButton);
    await expect(
      within(await settled(await screen.findByRole('menu'))).getByRole('menuitem', { name: 'Remove' }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await dismissed('menu');

    const selectionButton = canvas.getByRole('button', { name: 'Selectable work' });
    await expect(selectionButton).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(selectionButton);
    await expect(selectionButton).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(selectionButton);
    await expect(selectionButton).toHaveAttribute('aria-pressed', 'false');

    const creditArticle = canvas.getByRole('heading', { name: 'Qualified work' }).closest('article')!;
    const creditTitle = within(creditArticle).getByRole('link', { name: 'Qualified work' });
    const writerLink = within(creditArticle).getByRole('link', { name: 'A. Author' });
    const checkbox = within(creditArticle).getByRole('checkbox', { name: 'Qualified work' });
    await expect(writerLink).toHaveAttribute('href', '/people/author');
    await expect(creditTitle.querySelector('a, button, input')).toBeNull();
    await expect(checkbox.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    creditTitle.focus();
    await userEvent.tab();
    await expect(writerLink).toHaveFocus();
    await userEvent.click(checkbox);
    await expect(canvas.getByRole('status')).toHaveTextContent('Separate selection actions: 1');
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
