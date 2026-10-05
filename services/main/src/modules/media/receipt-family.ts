/** Content-owned media commands declare their Access terminal receipt families. */
export const receiptFamilies = {
  'media.upload': 'media-upload', 'media.manage': 'media-state', 'media.avatar': 'media-avatar',
  'media.labels': 'media-field', 'media.labels.protect': 'media-field',
  'media.conceal': 'media-field', 'media.conceal.protect': 'media-field',
  'media.inference': 'media-inference', 'media.use': 'media-document-use',
  'media.campaign': 'media-campaign',
} as const;
