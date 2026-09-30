import type { CSSProperties } from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';

/**
 * What the Work is, as a physical object: a bound book, a poster-like
 * document, a recipe card, a package tile or a game's key art. Each has its own proportions
 * and generated design.
 */
export type WorkCoverKind = 'book' | 'document' | 'recipe' | 'package' | 'game';

/** Width over height: books 2:3, documents 3:4, recipe cards and package tiles square, game key art 16:9. */
export const workCoverRatio: Record<WorkCoverKind, number> = { book: 2 / 3, document: 3 / 4, recipe: 1, package: 1,
  game: 16 / 9 };

/** A generated cover's colors: its ground, the text on it and a decorative accent. */
export interface WorkCoverSwatch {
  ground: string;
  ink: string;
  accent: string;
}

// Every ink reaches at least 5.4:1 on its ground, so the set type reads at any
// size; accents only draw rules and shapes. The logo red never appears here:
// it is reserved for identity marks (docs/development/design-system.md).
const cream = 'oklch(0.96 0.025 85)';
const swatches: Record<WorkCoverKind, readonly WorkCoverSwatch[]> = {
  // Book cloth: ink blue, oxblood, forest, teal, plum and charcoal, then light ochre, cream, sage and rose papers.
  book: [
    { ground: 'oklch(0.36 0.09 255)', ink: cream, accent: 'oklch(0.82 0.1 85)' },
    { ground: 'oklch(0.37 0.11 22)', ink: cream, accent: 'oklch(0.82 0.1 85)' },
    { ground: 'oklch(0.38 0.07 158)', ink: cream, accent: 'oklch(0.82 0.1 85)' },
    { ground: 'oklch(0.41 0.07 210)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.84 0.09 85)' },
    { ground: 'oklch(0.36 0.08 320)', ink: cream, accent: 'oklch(0.82 0.1 85)' },
    { ground: 'oklch(0.3 0.012 260)', ink: cream, accent: 'oklch(0.8 0.12 70)' },
    { ground: 'oklch(0.8 0.11 80)', ink: 'oklch(0.26 0.04 55)', accent: 'oklch(0.4 0.1 35)' },
    { ground: 'oklch(0.93 0.03 88)', ink: 'oklch(0.27 0.04 260)', accent: 'oklch(0.48 0.13 30)' },
    { ground: 'oklch(0.84 0.05 145)', ink: 'oklch(0.27 0.05 160)', accent: 'oklch(0.4 0.07 160)' },
    { ground: 'oklch(0.85 0.05 20)', ink: 'oklch(0.3 0.07 18)', accent: 'oklch(0.42 0.1 20)' },
  ],
  // Posters: paper grounds with one strong shape color, or a dark or bright ground.
  document: [
    { ground: 'oklch(0.96 0.01 90)', ink: 'oklch(0.24 0.03 260)', accent: 'oklch(0.5 0.15 258)' },
    { ground: 'oklch(0.96 0.01 90)', ink: 'oklch(0.24 0.03 260)', accent: 'oklch(0.63 0.19 35)' },
    { ground: 'oklch(0.28 0.03 262)', ink: 'oklch(0.96 0.01 90)', accent: 'oklch(0.84 0.14 88)' },
    { ground: 'oklch(0.95 0.015 190)', ink: 'oklch(0.24 0.03 260)', accent: 'oklch(0.58 0.1 195)' },
    { ground: 'oklch(0.89 0.1 96)', ink: 'oklch(0.24 0.03 260)', accent: 'oklch(0.3 0.04 260)' },
    { ground: 'oklch(0.44 0.13 262)', ink: 'oklch(0.97 0.01 90)', accent: 'oklch(0.86 0.09 40)' },
  ],
  // Kitchen tones: tomato, saffron, olive, cream, paprika and mint.
  recipe: [
    { ground: 'oklch(0.52 0.16 33)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.9 0.08 85)' },
    { ground: 'oklch(0.84 0.13 84)', ink: 'oklch(0.28 0.05 50)', accent: 'oklch(0.55 0.16 35)' },
    { ground: 'oklch(0.47 0.08 120)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.88 0.08 100)' },
    { ground: 'oklch(0.95 0.03 85)', ink: 'oklch(0.3 0.05 50)', accent: 'oklch(0.58 0.17 35)' },
    { ground: 'oklch(0.45 0.12 45)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.88 0.09 80)' },
    { ground: 'oklch(0.88 0.06 165)', ink: 'oklch(0.28 0.05 165)', accent: 'oklch(0.5 0.1 165)' },
  ],
  package: [
    { ground: 'oklch(0.28 0.03 262)', ink: 'oklch(0.96 0.01 90)', accent: 'oklch(0.84 0.14 88)' },
    { ground: 'oklch(0.96 0.01 90)', ink: 'oklch(0.24 0.03 260)', accent: 'oklch(0.5 0.15 258)' },
    { ground: 'oklch(0.41 0.07 210)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.84 0.09 85)' },
    { ground: 'oklch(0.89 0.1 96)', ink: 'oklch(0.24 0.03 260)', accent: 'oklch(0.3 0.04 260)' },
  ],
  // Key art skies: night indigo, deep teal, ember dusk, forest, violet and storm, each with a lit horizon.
  game: [
    { ground: 'oklch(0.3 0.09 272)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.8 0.13 70)' },
    { ground: 'oklch(0.34 0.07 205)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.82 0.11 150)' },
    { ground: 'oklch(0.36 0.1 35)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.85 0.12 80)' },
    { ground: 'oklch(0.33 0.07 150)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.86 0.1 110)' },
    { ground: 'oklch(0.32 0.11 305)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.8 0.12 350)' },
    { ground: 'oklch(0.3 0.03 250)', ink: 'oklch(0.97 0.02 85)', accent: 'oklch(0.78 0.1 230)' },
  ],
};

/**
 * FNV-1a with a final avalanche (MurmurHash3's fmix32): a stable 32-bit hash,
 * so a Work keeps its colors on every page and render. FNV's low bits follow
 * the input's low bits, and Main's fallback keys are hex strings, so without
 * the final mix a shelf of such keys lands on a few swatches.
 */
export function coverHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * What a Work's generated cover hashes: the last UUID in its id, so the IRI
 * (`https://rezics.com/id/<uuid>`), a `/w/<uuid>` path and the bare UUID pick
 * one design. A key without a UUID is used as given.
 */
export function coverSeed(id: string): string {
  return id.match(uuid)?.at(-1)?.toLowerCase() ?? id;
}

/** The swatch and layout a Work's id picks for a kind; the same Work always picks the same pair. */
export function coverDesign(kind: WorkCoverKind, id: string): { swatch: WorkCoverSwatch; layout: number } {
  const hash = coverHash(coverSeed(id));
  const set = swatches[kind];
  return { swatch: set[hash % set.length]!, layout: (hash >>> 8) % 4 };
}

const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const upright = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Short Chinese or Japanese titles are set upright in a title slip, as on a
 * thread-bound book; longer ones and Korean run horizontally.
 */
export function uprightTitle(title: string): boolean {
  const characters = [...title.replace(/\s/gu, '')];
  // A slip holds a short name; separators such as "·" mark a longer, compound title that reads better across.
  return characters.length > 0 && characters.length <= 6 && characters.every(character => upright.test(character));
}

const longestWord = (title: string) => Math.max(0, ...title
  .split(/[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u).map(word => [...word].length));

/**
 * The title's size in percent of the cover's width: smaller as the title grows
 * (CJK characters count about double), and small enough that its longest word
 * fits on one line where it can.
 */
export function coverTitleSize(title: string): number {
  let width = 0;
  for (const character of title) width += wide.test(character) ? 1.8 : 1;
  const byLength = width <= 14 ? 13 : width <= 28 ? 11 : width <= 48 ? 9.5 : width <= 80 ? 8 : 7;
  // A semibold serif letter is about 0.62em wide and a book's text column about 68% of its width.
  const longest = longestWord(title);
  return Math.max(7, Math.min(byLength, longest ? 68 / (0.62 * longest) : byLength));
}

const workCoverVariants = tv({
  base: [
    '@container relative isolate shrink-0 select-none overflow-hidden',
    // A printed object on the page: a hairline edge that holds in dark mode, and a soft drop shadow.
    'shadow-[0_1px_2px_rgb(0_0_0/0.1),0_8px_20px_-8px_rgb(0_0_0/0.32)]',
    'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10',
    'after:ring-inset dark:after:ring-white/12',
  ],
  variants: {
    size: {
      xs: 'w-10 rounded-[0.1875rem]', sm: 'w-16 rounded-[0.25rem]', md: 'w-28 rounded-[0.375rem]',
      lg: 'w-40 rounded-[0.5rem]', xl: 'w-56 rounded-[0.5rem]', fill: 'w-full rounded-[0.5rem]',
    },
    // Recipe cards and package tiles round further; books and documents take the size's radius.
    kind: { book: '', document: '', recipe: 'rounded-[12%]', package: 'rounded-[22%]', game: '' },
  },
  defaultVariants: { size: 'fill', kind: 'book' },
});

export interface WorkCoverImage {
  src: string;
  width?: number;
  height?: number;
}

export interface WorkCoverProps extends VariantProps<typeof workCoverVariants> {
  /** The Work's title, set on a generated cover. */
  title: string;
  /** The title's language, for hyphenation, CJK shaping and upright setting. */
  lang?: string;
  dir?: 'ltr' | 'rtl';
  /** Author names in credit order; the first two are set on a generated cover. */
  authors?: readonly string[];
  kind?: WorkCoverKind;
  /**
   * The Work's IRI or UUID. Only its UUID picks the generated colors and
   * layout, so a Work wears one cover on every surface. Never pass a key a
   * single read chose, such as Main's fallback avatar key: another surface
   * would draw another cover.
   */
  id?: string;
  /** @deprecated Pass the Work's `id`. */
  seed?: string;
  /** A selected cover image. The generated cover stays underneath while it loads or if it fails. */
  image?: WorkCoverImage | null;
  /**
   * Names the cover for assistive technology. Leave it out where the title is
   * already beside the cover, as on cards and the Work page.
   */
  alt?: string;
  /** `eager` for the one large cover a page leads with. */
  loading?: 'lazy' | 'eager';
  className?: string;
  style?: CSSProperties;
}

function Spine({ side }: { side: 'start' | 'right' }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute inset-y-0 z-20 w-[7%]',
    side === 'start'
      ? 'start-0 bg-[linear-gradient(90deg,rgb(0_0_0/0.3),rgb(0_0_0/0.08)_45%,rgb(255_255_255/0.12)_58%,transparent)] rtl:rotate-180'
      : 'right-0 bg-[linear-gradient(270deg,rgb(0_0_0/0.26),rgb(0_0_0/0.06)_45%,rgb(255_255_255/0.1)_58%,transparent)]')} />;
}

function Authors({ authors, lang, className }: { authors: readonly string[]; lang?: string; className?: string }) {
  if (!authors.length) return null;
  const text = authors.slice(0, 2).join(authors.some(name => wide.test(name)) ? '、' : ', ');
  const latin = !wide.test(text);
  return <p lang={lang} className={cn('hidden font-sans font-semibold leading-snug @min-[7rem]:line-clamp-2',
    latin ? 'text-[5.5cqw] uppercase tracking-[0.12em]' : 'text-[6.5cqw] tracking-[0.08em]', className)}>{text}</p>;
}

// Static class names, so Tailwind generates each clamp; titles show from 4.5rem wide, where they can be read.
const clamps = { 3: '@min-[4.5rem]:line-clamp-3', 4: '@min-[4.5rem]:line-clamp-4', 5: '@min-[4.5rem]:line-clamp-5',
  6: '@min-[4.5rem]:line-clamp-6' } as const;

function Title({ title, lang, dir, lines, scale = 1, className }: {
  title: string; lang?: string; dir?: 'ltr' | 'rtl'; lines: keyof typeof clamps; scale?: number; className?: string;
}) {
  return <p lang={lang} dir={dir} style={{ fontSize: `${coverTitleSize(title) * scale}cqw` }}
    className={cn('hidden text-balance font-semibold font-work-title leading-[1.14] [overflow-wrap:anywhere]',
      longestWord(title) > 12 ? 'hyphens-auto' : 'hyphens-manual', clamps[lines], className)}>{title}</p>;
}

/** A cloth-bound book: title and a rule at the head, authors at the foot, a shaded spine. */
function BookDesign({ title, lang, dir, authors, swatch, layout }: DesignProps) {
  if (uprightTitle(title)) {
    // Thread-bound: stitched on the right, the title upright on a paper slip at the upper left.
    return <>
      <span aria-hidden="true" className="absolute inset-y-0 right-[8%] w-px opacity-35" style={{ background: swatch.accent }} />
      {[14, 38, 62, 86].map(top => <span key={top} aria-hidden="true" className="absolute right-0 h-px w-[8%] opacity-50"
        style={{ top: `${top}%`, background: swatch.accent }} />)}
      <div className="absolute top-[8%] left-[11%] hidden border px-[3.5%] py-[5%] @min-[4.5rem]:block"
        style={{ background: 'oklch(0.95 0.02 85)', color: 'oklch(0.22 0.02 260)', borderColor: 'oklch(0.22 0.02 260 / 0.45)' }}>
        <p lang={lang} className="font-semibold font-work-title leading-none tracking-[0.18em] [text-orientation:upright]
          [writing-mode:vertical-rl]" style={{ fontSize: `${[...title.replace(/\s/gu, '')].length <= 4 ? 12 : 10}cqw` }}>
          {title.replace(/\s/gu, '')}</p>
      </div>
      <Authors authors={authors} lang={lang} className="absolute inset-x-[11%] bottom-[8%]" />
      <Spine side="right" />
    </>;
  }
  return <>
    {layout === 1 ? <span aria-hidden="true" className="absolute inset-x-0 top-[9%] h-[3.5%]" style={{ background: swatch.accent }} /> : null}
    {layout === 2 ? <span aria-hidden="true" className="absolute inset-[6%] start-[12%] border opacity-70"
      style={{ borderColor: swatch.accent }} /> : null}
    <div className={cn('absolute inset-0 flex flex-col pe-[11%] ps-[17%]',
      layout === 1 ? 'pt-[22%] pb-[11%]' : 'pt-[15%] pb-[11%]', layout === 2 && 'justify-center pb-[18%] pt-[18%]')}>
      <Title title={title} lang={lang} dir={dir} lines={layout === 2 ? 5 : 6} />
      <span aria-hidden="true" className="mt-[8%] hidden h-px w-[30%] shrink-0 @min-[4.5rem]:block"
        style={{ background: swatch.accent }} />
      {layout === 2 ? null : <span className="flex-1" />}
      <Authors authors={authors} lang={lang} className={layout === 2 ? 'mt-[10%]' : undefined} />
    </div>
    {layout === 3 ? <span aria-hidden="true" className="absolute inset-x-0 bottom-[5%] h-[1.2%] opacity-80"
      style={{ background: swatch.accent }} /> : null}
    <Spine side="start" />
  </>;
}

/** A poster: one bold shape in the upper half, authors as a label, the title set large at the foot. */
function DocumentDesign({ title, lang, dir, authors, swatch, layout }: DesignProps) {
  const shape = [
    <span key="sun" className="absolute -end-[22%] -top-[22%] size-[82%] rounded-full" style={{ background: swatch.accent }} />,
    <span key="bars" className="absolute inset-x-[10%] top-[10%] grid h-[30%] grid-rows-3 gap-[12%]">
      {[0, 1, 2].map(bar => <span key={bar} style={{ background: swatch.accent, width: `${100 - bar * 22}%` }} />)}</span>,
    <span key="arc" className="absolute -start-[30%] -top-[30%] size-[90%] rounded-full border-[9cqw]"
      style={{ borderColor: swatch.accent }} />,
    <span key="fold" className="absolute inset-x-0 top-0 h-[52%] [clip-path:polygon(0_0,100%_0,100%_62%,0_100%)]"
      style={{ background: swatch.accent }} />,
  ][layout];
  return <>
    <span aria-hidden="true">{shape}</span>
    <div className="absolute inset-x-[10%] bottom-[9%] flex max-h-[50%] flex-col justify-end gap-[5%]">
      <Authors authors={authors} lang={lang} />
      <Title title={title} lang={lang} dir={dir} lines={4} scale={1.05} className="text-start" />
    </div>
  </>;
}

/** A recipe card: a gingham band, a plate or a striped edge, and the title set in the lower half. */
function RecipeDesign({ title, lang, dir, authors, swatch, layout }: DesignProps) {
  const check = `color-mix(in oklab, ${swatch.accent} 55%, transparent)`;
  const motif = layout % 3 === 0
    ? <span className="absolute inset-x-0 top-0 h-[34%]" style={{ backgroundImage:
      `repeating-linear-gradient(0deg, ${check} 0 6cqw, transparent 6cqw 12cqw), repeating-linear-gradient(90deg, ${check} 0 6cqw, transparent 6cqw 12cqw)` }} />
    : layout % 3 === 1
      ? <span className="absolute top-[9%] left-1/2 size-[36%] -translate-x-1/2 rounded-full"
        style={{ boxShadow: `inset 0 0 0 2.5cqw ${swatch.accent}, inset 0 0 0 5cqw transparent, inset 0 0 0 5.6cqw ${check}` }} />
      : <span className="absolute inset-y-0 start-0 w-[9%]" style={{ backgroundImage:
        `repeating-linear-gradient(180deg, ${swatch.accent} 0 5cqw, transparent 5cqw 10cqw)` }} />;
  return <>
    <span aria-hidden="true">{motif}</span>
    <div className={cn('absolute inset-x-[11%] bottom-[10%] flex max-h-[52%] flex-col justify-end gap-[5%]',
      layout % 3 === 2 && 'start-[18%]')}>
      <Title title={title} lang={lang} dir={dir} lines={3} scale={0.95} />
      <Authors authors={authors} lang={lang} />
    </div>
  </>;
}

/** A package tile: the name centred on a label band. */
function PackageDesign({ title, lang, dir, swatch }: DesignProps) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-[6%] px-[12%] text-center">
    <span aria-hidden="true" className="h-[2.5%] w-[34%] rounded-full" style={{ background: swatch.accent }} />
    <Title title={title} lang={lang} dir={dir} lines={3} scale={0.9} />
  </div>;
}

/** The title's size on key art, in percent of its width: large for a short name, two or three lines at most. */
export function gameTitleSize(title: string): number {
  let width = 0;
  for (const character of title) width += wide.test(character) ? 1.8 : 1;
  const longest = longestWord(title);
  const byLength = width <= 10 ? 8.5 : width <= 20 ? 7 : width <= 36 ? 5.6 : 4.6;
  // A bold letter is about 0.6em wide and the title column about 62% of the art's width.
  return Math.max(4, Math.min(byLength, longest ? 62 / (0.6 * longest) : byLength));
}

/**
 * Key art in the wide slot a game store gives it: a sky over a horizon, one
 * of four scenes (hills and a low sun, a lit grid, a star field or a canyon),
 * the title large at the lower left and the developer small above it.
 */
function GameDesign({ title, lang, dir, authors, swatch, layout }: DesignProps) {
  const glow = `color-mix(in oklab, ${swatch.accent} 55%, transparent)`;
  const shade = 'rgb(0 0 0 / 0.28)';
  const scene = [
    <span key="hills" className="absolute inset-0">
      <span className="absolute end-[12%] bottom-[30%] size-[30cqw] rounded-full"
        style={{ background: `radial-gradient(circle, ${swatch.accent} 0 55%, ${glow} 56% 70%, transparent 71%)` }} />
      <span className="absolute inset-x-0 bottom-0 h-[46%] [clip-path:polygon(0_45%,18%_20%,34%_52%,52%_14%,70%_48%,86%_26%,100%_40%,100%_100%,0_100%)]"
        style={{ background: shade }} />
      <span className="absolute inset-x-0 bottom-0 h-[30%] [clip-path:polygon(0_60%,22%_30%,46%_62%,68%_28%,100%_55%,100%_100%,0_100%)]"
        style={{ background: 'rgb(0 0 0 / 0.38)' }} />
    </span>,
    <span key="grid" className="absolute inset-0">
      <span className="absolute start-1/2 bottom-[42%] size-[34cqw] -translate-x-1/2 rounded-full rtl:translate-x-1/2"
        style={{ background: `linear-gradient(180deg, ${swatch.accent}, ${glow})` }} />
      <span className="absolute inset-x-0 bottom-0 h-[42%] [transform:perspective(40cqw)_rotateX(58deg)] [transform-origin:bottom]"
        style={{ backgroundImage: `repeating-linear-gradient(90deg, ${glow} 0 0.5cqw, transparent 0.5cqw 8cqw),
          repeating-linear-gradient(0deg, ${glow} 0 0.5cqw, transparent 0.5cqw 6cqw)` }} />
    </span>,
    <span key="stars" className="absolute inset-0">
      <span className="absolute inset-0 opacity-80" style={{ backgroundImage:
        `radial-gradient(${swatch.ink} 0.35cqw, transparent 0.45cqw), radial-gradient(${swatch.accent} 0.3cqw, transparent 0.4cqw)`,
      backgroundSize: '11cqw 9cqw, 17cqw 13cqw', backgroundPosition: '0 0, 5cqw 4cqw' }} />
      <span className="absolute -end-[8%] -bottom-[40%] size-[62cqw] rounded-full"
        style={{ background: `radial-gradient(circle at 30% 30%, ${swatch.accent}, ${shade} 70%)` }} />
    </span>,
    <span key="canyon" className="absolute inset-0">
      <span className="absolute inset-x-0 top-[18%] h-[22%] opacity-70" style={{ background:
        `linear-gradient(180deg, transparent, ${glow}, transparent)` }} />
      <span className="absolute inset-y-0 start-0 w-[34%] [clip-path:polygon(0_0,70%_0,55%_40%,85%_70%,60%_100%,0_100%)]"
        style={{ background: shade }} />
      <span className="absolute inset-y-0 end-0 w-[30%] [clip-path:polygon(40%_0,100%_0,100%_100%,20%_100%,45%_62%,25%_35%)]"
        style={{ background: 'rgb(0 0 0 / 0.36)' }} />
    </span>,
  ][layout];
  return <>
    <span aria-hidden="true">{scene}</span>
    {/* A foot shade keeps the title legible over any scene. */}
    <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[62%]"
      style={{ background: 'linear-gradient(0deg, rgb(0 0 0 / 0.55), transparent)' }} />
    <div className="absolute inset-x-[6%] bottom-[9%] flex max-h-[80%] flex-col justify-end gap-[2.5cqw] pe-[26%]">
      <Authors authors={authors} lang={lang} className="text-[2.6cqw] opacity-90" />
      <p lang={lang} dir={dir} style={{ fontSize: `${gameTitleSize(title)}cqw` }}
        className="hidden text-balance font-bold font-work-title leading-[1.05] tracking-[-0.01em] [overflow-wrap:anywhere]
          [text-shadow:0_0.3cqw_1.2cqw_rgb(0_0_0/0.45)] @min-[6rem]:line-clamp-3">{title}</p>
    </div>
  </>;
}

interface DesignProps {
  title: string; lang?: string; dir?: 'ltr' | 'rtl'; authors: readonly string[]; swatch: WorkCoverSwatch; layout: number;
}

const designs = { book: BookDesign, document: DocumentDesign, recipe: RecipeDesign, package: PackageDesign,
  game: GameDesign };

/**
 * A Work's cover at a standard size and the right proportions for its kind.
 * With an image it shows the image; without one it generates a typographic
 * cover (title and authors in the Work-title face on colors picked by the
 * kind and the Work's `id`), never a single-letter monogram. Covers keep
 * their colors in dark mode, as printed objects do.
 *
 * A Zone may wash its generated covers with one translucent color through
 * `--work-cover-tint` (at most about 15% opacity, so the set type keeps its
 * contrast); nothing else about a cover is a Zone's to change.
 */
export function WorkCover({ title, lang, dir, authors = [], kind = 'book', id, seed, image, alt, size,
  loading = 'lazy', className, style }: WorkCoverProps) {
  const { swatch, layout } = coverDesign(kind, id ?? seed ?? title);
  const Design = designs[kind];
  const named = alt !== undefined && alt !== '';
  return <div data-slot="work-cover" data-kind={kind}
    role={named && !image ? 'img' : undefined} aria-label={named && !image ? alt : undefined}
    aria-hidden={named ? undefined : true}
    className={cn(workCoverVariants({ size, kind }), className)}
    style={{ aspectRatio: String(workCoverRatio[kind]), background: swatch.ground, color: swatch.ink, ...style }}>
    <div aria-hidden={named && image ? true : undefined} className="absolute inset-0">
      {/* A faint sheen and foot shadow give the flat color some paper. */}
      <span className="absolute inset-0 bg-[linear-gradient(180deg,rgb(255_255_255/0.07),transparent_38%,rgb(0_0_0/0.09))]" />
      <Design title={title} lang={lang} dir={dir} authors={authors} swatch={swatch} layout={layout} />
      <span data-slot="work-cover-tint" className="absolute inset-0 bg-(--work-cover-tint)" />
    </div>
    {image ? <img src={image.src} width={image.width} height={image.height} alt={named ? alt : ''} loading={loading}
      decoding="async" fetchPriority={loading === 'eager' ? 'high' : undefined}
      className="absolute inset-0 z-10 size-full object-cover" /> : null}
    {image && kind === 'book' ? <Spine side="start" /> : null}
  </div>;
}
