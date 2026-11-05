import type { KernelClient } from '@rezics/client';
import { parseDocument } from '@rezics/document';
import { readPageAuthors, type PageAuthor } from '../identity/read';
import type { ExactRevision } from '../threads/exact-revision';
import {
  loadRevisionDocumentMedia,
  revisionDocumentImageIds,
  type RevisionDocumentMedia,
} from '../threads/exact-revision-media';
import { threadTitle } from '../threads/thread-href';
import type { Report, ReportedRevision, ResolvedReportTarget } from './reports-read';

type Post = Pick<
  ExactRevision,
  | 'id'
  | 'threadId'
  | 'revisionId'
  | 'authorId'
  | 'createdAt'
  | 'revisedAt'
  | 'licence'
  | 'availability'
  | 'body'
  | 'mediaIds'
  | 'sha256'
>;
type State = 'available' | 'withheld' | 'erased' | 'unavailable';
type Thread = { id: string; boardId: string; title: string | null; post: Post };
type Board = { id: string; title: string | null };
export type ModerationEvidence = {
  moderationEvidence: {
    id: string;
    kind: Report['target']['kind'];
    state: State;
    post: Post | null;
    thread: { id: string; title: string | null } | null;
    board: Board | null;
    author: PageAuthor | null;
    documentMedia: RevisionDocumentMedia;
    exact: boolean;
    viewerId: string;
    now: string;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function resource(value: unknown, kind: Report['target']['kind']) {
  return record(record(value)?.[kind]);
}
function state(value: Record<string, unknown> | null, id: string): State {
  if (!uuid(id) || !value || value.id !== id) return 'unavailable';
  if (value.availability === 'withheld') return 'withheld';
  if (value.availability === 'erased' || value.availability === 'deleted') return 'erased';
  return value.availability === 'available' && !value.removed ? 'available' : 'unavailable';
}
function post(value: Record<string, unknown> | null, id: string, revisionId?: string): Post | null {
  if (state(value, id) !== 'available' || !value) return null;
  if (
    !uuid(value.id) ||
    !uuid(value.threadId) ||
    !uuid(value.revisionId) ||
    !uuid(value.authorId) ||
    (revisionId !== undefined && value.revisionId !== revisionId) ||
    !timestamp(value.createdAt) ||
    (value.revisedAt !== null && !timestamp(value.revisedAt)) ||
    typeof value.licence !== 'string' ||
    !value.licence ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Array.isArray(value.mediaIds) ||
    !value.mediaIds.every(uuid)
  )
    return null;
  try {
    return {
      id: value.id,
      threadId: value.threadId,
      revisionId: value.revisionId,
      authorId: value.authorId,
      createdAt: value.createdAt,
      revisedAt: value.revisedAt,
      licence: value.licence,
      availability: 'available',
      sha256: value.sha256,
      mediaIds: value.mediaIds,
      body: parseDocument(value.body),
    };
  } catch {
    return null;
  }
}
function thread(value: unknown, id: string): Thread | null {
  const data = resource(value, 'thread');
  if (
    !data ||
    state(data, id) !== 'available' ||
    !uuid(data.boardId) ||
    (data.title !== null && typeof data.title !== 'string')
  )
    return null;
  const opening = record(data.firstPost);
  const firstPost = opening && uuid(opening.id) ? post(opening, opening.id) : null;
  if (!firstPost || firstPost.threadId !== id) return null;
  return {
    id,
    boardId: data.boardId,
    title: threadTitle({
      title: typeof data.title === 'string' ? data.title : null,
    }),
    post: firstPost,
  };
}
function board(value: unknown, id: string): Board | null {
  const data = resource(value, 'board');
  return data && state(data, id) === 'available' && (data.title === null || typeof data.title === 'string')
    ? { id, title: data.title }
    : null;
}
export function moderationEvidence(value: unknown): ModerationEvidence['moderationEvidence'] | null {
  const envelope = record(value);
  return envelope && 'moderationEvidence' in envelope ? (envelope as ModerationEvidence).moderationEvidence : null;
}

/** One response's optional context. Only native current point reads can establish a parent destination. */
export async function enrichModerationTargets(
  client: KernelClient,
  targets: ResolvedReportTarget[],
  revisions: ReportedRevision[],
  reports: Report[],
  authorization: string,
  viewerId: string,
): Promise<{ targets: ResolvedReportTarget[]; revisions: ReportedRevision[] }> {
  const options = {
    headers: { authorization },
    fetch: { cache: 'no-store' as const },
  };
  const threads = new Map<string, Promise<Thread | null>>();
  const boards = new Map<string, Promise<Board | null>>();
  // Seed even denied target reads: duplicates never retry a denied source for context.
  for (const target of targets) {
    const id = target.key.slice(target.kind.length + 1);
    if (target.kind === 'thread') threads.set(id, Promise.resolve(thread(target.value, id)));
    if (target.kind === 'board') boards.set(id, Promise.resolve(board(target.value, id)));
  }
  const readThread = (id: string) => {
    if (!threads.has(id))
      threads.set(
        id,
        client
          .threads({ id })
          .get(options)
          .then((result) => (result.error ? null : thread(result.data, id)))
          .catch(() => null),
      );
    return threads.get(id)!;
  };
  const readBoard = (id: string) => {
    if (!boards.has(id))
      boards.set(
        id,
        client
          .boards({ id })
          .get(options)
          .then((result) => (result.error ? null : board(result.data, id)))
          .catch(() => null),
      );
    return boards.get(id)!;
  };
  const currentPosts = new Map<string, Post | null>();
  for (const target of targets)
    if (target.kind === 'post') {
      const id = target.key.slice('post:'.length);
      currentPosts.set(id, post(resource(target.value, 'post'), id));
    }
  const now = new Date().toISOString();
  const make = async (
    kind: Report['target']['kind'],
    id: string,
    value: unknown,
    revisionId?: string,
  ): Promise<ModerationEvidence> => {
    const data = resource(value, kind);
    let availability =
      revisionId !== undefined && data?.revisionId !== undefined && data.revisionId !== revisionId
        ? ('unavailable' as State)
        : state(data, id);
    let document = kind === 'post' ? post(data, id, revisionId) : null;
    let currentThread: Thread | null = null;
    let currentBoard: Board | null = null;
    if (availability === 'available') {
      if (kind === 'post') {
        if (!document) availability = 'unavailable';
        // The revision does not establish today's post-to-thread identity.
        const current = currentPosts.get(id);
        if (document && current && current.threadId === document.threadId)
          currentThread = await readThread(current.threadId);
      } else if (kind === 'thread') {
        currentThread = await readThread(id);
        document = currentThread?.post ?? null;
        if (!currentThread) {
          const opening = record(data?.firstPost);
          availability =
            opening && (opening.availability === 'erased' || opening.availability === 'withheld')
              ? opening.availability
              : 'unavailable';
        }
      } else {
        currentBoard = await readBoard(id);
        if (!currentBoard) availability = 'unavailable';
      }
      if (currentThread) currentBoard = await readBoard(currentThread.boardId);
    }
    if (availability !== 'available') document = null;
    return {
      moderationEvidence: {
        id,
        kind,
        state: availability,
        post: document,
        thread:
          availability === 'available' && currentThread ? { id: currentThread.id, title: currentThread.title } : null,
        board: availability === 'available' ? currentBoard : null,
        author: null,
        documentMedia: { kind: 'unavailable' },
        exact: revisionId !== undefined,
        viewerId,
        now,
      },
    };
  };
  const current = await Promise.all(
    targets.map(async (target) => ({
      ...target,
      value: await make(target.kind, target.key.slice(target.kind.length + 1), target.value),
    })),
  );
  const byReport = new Map(reports.map((report) => [report.id, report]));
  const immutable = new Map<string, Promise<ModerationEvidence>>();
  const reported = await Promise.all(
    revisions.map(async (revision) => {
      const report = byReport.get(revision.reportId);
      if (!report || report.target.kind !== 'post' || !report.revisionId) return { ...revision, value: null };
      const key = `${report.target.id}:${report.revisionId}`;
      if (!immutable.has(key)) immutable.set(key, make('post', report.target.id, revision.value, report.revisionId));
      return { ...revision, value: await immutable.get(key)! };
    }),
  );
  const evidence = [...current, ...reported].flatMap((target) =>
    target.value ? [target.value.moderationEvidence] : [],
  );
  const posts = evidence.flatMap((item) => (item.post ? [item.post] : []));
  // The existing batch reader has no options parameter; bind its one native request to this session.
  const identityClient = {
    accounts: {
      get: (input: Parameters<KernelClient['accounts']['get']>[0]) => client.accounts.get({ ...input, ...options }),
    },
  } as KernelClient;
  const [authors, media] = await Promise.all([
    readPageAuthors(
      identityClient,
      posts.map((item) => item.authorId),
    ),
    loadRevisionDocumentMedia(client, revisionDocumentImageIds(posts), authorization),
  ]);
  for (const item of evidence)
    if (item.post && item.state === 'available') {
      item.author = authors?.[item.post.authorId] ?? null;
      item.documentMedia = media;
    }
  return { targets: current, revisions: reported };
}
