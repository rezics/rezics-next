import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import type { CSSProperties } from 'react';
import { coverDesign, coverSeed, uprightTitle, WorkCover, type WorkCoverKind, workCoverRatio } from './work-cover.tsx';

// A generated image stands in for a publisher's cover, so stories need no network.
const imageCover = URL.createObjectURL(new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
  <rect width="400" height="600" fill="#1d3557"/><circle cx="200" cy="230" r="120" fill="#f1c453"/>
  <text x="200" y="470" fill="#f8f4e3" font-family="Georgia" font-size="44" text-anchor="middle">NORTHERN</text>
  <text x="200" y="520" fill="#f8f4e3" font-family="Georgia" font-size="44" text-anchor="middle">LIGHTS</text></svg>`], { type: 'image/svg+xml' }));

const classics = [
  { title: 'Pride and Prejudice', authors: ['Jane Austen'] },
  { title: 'Jane Eyre', authors: ['Charlotte Brontë'] },
  { title: 'Frankenstein; or, The Modern Prometheus', authors: ['Mary Shelley'] },
  { title: 'Little Women', authors: ['Louisa May Alcott'] },
  { title: 'The Secret Garden', authors: ['Frances Hodgson Burnett'] },
  { title: 'The Adventures of Sherlock Holmes', authors: ['Arthur Conan Doyle'] },
  { title: 'Alice’s Adventures in Wonderland', authors: ['Lewis Carroll'] },
  { title: 'Middlemarch', authors: ['George Eliot'] },
  { title: 'Wuthering Heights', authors: ['Emily Brontë'] },
  { title: 'Great Expectations', authors: ['Charles Dickens'] },
];

const meta = {
  title: 'Rezics UI/Work Cover',
  component: WorkCover,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A Work’s cover at standard sizes with the proportions of its kind: bound books 2:3, poster-like documents 3:4, recipe cards and package tiles square, game key art 16:9. With a selected image it shows the image; without one it generates a typographic cover — title and authors in the Work-title face, on colors picked from the kind and the Work’s `id` (only its UUID counts, so the IRI, a `/w/` path and the bare UUID draw one cover) — so a shelf of uncovered Works still reads as books, never as empty avatars. Short Chinese and Japanese titles are set upright on a title slip, as on a thread-bound book. Leave `alt` out where the title sits beside the cover; the cover is then decorative.',
      },
    },
  },
  args: { title: 'Pride and Prejudice', authors: ['Jane Austen'], kind: 'book', id: 'work-1', size: 'lg', lang: 'en' },
  decorators: [withSurface],
} satisfies Meta<typeof WorkCover>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const cover = canvasElement.querySelector<HTMLElement>('[data-slot="work-cover"]')!;
    // Decorative by default: the title is beside it wherever it is used.
    await expect(cover).toHaveAttribute('aria-hidden', 'true');
    const box = cover.getBoundingClientRect();
    await expect(box.width / box.height).toBeCloseTo(workCoverRatio.book, 2);
    await expect(within(cover).getByText('Pride and Prejudice')).toBeVisible();
    await expect(within(cover).getByText('Jane Austen')).toBeVisible();
  },
};

const kinds: { kind: WorkCoverKind; title: string; authors: string[]; lang: string }[] = [
  { kind: 'book', title: 'Middlemarch', authors: ['George Eliot'], lang: 'en' },
  { kind: 'document', title: 'Bun — JavaScript runtime', authors: ['Oven'], lang: 'en' },
  { kind: 'recipe', title: 'Weekend buttermilk pancakes', authors: [], lang: 'en' },
  { kind: 'package', title: 'Recipe scaling assistant', authors: [], lang: 'en' },
  { kind: 'game', title: 'Steins;Gate', authors: ['5pb.'], lang: 'en' },
];

export const Kinds: Story = {
  render: args => <ul className="flex flex-wrap items-end gap-6">
    {kinds.map(item => <li key={item.kind} className="grid w-40 gap-2">
      <WorkCover {...args} {...item} id={item.title} />
      <span className="text-muted-foreground text-sm capitalize">{item.kind}</span>
    </li>)}
  </ul>,
  async play({ canvasElement }) {
    for (const cover of canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]')) {
      const box = cover.getBoundingClientRect();
      await expect(box.width / box.height).toBeCloseTo(workCoverRatio[cover.dataset.kind as WorkCoverKind], 2);
    }
  },
};

export const Sizes: Story = {
  render: args => <div className="flex flex-wrap items-end gap-5">
    {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map(size => <div key={size} className="grid justify-items-start gap-2">
      <WorkCover {...args} size={size} />
      <span className="text-muted-foreground text-xs">{size}</span>
    </div>)}
  </div>,
  async play({ canvasElement }) {
    const [xs, , md] = canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]');
    // Too small to read, the title is left to the text beside the cover; the color and spine remain.
    await expect(within(xs!).getByText('Pride and Prejudice')).not.toBeVisible();
    await expect(within(md!).getByText('Pride and Prejudice')).toBeVisible();
  },
};

/** Ten uncovered classics: the id varies cloth, layout and rule, so a shelf is not a wall of one design. */
export const GeneratedShelf: Story = {
  render: args => <ul className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5">
    {classics.map(book => <li key={book.title}><WorkCover {...args} {...book} id={book.title} size="fill" /></li>)}
  </ul>,
  async play({ canvasElement }) {
    const grounds = new Set([...canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]')]
      .map(cover => cover.style.background));
    await expect(grounds.size).toBeGreaterThan(4);
  },
};

const work = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';

/**
 * One Work, one face: every surface passes the Work's id in whatever form its
 * read returns it, and only the UUID picks the design.
 */
export const StableColors: Story = {
  render: args => <div className="flex items-end gap-4">
    <WorkCover {...args} id={`https://rezics.com/id/${work}`} />
    <WorkCover {...args} id={work} size="md" />
    <WorkCover {...args} id={`/w/${work.toUpperCase()}`} size="sm" />
  </div>,
  async play({ canvasElement }) {
    const covers = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]')];
    await expect(new Set(covers.map(cover => cover.style.background))).toEqual(
      new Set([coverDesign('book', work).swatch.ground]));
    await expect(coverSeed(`https://rezics.com/id/${work}`)).toBe(work);
    await expect(coverSeed('not-a-work')).toBe('not-a-work');
  },
};

/** A Zone may wash its covers with one translucent color; the design underneath stays the Work's. */
export const ZoneTint: Story = {
  render: args => <div className="flex items-end gap-4">
    <WorkCover {...args} id={work} />
    <div style={{ '--work-cover-tint': 'color-mix(in oklab, oklch(0.62 0.17 150) 14%, transparent)' } as CSSProperties}>
      <WorkCover {...args} id={work} /></div>
  </div>,
  async play({ canvasElement }) {
    const [plain, tinted] = canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]');
    await expect(tinted!.style.background).toBe(plain!.style.background);
    const wash = (cover: HTMLElement) => getComputedStyle(cover.querySelector('[data-slot="work-cover-tint"]')!)
      .backgroundColor;
    await expect(wash(plain!)).toBe('rgba(0, 0, 0, 0)');
    await expect(wash(tinted!)).not.toBe('rgba(0, 0, 0, 0)');
  },
};

/**
 * Work ids are time-ordered UUIDs, so a seed run's Works share their leading
 * digits; a shelf of them should still not share a handful of colors.
 */
export const PaletteSpread: Story = {
  render: args => <div className="flex flex-wrap items-end gap-3">
    {Array.from({ length: 20 }, (_, index) => <WorkCover key={index} {...args} size="sm"
      id={`https://rezics.com/id/0192f3a4-5b${index.toString(16).padStart(2, '0')}-7d8e-9f01-23456789abcd`} />)}
  </div>,
  async play({ canvasElement }) {
    const grounds = new Set([...canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]')]
      .map(cover => cover.style.background));
    // Ten book swatches: twenty keys should reach most of them.
    await expect(grounds.size).toBeGreaterThanOrEqual(7);
  },
};

export const LongTitles: Story = {
  render: args => <div className="flex flex-wrap items-end gap-5">
    <WorkCover {...args} title="The Life and Opinions of Tristram Shandy, Gentleman, with a Discourse on Noses and Hobby-Horses"
      authors={['Laurence Sterne']} id="shandy" />
    <WorkCover {...args} title="Donaudampfschifffahrtsgesellschaftskapitänsmütze" authors={['Unbekannt']} lang="de"
      id="mutze" />
    <WorkCover {...args} kind="document" lang="zh-Hans" id="serial"
      title="雨夜书店 · 连载小说：一部关于深夜书店、未寄出的信和最后一班车的长篇连载" authors={['林夜']} />
    <WorkCover {...args} authors={['Mary Wollstonecraft Shelley', 'Percy Bysshe Shelley', 'Lord Byron']}
      title="Frankenstein; or, The Modern Prometheus" id="frankenstein" />
  </div>,
  async play({ canvasElement }) {
    // Nothing spills: every set line stays inside its cover.
    for (const cover of canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]')) {
      const box = cover.getBoundingClientRect();
      for (const line of cover.querySelectorAll('p')) {
        const text = line.getBoundingClientRect();
        await expect(text.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
        await expect(text.right).toBeLessThanOrEqual(box.right + 0.5);
      }
    }
  },
};

export const CJK: Story = {
  render: args => <div className="flex flex-wrap items-end gap-5">
    <WorkCover {...args} title="西游记" authors={['吴承恩']} lang="zh-Hans" id="journey" />
    <WorkCover {...args} title="聊斋志异" authors={['蒲松龄']} lang="zh-Hans" id="liaozhai" />
    <WorkCover {...args} title="吾輩は猫である" authors={['夏目漱石']} lang="ja" id="neko" />
    <WorkCover {...args} title="傲慢与偏见 · 中文译读" authors={['简·奥斯汀']} lang="zh-Hans" id="pride-zh" />
    <WorkCover {...args} title="채식주의자" authors={['한강']} lang="ko" id="vegetarian" />
    <WorkCover {...args} kind="recipe" title="韭菜鸡蛋饺子" authors={[]} lang="zh-Hans" id="dumplings" />
  </div>,
  async play({ canvasElement }) {
    await expect(uprightTitle('西游记')).toBe(true);
    await expect(uprightTitle('채식주의자')).toBe(false);
    // A compound title with a separator runs across rather than overfilling a slip.
    await expect(uprightTitle('雨夜书店 · 连载小说')).toBe(false);
    const journey = within(canvasElement).getByText('西游记');
    await expect(getComputedStyle(journey).writingMode).toBe('vertical-rl');
    // Korean covers set the title horizontally, as modern Korean books do.
    await expect(getComputedStyle(within(canvasElement).getByText('채식주의자')).writingMode).toBe('horizontal-tb');
  },
};

export const WithImage: Story = {
  args: { title: 'Northern Lights', authors: ['Philip Pullman'], image: { src: imageCover, width: 400, height: 600 } },
  async play({ canvasElement }) {
    const image = canvasElement.querySelector('img')!;
    await waitFor(() => expect(image.complete && image.naturalWidth > 0).toBe(true));
    await expect(image).toHaveAttribute('alt', '');
  },
};

/** A cover that fails to load leaves the generated one in place rather than a broken image. */
export const BrokenImage: Story = {
  args: { title: 'The Secret Garden', authors: ['Frances Hodgson Burnett'],
    image: { src: '/missing-cover.jpg', width: 400, height: 600 } },
};

/** Named where no title is beside it; the cover is then one image to assistive technology. */
export const Named: Story = {
  args: { alt: 'Cover of Pride and Prejudice' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('img', { name: 'Cover of Pride and Prejudice' })).toBeVisible();
  },
};

/** Covers keep their printed colors on a dark page; a hairline edge keeps dark cloth from dissolving. */
export const Dark: Story = {
  ...GeneratedShelf,
  globals: { theme: 'dark' },
};
