'use client';

import { WorkCover } from '@rezics/ui/work-cover';
import { useState } from 'react';
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
  return <WorkCover title={title.value} lang={title.language} kind={coverKindOf(types)} id={id} authors={authors} size={size}
    image={image && failed !== image.src ? image : null} loading={loading} className={className}
    revealable onImageError={() => { if (image) setFailed(image.src); }} />;
}
