import type { ActionCatalogue } from '../request/access.ts';

/** Content-owned seller authority. This action is consumed only by Commerce's
 * native Post-sale preparation; it has no client route or generic grant API.
 */
export const NATIVE_CONTENT_ACTIONS: ActionCatalogue = new Map([
  ['post:sell', { anonymous: false, 'x-resource-types': ['content.post'] }],
]);
