import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { fromPlainText, hasDocumentContent } from '@rezics/document';
import { RichTextEditor } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { DocumentBody } from '../document-body';
import type { BookOrganizerPort, StudioInput, StudioPort, StudioPresentation } from './contract';
import { StudioController } from './controller';
import { BookOrganizer } from './book-organizer';
import { ExactVersionDetails, StudioVersions } from './revisions';
import { StudioPublication } from './publication';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref, type Locale } from '../paraglide/runtime.js';
import { HostedInventoryVisit, hostedOwnerBookHref } from './hosted-inventory';
import type { HostedHistoryBinding } from './hosted-history';
import './studio.css';

export type StudioWorkspaceProps = {
  input: StudioInput;
  port: StudioPort;
  bookPort?: BookOrganizerPort;
  bookHistory?: HostedHistoryBinding;
  presentation?: StudioPresentation;
  /** Lets the mounted composition guard internal route navigation as well as browser departure. */
  onDepartureRiskChange?: (atRisk: boolean) => void;
};

/** Production composition surface. No route, generated-operation binding or public authority is inferred here. */
export function StudioWorkspace(props: StudioWorkspaceProps) {
  if (!props.port.isCurrent())
    return <p role="status">This Studio visit has ended. Reopen the workspace to continue.</p>;
  return <StudioVisit key={props.input.visitKey} {...props} />;
}
function StudioVisit({
  input,
  port,
  bookPort,
  bookHistory,
  presentation = {},
  onDepartureRiskChange,
}: StudioWorkspaceProps) {
  const [controller] = useState(() => new StudioController(input, port, bookPort));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [tab, setTab] = useState<'write' | 'preview' | 'versions'>('write');
  const [navigation, setNavigation] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const previousPost = useRef<string | null>(null);
  const id = useId();
  const selected = state.selected;
  const postId = selected?.source.revision.exact.postId ?? null;
  const editorGeneration = selected?.editorGeneration ?? 0;
  const editorCurrent = () => postId !== null && controller.isEditorCurrent(postId, editorGeneration);
  const unresolved = controller.hasUnresolvedCommand();
  const atRisk = Boolean(
    selected?.dirty || selected?.snapshotPending || selected?.uploading || state.busy || unresolved,
  );
  const blocked = Boolean(state.busy) || unresolved;

  useEffect(() => controller.connect(), [controller]);
  useEffect(() => {
    const wideLayout = window.matchMedia('(min-width: 64rem)');
    const syncNavigation = () => setNavigation(wideLayout.matches);
    syncNavigation();
    wideLayout.addEventListener('change', syncNavigation);
    return () => wideLayout.removeEventListener('change', syncNavigation);
  }, []);
  useEffect(() => {
    onDepartureRiskChange?.(atRisk);
    return () => onDepartureRiskChange?.(false);
  }, [atRisk, onDepartureRiskChange]);
  useEffect(() => {
    if (!atRisk) return;
    const preventDeparture = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventDeparture);
    return () => window.removeEventListener('beforeunload', preventDeparture);
  }, [atRisk]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void controller.save();
      }
    };
    window.addEventListener('keydown', save);
    return () => window.removeEventListener('keydown', save);
  }, [controller]);
  useEffect(() => {
    if (
      !selected?.dirty ||
      selected.snapshotPending ||
      selected.invalid ||
      selected.uploading ||
      !selected.source.permissions.edit ||
      blocked ||
      state.issue
    )
      return;
    const timer = window.setTimeout(() => void controller.save(), 1200);
    return () => window.clearTimeout(timer);
  }, [controller, selected, blocked, state.issue]);
  useEffect(() => {
    if (postId && previousPost.current !== postId) {
      setTab('write');
      setDiscard(false);
      editorHeading.current?.focus({ preventScroll: true });
    }
    previousPost.current = postId;
  }, [postId]);

  function keepWideNavigationOpen() {
    if (window.matchMedia('(min-width: 64rem)').matches) setNavigation(true);
    else setNavigation(false);
  }
  function open(post: string) {
    if (post === postId) return;
    if (selected?.dirty || selected?.snapshotPending || selected?.uploading) {
      setPendingOpen(post);
      return;
    }
    keepWideNavigationOpen();
    setTab('write');
    void controller.open(post);
  }
  async function continueToDraft(save: boolean) {
    const target = pendingOpen;
    if (!target) return;
    if (save) {
      if (!(await controller.save()) || controller.snapshot().selected?.dirty) return;
    } else controller.discard();
    if (await controller.open(target)) {
      setPendingOpen(null);
      keepWideNavigationOpen();
      setTab('write');
    }
  }
  if (!port.isCurrent()) return <p role="status">This Studio visit has ended. Reopen the workspace to continue.</p>;
  return (
    <section className="studio-workspace" aria-label={`${input.title} Studio`}>
      <header className="studio-header">
        <div>
          <p className="studio-eyebrow">Studio · {input.profile.kind === 'book' ? 'Book Library' : 'Articles'}</p>
          <h1>{input.title}</h1>
          {input.profile.kind === 'articles' && input.profile.seriesTitle ? <p>{input.profile.seriesTitle}</p> : null}
        </div>
        <a className="studio-skip" href={`#${id}-document`}>
          Skip to document
        </a>
        <p className="studio-help">Drafts save privately. Publishing requires a separate review.</p>
      </header>
      <div className="studio-status" aria-live="polite" aria-atomic="true">
        {state.busy ? <p role="status">{state.busy}…</p> : state.message ? <p role="status">{state.message}</p> : null}
        {state.issue ? (
          <div role="alert" className="studio-stack">
            <p>{state.issue.message}</p>
            {state.issue.kind === 'stale' ? (
              <p>Your working draft is retained. Copy your text before discarding and reopening the current draft.</p>
            ) : null}
            {unresolved ? (
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(state.busy)}
                onClick={() => void controller.retry()}
              >
                Retry the same operation
              </Button>
            ) : null}
            {!unresolved && state.failedDocumentCursor ? (
              <Button type="button" variant="outline" onClick={() => void controller.retry()}>
                {m.own_drafts_retry({}, { locale: getLocale() })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {pendingOpen ? (
        <section className="studio-navigation-confirm studio-stack" aria-label="Unsaved draft changes">
          <h2>Keep your changes before switching</h2>
          <p>Save this draft to continue, or discard its local changes.</p>
          <div className="studio-action-row">
            <Button
              type="button"
              disabled={blocked || Boolean(selected?.snapshotPending || selected?.invalid || selected?.uploading)}
              onClick={() => void continueToDraft(true)}
            >
              Save and switch
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={blocked || Boolean(selected?.uploading)}
              onClick={() => void continueToDraft(false)}
            >
              Discard and switch
            </Button>
            <Button type="button" variant="outline" onClick={() => setPendingOpen(null)}>
              Keep editing
            </Button>
          </div>
        </section>
      ) : null}
      <div className="studio-layout">
        <div id={`${id}-document`} className="studio-document" tabIndex={-1}>
          {selected ? (
            <>
              <header className="studio-document-heading">
                <h2 ref={editorHeading} tabIndex={-1}>
                  {selected.title || 'Untitled draft'}
                </h2>
                <p className="studio-help" role="status">
                  {selected.invalid
                    ? 'The editor snapshot needs attention before saving.'
                    : selected.uploading
                      ? 'Finish or remove pending attachments before saving.'
                      : selected.snapshotPending
                        ? 'Preparing editor changes…'
                        : selected.dirty
                          ? 'Unsaved changes'
                          : `Saved privately · ${selected.source.revision.savedAt}`}
                </p>
                <ExactVersionDetails exact={selected.source.revision.exact} />
              </header>
              <div className="studio-document-toolbar">
                <nav className="studio-action-row" aria-label="Document views">
                  {(['write', 'preview', 'versions'] as const).map((view) => (
                    <Button
                      key={view}
                      type="button"
                      variant={tab === view ? 'default' : 'outline'}
                      aria-pressed={tab === view}
                      disabled={
                        tab === 'write' && view !== 'write' && Boolean(selected.snapshotPending || selected.uploading)
                      }
                      onClick={() => setTab(view)}
                    >
                      {view === 'write' ? 'Write' : view === 'preview' ? 'Preview' : 'Versions'}
                    </Button>
                  ))}
                </nav>
                <Button
                  type="button"
                  disabled={
                    !selected.source.permissions.edit ||
                    Boolean(state.busy) ||
                    (unresolved && state.issue?.kind !== 'uncertain' && state.issue?.kind !== 'unavailable') ||
                    selected.snapshotPending ||
                    selected.invalid ||
                    selected.uploading ||
                    !selected.title.trim() ||
                    (!selected.dirty && !unresolved)
                  }
                  onClick={() => void controller.save()}
                >
                  Save draft
                </Button>
              </div>
              {/* Keep the editor mounted across previews so its undo and upload owners survive tab changes. */}
              <section hidden={tab !== 'write'} aria-label="Write document" className="studio-stack">
                <label htmlFor={`${id}-title`}>Document title</label>
                <Input
                  id={`${id}-title`}
                  value={selected.title}
                  disabled={
                    !selected.source.permissions.edit ||
                    Boolean(state.busy === 'Publishing reviewed versions') ||
                    (unresolved && Boolean(state.review))
                  }
                  onChange={(event) => controller.changeTitle(event.target.value)}
                />
                {!selected.source.permissions.edit ? <p>This document is read only for your current role.</p> : null}
                <RichTextEditor
                  {...presentation.editor?.(selected.source.revision.exact)}
                  key={`${postId}:${selected.editorGeneration}`}
                  value={selected.body}
                  label={input.profile.kind === 'book' ? 'Chapter document' : 'Article document'}
                  className="studio-rich-text"
                  toolbar="auto"
                  readOnly={!selected.source.permissions.edit}
                  disabled={
                    Boolean(state.busy === 'Publishing reviewed versions') || (unresolved && Boolean(state.review))
                  }
                  onChange={(body) => {
                    if (editorCurrent()) controller.changeBody(body);
                  }}
                  onSnapshotPending={() => {
                    if (editorCurrent()) controller.snapshotPending();
                  }}
                  onSnapshotError={() => {
                    if (editorCurrent()) controller.snapshotError();
                  }}
                  onUploadState={(uploadState) => {
                    if (editorCurrent()) controller.uploadState(uploadState !== 'ready');
                  }}
                  onSave={() => void controller.save()}
                />
                <div className="studio-action-row">
                  {discard ? (
                    <>
                      <p>Discard local changes and return to the last saved draft?</p>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={blocked || selected.uploading}
                        onClick={() => {
                          controller.discard();
                          setDiscard(false);
                        }}
                      >
                        Discard changes
                      </Button>
                      <Button type="button" variant="outline" onClick={() => setDiscard(false)}>
                        Keep changes
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={blocked || !selected.dirty || selected.uploading}
                      onClick={() => setDiscard(true)}
                    >
                      Discard changes…
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={blocked || selected.dirty || selected.snapshotPending || selected.uploading}
                    onClick={() => void controller.open(selected.source.revision.exact.postId)}
                  >
                    Reload saved draft
                  </Button>
                </div>
              </section>
              {tab === 'preview' ? (
                <section className="studio-preview studio-stack" aria-label="Private draft preview">
                  <h2>{selected.title}</h2>
                  <p className="studio-preview-notice">
                    Private preview · {selected.dirty ? 'includes unsaved changes' : 'saved draft version'}
                  </p>
                  <DocumentBody
                    {...presentation.reader?.(selected.source.revision.exact)}
                    document={selected.body}
                    visitKey={`${input.visitKey}:${postId}:preview:${selected.editorGeneration}`}
                  />
                </section>
              ) : null}
              {tab === 'versions' ? (
                <StudioVersions key={postId} controller={controller} state={state} presentation={presentation} />
              ) : null}
            </>
          ) : (
            <section className="studio-empty">
              <h2>Make room for your next page</h2>
              <p>
                {input.canCreateDraft
                  ? 'Open a draft or create a new document to start writing.'
                  : 'Open a chapter or article from the list to continue editing.'}
              </p>
              {input.canCreateDraft && !input.nativeDrafts ? (
                <NewDraft controller={controller} disabled={blocked} />
              ) : null}
            </section>
          )}
          <StudioPublication controller={controller} state={state} />
        </div>
        <aside className="studio-sidebar" aria-label="Workspace navigation">
          <details
            open={navigation}
            onToggle={(event) => setNavigation(event.currentTarget.open)}
            className="studio-mobile-navigation"
          >
            <summary>Documents and {input.profile.kind === 'book' ? 'table of contents' : 'articles'}</summary>
            <div className="studio-stack">
              {state.structure ? (
                <BookOrganizer
                  controller={controller}
                  state={state}
                  onOpen={open}
                  {...(bookHistory ? { history: bookHistory } : {})}
                />
              ) : null}
              <section
                aria-label={input.profile.kind === 'book' ? 'Document drafts' : 'Articles'}
                className="studio-stack"
              >
                <h2>{input.profile.kind === 'book' ? 'Document drafts' : 'Articles'}</h2>
                <p className="studio-help">
                  {input.profile.kind === 'book'
                    ? 'Documents can be placed as chapters after saving.'
                    : 'Each article has its own saved revisions and publication.'}
                </p>
                <ol className="studio-draft-list">
                  {state.documents.items.map((document) => (
                    <li key={document.postId}>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-current={postId === document.postId ? 'page' : undefined}
                        disabled={blocked || document.openable === false}
                        onClick={() => open(document.postId)}
                      >
                        {document.title || 'Untitled draft'}
                      </Button>
                      <span className="studio-help">
                        {document.openable === false
                          ? m.studio_account_continue_drafts({}, { locale: getLocale() })
                          : document.state === 'published'
                            ? 'Published document'
                            : document.state === 'protected'
                              ? 'Protected document'
                              : document.state === 'taken_down'
                                ? 'Taken down'
                                : 'Private draft'}
                      </span>
                    </li>
                  ))}
                </ol>
                {!state.documents.items.length ? <p>No drafts on this page.</p> : null}
                {state.documents.nextCursor ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={blocked}
                    onClick={() => void controller.loadDocuments()}
                  >
                    {controller.failedPageCursor() === state.documents.nextCursor
                      ? m.own_drafts_retry({}, { locale: getLocale() })
                      : 'Next drafts'}
                  </Button>
                ) : null}
                {input.nativeDrafts ? (
                  <NativeDraftComposer
                    controller={controller}
                    disabled={blocked || Boolean(selected?.dirty || selected?.snapshotPending || selected?.uploading)}
                  />
                ) : input.canCreateDraft ? (
                  <NewDraft
                    controller={controller}
                    disabled={blocked || Boolean(selected?.dirty || selected?.snapshotPending || selected?.uploading)}
                  />
                ) : null}
              </section>
            </div>
          </details>
        </aside>
      </div>
    </section>
  );
}
function NewDraft({ controller, disabled }: { controller: StudioController; disabled: boolean }) {
  const [title, setTitle] = useState('');
  const id = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await controller.createDraft(title)) setTitle('');
  }
  return (
    <form className="studio-new-draft studio-stack" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id}>New document title</label>
      <Input id={id} value={title} required disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
      <Button type="submit" disabled={disabled || !title.trim()}>
        Create private draft
      </Button>
      {disabled ? (
        <p className="studio-help">Finish the current operation and save changes before creating another draft.</p>
      ) : null}
    </form>
  );
}

function NativeDraftComposer({ controller, disabled }: { controller: StudioController; disabled: boolean }) {
  const [boardId, setBoardId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [licence, setLicence] = useState('LicenseRef-rezics-terms');
  const [subjects, setSubjects] = useState('');
  const [media, setMedia] = useState('');
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const selectedId = state.selected?.source.revision.exact.postId ?? null;
  const lastCreatedId = useRef<string | null>(null);
  const id = useId();
  const locale = getLocale();
  useEffect(() => {
    if (
      !selectedId ||
      selectedId === lastCreatedId.current ||
      state.message !== m.studio_account_created({}, { locale })
    )
      return;
    lastCreatedId.current = selectedId;
    setBoardId('');
    setTitle('');
    setBody('');
    setSubjects('');
    setMedia('');
  }, [locale, selectedId, state.message]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const document = fromPlainText(body, 'blocks');
    if (
      !(await controller.createNativeDraft({
        boardId,
        title,
        body: document,
        licence,
        subjectIds: subjects.split(/[\s,]+/).filter(Boolean),
        mediaIds: media.split(/[\s,]+/).filter(Boolean),
      }))
    )
      return;
  }
  const bodyReady = hasDocumentContent(fromPlainText(body, 'blocks'));
  return (
    <form
      className="studio-native-create studio-stack"
      onSubmit={(event) => void submit(event)}
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`}>{m.studio_account_create({}, { locale })}</h2>
      <p className="studio-help">{m.studio_account_intro({}, { locale })}</p>
      <label htmlFor={`${id}-board`}>{m.studio_account_board({}, { locale })}</label>
      <Input
        id={`${id}-board`}
        value={boardId}
        required
        maxLength={128}
        disabled={disabled}
        onChange={(event) => setBoardId(event.target.value)}
      />
      <label htmlFor={`${id}-title`}>{m.studio_account_title({}, { locale })}</label>
      <Input
        id={`${id}-title`}
        value={title}
        required
        maxLength={512}
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor={`${id}-body`}>{m.studio_account_body({}, { locale })}</label>
      <textarea
        id={`${id}-body`}
        value={body}
        required
        rows={5}
        disabled={disabled}
        onChange={(event) => setBody(event.target.value)}
        className="studio-native-body"
      />
      <label htmlFor={`${id}-licence`}>{m.own_drafts_licence({}, { locale })}</label>
      <Input
        id={`${id}-licence`}
        value={licence}
        required
        maxLength={128}
        disabled={disabled}
        onChange={(event) => setLicence(event.target.value)}
      />
      <label htmlFor={`${id}-subjects`}>{m.own_drafts_subjects({}, { locale })}</label>
      <Input
        id={`${id}-subjects`}
        value={subjects}
        disabled={disabled}
        aria-describedby={`${id}-subject-help`}
        onChange={(event) => setSubjects(event.target.value)}
      />
      <p id={`${id}-subject-help`} className="studio-help">
        {m.studio_account_subject_help({}, { locale })}
      </p>
      <label htmlFor={`${id}-media`}>{m.own_drafts_media({}, { locale })}</label>
      <Input
        id={`${id}-media`}
        value={media}
        disabled={disabled}
        aria-describedby={`${id}-media-help`}
        onChange={(event) => setMedia(event.target.value)}
      />
      <p id={`${id}-media-help`} className="studio-help">
        {m.studio_account_media_help({}, { locale })}
      </p>
      <Button type="submit" disabled={disabled || !boardId.trim() || !title.trim() || !licence.trim() || !bodyReady}>
        {m.studio_account_create({}, { locale })}
      </Button>
    </form>
  );
}

/** The existing Book inventory remains a bounded list beside the account-draft workspace. */
export function HostedBookInventory({ visit, locale }: { visit: HostedInventoryVisit; locale: Locale }) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const page = state.kind === 'ready' ? state.page : null;
  const reopen = localizeHref('/studio?books=1', { locale });
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Studio</h1>
        <p>{m.studio_books_intro({}, { locale })}</p>
        <a className="studio-skip" href={localizeHref('/studio', { locale })}>
          {m.studio_account_return({}, { locale })}
        </a>
      </header>
      <section className="studio-stack" aria-labelledby="studio-books-heading" aria-busy={state.kind === 'loading'}>
        <h2 id="studio-books-heading">{m.studio_books_heading({}, { locale })}</h2>
        {state.kind === 'loading' ? <p role="status">{m.studio_books_loading({}, { locale })}</p> : null}
        {state.kind === 'ended' ? (
          <p role="alert">{m.studio_books_ended({}, { locale })}</p>
        ) : state.kind === 'failed' ? (
          <div className="studio-stack" role="alert">
            <p>{state.error.message}</p>
            {state.error.kind === 'unavailable' ? (
              <Button type="button" variant="outline" onClick={() => void visit.load()}>
                {m.studio_books_retry({}, { locale })}
              </Button>
            ) : null}
          </div>
        ) : null}
        {page ? (
          <>
            <p className="studio-help" role="status">
              {page.scope.crossHome === 'complete'
                ? m.studio_books_complete({}, { locale })
                : page.scope.crossHome === 'partial'
                  ? m.studio_books_partial({}, { locale })
                  : m.studio_books_same_home({}, { locale })}
            </p>
            {page.items.length ? (
              <ol className="studio-draft-list">
                {page.items.map((book) => (
                  <li key={book.catalogueId}>
                    <a
                      className="studio-toc-open"
                      href={localizeHref(hostedOwnerBookHref(book, page.viewer), { locale })}
                    >
                      {m.studio_books_open({ id: book.catalogueId }, { locale })}
                    </a>
                    <span className="studio-help">
                      {book.postVisibility === 'draft'
                        ? m.studio_books_draft({}, { locale })
                        : book.postVisibility === 'protected'
                          ? m.studio_books_protected({}, { locale })
                          : m.studio_books_published({}, { locale })}
                      {' · '}
                      <time dateTime={book.createdAt}>{new Date(book.createdAt).toLocaleDateString(locale)}</time>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>
                {page.scope.crossHome === 'complete' &&
                state.kind === 'ready' &&
                state.cursor === null &&
                page.nextCursor === null
                  ? m.studio_books_empty({}, { locale })
                  : m.studio_books_empty_page({}, { locale })}
              </p>
            )}
            {page.nextCursor !== null ? (
              <Button type="button" variant="outline" onClick={() => void visit.next()}>
                {m.studio_books_more({}, { locale })}
              </Button>
            ) : null}
          </>
        ) : null}
        {state.kind === 'ended' || state.kind === 'failed' || (page && page.scope.crossHome !== 'complete') ? (
          <a className="studio-skip" href={reopen}>
            {m.studio_books_reopen({}, { locale })}
          </a>
        ) : null}
      </section>
    </main>
  );
}
