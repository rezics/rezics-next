import type { KernelClient } from '@rezics/client';

/** Vocabulary follows the root client callable used by readCollectionViewerActions. */
type ViewerActionsCall = KernelClient['viewerActions']['post'];
export type ViewerActionsInput = Parameters<ViewerActionsCall>[0];
export type ViewerActionsOutput = NonNullable<Awaited<ReturnType<ViewerActionsCall>>['data']>;
export type ViewerActionsResource = Extract<ViewerActionsOutput['resources'][number], { viewerActions: unknown }>;
export type ViewerAction = ViewerActionsResource['viewerActions'][number];

/** Local read outcome; an empty successful native list is authoritative. */
export type CollectionViewerActions =
  | { state: 'ready'; actions: ViewerActionsResource['viewerActions'] }
  | { state: 'unavailable' };
