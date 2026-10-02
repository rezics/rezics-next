'use client';

import { MediaImage, type MediaImageProps } from '@rezics/ui/media-image';
import { imageReferenceFromUrl } from '../api/media-metadata.ts';

/** Existing avatar URLs resolve their selected Use through the same image policy as body media. */
export function WebMediaImage(props: MediaImageProps) {
  const reference = !props.representationId && !props.metadata && typeof props.src === 'string'
    ? imageReferenceFromUrl(props.src) : undefined;
  return <MediaImage {...reference} {...props} />;
}
