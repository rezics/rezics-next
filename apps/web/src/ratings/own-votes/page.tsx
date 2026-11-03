import { useMemo, useRef, useState, type Ref } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../../shell/page-heading';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import type { OwnVoteEntry, OwnVotesPage } from '../../../../../services/kernel/src/rating/own-votes-page.ts';
import { executeOwnVoteIntent, voteReadbackForIntent, type OwnVotesRead } from './actions';
import { useOwnVotesCurrentOrigin } from './current-origin';
import { OwnVotesDeparture } from './departure';
import { OwnVoteEditor, type OwnVoteFeedback } from './editor';
import { indexOwnVotes, removeOwnVote, replaceOwnVote, votePairKey } from './inventory';
import { createOwnVoteIntent, type OwnVoteIntent } from './intent';
import type { OwnVoteReadback } from './readback';
import { OwnVotesInspection } from './inspection';
import { useOwnVotesReturn } from './return';

type Execute = (input: { data: OwnVoteIntent }) => Promise<Awaited<ReturnType<typeof executeOwnVoteIntent>>>;
type Review = (input: { data: { intent: OwnVoteIntent; after: 'REVIEW' } }) => Promise<OwnVoteReadback>;

export function CurrentViewerOwnVotesPage({
  initial,
  cursor,
  invalidAddress = false,
}: {
  initial: OwnVotesRead;
  cursor: string | null;
  invalidAddress?: boolean;
}) {
  const origin = useOwnVotesCurrentOrigin(initial, cursor, invalidAddress);
  const heading = useRef<HTMLHeadingElement>(null);
  useOwnVotesReturn(origin.viewKey, origin.isCurrent, origin.refresh, () => heading.current?.focus());
  return (
    <OwnVotesWorkspace
      key={origin.viewKey}
      state={origin.state}
      page={origin.page}
      cursor={origin.cursor}
      locale={origin.locale}
      isCurrent={origin.isCurrent}
      onRefresh={origin.refresh}
      onUpdatePage={origin.updatePage}
      headingRef={heading}
      execute={executeOwnVoteIntent}
      review={({ data }) => voteReadbackForIntent(data.intent, data.after)}
    />
  );
}

/** The page state and interaction owner; stories inject the same command/readback boundary. */
export function OwnVotesWorkspace({
  state,
  page,
  cursor,
  locale,
  isCurrent,
  onRefresh,
  onUpdatePage,
  headingRef,
  execute,
  review,
}: {
  state: OwnVotesRead['state'];
  page: OwnVotesPage | null;
  cursor: string | null;
  locale: string;
  isCurrent: () => boolean;
  onRefresh: () => Promise<unknown>;
  onUpdatePage: (update: (page: OwnVotesPage) => OwnVotesPage) => void;
  headingRef: Ref<HTMLHeadingElement>;
  execute: Execute;
  review: Review;
}) {
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<OwnVoteIntent | null>(null);
  const intentRef = useRef<OwnVoteIntent | null>(null);
  const [feedback, setFeedback] = useState<OwnVoteFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingCommand, setAwaitingCommand] = useState(false);
  const attempt = useRef(0);
  const index = useMemo(() => {
    if (!page) return new Map<string, OwnVoteEntry>();
    try {
      return indexOwnVotes(page);
    } catch {
      return new Map<string, OwnVoteEntry>();
    }
  }, [page]);
  const indexedPageValid = !page || index.size === page.votes.length;
  const activeEntry = selectedPair ? index.get(selectedPair) ?? null : null;
  const unresolved =
    feedback?.kind === 'uncertain' ||
    feedback?.kind === 'review-pending' ||
    feedback?.kind === 'review-failed' ||
    (awaitingCommand && feedback?.kind === 'review-missing');
  const dirty = !!activeEntry && editing && draft !== String(activeEntry.own.units);
  const locked = busy || unresolved;
  const selectedCurrent = () =>
    isCurrent() &&
    !!activeEntry &&
    (!intent || (intent.pair === votePairKey(activeEntry) && intent.path === `/v1/subjects/${activeEntry.targetId}/ratings/${activeEntry.questionId}/vote`));

  function clearIntent() {
    attempt.current += 1;
    intentRef.current = null;
    setIntent(null);
    setAwaitingCommand(false);
    setBusy(false);
  }

  function select(entry: OwnVoteEntry) {
    if (!isCurrent() || locked) return;
    attempt.current += 1;
    intentRef.current = null;
    setIntent(null);
    setFeedback(null);
    setEditing(false);
    setDraft('');
    setSelectedPair(votePairKey(entry));
  }

  function replaceFromReadback(readback: OwnVoteReadback, active: OwnVoteIntent) {
    if (readback.kind === 'current') {
      onUpdatePage((current) => {
        const entry = current.votes.find((row) => votePairKey(row) === active.pair);
        if (!entry) return current;
        return replaceOwnVote(current, { ...entry, own: readback });
      });
      return;
    }
    if (readback.kind === 'cleared') {
      onUpdatePage((current) => removeOwnVote(current, active));
      setSelectedPair(null);
      setEditing(false);
      setDraft('');
    }
  }

  async function send(active: OwnVoteIntent) {
    if (!isCurrent() || intentRef.current !== active || busy) return;
    const currentAttempt = ++attempt.current;
    const ownsResult = () => isCurrent() && attempt.current === currentAttempt && intentRef.current === active;
    setBusy(true);
    setFeedback({ kind: active.method === 'PUT' ? 'saving' : 'clearing' });
    try {
      const result = await execute({ data: active });
      if (!ownsResult()) return;
      setBusy(false);
      if (result.kind === 'acknowledged') {
        const readback = result.readback;
        if (readback.kind === 'current') {
          replaceFromReadback(readback, active);
          if (active.method === 'PUT' && readback.units === active.body?.units) {
            setFeedback({ kind: 'saved' });
            setEditing(false);
            setDraft('');
          } else {
            setFeedback({ kind: 'review-current', value: readback.units });
          }
          clearIntent();
          return;
        }
        if (readback.kind === 'cleared' && active.method === 'DELETE') {
          replaceFromReadback(readback, active);
          setFeedback({ kind: 'cleared' });
          clearIntent();
          return;
        }
        setAwaitingCommand(false);
        setFeedback({ kind: 'readback-unavailable' });
        return;
      }
      if (result.kind === 'rejected') {
        clearIntent();
        setEditing(active.method === 'PUT');
        setFeedback({ kind: 'rejected' });
        return;
      }
      setAwaitingCommand(true);
      setFeedback({ kind: 'uncertain' });
    } catch {
      if (!ownsResult()) return;
      setBusy(false);
      setAwaitingCommand(true);
      setFeedback({ kind: 'uncertain' });
    }
  }

  function startIntent(method: 'PUT' | 'DELETE', units?: number) {
    if (!activeEntry || !selectedCurrent() || locked || !originPageContains(activeEntry)) return;
    try {
      const next = createOwnVoteIntent(page!.viewer.accountId, activeEntry, method, units);
      intentRef.current = next;
      setIntent(next);
      setAwaitingCommand(true);
      void send(next);
    } catch {
      setFeedback({ kind: 'rejected' });
    }
  }

  function originPageContains(entry: OwnVoteEntry) {
    return !!page && index.get(votePairKey(entry)) === entry;
  }

  async function reviewOriginal() {
    const active = intentRef.current;
    if (!active || !isCurrent() || busy) return;
    const currentAttempt = ++attempt.current;
    const ownsResult = () => isCurrent() && attempt.current === currentAttempt && intentRef.current === active;
    const wasUncertain = awaitingCommand;
    setBusy(true);
    setFeedback({ kind: 'reviewing' });
    try {
      const result = await review({ data: { intent: active, after: 'REVIEW' } });
      if (!ownsResult()) return;
      setBusy(false);
      if (result.kind === 'current') {
        replaceFromReadback(result, active);
        if (!wasUncertain || (active.method === 'PUT' && result.units === active.body?.units)) {
          setFeedback({ kind: 'review-current', value: result.units });
          clearIntent();
        } else {
          setFeedback({ kind: 'review-pending', value: result.units });
        }
        return;
      }
      if ((result.kind === 'cleared' || result.kind === 'missing') && active.method === 'DELETE') {
        replaceFromReadback({ kind: 'cleared' }, active);
        setFeedback({ kind: 'review-cleared' });
        clearIntent();
        return;
      }
      if (result.kind === 'missing') {
        setFeedback({ kind: wasUncertain ? 'review-missing' : 'readback-unavailable' });
        return;
      }
      setFeedback({ kind: wasUncertain ? 'review-failed' : 'readback-unavailable' });
    } catch {
      if (!ownsResult()) return;
      setBusy(false);
      setFeedback({ kind: awaitingCommand ? 'review-failed' : 'readback-unavailable' });
    }
  }

  const message = (() => {
    if (!indexedPageValid) return m.library_my_ratings_unavailable();
    switch (state) {
      case 'signed-out': return m.library_my_ratings_signed_out();
      case 'denied': return m.library_my_ratings_denied();
      case 'preparing': return m.library_my_ratings_preparing();
      case 'unavailable': return m.library_my_ratings_unavailable();
      case 'invalid-cursor': return m.library_my_ratings_invalid_cursor();
      case 'ready': return null;
    }
  })();

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <PageHeading
        ref={headingRef}
        tabIndex={-1}
      >
        {m.library_my_ratings_heading()}
      </PageHeading>
      <p className="max-w-3xl text-muted-foreground">{m.library_my_ratings_description()}</p>
      {message ? (
        <section className="space-y-3" role={state === 'unavailable' || state === 'invalid-cursor' ? 'alert' : 'status'}>
          <p>{message}</p>
          {state === 'unavailable' ? (
            <Button className="min-h-11" onClick={() => void onRefresh()}>{m.library_my_ratings_retry_page()}</Button>
          ) : null}
          {state === 'invalid-cursor' ? (
            <Link className="inline-flex min-h-11 items-center underline" to="/library/ratings">
              {m.library_my_ratings_first()}
            </Link>
          ) : null}
        </section>
      ) : null}

      {state === 'ready' && page && indexedPageValid ? (
        <>
          <p className="text-sm text-muted-foreground">{m.library_my_ratings_page_order()}</p>
          {page.votes.length === 0 ? (
            feedback?.kind === 'cleared' || feedback?.kind === 'review-cleared' ? null : (
              <p role="status">{page.next ? m.library_my_ratings_sparse() : m.library_my_ratings_empty()}</p>
            )
          ) : (
            <OwnVotesInspection
              entries={page.votes}
              locale={locale}
              selectedPair={selectedPair}
              disabled={locked}
              onSelect={select}
            />
          )}
          {activeEntry && selectedCurrent() ? (
            <OwnVoteEditor
              entry={activeEntry}
              locale={locale}
              editing={editing}
              draft={draft}
              locked={locked}
              busy={busy}
              feedback={feedback}
              canRetry={awaitingCommand}
              onEdit={() => {
                setDraft(String(activeEntry.own.units));
                setEditing(true);
                setFeedback(null);
              }}
              onDraft={setDraft}
              onSave={() => startIntent('PUT', Number(draft))}
              onCancel={() => {
                setEditing(false);
                setDraft('');
                setFeedback(null);
              }}
              onClear={() => startIntent('DELETE')}
              onRetry={() => {
                const active = intentRef.current;
                if (active && awaitingCommand) void send(active);
              }}
              onReview={() => void reviewOriginal()}
            />
          ) : null}
          {feedback?.kind === 'cleared' || feedback?.kind === 'review-cleared' ? (
            <p role="status">{m.library_my_ratings_cleared()}</p>
          ) : null}
          {feedback?.kind === 'rejected' ? (
            <Button className="min-h-11" variant="outline" onClick={() => void onRefresh()}>
              {m.library_my_ratings_retry_page()}
            </Button>
          ) : null}
          <nav className="flex flex-wrap gap-3" aria-label={m.library_my_ratings_heading()}>
            {cursor !== null ? (
              <Link className="inline-flex min-h-11 items-center underline" to="/library/ratings">
                {m.library_my_ratings_first()}
              </Link>
            ) : null}
            {page.next ? (
              <Link
                className="inline-flex min-h-11 items-center underline"
                to="/library/ratings"
                search={{ cursor: page.next }}
              >
                {m.library_my_ratings_continue()}
              </Link>
            ) : null}
          </nav>
        </>
      ) : null}
      <OwnVotesDeparture dirty={dirty} locked={locked} isCurrent={isCurrent} />
    </main>
  );
}
