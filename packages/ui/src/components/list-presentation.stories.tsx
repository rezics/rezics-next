import type { Meta, StoryObj } from '@storybook/react-vite';
import { useId, useState, type ReactNode } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { fallbackListPresentation, type CoverSubject, type CoverSummary } from './cover.tsx';
import { CoverCard, CoverGrid } from './cover-card.tsx';
import { MemberListRow, MemberReadingDetail, MemberReadingItem } from './list-presentation.tsx';
import { withSurface } from '../stories/support.tsx';

const book: CoverSubject = { id: 'list-book', title: 'The Little Prince', types: ['schema:Book'] };
const movie: CoverSubject = { id: 'list-movie', title: 'The Red Turtle', types: ['schema:Movie'] };
const anime: CoverSubject = { id: 'list-anime', title: 'My Neighbor Totoro', types: ['rezics:AnimeRelease'] };
const music: CoverSubject = { id: 'list-music', title: 'Kind of Blue', types: ['schema:MusicAlbum'] };
const recipe: CoverSubject = { id: 'list-recipe', title: 'Miso soup', types: ['schema:Recipe'] };
const person: CoverSubject = { id: 'list-person', title: 'A performer', types: ['schema:Person'] };
const organization: CoverSubject = { id: 'list-organization', title: 'A studio', types: ['schema:Organization'] };
const unknown: CoverSubject = { id: 'list-unknown', title: 'Unclassified work', types: ['type:NotReleased'] };

function summary(subject: CoverSubject, aspect: 'portrait' | 'landscape' | 'square', withheld = false): CoverSummary {
  const [width, height] = aspect === 'portrait' ? [900, 1200] : aspect === 'landscape' ? [1600, 900] : [1000, 1000];
  return {
    media: subject.id,
    width,
    height,
    placeholder: { thumbhash: '', color: '#465c72' },
    variants: [{ format: 'webp', width: 640 }],
    focalPoint: null,
    credit: null,
    ...(withheld ? { withheld: 'suitability' as const } : {}),
  };
}

function imageSource(media: string) {
  const shape: [number, number] = media.includes('music')
    ? [1000, 1000]
    : media.includes('movie') || media.includes('anime') || media.includes('recipe')
      ? [1600, 900]
      : [900, 1200];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${shape[0]} ${shape[1]}"><rect width="${shape[0]}" height="${shape[1]}" fill="#465c72"/><circle cx="${shape[0] * 0.68}" cy="${shape[1] * 0.34}" r="${Math.min(...shape) * 0.2}" fill="#d5c39c"/><path d="M0 ${shape[1] * 0.8} Q ${shape[0] * 0.45} ${shape[1] * 0.58} ${shape[0]} ${shape[1] * 0.82} V ${shape[1]} H0Z" fill="#243947"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const meta = {
  title: 'Components/List Presentation',
  component: MemberListRow,
  args: { href: '/book', subject: book, cover: null, src: imageSource, title: book.title },
  decorators: [withSurface],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof MemberListRow>;
export default meta;
type Story = StoryObj<typeof meta>;

function Row({
  subject,
  aspect,
  withheld = false,
  children,
}: {
  subject: CoverSubject;
  aspect: 'portrait' | 'landscape' | 'square';
  withheld?: boolean;
  children?: ReactNode;
}) {
  const listPresentation = fallbackListPresentation(subject.types);
  return (
    <MemberListRow
      href={`/${subject.id}`}
      subject={subject}
      cover={summary(subject, aspect, withheld)}
      src={imageSource}
      title={subject.title}
      {...(listPresentation ? { listPresentation } : {})}
    >
      {children}
    </MemberListRow>
  );
}

export const Book: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <Row subject={book} aspect="portrait">
        <p className="text-sm text-muted-foreground">book</p>
      </Row>
    </ul>
  ),
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: book.title });
    await userEvent.click(canvasElement);
    await userEvent.tab();
    await expect(link).toHaveFocus();
  },
};

export const Video: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <Row subject={movie} aspect="landscape">
        <p className="text-sm text-muted-foreground">film</p>
      </Row>
    </ul>
  ),
};

export const Anime: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <Row subject={anime} aspect="landscape">
        <p className="text-sm text-muted-foreground">Anime release</p>
      </Row>
    </ul>
  ),
};

export const Music: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <Row subject={music} aspect="square">
        <p className="text-sm text-muted-foreground">album</p>
      </Row>
    </ul>
  ),
};

export const Recipe: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <Row subject={recipe} aspect="landscape">
        <p className="text-sm text-muted-foreground">recipe</p>
      </Row>
    </ul>
  ),
};

const mixedSubjects = [
  { subject: book, aspect: 'portrait', label: 'book' },
  { subject: movie, aspect: 'landscape', label: 'film' },
  { subject: anime, aspect: 'landscape', label: 'Anime release' },
  { subject: music, aspect: 'square', label: 'album' },
  { subject: person, aspect: 'portrait', label: 'person' },
  { subject: organization, aspect: null, label: 'organization' },
  { subject: recipe, aspect: 'landscape', label: 'recipe' },
  { subject: unknown, aspect: null, label: 'Type unavailable' },
] as const;
const mixedRatio = '5:7' as const;

export const Mixed: Story = {
  render: () => (
    <CoverGrid ratio={mixedRatio}>
      {mixedSubjects.map(({ subject, aspect, label }, index) => (
        <CoverCard
          key={subject.id}
          href={`/${subject.id}`}
          title={subject.title}
          secondary={label}
          cover={{
            subject,
            cover: aspect ? summary(subject, aspect) : null,
            src: imageSource,
          }}
          {...(index === 0
            ? { menuEntries: [{ type: 'item' as const, label: 'Inspect menu', onSelect: () => {} }] }
            : {})}
        />
      ))}
    </CoverGrid>
  ),
  async play({ canvasElement }) {
    const cards = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="cover-card"]')];
    const ratios = cards.map((card) => card.querySelector('[data-slot="cover"]')?.getAttribute('data-ratio'));
    await expect(ratios).toEqual(mixedSubjects.map(() => '5:7'));
    for (const index of [1, 2, 3, 6]) {
      await expect(cards[index]!.querySelector('[data-slot="cover"]')).toHaveAttribute('data-fit', 'contain');
      await expect(cards[index]!.querySelector('img')).toHaveClass('object-contain');
    }
    await expect(cards[5]!.querySelector('[data-slot="cover"]')).toHaveAttribute('data-state', 'placeholder');

    const trigger = within(cards[0]!).getByRole('button', { name: 'More actions for The Little Prince' });
    await userEvent.click(trigger);
    const dialog = screen.queryByRole('dialog');
    if (dialog) {
      await expect(within(dialog).getByRole('button', { name: 'Inspect menu' })).toBeVisible();
      await userEvent.keyboard('{Escape}');
    } else {
      await expect(await screen.findByRole('menu')).toBeVisible();
      await expect(screen.getByRole('menuitem', { name: 'Inspect menu' })).toBeVisible();
      await userEvent.keyboard('{Escape}');
    }
    await expect(trigger).toHaveFocus();
  },
};

export const MissingImage: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <MemberListRow href="/missing" subject={book} cover={null} src={imageSource} title={book.title}>
        <p className="text-sm text-muted-foreground">book</p>
      </MemberListRow>
    </ul>
  ),
};

export const Withheld: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <Row subject={anime} aspect="landscape" withheld>
        <p className="text-sm text-muted-foreground">Anime release</p>
      </Row>
    </ul>
  ),
  async play({ canvasElement }) {
    const button = within(canvasElement).getByRole('button', { name: 'Show cover' });
    const frame = canvasElement.querySelector('[data-slot="cover"]');
    await expect(frame).toHaveAttribute('data-state', 'withheld');
    await expect(canvasElement.querySelector('img')).toBeNull();
    await userEvent.click(button);
    await expect(frame).toHaveAttribute('data-state', 'loaded');
  },
};

export const KeyFacts: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <MemberListRow
        href="/book"
        subject={book}
        cover={null}
        src={imageSource}
        title={book.title}
        listPresentation={{ imageAspect: 'portrait', keyFacts: ['schema:genre'] }}
      >
        <p className="text-sm text-muted-foreground" data-property="schema:genre">
          Fable
        </p>
      </MemberListRow>
    </ul>
  ),
};

export const IntegratedMember: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <MemberListRow
        href="/book"
        subject={book}
        cover={summary(book, 'landscape')}
        src={imageSource}
        title={book.title}
        titleLang="en"
        listPresentation={{ imageAspect: 'landscape', keyFacts: ['schema:genre'] }}
        ratio="5:7"
        storyOverlay
        trailing={<button type="button">More actions</button>}
      >
        <p data-slot="member-list-row-facts" className="text-sm">
          Genre: <a href="/genres/fantasy">Fantasy</a>
        </p>
      </MemberListRow>
    </ul>
  ),
  async play({ canvasElement }) {
    await expect(canvasElement.querySelector('[data-overlay="visible"]')).not.toBeNull();
    await expect(within(canvasElement).getByRole('heading', { name: book.title })).toBeVisible();
    await expect(within(canvasElement).getByRole('link', { name: book.title })).toHaveAttribute('href', '/book');
    await expect(within(canvasElement).getByRole('link', { name: 'Fantasy' })).toHaveAttribute(
      'href',
      '/genres/fantasy',
    );
    await expect(within(canvasElement).getByRole('button', { name: 'More actions' })).toBeVisible();
  },
};

const readingExamples = [
  {
    id: 'covered-occurrence',
    subject: book,
    title: book.title,
    cover: summary(book, 'portrait'),
    metadata: 'A supplied fact in the covered tile.',
    note: 'A long supplied note. ' + 'The full occurrence remains in the reading sequence. '.repeat(16).trim(),
  },
  {
    id: 'placeholder-occurrence',
    subject: book,
    title: book.title,
    cover: null,
    metadata: 'A repeated Subject with a different occurrence and its own supplied summary.',
    note: 'The second occurrence has independent supplied details.',
  },
  {
    id: 'unavailable-occurrence',
    subject: null,
    title: 'An unavailable member with a deliberately long title',
    cover: null,
    metadata: 'No subject was supplied for this occurrence.',
    note: 'The supplied occurrence note is still available.',
  },
];

function CollectionReadingExample({ layout }: { layout: 'list' | 'grid' }) {
  const detailId = useId();
  const [selection, select] = useState<{ index: number; opener: HTMLButtonElement }>();
  const items = readingExamples.map((member, index) => (
    <MemberReadingItem
      key={member.id}
      layout={layout}
      {...(member.subject
        ? {
            href: `/subjects/${member.subject.id}`,
            cover: { subject: member.subject, cover: member.cover, src: imageSource },
          }
        : {})}
      title={member.title}
      occurrenceId={member.id}
      occurrenceLabel={`${member.title}, item ${index + 1}`}
      position={`Position ${index + 1} on this page`}
      metadata={<p className="text-sm">{member.metadata}</p>}
      evidence={layout === 'grid' ? <p className="text-sm">Action evidence remains visible.</p> : null}
      detailId={detailId}
      expanded={selection?.index === index}
      inspectLabel="Inspect details"
      onInspect={(opener) => select({ index, opener })}
      onClose={() => select(undefined)}
      detail={
        selection?.index === index ? (
          <MemberReadingDetail
            id={detailId}
            title={`${member.title}, item ${index + 1}`}
            closeLabel="Close details"
            opener={selection.opener}
            onClose={() => select(undefined)}
          >
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{member.note}</p>
          </MemberReadingDetail>
        ) : null
      }
    />
  ));
  return (
    <div className={layout === 'grid' ? 'max-w-lg space-y-4' : 'max-w-3xl space-y-4'}>
      {layout === 'grid' ? (
        <div role="list">
          <CoverGrid ratio="5:7">{items}</CoverGrid>
        </div>
      ) : (
        <ul className="divide-y divide-border">{items}</ul>
      )}
      {selection === undefined && <div id={detailId} hidden />}
      <nav aria-label="Collection pages">
        <a href="/collections/next" className="inline-flex min-h-11 items-center rounded-lg border px-3">
          More
        </a>
      </nav>
    </div>
  );
}

async function inspectReadingExamples(canvasElement: HTMLElement, layout: 'list' | 'grid') {
  const items = [
    ...canvasElement.querySelectorAll<HTMLElement>(
      layout === 'grid' ? '[data-slot="collection-member-card"]' : 'ul > li',
    ),
  ];
  await expect(items).toHaveLength(3);
  if (layout === 'grid') {
    await expect(items[0]!.querySelector('[data-slot="cover-card"] [data-slot="cover"]')).not.toBeNull();
    await expect(items[1]!.querySelector('[data-slot="cover-placeholder-title"]')).not.toBeNull();
    await expect(items[2]!.querySelector('[data-slot="cover-card"]')).toBeNull();
  }
  const openers = items.map((item) => item.querySelector<HTMLButtonElement>('[data-collection-detail-opener]')!);
  const more = within(canvasElement).getByRole('link', { name: 'More' });
  const view = canvasElement.ownerDocument.defaultView!;
  for (const [index, item] of items.entries()) {
    const opener = openers[index]!;
    opener.scrollIntoView({ block: 'center' });
    const rect = opener.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    await expect(rect.top).toBeGreaterThanOrEqual(itemRect.top);
    await expect(rect.bottom).toBeLessThanOrEqual(itemRect.bottom + 1);
    const hit = canvasElement.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await expect(hit === opener || opener.contains(hit)).toBe(true);
    const scrollY = view.scrollY;
    if (index === 1) {
      opener.focus();
      await userEvent.keyboard('{Enter}');
    } else {
      await userEvent.pointer([
        { keys: '[MouseLeft>]', target: opener },
        { keys: '[/MouseLeft]', target: opener },
      ]);
    }
    await expect(Math.abs(view.scrollY - scrollY)).toBeLessThanOrEqual(1);
    await expect(opener).toHaveFocus();
    await expect(opener).toHaveAttribute('aria-expanded', 'true');
    const detail = item.querySelector<HTMLElement>('[data-slot="member-reading-detail"]')!;
    await expect(detail).toBeVisible();
    await expect(detail).toHaveTextContent(readingExamples[index]!.note);
    await expect(canvasElement.querySelectorAll('[data-slot="member-reading-detail"]')).toHaveLength(1);
    await expect(detail.getBoundingClientRect().bottom).toBeLessThanOrEqual(item.getBoundingClientRect().bottom + 1);
    await expect(more.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      Math.max(...items.map((current) => current.getBoundingClientRect().bottom)),
    );
    await userEvent.tab();
    await expect(within(detail).getByRole('button', { name: 'Close details' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(opener).toHaveFocus();
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
    await expect(item.querySelector('[data-slot="member-reading-detail"]')).toBeNull();
  }
  more.scrollIntoView({ block: 'center' });
  await expect(more.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    Math.max(...items.map((item) => item.getBoundingClientRect().bottom)),
  );
}

export const CollectionReadingGrid: Story = {
  render: () => <CollectionReadingExample layout="grid" />,
  play: async ({ canvasElement }) => inspectReadingExamples(canvasElement, 'grid'),
};

export const CollectionReadingList: Story = {
  render: () => <CollectionReadingExample layout="list" />,
  play: async ({ canvasElement }) => inspectReadingExamples(canvasElement, 'list'),
};

export const UnknownType: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <MemberListRow href="/unknown" subject={unknown} cover={null} src={imageSource} title={unknown.title}>
        <p className="text-sm text-muted-foreground">Type unavailable</p>
      </MemberListRow>
    </ul>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-ratio', '5:7');
    await expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-state', 'placeholder');
  },
};
