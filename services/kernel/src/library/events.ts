import { Type } from 'typebox';

const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** Closed library events. Listings name the subject; a follow names only its target. */
export const LIBRARY_EVENTS = {
  'com.rezics.library.subject.listed.v1': Type.Object({ subjectId: id }, { additionalProperties: false }),
  'com.rezics.library.follow.updated.v1': Type.Object({ targetId: id }, { additionalProperties: false }),
} as const;
