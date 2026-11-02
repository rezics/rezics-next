import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { useEffect, useState, type MouseEvent } from 'react';
import { readMyRealmsPageForReview, type ReviewMyRealmsRead } from '../community/space-actions';
import type { RealmLink } from '../community/space';
import { kernelClient } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from '../threads/composer';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { env } from 'cloudflare:workers';
import { loadRealmReviewBoards, type ReviewBoardChoice } from '../threads/review-board-choices';
import { reviewThreadHref } from '../threads/review-policy';
import {
  beginReviewEntryRead,
  claimReviewEntryNavigation,
  expectedReviewReader,
  finishReviewEntryRead,
  preparedReviewReader,
  reviewEntryReadIsCurrent,
  reviewEntryVisitIsCurrent,
  sameReviewReader,
  useWriteReviewVisit,
  validateReviewReaderExpectation,
  type ReviewEntryReadTicket,
  type ReviewReaderExpectation,
  type ReviewReaderProvenance,
} from './write-review-lifetime';

export const REALM_PAGE_LIMIT = 20;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReviewBoardRead =
  | { kind: 'ready'; choices: ReviewBoardChoice[]; provenance: ReviewReaderProvenance }
  | { kind: 'mismatch' };

function validateReviewBoardRead(input: unknown): { realms: RealmLink[]; expected: ReviewReaderExpectation } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('realms' in input) ||
    !Array.isArray(input.realms) ||
    input.realms.length > REALM_PAGE_LIMIT ||
    !('expected' in input)
  )
    throw new Error('Invalid Realm page');
  const realms = input.realms.map((realm) => {
    if (
      !realm ||
      typeof realm !== 'object' ||
      !('realmId' in realm) ||
      typeof realm.realmId !== 'string' ||
      !uuid.test(realm.realmId) ||
      !('name' in realm) ||
      typeof realm.name !== 'string' ||
      realm.name.length > 1024
    )
      throw new Error('Invalid Realm page');
    return { realmId: realm.realmId, name: realm.name };
  });
  return { realms, expected: validateReviewReaderExpectation(input.expected) };
}

export const readRealmReviewBoards = createServerFn({ method: 'GET' })
  .validator(validateReviewBoardRead)
  .handler(async ({ data }): Promise<ReviewBoardRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const provenance = await preparedReviewReader(sessionSubject(request), requestCsrfToken(request));
    if (!authorization || !sameReviewReader(data.expected, provenance)) return { kind: 'mismatch' };
    const choices = await loadRealmReviewBoards(kernelClient(), data.realms, authorization);
    return { kind: 'ready', choices, provenance: provenance! };
  });

type RealmReadState = { state: 'loading' | 'failed' } | { state: 'ready'; realms: RealmLink[] };
type BoardReadState =
  | { state: 'idle' | 'loading' | 'failed'; choices: null }
  | { state: 'ready'; choices: ReviewBoardChoice[] };

function WriteReviewVisitView({
  visit,
  session,
}: {
  visit: ReturnType<typeof useWriteReviewVisit>;
  session: 'signed-in' | 'signed-out' | 'unavailable';
}) {
  const [expanded, setExpanded] = useState(false);
  const [realmRead, setRealmRead] = useState<RealmReadState>(() =>
    visit.ready ? { state: 'loading' } : { state: 'failed' },
  );
  const [boardRead, setBoardRead] = useState<BoardReadState>({ state: 'idle', choices: null });

  useEffect(() => {
    if (!visit.ready) return;
    const ticket = beginReviewEntryRead(visit, 'realms');
    if (!ticket) return;
    setRealmRead({ state: 'loading' });
    void readMyRealms(ticket);
  }, [visit]);

  useEffect(() => {
    if (
      !expanded ||
      realmRead.state !== 'ready' ||
      realmRead.realms.length === 0 ||
      boardRead.state !== 'idle' ||
      boardRead.choices !== null
    )
      return;
    const ticket = beginReviewEntryRead(visit, 'boards');
    if (!ticket) return;
    setBoardRead({ state: 'loading', choices: null });
    void readBoards(ticket, realmRead.realms);
  }, [visit, expanded, realmRead, boardRead]);

  function toggleExpanded() {
    if (reviewEntryVisitIsCurrent(visit)) setExpanded((value) => !value);
  }

  function retryRealmRead() {
    const ticket = beginReviewEntryRead(visit, 'realms');
    if (!ticket) return;
    setRealmRead({ state: 'loading' });
    void readMyRealms(ticket);
  }

  function retryBoardRead() {
    if (realmRead.state !== 'ready') return;
    const ticket = beginReviewEntryRead(visit, 'boards');
    if (!ticket) return;
    setBoardRead({ state: 'loading', choices: null });
    void readBoards(ticket, realmRead.realms);
  }

  function preventStaleNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (!reviewEntryVisitIsCurrent(visit)) event.preventDefault();
  }

  if (session === 'signed-out')
    return (
      <SignInPrompt
        compact
        returnTo={`/${encodeURIComponent(visit.target.locale)}/subjects/${encodeURIComponent(visit.target.subjectId)}/reviews`}
        label={m.thread_review_sign_in()}
      />
    );
  if (session !== 'signed-in') return null;

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal sm:min-h-9 [@media(pointer:coarse)]:min-h-11"
        onClick={toggleExpanded}
        aria-expanded={expanded}
      >
        {m.thread_review_write()}
      </Button>
      {expanded ? (
        <div className="min-w-0 basis-full space-y-3 rounded-lg border border-border/70 bg-card p-4">
          {realmRead.state === 'loading' ? (
            <p className="text-sm text-muted-foreground">{m.thread_review_boards_loading()}</p>
          ) : null}
          {realmRead.state === 'failed' ? (
            <>
              <p role="alert">{m.thread_review_unavailable()}</p>
              <Button type="button" variant="outline" onClick={retryRealmRead}>
                {m.subject_view_retry()}
              </Button>
            </>
          ) : null}
          {realmRead.state === 'ready' && realmRead.realms.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.thread_review_no_realms()}</p>
          ) : null}
          {realmRead.state === 'ready' && realmRead.realms.length > 0 ? (
            <div className="space-y-3">
              {boardRead.state === 'loading' ? (
                <p className="text-sm text-muted-foreground">{m.thread_review_boards_loading()}</p>
              ) : null}
              {boardRead.state === 'failed' ? (
                <>
                  <p role="alert">{m.thread_review_unavailable()}</p>
                  <Button type="button" variant="outline" onClick={retryBoardRead}>
                    {m.subject_view_retry()}
                  </Button>
                </>
              ) : null}
              {boardRead.state === 'ready' && boardRead.choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.thread_review_no_board()}</p>
              ) : null}
              {boardRead.state === 'ready' && boardRead.choices.length > 1 ? (
                <ul className="grid min-w-0 gap-2 sm:grid-cols-2" aria-label={m.thread_review_choose_board()}>
                  {boardRead.choices.map((board) => (
                    <li key={board.id} className="min-w-0">
                      <ContentItemFrame as="div" className="h-full min-w-0 p-3">
                        <ContentItemHeading level={3} className="min-w-0 text-base leading-snug font-medium">
                          <ContentItemTitleLink
                            stretch={false}
                            className="inline-flex min-h-11 min-w-11 max-w-full flex-col justify-center whitespace-normal rounded-sm text-primary underline-offset-4 [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            href={reviewThreadHref(
                              visit.target.locale,
                              board.id,
                              visit.target.subjectId,
                              visit.target.subjectTitle,
                            )}
                            onClick={preventStaleNavigation}
                          >
                            <span dir="auto" className="block min-w-0 max-w-full">
                              {board.title ?? m.threads_untitled()}
                            </span>
                            <span
                              dir="auto"
                              className="mt-1 block min-w-0 max-w-full text-sm font-normal text-muted-foreground"
                            >
                              {board.realmName}
                            </span>
                          </ContentItemTitleLink>
                        </ContentItemHeading>
                      </ContentItemFrame>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  async function readMyRealms(ticket: ReviewEntryReadTicket) {
    try {
      const expected = await expectedReviewReader(ticket.visit);
      if (!reviewEntryReadIsCurrent(ticket)) return;
      const result = (await readMyRealmsPageForReview({ data: { expected } })) as ReviewMyRealmsRead;
      if (!reviewEntryReadIsCurrent(ticket)) return;
      if (result.kind !== 'ready' || !result.page.signedIn || !sameReviewReader(expected, result.provenance)) {
        setRealmRead({ state: 'failed' });
        return;
      }
      setRealmRead({ state: 'ready', realms: result.page.realms.slice(0, REALM_PAGE_LIMIT) });
    } catch {
      if (reviewEntryReadIsCurrent(ticket)) setRealmRead({ state: 'failed' });
    } finally {
      finishReviewEntryRead(ticket);
    }
  }

  async function readBoards(ticket: ReviewEntryReadTicket, realms: RealmLink[]) {
    try {
      const expected = await expectedReviewReader(ticket.visit);
      if (!reviewEntryReadIsCurrent(ticket)) return;
      const result = (await readRealmReviewBoards({ data: { realms, expected } })) as ReviewBoardRead;
      if (!reviewEntryReadIsCurrent(ticket)) return;
      if (result.kind !== 'ready' || !sameReviewReader(expected, result.provenance)) {
        setBoardRead({ state: 'failed', choices: null });
        return;
      }
      setBoardRead({ state: 'ready', choices: result.choices });
      if (result.choices.length === 1 && claimReviewEntryNavigation(ticket)) {
        window.location.assign(
          reviewThreadHref(
            ticket.visit.target.locale,
            result.choices[0]!.id,
            ticket.visit.target.subjectId,
            ticket.visit.target.subjectTitle,
          ),
        );
      }
    } catch {
      if (reviewEntryReadIsCurrent(ticket)) setBoardRead({ state: 'failed', choices: null });
    } finally {
      finishReviewEntryRead(ticket);
    }
  }
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
  return <WriteReviewVisitView key={visit.id} visit={visit} session={session} />;
}
