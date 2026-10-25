import { Type } from 'typebox';

const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** Indexers rebuild from the subject partition; events disclose no Collection identifiers. */
export const LIBRARY_EVENTS = {
  'com.rezics.library.subject.listed.v1': Type.Object({ subjectId: id }, { additionalProperties: false }),
} as const;
