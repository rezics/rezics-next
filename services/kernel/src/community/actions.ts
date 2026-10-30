import type { ActionCatalogue } from '../request/access.ts';

/** Fixed native container declarations; protected handlers are owned by Content. */
export const NATIVE_CONTAINER_ACTIONS: ActionCatalogue = new Map([
  ['space:restore', { anonymous: false }],
  ['realm:restore', { anonymous: false }],
  ['realm:approve_claim', { anonymous: false }],
]);
