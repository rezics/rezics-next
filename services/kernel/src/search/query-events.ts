import { Type } from 'typebox';

/** Search producers declare their event schemas; the process catalogue collects them. */
export const RECENT_SEARCH_EVENTS = {
  'com.rezics.search.recent-changed.v1': Type.Object(
    { accountId: Type.String({ format: 'uuid' }) },
    { additionalProperties: false },
  ),
};

export const TRENDING_SEARCH_EVENTS = {
  'com.rezics.search.trending.changed.v1': Type.Object({}, { additionalProperties: false }),
};
