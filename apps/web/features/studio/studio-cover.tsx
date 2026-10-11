'use client';

import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { useState } from 'react';
import { CatalogueCoverCredit } from '../catalogue/cover.tsx';
import { coverImage, coverKindOf } from '../catalogue/work.ts';
import type { WorkCover as MainCover } from '../discover/types.ts';

/**
 * A Work's cover in Studio: the catalogue's cover at a Studio size, its image
 * read through the BFF as the Studio Agent, or the generated typographic cover
 * while it has none. Main does not yet deliver a private Work's cover image to
 * its writer, so an image that fails to load gives way to the generated cover
 * instead of a broken picture.
 */
export function StudioCover({ id, title, cover, types, authors, actingSubject, size = 'sm', loading, className }: {
  id: string; title: { value: string; language: string }; cover: MainCover | null; types: readonly string[];
  authors: readonly string[]; actingSubject: string; size?: 'xs' | 'sm' | 'md' | 'lg';
  loading?: 'lazy' | 'eager'; className?: string;
}) {
  const image = coverImage(cover, `?actingSubject=${encodeURIComponent(actingSubject)}`);
  const [failed, setFailed] = useState<string | null>(null);
  const selected = image && failed !== image.src ? cover : null;
  return <div className={cn('grid min-w-0 gap-1.5', { xs: 'w-10', sm: 'w-16', md: 'w-28', lg: 'w-40' }[size], className)}>
    <WorkCover title={title.value} lang={title.language} kind={coverKindOf(types)} id={id} authors={authors} size={size}
    image={image && failed !== image.src ? image : null} loading={loading} className={className}
    revealable onImageError={() => { if (image) setFailed(image.src); }} />
    <CatalogueCoverCredit work={{ id, title: null, cover: selected,
      kind: coverKindOf(types), authors: authors.map(name => ({ name, href: null })) }}
      avatarQuery={`?actingSubject=${encodeURIComponent(actingSubject)}`} />
  </div>;
}
