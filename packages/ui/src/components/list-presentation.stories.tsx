import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { fallbackListPresentation, type CoverSubject, type CoverSummary } from './cover.tsx';
import { CoverCard, CoverGrid } from './cover-card.tsx';
import { MemberListRow } from './list-presentation.tsx';
import { withSurface } from '../stories/support.tsx';

const book: CoverSubject = { id: 'list-book', title: 'The Little Prince', types: ['schema:Book'] };
const movie: CoverSubject = { id: 'list-movie', title: 'The Red Turtle', types: ['schema:Movie'] };
const anime: CoverSubject = { id: 'list-anime', title: 'My Neighbor Totoro', types: ['rezics:AnimeRelease'] };
const music: CoverSubject = { id: 'list-music', title: 'Kind of Blue', types: ['schema:MusicAlbum'] };
const recipe: CoverSubject = { id: 'list-recipe', title: 'Miso soup', types: ['schema:Recipe'] };
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

const mixedSubjects = [book, movie, anime, music, recipe] as const;
const mixedRatio = '5:7' as const;

export const Mixed: Story = {
  render: () => (
    <CoverGrid ratio={mixedRatio}>
      {mixedSubjects.map((subject, index) => (
        <CoverCard
          key={subject.id}
          href={`/${subject.id}`}
          title={subject.title}
          secondary={['book', 'film', 'Anime release', 'album', 'recipe'][index]}
          cover={{
            subject,
            cover: summary(subject, fallbackListPresentation(subject.types)?.imageAspect ?? 'square'),
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
    await expect(ratios).toEqual(['3:4', '16:9', '16:9', '1:1', '16:9']);

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

export const UnknownType: Story = {
  render: () => (
    <ul className="max-w-3xl">
      <MemberListRow href="/unknown" subject={unknown} cover={null} src={imageSource} title={unknown.title}>
        <p className="text-sm text-muted-foreground">Type unavailable</p>
      </MemberListRow>
    </ul>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-ratio', '1:1');
    await expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-state', 'placeholder');
  },
};
