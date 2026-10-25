import type { DocumentSnapshot } from '@rezics/document';
import type { CommandBasis } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
import type { Partition } from '../partition/partition.ts';

export type ContentId = string;
export type BoardId = ContentId;
export type ThreadId = ContentId;
export type PostId = ContentId;
export type RevisionId = ContentId;
export type ReportId = ContentId;
export type MediaId = ContentId;
export type Route = number;

export type ItemMetadata = Readonly<{
  id: PostId;
  threadId: ThreadId;
  route: Route;
  authorId: ContentId;
  parentId: PostId | null;
  licence: string;
  subjectIds: readonly ContentId[];
  boardId: BoardId;
  visibility: Visibility;
  securityRevision: number;
  availability: Availability;
  createdAt: string;
}>;

export type RevisionMetadata = Readonly<{
  id: RevisionId;
  itemId: PostId;
  threadId: ThreadId;
  route: Route;
  authorId: ContentId;
  licence: string;
  subjectIds: readonly ContentId[];
  boardId: BoardId;
  createdAt: string;
}>;

export type ItemView = Readonly<
  ItemMetadata & { revisionId: RevisionId } & ({ body: DocumentSnapshot; erased: false } | { body: null; erased: true })
>;

export type RevisionView = Readonly<
  RevisionMetadata & ({ body: DocumentSnapshot; erased: false } | { body: null; erased: true })
>;

export type ThreadView = Readonly<{
  id: ThreadId;
  route: Route;
  authorId: ContentId;
  title: string;
  licence: string;
  subjectIds: readonly ContentId[];
  boardId: BoardId;
  visibility: Visibility;
  securityRevision: number;
  availability: Availability;
  createdAt: string;
  firstPost: ItemView;
}>;

export type BoardView = Readonly<{
  id: BoardId;
  route: Route;
  title: string;
  createdAt: string;
}>;

export type Visibility = 'published' | 'draft' | 'protected' | 'taken_down';
export type Availability = 'available' | 'erased';

export type ThreadInput = Readonly<{
  title: string;
  body: unknown;
  licence: string;
  subjectIds: readonly ContentId[];
  boardId: BoardId;
  visibility: 'published' | 'draft';
}>;

export type PostInput = Readonly<{
  threadId: ThreadId;
  body: unknown;
  licence: string;
  subjectIds?: readonly ContentId[];
  boardId?: BoardId;
  parentId?: PostId | null;
}>;

export type RevisionInput = Readonly<{
  threadId: ThreadId;
  itemId: PostId;
  body: unknown;
  licence?: string;
  subjectIds?: readonly ContentId[];
  boardId?: BoardId;
}>;

export type RequestContext = Readonly<{
  basis: Readonly<CommandBasis> | null;
  requestId: string;
  idempotencyKey: string;
}>;

export type CommandReceipt<TId extends ContentId = ContentId> = Readonly<{
  receiptId: string;
  id: TId;
  itemId?: PostId;
  revisionId?: RevisionId;
}>;

export type CommandResult<TId extends ContentId = ContentId> = Readonly<{
  receipt: CommandReceipt<TId>;
  componentId?: ContentId;
  itemId?: PostId;
  revisionId?: RevisionId;
}>;

export type AnchoredPosition = Readonly<{
  partition: Partition;
  epoch: number;
  position: bigint;
}>;

export type Anchored<T> = Readonly<{ value: T; anchor: AnchoredPosition }>;

export type ReadContext = Readonly<{ actor: Actor; deadline: number }>;

export type Page<T> = Readonly<{
  entries: readonly T[];
  nextCursor: string | null;
  anchor: AnchoredPosition;
}>;

export type UnfinishedPortError = Error & { readonly port: string };

export function unfinishedPort(port: string): UnfinishedPortError {
  const error = new Error(`Content port is unfinished: ${port}`) as UnfinishedPortError;
  error.name = 'UnfinishedPortError';
  Object.defineProperty(error, 'port', { value: port, enumerable: true });
  return error;
}
