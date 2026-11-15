import type { EditorMediaLabels } from '@rezics/editor';
import { m } from '../paraglide/messages.js';

export function localizedMediaLabels(locale?: string): EditorMediaLabels {
  const options = locale ? { locale: locale as never } : undefined;
  return {
    imageProperties: m.editor_media_image_properties({}, options),
    mediaProperties: m.editor_media_media_properties({}, options),
    imageUnavailable: m.editor_media_image_unavailable({}, options),
    mediaUnavailable: m.editor_media_media_unavailable({}, options),
    embeddedComponent: m.editor_media_embedded_component({}, options),
    revealImage: m.editor_media_reveal_image({}, options),
    imageTitle: m.editor_media_image_title({}, options),
    imageWidth: m.editor_media_image_width({}, options),
    imageHeight: m.editor_media_image_height({}, options),
    imageConceal: m.editor_media_image_conceal({}, options),
    imageDimensionsHelp: m.editor_media_image_dimensions_help({}, options),
    invalidImageDimensions: m.editor_media_invalid_image_dimensions({}, options),
    mediaCaption: m.editor_media_media_caption({}, options),
    imagePropertiesHelp: m.editor_media_image_properties_help({}, options),
    mediaPropertiesHelp: m.editor_media_media_properties_help({}, options),
    structuredPasteRejected: m.editor_media_structured_paste_rejected({}, options),
  };
}
