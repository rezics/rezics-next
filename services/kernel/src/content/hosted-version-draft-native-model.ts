import type { HostedVersionDraftMoveSelection } from './hosted-version-draft-edit-model.ts';
import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import type {
  HostedVersionOccurrenceValue,
  HostedVersionSnapshot,
  HostedVersionWrite,
} from './hosted-version-model.ts';
import type { HostedVersionRevisionResolution } from './hosted-version-revision.ts';

export type HostedVersionDraftMoveDescriptor = Extract<HostedVersionRevisionResolution, { kind: 'ordered' }>;

/** Product occurrence facts stored beside the versioned containment edge. */
export type HostedVersionDraftMoveStoredValue = Readonly<{
  kind: 'part' | 'chapter';
  subtreeHeight: number;
  chapterCount: bigint;
  title: string | null;
  target: HostedChapterTarget | null;
  readonly [key: string]: unknown;
}>;

export type HostedVersionDraftMoveSelectedOccurrence = HostedVersionOccurrenceValue<HostedVersionDraftMoveStoredValue>;

/** Private metadata paired with the retained binder's public selection object. */
export type HostedVersionDraftMoveNativeContext = Readonly<{
  descriptor: HostedVersionDraftMoveDescriptor;
  snapshot: HostedVersionSnapshot;
  write: HostedVersionWrite<HostedVersionDraftMoveStoredValue>;
  occurrences: ReadonlyMap<string, HostedVersionDraftMoveSelectedOccurrence>;
  selection: HostedVersionDraftMoveSelection;
}>;
