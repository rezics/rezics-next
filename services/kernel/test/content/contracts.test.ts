import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import type { DocumentSnapshot } from '@rezics/document';
import type { NativePostRevisionPage } from '../../src/content/history-page.ts';
import type { CommunityPresentation } from '../../src/content/community-presentation-model.ts';
import type { CommandOutcome, CommandTransaction } from '../../src/command/command.ts';
import type { Effect } from '../../src/events/effects.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import type { Partition } from '../../src/partition/partition.ts';
import type { Access, Actor, Resource } from '../../src/request/access.ts';
import type { RealmParticipationCheck } from '../../src/community/participation.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import * as commands from '../../src/content/commands.ts';
import * as reads from '../../src/content/reads.ts';
import * as board from '../../src/content/board-projection.ts';
import * as media from '../../src/content/media.ts';
import * as moderation from '../../src/content/moderation.ts';
import * as operations from '../../src/content/operations.ts';
import * as erasePost from '../../src/content/erase-post.ts';
import type {
  AuthorErasureDependencies,
  AuthorErasureInput,
  BeginAuthorErasure,
  CommandRequestContext,
  ReadOperation,
} from '../../src/content/operation-contract.ts';
import * as reports from '../../src/content/reports.ts';
import * as reportEffect from '../../src/content/report-effect.ts';
import * as imageJob from '../../src/content/image-job.ts';
import * as collectionJob from '../../src/content/collection-job.ts';
import * as erasureJob from '../../src/content/erasure-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import type { DownloadContext } from '../../src/content/media-download.ts';
import type { TurnstileVerifier } from '../../src/content/turnstile.ts';
import type * as model from '../../src/content/model.ts';
import type { ImportedSource, Rights } from '../../src/content/imported-contract.ts';
import type { Kernel } from '../../src/http/kernel.ts';
import { MediaReservationInputSchema, RealmMediaReservationInputSchema } from '../../src/content/schemas.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function same<T extends true>(..._proof: T[]): void {}

type Command<I, V, D = commands.ContentCommandDependencies, C = model.RequestContext> = (
  dependencies: D,
  actor: Actor,
  input: I,
  context: C,
) => Promise<CommandOutcome<V>>;
type Ids = Readonly<{ threadId: string; itemId: string; revisionId: string }>;
type ModerationValue = Readonly<{ targetId: string; securityRevision: string }>;
type ReadItemFields = Omit<model.ItemView, 'availability' | 'body' | 'sha256'>;
type AvailableReadPayload = Readonly<{ availability: 'available'; body: DocumentSnapshot; sha256: string }>;
type ErasedReadPayload = Readonly<{
  availability: 'erased';
  removed: true;
  body: null;
  sha256: null;
  restorableUntil?: string;
}>;
type WithheldReadPayload = Readonly<{
  availability: 'withheld';
  removed: true;
  body: null;
  sha256: null;
  decisionId?: string;
}>;
type ErasedPagePlaceholder = model.ErasedPlaceholder & Readonly<{ restorableUntil?: string }>;
type ReadRevisionFields = Omit<model.RevisionView, 'availability' | 'body' | 'sha256'>;

// These consumers are intentionally uncalled: type checking must never execute a port.
function publishedSignatures(): void {
  same<Equal<typeof commands.threadTarget, (key: Uint8Array, accountId: string, idempotencyKey: string) => Resource>>();
  same<
    Equal<typeof commands.createThread, Command<model.ThreadInput & Readonly<{ mediaIds?: readonly string[] }>, Ids>>
  >();
  same<Equal<typeof commands.createPost, Command<model.PostInput, Ids>>>();
  same<Equal<typeof commands.revisePost, Command<model.RevisionInput, Ids>>>();
  same<
    Equal<
      typeof reads.readBoard,
      (
        deps: reads.ContentReadDependencies,
        id: string,
        context: model.ReadContext,
      ) => Promise<model.Anchored<model.BoardView | null>>
    >
  >();
  same<
    Equal<
      typeof reads.readThread,
      (
        deps: reads.ContentReadDependencies,
        id: string,
        context: model.ReadContext,
      ) => Promise<model.Anchored<reads.ThreadView | null>>
    >
  >();
  same<
    Equal<
      typeof reads.readPost,
      (
        deps: reads.ContentReadDependencies,
        threadId: string,
        postId: string,
        context: model.ReadContext,
        revisionId?: string,
      ) => Promise<model.Anchored<reads.PostEntry | null>>
    >
  >();
  same<
    Equal<
      typeof reads.listThreadPosts,
      (
        deps: reads.ContentReadDependencies,
        threadId: string,
        context: model.ReadContext,
        cursor?: string,
        limit?: number,
      ) => Promise<model.Page<reads.PostEntry>>
    >
  >();
  same<
    Equal<
      typeof reads.listPostRevisions,
      (
        deps: reads.ContentReadDependencies,
        threadId: string,
        postId: string,
        context: model.ReadContext,
        cursor?: string,
        limit?: number,
      ) => Promise<NativePostRevisionPage>
    >
  >();
  same<
    Equal<
      typeof reads.discloseThreads,
      (
        deps: reads.ContentReadDependencies,
        ids: readonly string[],
        context: model.ReadContext,
      ) => Promise<readonly model.Anchored<reads.ThreadView | null>[]>
    >
  >();
  same<Equal<typeof board.createBoardEffect, (pool: Pool) => Effect>>();
  same<
    Equal<
      typeof board.readBoardCandidates,
      (
        pool: Pool,
        boardId: string,
        after: board.BoardCandidateKey | null,
        limit: number,
      ) => Promise<board.BoardCandidatePage>
    >
  >();
  same<Equal<typeof board.applyBoardCandidate, (pool: Pool, candidate: board.BoardCandidate) => Promise<void>>>();
  same<
    Equal<
      typeof media.reserveMedia,
      (
        deps: media.MediaDependencies,
        actor: Actor,
        input: media.MediaReservationInput,
        context: model.RequestContext,
        newThreadTarget?: media.NewThreadMediaTarget,
      ) => Promise<CommandOutcome<Readonly<{ mediaId: string }>>>
    >
  >();
  same<
    Equal<
      typeof media.completeMedia,
      (
        deps: media.MediaDependencies,
        actor: Actor,
        mediaId: string,
        input: media.MediaCompletionInput,
        context: model.RequestContext,
      ) => Promise<CommandOutcome<Readonly<{ mediaId: string; state: 'uploaded' }>>>
    >
  >();
  same<
    Equal<
      typeof media.readReservation,
      (
        deps: media.MediaDependencies,
        mediaId: string,
        context: model.ReadContext,
      ) => Promise<media.MediaMetadata | null>
    >
  >();
  same<
    Equal<typeof media.claimMedia, (transaction: CommandTransaction, input: media.ClaimMediaInput) => Promise<void>>
  >();
  same<
    Equal<
      typeof media.decideDownload,
      (
        deps: media.MediaDependencies,
        mediaId: string,
        actor: Actor,
        variant: media.DownloadVariant,
      ) => Promise<media.DownloadDecision>
    >
  >();
  same<Equal<typeof media.readMediaState, (pool: Pool, mediaId: string) => Promise<media.MediaState | null>>>();
  same<Equal<typeof media.readCollectionFence, (pool: Pool, mediaId: string) => Promise<boolean | null>>>();
  same<
    Equal<
      typeof moderation.takedown,
      Command<moderation.TakedownInput, ModerationValue, moderation.ModerationDependencies>
    >
  >();
  // Initiation must retain receipt/request metadata, even before native work is wired.
  same<Equal<typeof operations.beginAuthorErasure, BeginAuthorErasure>>();
  same<Equal<typeof operations.readOperation, ReadOperation>>();
  same<
    Equal<
      typeof erasePost.erasePostLogical,
      Command<erasePost.ErasePostInput, { postId: string; securityRevision: string }, erasePost.ErasePostDependencies>
    >
  >();
  same<
    Equal<
      typeof moderation.eraseStandaloneMedia,
      Command<moderation.EraseStandaloneMediaInput, ModerationValue, moderation.ModerationDependencies>
    >
  >();
  same<
    Equal<
      typeof reports.createReport,
      Command<
        reports.ReportInput,
        Readonly<{ reportId: string }>,
        reports.ReportDependencies,
        reports.ReportRequestContext
      >
    >
  >();
  same<
    Equal<
      typeof reports.readReport,
      (
        deps: reports.ReportDependencies,
        id: string,
        context: model.ReadContext,
      ) => Promise<model.Anchored<reports.ReportView | null>>
    >
  >();
  same<
    Equal<
      typeof reports.listTargetReports,
      (
        deps: reports.ReportDependencies,
        target: reports.ReportTarget,
        context: model.ReadContext,
        cursor?: string,
        limit?: number,
      ) => Promise<model.Page<reports.ReportView>>
    >
  >();
  same<Equal<typeof reportEffect.createReportEffect, (pool: Pool) => Effect>>();
  same<Equal<typeof reportEffect.applyReportEffect, (pool: Pool, event: CloudEvent) => Promise<void>>>();
  same<Equal<typeof imageJob.createImageJob, (pool: Pool, storage: MediaStorage) => imageJob.ImageJob>>();
  same<
    Equal<
      typeof imageJob.processImage,
      (pool: Pool, storage: MediaStorage, mediaId: string) => Promise<imageJob.ImageJobOutcome>
    >
  >();
  same<Equal<imageJob.ImageJob, Readonly<{ process(mediaId: string): Promise<imageJob.ImageJobOutcome> }>>>();
  same<
    Equal<
      typeof collectionJob.createCollectionJob,
      (
        pool: Pool,
        storage: MediaStorage,
        configuration?: Readonly<{ clock?: () => Date }>,
      ) => collectionJob.CollectionJob
    >
  >();
  same<
    Equal<
      typeof collectionJob.collectPartition,
      (
        pool: Pool,
        storage: MediaStorage,
        partition: number,
        batchSize: number,
      ) => Promise<collectionJob.CollectionOutcome>
    >
  >();
  same<
    Equal<
      collectionJob.CollectionJob,
      Readonly<{ collectPartition(partition: number, batchSize: number): Promise<collectionJob.CollectionOutcome> }>
    >
  >();
  same<Equal<typeof erasureJob.createErasureJob, (pool: Pool, storage: MediaStorage) => erasureJob.ErasureJob>>();
  same<
    Equal<
      typeof erasureJob.purgeObject,
      (pool: Pool, storage: MediaStorage, mediaId: string) => Promise<erasureJob.PurgeOutcome>
    >
  >();
  same<Equal<erasureJob.ErasureJob, Readonly<{ purgeObject(mediaId: string): Promise<erasureJob.PurgeOutcome> }>>>();
}

function publishedModels(): void {
  // Comparing ports with CommandOutcome alone would miss changes to the shared
  // envelope itself, including loss of native position or receipt metadata.
  same<
    Equal<
      CommandOutcome<Ids>,
      {
        value: Ids;
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
        replayed: boolean;
      }
    >
  >();
  same<
    Equal<
      commands.ContentCommandDependencies,
      Readonly<{
        pool: Pool;
        access: Access;
        routeKey: Uint8Array;
        realmParticipation?: RealmParticipationCheck;
        clock?: () => Date;
      }>
    >
  >();
  same<
    Equal<reads.ContentReadDependencies, Readonly<{ pool: Pool; access: Access; tokens: KeyRing; clock?: () => Date }>>
  >();
  same<
    Equal<
      media.MediaDependencies,
      Readonly<{
        pool: Pool;
        access: Access;
        realmParticipation?: RealmParticipationCheck;
        clock?: () => Date;
        downloadContext?: DownloadContext;
      }>
    >
  >();
  same<Equal<model.ContentCommandValue, Ids>>();
  same<Equal<model.RequestContext, Readonly<{ idempotencyKey: string; deadline: number; requestId: string }>>>();
  same<Equal<model.ReadContext, Readonly<{ actor: Actor; deadline: number }>>>();
  same<Equal<model.SecurityRevision, string>>();
  same<
    Equal<
      model.ThreadView['securityRevision'] | model.ItemView['securityRevision'] | model.BoardView['securityRevision'],
      string
    >
  >();
  same<Equal<model.AnchoredPosition, Readonly<{ partition: Partition; epoch: number; position: bigint }>>>();
  same<
    Equal<model.Component, Readonly<{ partition: number; epoch: number; position: bigint; transactionId: string }>>
  >();
  same<Equal<model.Anchored<model.ItemView>, Readonly<{ value: model.ItemView; anchor: model.AnchoredPosition }>>>();
  same<
    Equal<
      model.Page<model.ItemView>,
      Readonly<{ entries: readonly model.ItemView[]; nextCursor: string | null; anchor: model.AnchoredPosition }>
    >
  >();
  same<
    Equal<
      model.ThreadInput,
      Readonly<{
        title: string;
        body: unknown;
        licence: string;
        subjectIds: readonly string[];
        boardId: string;
        visibility: 'published' | 'draft' | 'protected';
        kind?: 'discussion' | 'review';
        voteCitation?: model.ReviewVoteCitation;
      }>
    >
  >();
  same<
    Equal<
      model.PostInput,
      Readonly<{
        threadId: string;
        visibility?: 'published' | 'draft' | 'protected';
        body: unknown;
        licence: string;
        subjectIds?: readonly string[];
        boardId?: string;
        parentId?: string | null;
        mediaIds?: readonly string[];
      }>
    >
  >();
  same<
    Equal<
      model.RevisionInput,
      Readonly<{
        threadId: string;
        title?: string;
        visibility?: 'published' | 'draft';
        itemId: string;
        body: unknown;
        licence?: string;
        subjectIds?: readonly string[];
        boardId?: string;
        mediaIds?: readonly string[];
        expectedRevisionId?: string | null;
        voteCitation?: model.ReviewVoteCitation;
      }>
    >
  >();
  same<
    Equal<
      Pick<model.ItemMetadata, 'licence' | 'subjectIds' | 'boardId' | 'sha256' | 'mediaIds'>,
      Pick<model.RevisionMetadata, 'licence' | 'subjectIds' | 'boardId' | 'sha256' | 'mediaIds'>
    >
  >();
  same<
    Equal<
      model.ItemMetadata,
      Readonly<{
        id: string;
        threadId: string;
        route: number;
        authorId: string;
        parentId: string | null;
        licence: string;
        subjectIds: readonly string[];
        boardId: string;
        visibility: 'published' | 'draft' | 'protected' | 'taken_down';
        securityRevision: string;
        availability: 'available' | 'erased';
        createdAt: string;
        revisedAt: string | null;
        sha256: string;
        mediaIds: readonly string[];
        voteCitation: model.ReviewVoteCitation | null;
      }>
    >
  >();
  same<
    Equal<
      model.RevisionMetadata,
      Readonly<{
        id: string;
        itemId: string;
        threadId: string;
        route: number;
        authorId: string;
        licence: string;
        subjectIds: readonly string[];
        boardId: string;
        createdAt: string;
        revisedAt: string | null;
        sha256: string;
        mediaIds: readonly string[];
        voteCitation: model.ReviewVoteCitation | null;
      }>
    >
  >();
  same<
    Equal<
      model.ThreadView,
      Readonly<{
        id: string;
        route: number;
        authorId: string;
        kind: 'discussion' | 'review';
        title: string | null;
        licence: string;
        subjectIds: readonly string[];
        boardId: string;
        visibility: model.Visibility;
        securityRevision: string;
        availability: model.Availability;
        createdAt: string;
        firstPost: model.PostEntry;
      }>
    >
  >();
  same<
    Equal<
      model.BoardView,
      Readonly<{
        id: string;
        realmId: string | null;
        community: CommunityPresentation | null;
        route: number;
        title: string | null;
        purpose: 'discussion' | 'reviews';
        visibility: model.Visibility;
        securityRevision: string;
        availability: model.Availability;
        createdAt: string;
      }>
    >
  >();
  same<Equal<reads.ItemView, ReadItemFields & (AvailableReadPayload | ErasedReadPayload)>>();
  same<Equal<reads.WithheldPostEntry, ReadItemFields & WithheldReadPayload>>();
  same<Equal<reads.RevisionView, ReadRevisionFields & (AvailableReadPayload | ErasedReadPayload)>>();
  same<
    Equal<
      model.ErasedPlaceholder,
      Readonly<{
        id: string;
        threadId: string;
        route: number;
        parentId: string | null;
        removed: true;
        availability: 'erased';
        body: null;
        sha256: null;
      }>
    >
  >();
  same<Equal<model.PostEntry, model.ItemView | model.ErasedPlaceholder>>();
  same<Equal<reads.PostEntry, reads.ItemView | ErasedPagePlaceholder | reads.WithheldPostEntry>>();
  same<
    Equal<
      typeof model.isErasedPlaceholder,
      (
        entry: Readonly<{ availability: model.Availability | 'withheld'; revisionId?: string }>,
      ) => entry is model.ErasedPlaceholder
    >
  >();
  same<Equal<reads.ThreadView, Omit<model.ThreadView, 'firstPost'> & Readonly<{ firstPost: reads.PostEntry }>>>();
  same<Equal<media.NewThreadMediaTarget, Readonly<{ thread: Resource; boardId: string }>>>();
  same<Equal<moderation.ModerationValue, ModerationValue>>();
  same<Equal<keyof model.ItemView, keyof model.ItemMetadata | 'revisionId' | 'body'>>();
  same<
    Equal<
      keyof model.ErasedPlaceholder,
      'id' | 'threadId' | 'route' | 'parentId' | 'removed' | 'availability' | 'body' | 'sha256'
    >
  >();
  same<Equal<keyof model.RevisionView, keyof model.RevisionMetadata | 'availability' | 'body'>>();
  same<Equal<board.BoardCandidateKey, Readonly<{ createdAt: string; id: string }>>>();
  same<
    Equal<
      board.BoardCandidate,
      Readonly<{ id: string; boardId: string; createdAt: string; epoch: number; position: bigint }>
    >
  >();
  same<
    Equal<
      board.BoardCandidatePage,
      Readonly<{
        candidates: readonly board.BoardCandidate[];
        next: board.BoardCandidateKey | null;
        epoch: number;
        position: bigint;
      }>
    >
  >();
  same<
    Equal<
      imageJob.ImageJobOutcome,
      Readonly<{
        mediaId: string;
        state: 'available' | 'rejected' | 'already_terminal';
        variants: readonly media.MediaVariant[];
      }>
    >
  >();
  same<
    Equal<
      collectionJob.CollectionOutcome,
      Readonly<{ partition: number; examined: number; collected: number; complete: boolean }>
    >
  >();
  same<
    Equal<erasureJob.PurgeOutcome, Readonly<{ mediaId: string; outcome: 'purged' | 'already_absent' | 'fenced' }>>
  >();
  same<Equal<model.ItemView['revisionId'], string>>();
  same<Equal<Pick<model.ItemView, 'body' | 'availability'>, Pick<model.RevisionView, 'body' | 'availability'>>>();
  same<Equal<Extract<model.ItemView, { availability: 'available' }>['body'], DocumentSnapshot>>();
  same<Equal<Extract<model.ItemView, { availability: 'erased' }>['body'], null>>();
  same<Equal<Extract<model.RevisionView, { availability: 'available' }>['body'], DocumentSnapshot>>();
  same<Equal<Extract<model.RevisionView, { availability: 'erased' }>['body'], null>>();
  same<Equal<model.ItemView['availability'] | model.RevisionView['availability'], 'available' | 'erased'>>();
  type Body<V> = V extends { readonly body: infer B; readonly availability: infer A }
    ? Readonly<{ body: B; availability: A }>
    : never;
  type AuthoredBody =
    | Readonly<{ body: DocumentSnapshot; availability: 'available' }>
    | Readonly<{ body: null; availability: 'erased' }>;
  same<Equal<Body<model.ItemView>, AuthoredBody>>();
  same<Equal<Body<model.RevisionView>, AuthoredBody>>();
  same<
    Equal<
      media.MediaReservationInput,
      Readonly<{
        purpose: 'post-image' | 'avatar' | 'realm-icon' | 'realm-banner';
        mediaType: string;
        byteCount: number;
        sha256?: string;
      }> &
        (
          | Readonly<{ containerId: string; newThread?: never }>
          | Readonly<{
              purpose: 'post-image';
              newThread: Readonly<{ boardId: string; idempotencyKey: string }>;
              containerId?: never;
            }>
        )
    >
  >();
  // Native reservation serves both routes; the generic HTTP input keeps its narrower purposes.
  type ImageMediaType = 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  type GenericReservation = Kernel['~Routes']['v1']['media']['post'];
  type RealmReservation = Kernel['~Routes']['v1']['realms'][':realmId']['media']['post'];
  same<
    Equal<
      GenericReservation['body'],
      | {
          containerId: string;
          purpose: 'post-image' | 'avatar';
          mediaType: ImageMediaType;
          byteCount: number;
          sha256?: string;
        }
      | {
          newThread: { boardId: string; idempotencyKey: string };
          purpose: 'post-image';
          mediaType: ImageMediaType;
          byteCount: number;
          sha256?: string;
        }
    >
  >();
  same<Equal<RealmReservation['params'], { realmId: string }>>();
  same<
    Equal<
      RealmReservation['body'],
      { purpose: 'realm-icon' | 'realm-banner'; mediaType: ImageMediaType; byteCount: number; sha256?: string }
    >
  >();
  same<
    Equal<
      media.MediaCompletionInput,
      Readonly<{ containerId: string; reservationRequestId: string; byteCount: number; sha256: string }>
    >
  >();
  same<
    Equal<
      media.ClaimMediaInput,
      Readonly<{ mediaIds: readonly string[]; containerId: string; author: Actor; boardId?: string }> &
        (
          | Readonly<{ itemId: string; revisionId: string; reference?: never }>
          | Readonly<{
              reference: Readonly<{
                kind: 'semantic_candidate';
                subjectId: string;
                candidateId: string;
                revision: number;
              }>;
              itemId?: never;
              revisionId?: never;
            }>
        )
    >
  >();
  same<Equal<media.DownloadVariant, 'original' | `webp-${number}` | `avif-${number}`>>();
  same<
    Equal<
      media.DownloadDecision,
      | Readonly<{ allowed: false }>
      | Readonly<{
          allowed: true;
          key: string;
          sha256: string;
          mediaType: string;
          byteCount: number;
          publicCache: false;
          cacheControl: 'private, no-cache' | 'private, no-store';
        }>
    >
  >();
  same<
    Equal<
      media.MediaVariant,
      Readonly<{
        format: 'webp' | 'avif';
        width: number;
        height: number;
        mediaType: string;
        byteCount: number;
        sha256: string;
        key: string;
      }>
    >
  >();
  type MediaMetadataBase = Readonly<{
    id: string;
    key: string;
    containerId: string;
    uploaderId: string;
    route: number;
    reservationRequestId: string;
    declaredSha256?: string;
    sha256: string | null;
    state: 'reserved' | 'uploaded' | 'available' | 'rejected';
    claimedAt: string | null;
    erased: boolean;
    takenDown: boolean;
    securityRevision: string;
    collectionPending: boolean;
    createdAt: string;
    decision: string | null;
    variants: readonly media.MediaVariant[];
  }>;
  same<
    Equal<
      media.MediaMetadata,
      | (MediaMetadataBase &
          Readonly<{
            purpose: 'post-image' | 'avatar' | 'realm-icon' | 'realm-banner';
            mediaType: string;
            byteCount: number;
          }>)
      | (MediaMetadataBase &
          Readonly<{
            purpose: 'cover';
            mediaType: string | null;
            byteCount: number | null;
            rights: Rights;
            source: ImportedSource;
          }>)
    >
  >();
  same<Equal<media.MediaStorage, MediaStorage>>();
  same<Equal<keyof MediaStorage, 'get' | 'put' | 'deletePrefix'>>();
  same<Equal<MediaStorage['get'], (key: string) => Promise<Uint8Array | null>>>();
  same<Equal<MediaStorage['put'], (key: string, bytes: Uint8Array, options: { mediaType: string }) => Promise<void>>>();
  same<Equal<MediaStorage['deletePrefix'], (prefix: string) => Promise<void>>>();
  same<
    Equal<
      reports.ReportTarget,
      | Readonly<{ kind: 'board'; id: string }>
      | Readonly<{ kind: 'thread'; id: string }>
      | Readonly<{ kind: 'post'; id: string }>
      | Readonly<{ kind: 'subject'; id: string }>
      | Readonly<{ kind: 'space'; id: string }>
      | Readonly<{ kind: 'realm'; id: string }>
    >
  >();
  same<
    Equal<
      reports.ReportInput,
      Readonly<{ target: reports.ReportTarget; revisionId?: string; reason: string; evidence?: string }>
    >
  >();
  same<
    Equal<
      reports.ReportView,
      Readonly<{
        id: string;
        partition: number;
        target: reports.ReportTarget;
        revisionId: string | null;
        reason: string;
        evidence: string | null;
        createdAt: string;
        outcome: 'actioned' | 'dismissed' | null;
        resolvedAt: string | null;
        transactionId: string;
        reporterId: string | null;
      }>
    >
  >();
  same<
    Equal<
      reports.ReportDependencies,
      Readonly<{
        pool: Pool;
        access: Access;
        routeKey: Uint8Array;
        clock?: () => Date;
        anonymousVerifier?: TurnstileVerifier;
      }>
    >
  >();
  same<
    Equal<
      moderation.ModerationDependencies,
      Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array; clock?: () => Date }>
    >
  >();
  same<
    Equal<
      moderation.TakedownTarget,
      | Readonly<{ kind: 'board'; id: string }>
      | Readonly<{ kind: 'thread'; id: string }>
      | Readonly<{ kind: 'post'; id: string }>
    >
  >();
  same<Equal<moderation.TakedownInput, Readonly<{ target: moderation.TakedownTarget; reason: string }>>>();
  same<Equal<AuthorErasureInput, Readonly<{ threadId: string; authorId: string }>>>();
  same<
    Equal<
      CommandRequestContext,
      Readonly<{ deadline: number }> & Readonly<{ idempotencyKey: string; requestId: string }>
    >
  >();
  same<
    Equal<Parameters<BeginAuthorErasure>, [AuthorErasureDependencies, Actor, AuthorErasureInput, CommandRequestContext]>
  >();
  same<Equal<ReturnType<BeginAuthorErasure>, Promise<CommandOutcome<{ operationId: string }>>>>();
  same<Equal<erasePost.ErasePostInput, Readonly<{ postId: string; reason: string }>>>();
  same<Equal<erasePost.ErasePostContext, model.RequestContext>>();
  same<
    Equal<
      erasePost.ErasePostDependencies,
      Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array; clock?: () => Date }>
    >
  >();
  same<Equal<moderation.EraseStandaloneMediaInput, Readonly<{ mediaId: string; reason: string }>>>();
  same<Equal<reports.ReportRequestContext, model.RequestContext & Readonly<{ botToken?: string }>>>();
}
void [publishedSignatures, publishedModels];

test('Realm media reservation keeps its own strict purpose and route-owned parent input', () => {
  const fields = { mediaType: 'image/png', byteCount: 10 };
  const containerId = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
  for (const purpose of ['realm-icon', 'realm-banner']) {
    const input = { purpose, ...fields };
    expect(Value.Check(RealmMediaReservationInputSchema, input)).toBe(true);
    expect(Value.Check(RealmMediaReservationInputSchema, { ...input, sha256: 'a'.repeat(64) })).toBe(true);
    expect(Value.Check(MediaReservationInputSchema, { ...input, containerId })).toBe(false);
    for (const extra of [
      { containerId },
      { newThread: { boardId: containerId, idempotencyKey: 'thread' } },
      { unexpected: true },
    ]) {
      expect(Value.Check(RealmMediaReservationInputSchema, { ...input, ...extra })).toBe(false);
    }
    expect(Value.Check(RealmMediaReservationInputSchema, { purpose, byteCount: 10 })).toBe(false);
    expect(Value.Check(RealmMediaReservationInputSchema, { purpose, mediaType: 'image/png' })).toBe(false);
  }
  for (const purpose of ['post-image', 'avatar', 'cover', 'bad-purpose']) {
    expect(Value.Check(RealmMediaReservationInputSchema, { purpose, ...fields })).toBe(false);
  }
});

test('named content ports are exported', () => {
  for (const port of [
    commands.threadTarget,
    commands.createThread,
    commands.createPost,
    commands.revisePost,
    reads.readBoard,
    reads.readThread,
    reads.readPost,
    reads.listThreadPosts,
    reads.listPostRevisions,
    reads.discloseThreads,
    board.createBoardEffect,
    board.readBoardCandidates,
    board.applyBoardCandidate,
    media.reserveMedia,
    media.completeMedia,
    media.readReservation,
    media.claimMedia,
    media.decideDownload,
    media.readMediaState,
    media.readCollectionFence,
    moderation.takedown,
    operations.beginAuthorErasure,
    operations.readOperation,
    erasePost.erasePostLogical,
    moderation.eraseStandaloneMedia,
    reports.createReport,
    reports.readReport,
    reports.listTargetReports,
    reportEffect.createReportEffect,
    reportEffect.applyReportEffect,
    imageJob.createImageJob,
    imageJob.processImage,
    collectionJob.createCollectionJob,
    collectionJob.collectPartition,
    erasureJob.createErasureJob,
    erasureJob.purgeObject,
  ]) {
    expect(typeof port).toBe('function');
  }
});
