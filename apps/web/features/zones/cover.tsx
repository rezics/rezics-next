import { cn } from '@rezics/ui/utils';
import type { ZoneWork } from '@rezics/zone-sdk';

// The cover seam. G-283 is building `WorkCover` in Rezics UI (a generated
// typographic cover for every Work type); until it is on `main`, this stands
// in with the same contract: a real cover when Main has one, otherwise the
// title and author set as a book, never a monogram. Replace the body with
// `<WorkCover>` when it lands; callers do not change.

// Book cloth grounds with their inks; every pair reads at 5:1 or better.
const cloths = [
  ['#27406b', '#f5efe0'], ['#6b2530', '#f5efe0'], ['#24503b', '#f2ecd8'], ['#2e5663', '#f4efe2'],
  ['#4d2b58', '#f5efe0'], ['#2f3238', '#f1e6c8'], ['#d9b25f', '#3a2410'], ['#ece4d0', '#2a3446'],
  ['#c9d8c0', '#223a2b'], ['#e7c9c2', '#4a1f22'],
] as const;

function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) value = Math.imul(value ^ seed.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

export function ZoneCover({ work, className, sizes = 'small' }: {
  work: Pick<ZoneWork, 'id' | 'title' | 'author' | 'cover'>; className?: string;
  /** `large` sets the generated title for hero-sized covers. */
  sizes?: 'small' | 'large';
}) {
  const frame = cn('zone-cover relative isolate block aspect-(--zone-cover-ratio) w-full shrink-0 overflow-hidden',
    'rounded-(--zone-radius-cover) bg-muted',
    'shadow-[0_1px_2px_rgb(0_0_0/0.1),0_8px_18px_-10px_rgb(0_0_0/0.4)]',
    'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1',
    'after:ring-black/8 after:ring-inset dark:after:ring-white/10', className);
  if (work.cover) {
    return <span className={frame}>
      <img src={work.cover.url} alt="" width={work.cover.width} height={work.cover.height} loading="lazy"
        decoding="async" className="size-full object-cover" />
    </span>;
  }
  const [ground, ink] = cloths[hash(work.id) % cloths.length]!;
  const title = work.title?.value ?? '';
  return <span aria-hidden="true" className={cn(frame, 'flex flex-col justify-between p-[9%] text-start')}
    style={{ backgroundColor: ground, color: ink }}>
    <span className="block h-px w-1/3 bg-current opacity-50" />
    <span lang={work.title?.lang} className={cn('line-clamp-5 font-semibold font-work-title leading-[1.15]',
      '[text-wrap:balance]', sizes === 'large' ? 'text-2xl sm:text-3xl' : 'text-[0.8rem] sm:text-sm')}>{title}</span>
    <span lang={work.author?.lang}
      className={cn('line-clamp-1 opacity-80', sizes === 'large' ? 'text-sm' : 'text-[0.6rem]')}>
      {work.author?.value ?? ''}</span>
  </span>;
}
