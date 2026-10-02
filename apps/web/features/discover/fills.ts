import type { DiscoveryPage, Loaded } from './types.ts';

/** The fewest Works an overview row shows; a row of one reads as a gap, not a shelf. */
export const MIN_ROW = 2;

/** An overview row worth showing: it loaded and holds at least two Works. */
export const fills = (shelf: { initial: Loaded<DiscoveryPage> }) => shelf.initial.ok && shelf.initial.data.items.length >= MIN_ROW;
