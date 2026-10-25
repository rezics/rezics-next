import { expect, test } from 'bun:test';
import * as commands from '../../src/content/commands.ts';
import * as reads from '../../src/content/reads.ts';
import * as board from '../../src/content/board-projection.ts';
import * as media from '../../src/content/media.ts';
import * as moderation from '../../src/content/moderation.ts';
import * as reports from '../../src/content/reports.ts';
import * as reportEffect from '../../src/content/report-effect.ts';
import * as imageJob from '../../src/content/image-job.ts';
import * as collectionJob from '../../src/content/collection-job.ts';
import * as erasureJob from '../../src/content/erasure-job.ts';
import type { ContentCommandDependencies } from '../../src/content/commands.ts';
import type { BoardCandidate, BoardCandidateKey, BoardCandidatePage } from '../../src/content/board-projection.ts';
import type {
  MediaDependencies,
  MediaMetadata,
  MediaPurpose,
  MediaState,
  MediaStorage,
  MediaVariant,
} from '../../src/content/media.ts';
import type { ModerationDependencies, TakedownTarget } from '../../src/content/moderation.ts';
import type {
  ReportDependencies,
  ReportInput,
  ReportRequestContext,
  ReportTarget,
  ReportView,
} from '../../src/content/reports.ts';
import type { ImageJobOutcome } from '../../src/content/image-job.ts';
import type { CollectionOutcome } from '../../src/content/collection-job.ts';
import type { PurgeOutcome } from '../../src/content/erasure-job.ts';
import type { CommandOutcome } from '../../src/command/command.ts';
import type { Access, Actor, Resource } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import type {
  Anchored,
  AnchoredPosition,
  Availability,
  BoardView,
  Component,
  ContentCommandValue,
  ContentId,
  ItemMetadata,
  ItemView,
  Page,
  PostInput,
  ReadContext,
  RevisionInput,
  RevisionMetadata,
  RevisionView,
  RequestContext,
  SecurityRevision,
  ThreadInput,
  ThreadView,
  Visibility,
} from '../../src/content/model.ts';

const ports = [
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
  moderation.eraseAuthorScope,
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
];

type PublishedContentContracts = readonly [
  ContentCommandDependencies,
  CommandOutcome<ContentCommandValue>,
  Resource,
  Access,
  Actor,
  KeyRing,
  BoardCandidate,
  BoardCandidateKey,
  BoardCandidatePage,
  MediaDependencies,
  MediaMetadata,
  MediaPurpose,
  MediaState,
  MediaStorage,
  MediaVariant,
  ModerationDependencies,
  TakedownTarget,
  ReportDependencies,
  ReportInput,
  ReportRequestContext,
  ReportTarget,
  ReportView,
  ImageJobOutcome,
  CollectionOutcome,
  PurgeOutcome,
  Anchored<BoardView | null>,
  AnchoredPosition,
  Availability,
  Component,
  ContentId,
  ItemMetadata,
  ItemView,
  Page<ItemView>,
  PostInput,
  ReadContext,
  RevisionInput,
  RevisionMetadata,
  RevisionView,
  RequestContext,
  SecurityRevision,
  ThreadInput,
  ThreadView,
  Visibility,
];

const publishedContracts: PublishedContentContracts | null = null;
void publishedContracts;

type Port = (...args: never[]) => unknown;
test('content ports are published and fail closed before touching dependencies', async () => {
  let touches = 0;
  const dependency = new Proxy(
    {},
    {
      get() {
        touches += 1;
        throw new Error('content port touched a dependency');
      },
    },
  );
  const args = Array.from({ length: 8 }, () => dependency) as never[];
  for (const port of ports) {
    expect(typeof port).toBe('function');
    await expect(Promise.resolve().then(() => (port as Port)(...args))).rejects.toThrow(/unfinished/i);
  }
  expect(touches).toBe(0);
});
