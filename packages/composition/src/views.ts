// SPDX-License-Identifier: Apache-2.0
import type { CompositionDocument } from './registry.ts';

/** The closed list of subject views, in the order a page offers them. */
export const VIEWS = [
  'overview',
  'editions',
  'contents',
  'characters',
  'appearances',
  'credits',
  'works',
  'relations',
  'posts',
  'reviews',
  'discussion',
  'lists',
  'collections',
  'details',
] as const;

export type View = (typeof VIEWS)[number];

/** The documents of one template: `overview` is required, the other views are optional. */
export type ViewDocuments = { overview: CompositionDocument } & {
  [K in Exclude<View, 'overview'>]?: CompositionDocument;
};

const VIEW_SET: ReadonlySet<string> = new Set(VIEWS);

export function isView(value: unknown): value is View {
  return typeof value === 'string' && VIEW_SET.has(value);
}
