import type { CollectionDestination } from '../collection-read';

export type CollectionMoveAnchor = Readonly<{
  id: string;
  title: string;
  page: number;
  position: number;
}>;

/** Captured destination revision plus an optional disclosed occurrence anchor. Subject identity is never an operand. */
export type CollectionMoveChoice = Readonly<{
  destination: CollectionDestination;
  after: string | null;
  anchor: CollectionMoveAnchor | null;
}>;
