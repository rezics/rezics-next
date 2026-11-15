export const editorMediaLabels = {
  imageProperties: 'Image properties',
  mediaProperties: 'Media properties',
  imageUnavailable: 'Image unavailable',
  mediaUnavailable: 'Media unavailable',
  embeddedComponent: 'Embedded component unavailable',
  revealImage: 'Reveal image',
  imageTitle: 'Title',
  imageWidth: 'Width (px)',
  imageHeight: 'Height (px)',
  imageConceal: 'Conceal image until revealed',
  imageDimensionsHelp: 'Leave a dimension empty to use the supplied image dimensions.',
  invalidImageDimensions: 'Use positive dimensions or leave them empty.',
  mediaCaption: 'Caption',
  imagePropertiesHelp: 'Change this occurrence without changing the stored media object.',
  mediaPropertiesHelp: 'Edit the caption. The host owns the media source and access.',
  structuredPasteRejected: 'This structured content could not be pasted without losing data.',
} as const;

export type EditorMediaLabels = { readonly [K in keyof typeof editorMediaLabels]: string };
