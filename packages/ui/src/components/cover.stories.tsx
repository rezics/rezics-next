import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { Cover, sharedRatio, type CoverRatio, type CoverSize, type CoverSubject, type CoverSummary } from './cover.tsx';

// Every image is an inline SVG, so stories never depend on the network. The media id is a name in `shapes`.
const shapes = new Map<string, { width: number; height: number; hue: number }>();

function art(media: string) {
  const { width, height, hue } = shapes.get(media) ?? { width: 2, height: 3, hue: 200 };
  const unit = Math.min(width, height);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 55% 30%)"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/><circle cx="${width * 0.66}" cy="${height * 0.34}" r="${unit * 0.22}" fill="hsl(${hue} 80% 90%)" opacity="0.85"/><path d="M0 ${height * 0.78} Q ${width * 0.4} ${height * 0.6} ${width} ${height * 0.82} V ${height} H 0 Z" fill="hsl(${hue} 40% 18%)" opacity="0.7"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const artSrc = (media: string) => art(media);
// An undecodable image: the browser fires an error event, offline and at once.
const brokenSrc = () => 'data:image/png;base64,AAAA';

let counter = 0;
function summary(width: number, height: number, extra: Partial<CoverSummary> = {}): CoverSummary {
  const media = `media-${++counter}-${width}x${height}`;
  const hue = (counter * 47) % 360;
  shapes.set(media, { width, height, hue });
  return {
    media,
    width,
    height,
    placeholder: { thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j3A', color: `hsl(${hue} 40% 40%)` },
    variants: [
      { format: 'avif', width: 320 },
      { format: 'avif', width: 640 },
      { format: 'webp', width: 320 },
      { format: 'webp', width: 640 },
    ],
    focalPoint: null,
    credit: {
      rightsHolder: 'Shinchosha',
      via: { name: 'Open Library', url: 'https://openlibrary.org/' },
      license: 'All rights reserved',
    },
    ...extra,
  };
}

const book: CoverSubject = {
  id: '0192-book',
  title: 'The Wind-Up Bird Chronicle',
  types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
  byline: 'Haruki Murakami',
};
const person: CoverSubject = { id: '0192-person', title: 'Kaori Miyazono', types: ['wd:Q95074', 'schema:Thing'] };
const album: CoverSubject = {
  id: '0192-album',
  title: 'Kind of Blue',
  types: ['schema:MusicAlbum', 'schema:CreativeWork'],
  byline: 'Miles Davis',
};
const recipe: CoverSubject = {
  id: '0192-recipe',
  title: 'Miso soup with tofu and wakame',
  types: ['schema:Recipe'],
  byline: 'Rezics kitchen',
};
const game: CoverSubject = {
  id: '0192-game',
  title: 'Steins;Gate',
  types: ['wd:Q689445', 'schema:CreativeWork'],
  byline: '5pb. / Nitroplus',
};
const classic: CoverSubject = {
  id: '0192-cjk',
  title: '吾輩は猫である 夏目漱石全集 第一巻 新潮文庫 改版 解説付き',
  types: ['schema:Book', 'schema:CreativeWork'],
  byline: '夏目漱石',
};

const sizes: CoverSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

const meta = {
  title: 'Rezics UI/Cover',
  component: Cover,
  tags: ['autodocs'],
  args: { subject: book, cover: null, size: 'md', src: artSrc },
  parameters: {
    docs: {
      description: {
        component:
          'The image area of any subject, which always renders. The frame takes its ratio from the subject’s type and its width from a named size, so nothing shifts while an image loads, fails or is withheld. A missing, failed or taken-down image shows the typographic placeholder: the title in the Work title face and the byline in the interface face on a colour fixed by the subject. Covers withheld for suitability stay blurred behind a label and a reveal control. Covers at `lg` and larger carry their credit.',
      },
    },
  },
  decorators: [withSurface],
} satisfies Meta<typeof Cover>;
export default meta;
type Story = StoryObj<typeof meta>;

function Row({ label, kind, children }: { label: string; kind: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" data-row={kind}>
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap items-end gap-4">{children}</div>
    </section>
  );
}

function Grid({ className }: { className?: string }) {
  const image = (subject: CoverSubject, size: CoverSize, shape: [number, number]) => (
    <Cover key={size} subject={subject} cover={summary(...shape)} size={size} src={artSrc} />
  );
  return (
    <div className={cn('flex flex-col gap-8', className)}>
      <Row kind="image" label="Image available">
        {sizes.map((size) => image(book, size, [1200, 1800]))}
        <div className="w-28">
          <Cover subject={book} cover={summary(1200, 1800)} size="fill" src={artSrc} />
        </div>
      </Row>
      <Row kind="none" label="No image">
        {sizes.map((size) => (
          <Cover key={size} subject={book} cover={null} size={size} src={artSrc} />
        ))}
        <div className="w-28">
          <Cover subject={book} cover={null} size="fill" src={artSrc} />
        </div>
        <div className="w-12">
          <Cover subject={book} cover={null} size="fill" src={artSrc} />
        </div>
      </Row>
      <Row kind="error" label="Load error">
        {sizes.map((size) => (
          <Cover key={size} subject={person} cover={summary(900, 1200)} size={size} src={brokenSrc} />
        ))}
      </Row>
      <Row kind="withheld" label="Withheld for suitability">
        {sizes.map((size) => (
          <Cover
            key={size}
            subject={game}
            cover={summary(900, 1200, { withheld: 'suitability' })}
            size={size}
            src={artSrc}
          />
        ))}
      </Row>
      <Row kind="down" label="Taken down">
        {sizes.map((size) => (
          <Cover key={size} subject={album} cover={null} size={size} src={artSrc} />
        ))}
      </Row>
      <Row kind="ratios" label="Frame ratios: 5:7, 3:4, 1:1, 4:3">
        <Cover subject={book} cover={summary(1200, 1800)} size="md" src={artSrc} />
        <Cover subject={person} cover={summary(900, 1200)} size="md" src={artSrc} />
        <Cover subject={album} cover={summary(1000, 1000)} size="md" src={artSrc} />
        <Cover subject={recipe} cover={summary(1600, 1200)} size="md" src={artSrc} />
      </Row>
    </div>
  );
}

async function settledCovers(root: HTMLElement) {
  await waitFor(() => {
    for (const element of root.querySelectorAll('[data-row="image"] [data-slot="cover"]'))
      expect(element).toHaveAttribute('data-state', 'loaded');
    for (const element of root.querySelectorAll('[data-row="error"] [data-slot="cover"]'))
      expect(element).toHaveAttribute('data-state', 'placeholder');
  });
}

/** Every state at every size. */
export const States: Story = {
  render: () => <Grid />,
  play: async ({ canvasElement }) => {
    await settledCovers(canvasElement);
    for (const row of ['none', 'error', 'down'])
      for (const cover of canvasElement.querySelectorAll(`[data-row="${row}"] [data-slot="cover"]`))
        expect(cover).toHaveAttribute('data-state', 'placeholder');
    for (const cover of canvasElement.querySelectorAll('[data-row="withheld"] [data-slot="cover"]'))
      expect(cover).toHaveAttribute('data-state', 'withheld');
    expect(canvasElement.querySelector('[data-row="error"] img')).toBeNull();
    // Each cover keeps the ratio of its type: heights follow widths.
    const [portrait, three, square, landscape] = [
      ...canvasElement.querySelectorAll('[data-row="ratios"] [data-slot="cover"]'),
    ].map((element) => element.getBoundingClientRect());
    expect(portrait!.height / portrait!.width).toBeCloseTo(7 / 5, 1);
    expect(three!.height / three!.width).toBeCloseTo(4 / 3, 1);
    expect(square!.height / square!.width).toBeCloseTo(1, 1);
    expect(landscape!.height / landscape!.width).toBeCloseTo(3 / 4, 1);
  },
};

/** The same states in the dark theme. */
export const Dark: Story = {
  render: () => (
    <div className="dark -m-6 bg-background p-6 text-foreground">
      <Grid />
    </div>
  ),
  play: async ({ canvasElement }) => settledCovers(canvasElement),
};

const darkFrame: Decorator = (Story) => (
  <div className="max-w-[390px]">
    <Story />
  </div>
);

/** A phone-width screen: six small covers in a row, and a grid whose `fill` frames shrink to initials. */
export const Phone: Story = {
  parameters: { viewport: { defaultViewport: 'phone' } },
  decorators: [darkFrame],
  render: () => {
    const row = sharedRatio([book, person, album, recipe, game, classic].map((subject) => subject));
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-6 gap-2" data-row="initials">
          {[book, person, album, recipe, game, classic].map((subject) => (
            <Cover key={subject.id} subject={subject} cover={null} size="fill" ratio={row} src={artSrc} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[book, person, album, recipe, game, classic].map((subject) => (
            <Cover
              key={subject.id}
              subject={subject}
              cover={summary(1200, 1800)}
              size="fill"
              ratio={row}
              src={artSrc}
            />
          ))}
        </div>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const first = canvasElement.querySelector('[data-row="initials"] [data-slot="cover"]')!;
    // A frame under 64 px wide shows initials, not a set title.
    await waitFor(() => expect(first.getBoundingClientRect().width).toBeLessThan(64));
    await waitFor(() => expect(within(first as HTMLElement).getByText('TW')).toBeVisible());
  },
};

function Measured({
  id,
  subject,
  size,
  src,
}: {
  id: string;
  subject: CoverSubject;
  size: CoverSize;
  src: typeof artSrc;
}) {
  return (
    <div data-case={id}>
      <Cover subject={subject} cover={summary(1200, 1800)} size={size} src={src} />
    </div>
  );
}

const measures: [string, CoverSubject, number][] = [
  ['book', book, 5 / 7],
  ['character', person, 3 / 4],
  ['album', album, 1],
  ['recipe', recipe, 4 / 3],
];

/**
 * The browser measures the frame of each type before its image loads (the lazy images sit far below the first
 * screen, so they have not started), after it loads and after it fails.
 */
export const FrameKeepsSize: Story = {
  render: () => (
    <div>
      <div className="flex flex-wrap gap-4">
        {measures.map(([id, subject]) => (
          <Measured key={`fail-${id}`} id={`fail-${id}`} subject={subject} size="md" src={brokenSrc} />
        ))}
      </div>
      <div style={{ height: 12000 }} />
      <div className="flex flex-wrap gap-4">
        {measures.map(([id, subject]) => (
          <Measured key={id} id={id} subject={subject} size="md" src={artSrc} />
        ))}
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const cover = (id: string) => canvasElement.querySelector<HTMLElement>(`[data-case="${id}"] [data-slot="cover"]`)!;
    const size = (id: string) => {
      const { width, height } = cover(id).getBoundingClientRect();
      return { width: Math.round(width), height: Math.round(height) };
    };
    const expected = (ratio: number) => ({ width: 160, height: Math.round(160 / ratio) });
    for (const [id, , ratio] of measures) {
      expect(cover(id)).toHaveAttribute('data-state', 'loading');
      expect(size(id)).toEqual(expected(ratio));
    }
    for (const [id, , ratio] of measures) {
      await waitFor(() => expect(cover(`fail-${id}`)).toHaveAttribute('data-state', 'placeholder'));
      expect(size(`fail-${id}`)).toEqual(expected(ratio));
    }
    cover('book').scrollIntoView();
    for (const [id, , ratio] of measures) {
      await waitFor(() => expect(cover(id)).toHaveAttribute('data-state', 'loaded'));
      expect(size(id)).toEqual(expected(ratio));
    }
  },
};

/** A failed image becomes the typographic placeholder: no broken-image icon, the title and byline in its place. */
export const ImageFails: Story = {
  args: { subject: book, cover: summary(1200, 1800), size: 'lg', src: brokenSrc },
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>('[data-slot="cover"]')!;
    await waitFor(() => expect(frame).toHaveAttribute('data-state', 'placeholder'));
    expect(canvasElement.querySelector('img')).toBeNull();
    expect(canvasElement.querySelector('svg')).toBeNull();
    expect(within(frame).getByText('The Wind-Up Bird Chronicle')).toBeVisible();
    expect(within(frame).getByText('Haruki Murakami')).toBeVisible();
  },
};

/** The placeholder never shows a letter or an icon alone, even for long CJK titles, long bylines and no byline. */
export const LongTitles: Story = {
  render: () => (
    <div className="flex flex-col gap-6" data-row="long">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <div key={size} className="flex flex-wrap items-end gap-4">
          <Cover subject={classic} cover={null} size={size} src={artSrc} />
          <Cover
            subject={{
              id: 'long-latin',
              title: 'A Very Long Title That Keeps Going: Being the Complete and Annotated Account of Everything',
              types: ['schema:Book'],
              byline: 'A Contributor With an Exceptionally Long Name and Several Honorifics',
            }}
            cover={null}
            size={size}
            src={artSrc}
          />
          <Cover subject={{ ...person, byline: undefined }} cover={null} size={size} src={artSrc} />
          <Cover subject={{ ...classic, id: 'cjk-2' }} cover={summary(1200, 1800)} size={size} src={brokenSrc} />
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      for (const frame of canvasElement.querySelectorAll('[data-slot="cover"]'))
        expect(frame).toHaveAttribute('data-state', 'placeholder');
    });
    for (const frame of canvasElement.querySelectorAll<HTMLElement>('[data-slot="cover"]')) {
      // Nothing spills out of the frame.
      const box = frame.getBoundingClientRect();
      for (const text of frame.querySelectorAll('p')) {
        const inner = text.getBoundingClientRect();
        expect(inner.right).toBeLessThanOrEqual(box.right + 1);
        expect(inner.bottom).toBeLessThanOrEqual(box.bottom + 1);
      }
    }
  },
};

const mixed: { subject: CoverSubject; shape: [number, number] }[] = [
  { subject: book, shape: [1200, 1800] },
  { subject: game, shape: [1600, 900] },
  { subject: album, shape: [1000, 1000] },
  { subject: person, shape: [900, 1200] },
  { subject: { ...book, id: 'second-book', title: 'Norwegian Wood' }, shape: [1000, 1500] },
];

/** A row that mixes types uses the ratio of most of its items; each image is then fitted to the shared frame. */
export const MixedRow: Story = {
  render: () => {
    const ratio: CoverRatio = sharedRatio(mixed.map((item) => item.subject));
    return (
      <div className="flex flex-wrap items-start gap-4" data-ratio={ratio} data-row="mixed">
        {mixed.map(({ subject, shape }) => (
          <Cover key={subject.id} subject={subject} cover={summary(...shape)} size="md" ratio={ratio} src={artSrc} />
        ))}
        <Cover subject={classic} cover={null} size="md" ratio={ratio} src={artSrc} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector<HTMLElement>('[data-row="mixed"]')!;
    expect(row).toHaveAttribute('data-ratio', '5:7');
    const frames = [...row.querySelectorAll<HTMLElement>('[data-slot="cover"]')];
    await waitFor(() => {
      for (const frame of frames) expect(frame).not.toHaveAttribute('data-state', 'loading');
    });
    for (const frame of frames) {
      expect(frame).toHaveAttribute('data-ratio', '5:7');
      expect(Math.round(frame.getBoundingClientRect().height)).toBe(224);
    }
    // Landscape package art is shown whole; a portrait image fills its frame.
    expect(frames[1]).toHaveAttribute('data-fit', 'contain');
    expect(frames[0]).toHaveAttribute('data-fit', 'cover');
  },
};

/** Covers withheld for suitability stay behind a label and a reveal control until the viewer reveals them. */
export const WithheldReveal: Story = {
  args: { subject: game, cover: summary(900, 1200, { withheld: 'suitability' }), size: 'lg' },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('the cover is blurred behind a label and a control', async () => {
      expect(canvas.getByText('Sensitive cover')).toBeVisible();
      expect(canvasElement.querySelector('img')).toBeNull();
      expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-state', 'withheld');
    });
    await step('revealing shows the image', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Show cover' }));
      await waitFor(() =>
        expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-state', 'loaded'),
      );
      expect(canvas.queryByText('Sensitive cover')).toBeNull();
      expect(canvas.getByRole('img', { name: 'Steins;Gate' })).toBeVisible();
    });
  },
};

/** A viewer who shows such covers sees the image at once. */
export const WithheldShown: Story = {
  args: { subject: game, cover: summary(900, 1200, { withheld: 'suitability' }), size: 'lg', suitability: 'show' },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="cover"]')).toHaveAttribute('data-state', 'loaded'),
    );
    expect(within(canvasElement).queryByRole('button', { name: 'Show cover' })).toBeNull();
  },
};

/** From `lg` the credit is one control away from the cover; a caption prints it for the subject page. */
export const CreditAtLargeSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-8">
      <div data-case="md">
        <Cover subject={book} cover={summary(1200, 1800)} size="md" src={artSrc} />
      </div>
      <div data-case="lg">
        <Cover subject={book} cover={summary(1200, 1800)} size="lg" src={artSrc} />
      </div>
      <div data-case="caption">
        <Cover subject={book} cover={summary(1200, 1800)} size="xl" src={artSrc} caption priority />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const within_ = (id: string) => within(canvasElement.querySelector<HTMLElement>(`[data-case="${id}"]`)!);
    expect(within_('md').queryByRole('button', { name: 'Cover credit' })).toBeNull();
    const caption = within_('caption').getByText(/Shinchosha/);
    expect(caption.closest('figcaption')).not.toBeNull();
    expect(within_('caption').getByRole('link', { name: 'Open Library' })).toHaveAttribute(
      'href',
      'https://openlibrary.org/',
    );
    await userEvent.click(within_('lg').getByRole('button', { name: 'Cover credit' }));
    const popup = await screen.findByRole('dialog');
    await settled(popup);
    expect(within(popup).getByText(/Shinchosha/)).toBeVisible();
    expect(within(popup).getByRole('link', { name: 'Open Library' })).toHaveAttribute(
      'href',
      'https://openlibrary.org/',
    );
    await userEvent.keyboard('{Escape}');
    await dismissed('dialog');
  },
};

/** The page's own cover loads eagerly with high priority; a decorative repeat has empty alt text. */
export const PriorityAndDecorative: Story = {
  render: () => (
    <div className="flex items-start gap-4">
      <div data-case="page">
        <Cover subject={book} cover={summary(1200, 1800)} size="lg" src={artSrc} priority />
      </div>
      <div data-case="repeat">
        <Cover subject={book} cover={summary(1200, 1800)} size="sm" src={artSrc} decorative />
      </div>
      <div data-case="other">
        <Cover subject={book} cover={summary(1200, 1800)} size="sm" src={artSrc} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const image = (id: string) => canvasElement.querySelector<HTMLImageElement>(`[data-case="${id}"] img`)!;
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-case="page"] [data-slot="cover"]')).toHaveAttribute(
        'data-state',
        'loaded',
      ),
    );
    expect(image('page').loading).toBe('eager');
    expect(image('page').fetchPriority).toBe('high');
    expect(image('repeat').getAttribute('alt')).toBe('');
    expect(image('other').loading).toBe('lazy');
    expect(image('other').alt).toBe('The Wind-Up Bird Chronicle');
  },
};
