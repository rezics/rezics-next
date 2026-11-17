import type { ActionCatalogue } from '../request/access.ts';

export const NATIVE_CONTENT_ACTIONS: ActionCatalogue = new Map([
  // Commerce's native Post-sale preparation has no mounted client action.
  ['post:sell', { anonymous: false, 'x-resource-types': ['content.post'] }],
  // A future-thread reservation creates media under the Board's thread authority.
  ['thread:create', { anonymous: false, 'x-resource-types': ['content.media'] }],
]);
