import { Type } from 'typebox';

const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** Closed library events. Private updates identify the changed item without exposing its state. Collection events carry the collection id; a member fact also carries its member and subject ids. */
export const LIBRARY_EVENTS = {
  'com.rezics.library.personal-import.changed.v1': Type.Object({}, { additionalProperties: false }),
