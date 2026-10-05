import type { MediaImageReference } from './media-image.tsx';

/** An image's lookup key, shared by MediaImage and the server reads that resolve its metadata; a plain module, so a server render can call it. */
export const mediaImageKey = ({ representationId, mediaUseId }: MediaImageReference) => `${representationId}:${mediaUseId ?? ''}`;
