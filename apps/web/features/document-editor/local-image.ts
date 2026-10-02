import type { ImageUploader } from '@rezics/ui/editor-image';

/**
 * A stand-in for media upload while documents have no contract for referencing stored media: the
 * chosen image stays in this page as a blob address and is gone after a reload. Replace it with the
 * media API once a document can reference an uploaded asset and its screening state.
 */
export const localImageUpload: ImageUploader = async (file) => ({ src: URL.createObjectURL(file) });
