import { cn } from '@rezics/ui/utils';
import { BFF_PREFIX } from '../api/browser.ts';
import type { MyText } from './types.ts';

type Cover = NonNullable<MyText['work']>['cover'];

// Text-safe tints only: the logo red never sits behind text (docs/development/design-system.md).
const tints = ['bg-primary/10 text-primary', 'bg-info/10 text-info-foreground', 'bg-success/10 text-success-foreground',
  'bg-warning/10 text-warning-foreground', 'bg-secondary text-secondary-foreground'] as const;

function tintOf(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return tints[hash % tints.length]!;
}

/**
 * A Work's cover in Studio lists: its image, or a typographic cover set in the
 * reading serif with the title itself, never a lone initial. Image URLs are
 * Main paths read through the BFF as the Studio Agent.
 */
export function ManuscriptCover({ cover, title, language, fallbackKey, actingSubject, className }: {
  cover: Cover | null; title: string; language?: string; fallbackKey: string; actingSubject: string; className?: string;
}) {
  const frame = cn('aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg border border-border/60 sm:w-20', className);
  if (cover?.kind === 'image') {
    return <img src={`${BFF_PREFIX}${cover.url}?actingSubject=${encodeURIComponent(actingSubject)}`} alt=""
      width={cover.width} height={cover.height} loading="lazy" decoding="async" className={cn(frame, 'h-auto bg-muted object-cover')} />;
  }
  return <div aria-hidden="true" className={cn(frame, 'flex items-end p-1.5', tintOf(cover?.key ?? fallbackKey))}>
    <span lang={language} className="line-clamp-4 break-words font-work-title text-[10px]/tight sm:text-xs/tight">{title}</span>
  </div>;
}
