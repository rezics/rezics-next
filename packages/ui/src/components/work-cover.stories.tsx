import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { coverDesign, uprightTitle, WorkCover, type WorkCoverKind, workCoverRatio } from './work-cover.tsx';

// A generated image stands in for a publisher's cover, so stories need no network.
const imageCover = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
  <rect width="400" height="600" fill="#1d3557"/><circle cx="200" cy="230" r="120" fill="#f1c453"/>
  <text x="200" y="470" fill="#f8f4e3" font-family="Georgia" font-size="44" text-anchor="middle">NORTHERN</text>
  <text x="200" y="520" fill="#f8f4e3" font-family="Georgia" font-size="44" text-anchor="middle">LIGHTS</text></svg>`)}`;

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
          'A Work’s cover at standard sizes with the proportions of its kind: bound books 2:3, poster-like documents 3:4, recipe cards and package tiles square. With a selected image it shows the image; without one it generates a typographic cover — title and authors in the Work-title face, on colors picked from the kind and a stable seed (use the Work ID) — so a shelf of uncovered Works still reads as books, never as empty avatars. Short Chinese and Japanese titles are set upright on a title slip, as on a thread-bound book. Leave `alt` out where the title sits beside the cover; the cover is then decorative.',
      },
    },
  },
  args: { title: 'Pride and Prejudice', authors: ['Jane Austen'], kind: 'book', seed: 'work-1', size: 'lg', lang: 'en' },
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
];

export const Kinds: Story = {
  render: args => <ul className="flex flex-wrap items-end gap-6">
    {kinds.map(item => <li key={item.kind} className="grid w-40 gap-2">
      <WorkCover {...args} {...item} seed={item.title} />
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

/** Ten uncovered classics: the seed varies cloth, layout and rule, so a shelf is not a wall of one design. */
export const GeneratedShelf: Story = {
  render: args => <ul className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5">
    {classics.map(book => <li key={book.title}><WorkCover {...args} {...book} seed={book.title} size="fill" /></li>)}
  </ul>,
  async play({ canvasElement }) {
    const grounds = new Set([...canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]')]
      .map(cover => cover.style.background));
    await expect(grounds.size).toBeGreaterThan(4);
  },
};

export const StableColors: Story = {
  render: args => <div className="flex gap-4">
    <WorkCover {...args} seed="https://rezics.com/id/00000001" />
    <WorkCover {...args} seed="https://rezics.com/id/00000001" size="md" />
  </div>,
  async play({ canvasElement }) {
    const [a, b] = canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]');
    await expect(a!.style.background).toBe(b!.style.background);
    await expect(a!.style.background).toBe(coverDesign('book', 'https://rezics.com/id/00000001').swatch.ground);
  },
};

/** Main's fallback keys are hex digests; a shelf of them should not share a handful of colors. */
export const PaletteSpread: Story = {
  render: args => <div className="flex flex-wrap items-end gap-3">
    {Array.from({ length: 20 }, (_, index) => <WorkCover key={index} {...args} size="sm"
      seed={`${(index * 2654435761 >>> 0).toString(16).padStart(8, '0')}7a2c1e8d3b4c6a9e2f1b4d6a`} />)}
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
      authors={['Laurence Sterne']} seed="shandy" />
    <WorkCover {...args} title="Donaudampfschifffahrtsgesellschaftskapitänsmütze" authors={['Unbekannt']} lang="de"
      seed="mutze" />
    <WorkCover {...args} kind="document" lang="zh-Hans" seed="serial"
      title="雨夜书店 · 连载小说：一部关于深夜书店、未寄出的信和最后一班车的长篇连载" authors={['林夜']} />
    <WorkCover {...args} authors={['Mary Wollstonecraft Shelley', 'Percy Bysshe Shelley', 'Lord Byron']}
      title="Frankenstein; or, The Modern Prometheus" seed="frankenstein" />
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
    <WorkCover {...args} title="西游记" authors={['吴承恩']} lang="zh-Hans" seed="journey" />
    <WorkCover {...args} title="聊斋志异" authors={['蒲松龄']} lang="zh-Hans" seed="liaozhai" />
    <WorkCover {...args} title="吾輩は猫である" authors={['夏目漱石']} lang="ja" seed="neko" />
    <WorkCover {...args} title="傲慢与偏见 · 中文译读" authors={['简·奥斯汀']} lang="zh-Hans" seed="pride-zh" />
    <WorkCover {...args} title="채식주의자" authors={['한강']} lang="ko" seed="vegetarian" />
    <WorkCover {...args} kind="recipe" title="韭菜鸡蛋饺子" authors={[]} lang="zh-Hans" seed="dumplings" />
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
