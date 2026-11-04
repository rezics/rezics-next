import { Button } from '@rezics/ui/shadcn/button';
import { createServerFn } from '@tanstack/react-start';
import { useRef, useState } from 'react';
import { readMyRealmsPageForReview, type ReviewMyRealmsRead } from '../community/space-actions';
import type { RealmLink } from '../community/space';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from '../threads/composer';
import { readReviewDestination } from '../threads/review-destination/server';
import type { ReviewDestinationPage } from '../threads/review-board-choices';
import { reviewThreadHref } from '../threads/review-policy';
import {
  beginReviewEntryRead,
  cancelReviewEntryRead,
  claimReviewEntryNavigation,
  expectedReviewReader,
  finishReviewEntryRead,
  sameReviewReader,
  reviewEntryReadIsCurrent,
  reviewEntryVisitIsCurrent,
  useWriteReviewVisit,
  type ReviewEntryReadTicket,
  type ReviewReaderProvenance,
} from './write-review-lifetime';

export const REALM_PAGE_LIMIT = 20;

type RealmReadState =
  | { state: 'idle' }
  | { state: 'loading'; cursor?: string }
  | { state: 'failed'; cursor?: string; expired: boolean }
  | { state: 'ready'; realms: RealmLink[]; next: string | null };
type BoardReadState =
  | { state: 'idle' }
  | { state: 'loading'; cursor?: string }
  | { state: 'failed'; cursor?: string; expired: boolean }
  | { state: 'ready'; page: ReviewDestinationPage; cursor?: string };
type InspectionState = { state: 'idle' | 'loading' | 'failed' | 'denied' | 'changed'; boardId?: string };
type ReaderResult =
  | { kind: 'ready'; page: ReviewDestinationPage; provenance: ReviewReaderProvenance }
  | { kind: 'mismatch' };

function sameSource(
  left: Readonly<{ partition: number; epoch: number; position: string }>,
  right: Readonly<{ partition: number; epoch: number; position: string }>,
) {
  return left.partition === right.partition && left.epoch === right.epoch && left.position === right.position;
}

function WriteReviewVisitView({ visit }: { visit: ReturnType<typeof useWriteReviewVisit> }) {
  const [expanded, setExpanded] = useState(false);
  const [realms, setRealms] = useState<RealmReadState>({ state: 'idle' });
  const [selectedRealm, setSelectedRealm] = useState<RealmLink | null>(null);
  const [boards, setBoards] = useState<BoardReadState>({ state: 'idle' });
  const [inspection, setInspection] = useState<InspectionState>({ state: 'idle' });
  const tickets = useRef<{ realms: ReviewEntryReadTicket | null; boards: ReviewEntryReadTicket | null }>({
    realms: null,
    boards: null,
  });

  function retireRead(kind: 'realms' | 'boards') {
    const previous = tickets.current[kind];
    if (previous) cancelReviewEntryRead(previous);
    tickets.current[kind] = null;
  }

  function openChooser() {
    if (!reviewEntryVisitIsCurrent(visit)) return;
    setExpanded(true);
    if (realms.state === 'idle') void readRealms(undefined);
  }

  async function readRealms(cursor: string | undefined) {
    retireRead('realms');
    const ticket = beginReviewEntryRead(visit, 'realms');
    if (!ticket) {
      setRealms({ state: 'failed', ...(cursor === undefined ? {} : { cursor }), expired: false });
      return;
    }
    tickets.current.realms = ticket;
    setRealms({ state: 'loading', ...(cursor === undefined ? {} : { cursor }) });
    try {
      const expected = await expectedReviewReader(ticket.visit);
      if (!reviewEntryReadIsCurrent(ticket)) return;
      const result = (await readMyRealmsPageForReview({
        data: { expected, ...(cursor ? { cursor } : {}) },
        signal: ticket.controller.signal,
      })) as ReviewMyRealmsRead;
      if (!reviewEntryReadIsCurrent(ticket)) return;
      if (result.kind !== 'ready' || !result.page.signedIn || !sameReviewReader(expected, result.provenance)) {
        setRealms({ state: 'failed', ...(cursor === undefined ? {} : { cursor }), expired: false });
      } else if (result.page.cursorExpired) {
        setRealms({ state: 'failed', ...(cursor === undefined ? {} : { cursor }), expired: true });
      } else {
        setRealms({ state: 'ready', realms: result.page.realms.slice(0, REALM_PAGE_LIMIT), next: result.page.next });
      }
    } catch {
      if (reviewEntryReadIsCurrent(ticket))
        setRealms({ state: 'failed', ...(cursor === undefined ? {} : { cursor }), expired: false });
    } finally {
      finishReviewEntryRead(ticket);
      if (tickets.current.realms === ticket) tickets.current.realms = null;
    }
  }

  async function readBoardPage(realm: RealmLink, cursor: string | undefined) {
    retireRead('boards');
    const ticket = beginReviewEntryRead(visit, 'boards');
    if (!ticket) {
      setBoards({ state: 'failed', ...(cursor === undefined ? {} : { cursor }), expired: false });
      return;
    }
    tickets.current.boards = ticket;
    setInspection({ state: 'idle' });
    setBoards({ state: 'loading', ...(cursor === undefined ? {} : { cursor }) });
    try {
      const expected = await expectedReviewReader(ticket.visit);
      if (!reviewEntryReadIsCurrent(ticket)) return;
      const result = (await readReviewDestination({
        data: {
          realmId: realm.realmId,
          subjectId: ticket.visit.target.subjectId,
          locale: ticket.visit.target.locale,
          ...(cursor === undefined ? {} : { cursor }),
          expected,
        },
        signal: ticket.controller.signal,
      })) as ReaderResult;
      if (!reviewEntryReadIsCurrent(ticket)) return;
      if (result.kind !== 'ready' || !sameReviewReader(expected, result.provenance)) {
        setBoards({ state: 'failed', ...(cursor === undefined ? {} : { cursor }), expired: false });
      } else {
        setBoards({ state: 'ready', page: result.page, ...(cursor === undefined ? {} : { cursor }) });
      }
    } catch {
      if (reviewEntryReadIsCurrent(ticket))
        setBoards({ state: 'failed', ...(cursor === undefined ? {} : { cursor }), expired: false });
    } finally {
      finishReviewEntryRead(ticket);
      if (tickets.current.boards === ticket) tickets.current.boards = null;
    }
  }

  function chooseRealm(realm: RealmLink) {
    if (!reviewEntryVisitIsCurrent(visit) || selectedRealm?.realmId === realm.realmId) return;
    retireRead('boards');
    setSelectedRealm(realm);
    setBoards({ state: 'idle' });
    setInspection({ state: 'idle' });
    void readBoardPage(realm, undefined);
  }

  async function chooseBoard(board: ReviewDestinationPage['items'][number]) {
    const realm = selectedRealm;
    if (!realm || !reviewEntryVisitIsCurrent(visit)) return;
    retireRead('boards');
    const ticket = beginReviewEntryRead(visit, 'boards');
    if (!ticket) {
      setInspection({ state: 'failed', boardId: board.id });
      return;
    }
    tickets.current.boards = ticket;
    setInspection({ state: 'loading', boardId: board.id });
    try {
      const expected = await expectedReviewReader(ticket.visit);
      if (!reviewEntryReadIsCurrent(ticket)) return;
      const result = (await readReviewDestination({
        data: {
          realmId: realm.realmId,
          subjectId: board.native.subjectIds[0],
          boardId: board.native.boardId,
          locale: ticket.visit.target.locale,
          expected,
        },
        signal: ticket.controller.signal,
      })) as ReaderResult;
      if (!reviewEntryReadIsCurrent(ticket)) return;
      if (result.kind !== 'ready' || !sameReviewReader(expected, result.provenance)) {
        setInspection({ state: 'failed', boardId: board.id });
        return;
      }
      const current = result.page.items[0];
      const inspectedContext = result.page.context;
      const identityIsSame =
        result.page.state === 'choices' &&
        inspectedContext !== null &&
        inspectedContext.subject.id === ticket.visit.target.subjectId &&
        inspectedContext.realm.id === realm.realmId &&
        current?.id === board.id &&
        current.native.boardId === board.native.boardId &&
        current.native.subjectIds[0] === board.native.subjectIds[0] &&
        sameSource(current.native.subjectSource, board.native.subjectSource) &&
        current.native.realmHeadRevisionId === board.native.realmHeadRevisionId &&
        current.native.boardSecurityRevision === board.native.boardSecurityRevision;
      if (!identityIsSame) {
        setInspection({ state: result.page.viewer.state === 'denied' ? 'denied' : 'changed', boardId: board.id });
        return;
      }
      if (!claimReviewEntryNavigation(ticket)) return;
      window.location.assign(
        reviewThreadHref(
          ticket.visit.target.locale,
          board.native.boardId,
          board.native.subjectIds[0],
          ticket.visit.target.subjectTitle,
        ),
      );
    } catch {
      if (reviewEntryReadIsCurrent(ticket)) setInspection({ state: 'failed', boardId: board.id });
    } finally {
      finishReviewEntryRead(ticket);
      if (tickets.current.boards === ticket) tickets.current.boards = null;
    }
  }

  const boardPage = boards.state === 'ready' ? boards.page : null;
  const boardContextMatches =
    boardPage === null ||
    boardPage.state === 'denied' ||
    (boardPage.context !== null &&
      boardPage.context.subject.id === visit.target.subjectId &&
      boardPage.context.realm.id === selectedRealm?.realmId);
  const expiredRealmCursor = realms.state === 'failed' && realms.expired;
  const expiredBoardCursor = boardPage?.state === 'expired';

  if (!visit.ready) return <p role="alert">{m.thread_review_unavailable()}</p>;

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal sm:min-h-9 [@media(pointer:coarse)]:min-h-11"
        onClick={expanded ? () => setExpanded(false) : openChooser}
        aria-expanded={expanded}
      >
        {m.thread_review_write()}
      </Button>
      {expanded ? (
        <div className="min-w-0 basis-full space-y-4 rounded-lg border border-border/70 bg-card p-4">
          <section aria-labelledby="review-realm-heading" className="min-w-0 space-y-3">
            <h3 id="review-realm-heading" className="text-base font-semibold">
              {m.thread_review_choose_realm()}
            </h3>
            {realms.state === 'idle' || realms.state === 'loading' ? (
              <p role="status" className="text-sm text-muted-foreground">
                {m.thread_review_realms_loading()}
              </p>
            ) : null}
            {realms.state === 'failed' ? (
              <div className="space-y-2">
                <p role="alert">
                  {expiredRealmCursor ? m.thread_review_cursor_expired() : m.thread_review_unavailable()}
                </p>
                {expiredRealmCursor ? (
                  <Button type="button" variant="outline" onClick={() => void readRealms(undefined)}>
                    {m.thread_review_restart()}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" onClick={() => void readRealms(realms.cursor)}>
                    {m.subject_view_retry()}
                  </Button>
                )}
              </div>
            ) : null}
            {realms.state === 'ready' && realms.realms.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.thread_review_no_realms()}</p>
            ) : null}
            {realms.state === 'ready' && realms.realms.length > 0 ? (
              <>
                <ul className="grid min-w-0 gap-2 sm:grid-cols-2" aria-label={m.thread_review_choose_realm()}>
                  {realms.realms.map((realm) => (
                    <li key={realm.realmId} className="min-w-0">
                      <Button
                        type="button"
                        variant={selectedRealm?.realmId === realm.realmId ? 'secondary' : 'outline'}
                        aria-pressed={selectedRealm?.realmId === realm.realmId}
                        className="h-auto min-h-11 w-full min-w-11 justify-start whitespace-normal text-left [overflow-wrap:anywhere]"
                        onClick={() => chooseRealm(realm)}
                      >
                        <span dir="auto" className="block min-w-0 max-w-full">
                          {realm.name}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
                {realms.next ? (
                  <Button type="button" variant="outline" onClick={() => void readRealms(realms.next!)}>
                    {m.realms_more()}
                  </Button>
                ) : null}
              </>
            ) : null}
          </section>

          {selectedRealm ? (
            <section
              aria-labelledby="review-board-heading"
              className="min-w-0 space-y-3 border-t border-border/70 pt-4"
            >
              <h3 id="review-board-heading" className="text-base font-semibold [overflow-wrap:anywhere]">
                {m.thread_review_choose_board()}:{' '}
                {boardPage?.context?.realm.id === selectedRealm.realmId
                  ? boardPage.context.realm.title
                  : selectedRealm.name}
              </h3>
              {boards.state === 'idle' || boards.state === 'loading' ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {m.thread_review_preparing()}
                </p>
              ) : null}
              {boards.state === 'failed' ? (
                <div className="space-y-2">
                  <p role="alert">{m.thread_review_unavailable()}</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void readBoardPage(selectedRealm, boards.cursor)}
                  >
                    {m.subject_view_retry()}
                  </Button>
                </div>
              ) : null}
              {expiredBoardCursor ? (
                <div className="space-y-2">
                  <p role="alert">{m.thread_review_cursor_expired()}</p>
                  <Button type="button" variant="outline" onClick={() => void readBoardPage(selectedRealm, undefined)}>
                    {m.thread_review_restart()}
                  </Button>
                </div>
              ) : null}
              {boardPage?.state === 'denied' ? <p role="alert">{m.thread_review_denied()}</p> : null}
              {boardPage && !boardContextMatches ? (
                <div className="space-y-2">
                  <p role="alert">{m.thread_review_destination_changed()}</p>
                  <Button type="button" variant="outline" onClick={() => void readBoardPage(selectedRealm, undefined)}>
                    {m.thread_review_restart()}
                  </Button>
                </div>
              ) : null}
              {boardPage?.state === 'no-destinations' ? (
                <p className="text-sm text-muted-foreground">{m.thread_review_no_board()}</p>
              ) : null}
              {boardPage?.state === 'exhausted' ? (
                <p className="text-sm text-muted-foreground">{m.thread_review_exhausted()}</p>
              ) : null}
              {boardPage?.state === 'sparse' ? (
                <p className="text-sm text-muted-foreground">{m.thread_review_sparse()}</p>
              ) : null}
              {boardPage && boardContextMatches && boardPage.items.length > 0 ? (
                <ul className="grid min-w-0 gap-2 sm:grid-cols-2" aria-label={m.thread_review_choose_board()}>
                  {boardPage.items.map((board) => (
                    <li key={board.id} className="min-w-0">
                      <div className="min-w-0 rounded-lg border border-border/70 p-3">
                        <p dir="auto" className="break-words text-base font-medium">
                          {board.title ?? m.threads_untitled()}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">{m.realm_board_purpose_reviews()}</p>
                        <Button
                          type="button"
                          variant="outline"
                          className="mt-3 h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                          disabled={inspection.state === 'loading'}
                          onClick={() => void chooseBoard(board)}
                        >
                          {inspection.state === 'loading' && inspection.boardId === board.id
                            ? m.thread_review_preparing()
                            : m.thread_review_select_board()}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              {inspection.state === 'failed' ? <p role="alert">{m.thread_review_unavailable()}</p> : null}
              {inspection.state === 'failed' ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const board = boardPage?.items.find((item) => item.id === inspection.boardId);
                    if (board) void chooseBoard(board);
                  }}
                >
                  {m.subject_view_retry()}
                </Button>
              ) : null}
              {inspection.state === 'denied' ? <p role="alert">{m.thread_review_denied()}</p> : null}
              {inspection.state === 'changed' ? (
                <div className="space-y-2">
                  <p role="alert">{m.thread_review_destination_changed()}</p>
                  <Button type="button" variant="outline" onClick={() => void readBoardPage(selectedRealm, undefined)}>
                    {m.thread_review_restart()}
                  </Button>
                </div>
              ) : null}
              {boardPage?.next ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void readBoardPage(selectedRealm, boardPage.next!)}
                >
                  {m.thread_review_more()}
                </Button>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WriteReviewAction({
  subjectId,
  subjectTitle,
  session,
  locale,
}: {
  subjectId: string;
  subjectTitle: string;
  session: 'signed-in' | 'signed-out' | 'unavailable';
  locale: string;
}) {
  const visit = useWriteReviewVisit({ subjectId, subjectTitle, locale, session });
  if (session === 'signed-out')
    return (
      <SignInPrompt
        compact
        returnTo={`/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subjectId)}/reviews`}
        label={m.thread_review_sign_in()}
      />
    );
  if (session !== 'signed-in') return null;
  return <WriteReviewVisitView key={visit.id} visit={visit} />;
}
