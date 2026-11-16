import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure, StudioPort, StudioSelection } from './contract';
import type { HostedOwnedBook } from './hosted-contract';
import type { EditableHostedChapter, HostedDraftPointVisit } from './hosted-draft-points';
import { createPostDocumentPort } from './post-document-port';
import { StudioWorkspace } from './workspace';

type ChapterRead =
  | { kind: 'loading' }
  | { kind: 'failed'; error: StudioFailure }
  | { kind: 'ready'; port: StudioPort; selection: StudioSelection };

/** One observed occurrence authorizes asking the existing private Post port for one chapter head. */
export function HostedChapterStudio({
  chapter,
  outline,
  owner,
  source,
  csrfToken,
  locale,
  onBack,
}: {
  chapter: EditableHostedChapter;
  outline: HostedDraftPointVisit;
  owner: HostedOwnedBook;
  source: HistoricalReaderSource;
  csrfToken: string;
  locale: Locale;
  onBack: () => void;
}) {
  const [read, setRead] = useState<ChapterRead>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [atRisk, setAtRisk] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const state = useSyncExternalStore(outline.subscribe, outline.snapshot, outline.snapshot);
  const catalogueId = owner.item.catalogueId;
  const target = chapter.item.target;
  const options = { locale };

  useEffect(() => {
    back.current?.focus();
  }, []);
  useEffect(() => {
    const request = new AbortController();
    const current = () => {
      const selection = outline.snapshot();
      return (
        !request.signal.aborted &&
        outline.isCurrent() &&
        selection.kind === 'active' &&
        selection.head === chapter.revisionId
      );
    };
    const unavailable: ChapterRead = {
      kind: 'failed',
      error: { kind: 'unavailable', message: m.studio_book_chapter_unavailable({}, { locale }) },
    };
    const documents = createPostDocumentPort({
      projectId: catalogueId,
      accountId: owner.viewer.accountId,
      locale,
      source,
      csrfToken,
      isCurrent: current,
      admitsPost: (postId) => postId === target.postId,
    });
    const unavailablePublication = async () => ({
      ok: false as const,
      error: { kind: 'unavailable' as const, message: m.studio_release_unavailable({}, { locale }) },
    });
    const port: StudioPort = {
      ...documents,
      reviewPublication: unavailablePublication,
      publish: unavailablePublication,
      publications: unavailablePublication,
    };
    const load = async () => {
      if (!current()) return;
      const result = await documents.open({ projectId: catalogueId, postId: target.postId }, request.signal);
      if (!current()) return;
      if (!result.ok) setRead({ kind: 'failed', error: result.error });
      else if (result.value.native?.threadId !== target.threadId) setRead(unavailable);
      else setRead({ kind: 'ready', port, selection: result.value });
    };
    void load().catch(() => {
      if (current()) setRead(unavailable);
    });
    return () => request.abort();
  }, [attempt, catalogueId, chapter.revisionId, csrfToken, locale, outline, owner.viewer.accountId, source, target]);

  if (!outline.isCurrent() || state.kind !== 'active' || state.head !== chapter.revisionId)
    return <p role="status">{m.studio_workspace_ended({}, options)}</p>;

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-6">
      <div className="studio-action-row">
        <Button ref={back} type="button" variant="outline" disabled={atRisk} onClick={onBack}>
          {m.studio_point_back_draft({}, options)}
        </Button>
        {atRisk ? <p className="studio-help">{m.studio_workspace_switch_help({}, options)}</p> : null}
      </div>
      {read.kind === 'loading' ? <p role="status">{m.studio_workspace_opening({}, options)}</p> : null}
      {read.kind === 'failed' ? (
        <div className="studio-stack" role="alert">
          <p>{read.error.message}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setRead({ kind: 'loading' });
              setAttempt((value) => value + 1);
            }}
          >
            {m.own_drafts_retry({}, options)}
          </Button>
        </div>
      ) : null}
      {read.kind === 'ready' ? (
        <StudioWorkspace
          input={{
            visitKey: JSON.stringify([catalogueId, chapter.item.occurrenceId, chapter.revisionId, attempt]),
            projectId: catalogueId,
            title: owner.item.title ?? m.studio_workspace_book_title({}, options),
            profile: { kind: 'book', structure: null },
            initialSelection: read.selection,
            documents: { items: [], nextCursor: null },
            publications: { items: [], nextCursor: null },
            canCreateDraft: false,
            canPublish: false,
          }}
          port={read.port}
          onDepartureRiskChange={setAtRisk}
        />
      ) : null}
    </div>
  );
}
