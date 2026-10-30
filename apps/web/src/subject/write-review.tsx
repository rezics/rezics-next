import { Button } from '@rezics/ui/shadcn/button';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { useEffect, useState } from 'react';
import { readMyRealmsPage } from '../community/space-actions';
import type { RealmLink } from '../community/space';
import { kernelClient } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from '../threads/composer';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { env } from 'cloudflare:workers';
import { loadRealmReviewBoards, type ReviewBoardChoice } from '../threads/review-board-choices';
import { reviewThreadHref } from '../threads/review-policy';

export const REALM_PAGE_LIMIT = 20;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const readRealmReviewBoards = createServerFn({ method: 'GET' })
  .validator((input: unknown): { realms: RealmLink[] } => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('realms' in input) ||
      !Array.isArray(input.realms) ||
      input.realms.length > REALM_PAGE_LIMIT
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
    return { realms };
  })
  .handler(async ({ data }): Promise<ReviewBoardChoice[]> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return [];
    return loadRealmReviewBoards(kernelClient(), data.realms, authorization);
  });

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
  const [expanded, setExpanded] = useState(false);
  const [realmPage, setRealmPage] = useState<{ realms: RealmLink[] } | null>(null);
  const [realmState, setRealmState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [boardChoices, setBoardChoices] = useState<ReviewBoardChoice[] | null>(null);
  const [boardsState, setBoardsState] = useState<'idle' | 'loading' | 'failed'>('idle');

  useEffect(() => {
    if (session !== 'signed-in') return;
    let active = true;
    void readMyRealmsPage({ data: {} }).then(
      (page) => {
        if (!active) return;
        setRealmPage({ realms: page.realms.slice(0, REALM_PAGE_LIMIT) });
        setRealmState(page.signedIn ? 'ready' : 'failed');
      },
      () => {
        if (active) setRealmState('failed');
      },
    );
    return () => {
      active = false;
    };
  }, [session]);

  async function findBoards() {
    if (!realmPage || boardsState === 'loading') return;
    setBoardsState('loading');
    setBoardChoices(null);
    try {
      const choices = await readRealmReviewBoards({ data: { realms: realmPage.realms } });
      setBoardChoices(choices);
      setBoardsState('idle');
      if (choices.length === 1) {
        window.location.assign(reviewThreadHref(locale, choices[0]!.id, subjectId, subjectTitle));
      }
    } catch {
      setBoardsState('failed');
    }
  }

  useEffect(() => {
    if (
      expanded &&
      realmState === 'ready' &&
      realmPage?.realms.length &&
      boardChoices === null &&
      boardsState === 'idle'
    )
      void findBoards();
  }, [expanded, realmState, realmPage, boardChoices, boardsState]);

  if (session === 'signed-out')
    return (
      <SignInPrompt
        compact
        returnTo={`/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subjectId)}/reviews`}
        label={m.thread_review_sign_in()}
      />
    );
  if (session !== 'signed-in') return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {m.thread_review_write()}
      </Button>
      {expanded ? (
        <div className="basis-full space-y-3 rounded-lg border border-border/70 bg-card p-4">
          {realmState === 'loading' ? (
            <p className="text-sm text-muted-foreground">{m.thread_review_boards_loading()}</p>
          ) : null}
          {realmState === 'failed' ? <p role="alert">{m.thread_review_unavailable()}</p> : null}
          {realmState === 'ready' && realmPage?.realms.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.thread_review_no_realms()}</p>
          ) : null}
          {realmState === 'ready' && realmPage && realmPage.realms.length > 0 ? (
            <div className="space-y-3">
              {boardsState === 'loading' ? (
                <p className="text-sm text-muted-foreground">{m.thread_review_boards_loading()}</p>
              ) : null}
              {boardsState === 'failed' ? <p role="alert">{m.thread_review_unavailable()}</p> : null}
              {boardChoices?.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.thread_review_no_board()}</p>
              ) : null}
              {boardChoices && boardChoices.length > 1 ? (
                <ul className="grid gap-2 sm:grid-cols-2" aria-label={m.thread_review_choose_board()}>
                  {boardChoices.map((board) => (
                    <li key={board.id}>
                      <a
                        className="block rounded-lg border border-border/70 bg-background p-3 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={reviewThreadHref(locale, board.id, subjectId, subjectTitle)}
                      >
                        <span className="block">{board.title ?? m.threads_untitled()}</span>
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">{board.realmName}</span>
                      </a>
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
}
