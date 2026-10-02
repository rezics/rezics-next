'use client';

import { initials } from '@rezics/ui/avatar-initials';
import { cn } from '@rezics/ui/utils';
import { useState } from 'react';
import { BFF_PREFIX } from '../api/browser.ts';
import { WebMediaImage } from '../document-editor/media-image.tsx';
import type { AgentKind } from './types.ts';

/** The letters a profile without a photo shows: the site-wide rule, so a person reads the same everywhere. */
export { initials };

const sizes = {
  sm: 'size-10 text-base',
  /** The profile header: small beside the name on phones, Goodreads-sized beside the text on wider screens. */
  lg: 'size-20 text-3xl sm:size-40 sm:text-6xl',
};

/**
 * A profile's photo, or its initials on the accent surface. People are
 * round; organizations and services are rounded squares, as on most sites
 * that list both. The photo comes through the BFF, which adds the token Main
 * needs for the reader's Agent. A photo Main does not show this reader (new
 * and still being checked, or held for review) does not load, and the initials
 * stand in for it rather than a broken image.
 */
export function ProfileAvatar({ name, kind, avatarUrl, avatarQuery = '', size = 'lg', className }: {
  name: string; kind: AgentKind; avatarUrl: string | null; avatarQuery?: string; size?: keyof typeof sizes;
  className?: string;
}) {
  const shape = kind === 'person' ? 'rounded-full' : 'rounded-[22%]';
  const [failed, setFailed] = useState<string | null>(null);
  const url = avatarUrl?.startsWith('/v1/media/') ? `${BFF_PREFIX}${avatarUrl}${avatarQuery}` : null;
  const src = url && url !== failed ? url : null;
  return <span className={cn('relative grid shrink-0 place-items-center overflow-hidden bg-accent',
    'text-accent-foreground after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border',
    'after:border-foreground/8', shape, sizes[size], className)}>
    {src ? <WebMediaImage revealable={size === 'lg'} compact src={src} alt="" className="size-full object-cover" onError={() => setFailed(src)} />
      : <span aria-hidden="true" className="font-semibold font-work-title leading-none">{initials(name)}</span>}
  </span>;
}
