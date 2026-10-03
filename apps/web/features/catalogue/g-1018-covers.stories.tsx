import type { Meta, StoryObj } from '@storybook/react-vite';
import { mediaImageKey, MediaImageProvider, type MediaImageMetadata } from '@rezics/ui/media-image';
import { expect, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { browseId, browseResources } from '../discover/browse-fixtures.ts';
import { resourceWork } from '../discover/resource-card.tsx';
import { WorkGrid, WorkShelf } from './work-shelf.tsx';
import { WorkRow } from './work-row.tsx';

// Different publisher dimensions, resolved locally so the story needs no network or session.
const dimensions = [
  [900, 400],
  [300, 900],
] as const;
const images = Object.fromEntries(
  dimensions.map(([width, height], index) => {
    const representationId = browseId(index + 8000).slice(-36);
    const src = URL.createObjectURL(
      new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#234a62"/><rect x="5%" y="5%" width="90%" height="90%" fill="none" stroke="#f4d997" stroke-width="8"/>
    <text x="50%" y="50%" fill="#f4d997" text-anchor="middle" font-size="36">${width} × ${height}</text></svg>`,
        ],
        { type: 'image/svg+xml' },
      ),
    );
    return [
      mediaImageKey({ representationId }),
      {
        representationId,
        src,
        nsfw: 'sfw',
        ageRating: { status: 'unassessed' },
      } satisfies MediaImageMetadata,
    ];
  }),
);

function Covers({ locale }: { locale: UiLocale }) {
  const base = browseResources[0]!;
  const works = [null, ...dimensions].map((size, index) =>
    resourceWork(
      {
        ...base,
        id: browseId(index + 8100),
        types: ['https://schema.org/Book'],
        name: {
          ...base.name,
          value: locale === 'en' ? `Book ${index + 1}` : `作品 ${index + 1}`,
          language: locale,
        },
        icon: size
          ? {
              kind: 'image',
              url: `/v1/media/representations/${browseId(index - 1 + 8000).slice(-36)}`,
              selection: browseId(index + 8200),
              mediaType: 'image/svg+xml',
              crop: null,
              basis: { policy: 'story', context: browseId(8300) },
              width: size[0],
              height: size[1],
            }
          : base.icon,
      },
      undefined,
      locale,
    ),
  );
  return (
    <MediaImageProvider
      viewer={{
        ready: true,
        signedIn: false,
        age: 'unknown',
        optIns: { general: true, r15: false, sexual: false, grotesque: false },
      }}
      images={images}
    >
      <div className="grid max-w-5xl gap-10 p-4">
        <section aria-label="Grid">
          <WorkGrid works={works} locale={locale} className="lg:grid-cols-3" />
        </section>
        <WorkShelf heading={{ title: 'Rail' }} works={works} locale={locale} />
        <section aria-label="Rows" className="grid gap-5">
          {works.map((work) => (
            <WorkRow key={work.id} work={work} locale={locale} shelf="none" />
          ))}
        </section>
      </div>
    </MediaImageProvider>
  );
}

const meta = {
  title: 'Catalogue/Even cover boxes',
  component: Covers,
  args: { locale: 'en' },
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const images = canvasElement.querySelectorAll<HTMLImageElement>('[data-slot="media-image"]');
    await expect(images.length).toBe(6);
    for (const image of images) {
      await waitFor(() => expect(image.complete && image.naturalWidth > 0).toBe(true));
      await expect(getComputedStyle(image).objectFit).toBe('contain');
      const box = image.getBoundingClientRect(),
        cover = image.closest('[data-slot="work-cover"]')!.getBoundingClientRect();
      await expect(box.width).toBeCloseTo(cover.width, 1);
      await expect(box.height).toBeCloseTo(cover.height, 1);
    }
    for (const name of ['Grid', 'Rail', 'Rows']) {
      const region = canvas.getByRole('region', { name });
      const covers = region.querySelectorAll<HTMLElement>('[data-slot="work-cover"]');
      for (const cover of covers) {
        const box = cover.getBoundingClientRect();
        await expect(box.width / box.height).toBeCloseTo(2 / 3, 2);
        await expect(box.height).toBeCloseTo(covers[0]!.getBoundingClientRect().height, 1);
      }
      if (name !== 'Rows') {
        // Check every actual row, including the phone's wrapped grid.
        const rows = new Map<number, number[]>();
        for (const article of region.querySelectorAll('article')) {
          const row = Math.round(article.getBoundingClientRect().top);
          const headings = rows.get(row) ?? [];
          headings.push(article.querySelector('h3')!.getBoundingClientRect().top);
          rows.set(row, headings);
        }
        for (const headings of rows.values())
          await expect(Math.max(...headings) - Math.min(...headings)).toBeLessThan(1);
      }
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
} satisfies Meta<typeof Covers>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Latin: Story = {};
export const Cjk: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Phone: Story = { globals: { viewport: { value: 'phone' } } };
