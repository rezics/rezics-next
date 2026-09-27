import { initials } from '@rezics/ui/avatar-initials';
import { cn } from '@rezics/ui/utils';
import { BFF_PREFIX } from '../api/browser.ts';

type Icon = { kind: 'fallback'; key: string } | { kind: 'image'; url: string } | null;

// Text-safe tints for Realms without an icon; the logo red stays off text.
const tints = ['bg-primary/12 text-primary', 'bg-info/12 text-info-foreground',
  'bg-success/12 text-success-foreground', 'bg-warning/15 text-warning-foreground',
  'bg-secondary text-secondary-foreground'] as const;

function tintOf(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return tints[hash % tints.length]!;
}

/**
 * A Realm's, Zone's or person's round mark, as Reddit shows a community: its
 * icon, or on a stable tint its name's first letter, or a person's initials
 * by the site-wide rule. Decorative: the name is always written next to it.
 */
export function CommunityIcon({ icon, name, size = 'sm', avatarQuery = '', person = false, className }: {
  icon: Icon; name: string; size?: 'xs' | 'sm' | 'md'; avatarQuery?: string; person?: boolean; className?: string;
}) {
  const frame = cn('grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold',
    size === 'xs' ? 'size-5 text-[10px]' : size === 'sm' ? 'size-6 text-xs' : 'size-9 text-sm', className);
  if (icon?.kind === 'image') {
    return <img src={`${BFF_PREFIX}${icon.url}${avatarQuery}`} alt="" loading="lazy" decoding="async"
      className={cn(frame, 'bg-muted object-cover')} />;
  }
  const initial = person ? initials(name, '·') : name.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? '·';
  return <span aria-hidden="true" className={cn(frame, tintOf(icon?.key ?? name))}>{initial}</span>;
}
