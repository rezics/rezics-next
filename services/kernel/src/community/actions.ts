import type { ActionCatalogue } from '../request/access.ts';

/** Fixed native restoration declarations; protected handlers are owned by Content. */
export const NATIVE_CONTAINER_ACTIONS: ActionCatalogue = new Map([
  ['space:restore', { anonymous: false }],
  ['realm:restore', { anonymous: false }],
]);
