import type { Pool } from 'pg';
import type { Actor } from '../../request/access.ts';
import type { ConversationActivityBatch } from '../conversation-activity.ts';
import type { FeedContentContextDependencies } from '../feed-context.ts';
import type { MediaDependencies } from '../media.ts';
import type { DocumentImagePresentation } from '../media-presentation.ts';
import type { AnchoredPosition, ReadContext } from '../model.ts';
import type { PostEntry, ThreadView } from '../reads.ts';
import type {
  ReadingPageActivity,
  ReadingPagePlace,
  ReadingPageMentions,
  ReadingPageReviewContext,
  ReadingPageDocumentSelection,
  ReadingPageDocumentMedia,
  SelectedReadingPageMentionInventory,
} from '../contract/index.ts';

export type ReadingPageCapabilities = Readonly<{
  publishedCitations(thread: ThreadView, replies: readonly PostEntry[]): ReadingPageReviewContext['citations'];
  selectActivity(
    producer: ConversationActivityBatch,
    place: ReadingPagePlace,
    deadline: number,
  ): Promise<
    Readonly<{
      confirm(): Promise<Readonly<{ value: ReadingPageActivity; anchors: readonly AnchoredPosition[] }>>;
    }>
  >;
  prepareReviewContext(
    dependencies: FeedContentContextDependencies,
    thread: ThreadView,
    replies: readonly PostEntry[],
    context: ReadContext,
  ): Promise<
    Readonly<{
      finish(): Promise<ReadingPageReviewContext | undefined>;
    }>
  >;
  readDocuments(
    dependencies: MediaDependencies & Readonly<{ routeKey: Uint8Array }>,
    actor: Actor,
    selection: ReadingPageDocumentSelection,
    deadline: number,
  ): Promise<ReadingPageDocumentMedia<DocumentImagePresentation>>;
  readMentions(
    pool: Pool,
    selection: SelectedReadingPageMentionInventory,
    deadline?: number,
  ): Promise<ReadingPageMentions>;
}>;

let bound: ReadingPageCapabilities | undefined;
export function bindReadingPageCapabilities(capabilities: ReadingPageCapabilities): void {
  bound = capabilities;
}
export function readingPageCapabilities(): ReadingPageCapabilities {
  if (!bound) throw new Error('Content reading-page capabilities are not bound');
  return bound;
}
