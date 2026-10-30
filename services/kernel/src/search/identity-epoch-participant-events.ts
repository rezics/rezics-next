import { Type } from 'typebox';

export const SEARCH_IDENTITY_WRITER_CHANGED = 'com.rezics.search.identity_writer.changed.v1';
export const SEARCH_IDENTITY_EVENTS = {
  [SEARCH_IDENTITY_WRITER_CHANGED]: Type.Object({}, { additionalProperties: false }),
} as const;
