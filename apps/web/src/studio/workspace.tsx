import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import { fromPlainText, hasDocumentContent } from '@rezics/document';
import { RichTextEditor } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { DocumentBody } from '../document-body';
import type { BookOrganizerPort, StudioInput, StudioPort, StudioPresentation } from './contract';
import { StudioController } from './controller';
import { workspaceEditorLabels, workspaceFailureMessage } from './workspace-language';
import { BookOrganizer } from './book-organizer';
import { ExactVersionDetails, StudioVersions } from './revisions';
import { StudioPublication } from './publication';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref, type Locale } from '../paraglide/runtime.js';
import { HostedInventoryVisit, hostedOwnerBookHref } from './hosted-inventory';
import type { HostedHistoryBinding } from './hosted-history';
import {
  HostedBookStart,
  savedOpeningForBook,
  type HostedBookStartBinding,
  type HostedBookStartState,
} from './hosted-book-start';
import { HostedBookStartAction } from './hosted-book-start-action';
import { HostedDraftPickerView } from './hosted-draft-picker-view';
import type { HostedDraftPicker } from './hosted-draft-picker';
import { HostedReleaseReaderLink } from './hosted-release-reader-link-action';
import type { HostedReleaseReaderBinding } from './hosted-release-reader-link';
import { WorkbenchRegion } from './workbench-region';
import { workbenchCopy } from './workbench-copy';
import './studio.css';

const noBookStart: HostedBookStartState = { kind: 'idle' };
const noSubscribe = () => () => {};
const noSnapshot = () => noBookStart;

export type StudioWorkspaceProps = {
  input: StudioInput;
  port: StudioPort;
  bookPort?: BookOrganizerPort;
  bookHistory?: HostedHistoryBinding;
  draftPicker?: HostedDraftPicker;
  hostedReleaseReader?: HostedReleaseReaderBinding;
  /** Only the account-draft route supplies this capability; other document workspaces cannot start Books. */
  bookStart?: HostedBookStartBinding;
  presentation?: StudioPresentation;
  /** Route-owned preparation links belong beside the deliberate publication controls. */
  publicationTools?: ReactNode;
  /** Lets the mounted composition guard internal route navigation as well as browser departure. */
  onDepartureRiskChange?: (atRisk: boolean) => void;
};

/** Production composition surface. No route, generated-operation binding or public authority is inferred here. */
export function StudioWorkspace(props: StudioWorkspaceProps) {
  if (!props.port.isCurrent()) return <p role="status">{m.studio_workspace_ended({}, { locale: getLocale() })}</p>;
  return <StudioVisit key={props.input.visitKey} {...props} />;
}
function StudioVisit(props: StudioWorkspaceProps) {
  const [controller] = useState(
    () => new StudioController(props.input, props.port, props.bookPort, Boolean(props.draftPicker)),
  );
  return <StudioWorkbench {...props} controller={controller} />;
}

/** The installed workbench can also resume an already prepared visit without duplicating its view. */
export function StudioWorkbench({
  controller,
  input,
  port,
  bookHistory,
  draftPicker,
  hostedReleaseReader,
  bookStart,
  presentation = {},
  publicationTools,
  onDepartureRiskChange,
}: StudioWorkspaceProps & { controller: StudioController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [starter] = useState(() =>
    bookStart
      ? new HostedBookStart(bookStart, () =>
          controller.hasUnresolvedCommand() ? null : savedOpeningForBook(controller.snapshot()),
        )
      : null,
  );
  const startState = useSyncExternalStore(
    starter?.subscribe ?? noSubscribe,
    starter?.snapshot ?? noSnapshot,
    starter?.snapshot ?? noSnapshot,
  );
  const startingBook = starter?.locked() ?? false;
  const [tab, setTab] = useState<'write' | 'preview' | 'versions'>(() => (state.historical ? 'versions' : 'write'));
  const [navigation, setNavigation] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const previousPost = useRef<string | null>(
    state.historical ? (state.selected?.source.revision.exact.postId ?? null) : null,
  );
  const id = useId();
  const locale = getLocale();
  const options = { locale };
  const copy = workbenchCopy[locale];
  const selected = state.selected;
  const editorPresentation = selected ? presentation.editor?.(selected.source.revision.exact) : undefined;
  const editorLabels = useMemo(
    () => ({ ...workspaceEditorLabels(locale), ...editorPresentation?.labels }),
    [locale, editorPresentation?.labels],
  );
  const documentTitle = selected?.title.trim() || m.own_drafts_no_title({}, options);
  const workTitle = input.title.trim() || m.own_drafts_no_title({}, options);
  const postId = selected?.source.revision.exact.postId ?? null;
  const editorGeneration = selected?.editorGeneration ?? 0;
  const editorCurrent = () => postId !== null && controller.isEditorCurrent(postId, editorGeneration);
  const unresolved = controller.hasUnresolvedCommand();
  const atRisk = Boolean(
    selected?.dirty ||
    selected?.snapshotPending ||
    selected?.uploading ||
    state.operation ||
    unresolved ||
    startingBook,
  );
  const blocked = Boolean(state.operation) || unresolved || startingBook;

  useEffect(() => controller.connect(), [controller]);
  useEffect(() => starter?.connect(), [starter]);
  useEffect(() => draftPicker?.connect(), [draftPicker]);
  useEffect(() => {
    if (!state.operation) draftPicker?.retainSelection(selected?.source ?? null);
  }, [draftPicker, selected?.source, state.operation]);
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
        if (!startingBook) void controller.save();
      }
    };
    window.addEventListener('keydown', save);
    return () => window.removeEventListener('keydown', save);
  }, [controller, startingBook]);
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
  if (!port.isCurrent()) return <p role="status">{m.studio_workspace_ended({}, { locale: getLocale() })}</p>;
  return (
    <section className="studio-workspace" aria-label={m.studio_workspace_region({ title: workTitle }, options)}>
      <header className="studio-header">
        <div className="studio-work-heading">
          <p className="studio-eyebrow">
            {input.profile.kind === 'book'
              ? m.studio_workspace_book_profile({}, options)
              : input.profile.seriesTitle
                ? copy.column
                : m.studio_workspace_articles({}, options)}
          </p>
          <h1>{workTitle}</h1>
          {input.profile.kind === 'articles' && input.profile.seriesTitle ? (
            <p className="studio-help">{input.profile.seriesTitle}</p>
          ) : null}
        </div>
        <a className="studio-skip" href={`#${id}-document`}>
          {m.studio_workspace_skip({}, options)}
        </a>
      </header>
      <div className="studio-status" aria-live="polite" aria-atomic="true">
        {state.busy ? <p role="status">{state.busy}</p> : state.message ? <p role="status">{state.message}</p> : null}
        {state.issue ? (
          <div role="alert" className="studio-stack">
            <p>{workspaceFailureMessage(state.issue.kind, locale)}</p>
            {state.issue.message !== workspaceFailureMessage(state.issue.kind, locale) ? (
              <p>{state.issue.message}</p>
            ) : null}
            {unresolved ? (
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(state.operation)}
                onClick={() => void controller.retry()}
              >
                {m.studio_workspace_retry({}, options)}
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
        <section
          className="studio-navigation-confirm studio-stack"
          aria-label={m.studio_workspace_switch_region({}, options)}
        >
          <h2>{m.studio_workspace_switch_heading({}, options)}</h2>
          <p>{m.studio_workspace_switch_help({}, options)}</p>
          <div className="studio-action-row">
            <Button
              type="button"
              disabled={blocked || Boolean(selected?.snapshotPending || selected?.invalid || selected?.uploading)}
              onClick={() => void continueToDraft(true)}
            >
              {m.studio_workspace_save_switch({}, options)}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={blocked || Boolean(selected?.uploading)}
              onClick={() => void continueToDraft(false)}
            >
              {m.studio_workspace_discard_switch({}, options)}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPendingOpen(null)}>
              {m.studio_workspace_keep_editing({}, options)}
            </Button>
          </div>
        </section>
      ) : null}
      <fieldset className="studio-layout min-w-0" disabled={startingBook}>
        <aside className="studio-sidebar" aria-label={m.studio_workspace_navigation({}, options)}>
          <details
            open={navigation}
            onToggle={(event) => setNavigation(event.currentTarget.open)}
            className="studio-mobile-navigation"
          >
            <summary>
              {input.profile.kind === 'book'
                ? m.studio_workspace_book_navigation({}, options)
                : m.studio_workspace_article_navigation({}, options)}
            </summary>
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
                aria-label={
                  input.profile.kind === 'book'
                    ? m.studio_workspace_drafts({}, options)
                    : m.studio_workspace_articles({}, options)
                }
                className="studio-stack"
              >
                <h2>
                  {input.profile.kind === 'book'
                    ? m.studio_workspace_drafts({}, options)
                    : m.studio_workspace_articles({}, options)}
                </h2>
                <p className="studio-help">
                  {input.profile.kind === 'book'
                    ? m.studio_workspace_book_drafts_help({}, options)
                    : m.studio_workspace_article_drafts_help({}, options)}
                </p>
                {draftPicker ? (
                  <HostedDraftPickerView
                    picker={draftPicker}
                    disabled={atRisk || Boolean(selected?.invalid)}
                    onSelect={(post) => void controller.open(post)}
                  />
                ) : null}
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
                        {document.openable === false
                          ? document.title.trim() || m.own_drafts_selection_unavailable({}, options)
                          : document.title.trim() || m.own_drafts_no_title({}, options)}
                      </Button>
                      <span className="studio-help">
                        {document.openable === false
                          ? m.studio_account_continue_drafts({}, { locale: getLocale() })
                          : document.state === 'published'
                            ? m.studio_workspace_published_document({}, options)
                            : document.state === 'protected'
                              ? m.studio_workspace_protected_document({}, options)
                              : document.state === 'taken_down'
                                ? m.studio_workspace_taken_down({}, options)
                                : m.studio_workspace_private_draft({}, options)}
                      </span>
                    </li>
                  ))}
                </ol>
                {!state.documents.items.length ? <p>{m.studio_workspace_empty_page({}, options)}</p> : null}
                {state.documents.nextCursor ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={blocked}
                    onClick={() => void controller.loadDocuments()}
                  >
                    {controller.failedPageCursor() === state.documents.nextCursor
                      ? m.own_drafts_retry({}, { locale: getLocale() })
                      : m.studio_workspace_next({}, options)}
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
              <details className="studio-technical">
                <summary>{copy.workDetails}</summary>
                <p>{m.studio_workspace_private_help({}, options)}</p>
              </details>
            </div>
          </details>
        </aside>
        <div id={`${id}-document`} className="studio-document" tabIndex={-1}>
          {selected ? (
            <>
              <header className="studio-document-heading">
                <p className="studio-eyebrow">
                  {input.profile.kind === 'book'
                    ? postId === state.structure?.catalogueId
                      ? m.studio_workspace_book_profile({}, options)
                      : copy.chapter
                    : copy.article}
                </p>
                <h2 ref={editorHeading} tabIndex={-1}>
                  {documentTitle}
                </h2>
                <p className="studio-help" role="status">
                  {selected.invalid
                    ? m.studio_workspace_snapshot_error({}, options)
                    : selected.uploading
                      ? m.studio_workspace_upload_pending({}, options)
                      : selected.snapshotPending
                        ? m.studio_workspace_snapshot_pending({}, options)
                        : selected.dirty
                          ? m.studio_workspace_unsaved({}, options)
                          : m.studio_workspace_saved_at({ savedAt: selected.source.revision.savedAt }, options)}
                </p>
                {!selected.source.permissions.edit ? (
                  <p role="status">{m.studio_workspace_readonly({}, options)}</p>
                ) : null}
              </header>
              <div className="studio-document-toolbar">
                <nav className="studio-action-row" aria-label={m.studio_workspace_views({}, options)}>
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
                      {view === 'write'
                        ? m.studio_workspace_write({}, options)
                        : view === 'preview'
                          ? m.studio_workspace_preview({}, options)
                          : m.studio_workspace_versions({}, options)}
                    </Button>
                  ))}
                </nav>
                <Button
                  type="button"
                  disabled={
                    !selected.source.permissions.edit ||
                    Boolean(state.operation) ||
                    (unresolved && state.issue?.kind !== 'uncertain' && state.issue?.kind !== 'unavailable') ||
                    selected.snapshotPending ||
                    selected.invalid ||
                    selected.uploading ||
                    !selected.title.trim() ||
                    (!selected.dirty && !unresolved)
                  }
                  onClick={() => void controller.save()}
                >
                  {m.studio_workspace_save({}, options)}
                </Button>
              </div>
              {/* Keep the editor mounted across previews so its undo and upload owners survive tab changes. */}
              <section
                hidden={tab !== 'write'}
                aria-label={m.studio_workspace_write_region({}, options)}
                className="studio-writing-canvas studio-stack"
              >
                <label htmlFor={`${id}-title`}>{m.studio_workspace_title({}, options)}</label>
                <Input
                  id={`${id}-title`}
                  value={selected.title}
                  disabled={
                    !selected.source.permissions.edit ||
                    startingBook ||
                    state.operation === 'publish' ||
                    state.operation === 'withdraw' ||
                    (unresolved && Boolean(state.review))
                  }
                  onChange={(event) => controller.changeTitle(event.target.value)}
                />
                <RichTextEditor
                  {...editorPresentation}
                  labels={editorLabels}
                  lang={editorPresentation?.lang ?? locale}
                  key={`${postId}:${selected.editorGeneration}`}
                  value={selected.body}
                  label={
                    input.profile.kind === 'book'
                      ? m.studio_workspace_chapter_document({}, options)
                      : m.studio_workspace_article_document({}, options)
                  }
                  className="studio-rich-text"
                  toolbar="auto"
                  readOnly={!selected.source.permissions.edit || startingBook}
                  disabled={
                    startingBook ||
                    state.operation === 'publish' ||
                    state.operation === 'withdraw' ||
                    (unresolved && Boolean(state.review))
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
                <WorkbenchRegion title={copy.draftActions} attention={discard || selected.dirty}>
                  <ExactVersionDetails exact={selected.source.revision.exact} />
                  <div className="studio-action-row">
                    {discard ? (
                      <>
                        <p>{m.studio_workspace_discard_prompt({}, options)}</p>
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={blocked || selected.uploading}
                          onClick={() => {
                            controller.discard();
                            setDiscard(false);
                          }}
                        >
                          {m.studio_workspace_discard({}, options)}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setDiscard(false)}>
                          {m.studio_workspace_keep_changes({}, options)}
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={blocked || !selected.dirty || selected.uploading}
                        onClick={() => setDiscard(true)}
                      >
                        {m.studio_workspace_discard_review({}, options)}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={blocked || selected.dirty || selected.snapshotPending || selected.uploading}
                      onClick={() => void controller.open(selected.source.revision.exact.postId)}
                    >
                      {m.studio_workspace_reload({}, options)}
                    </Button>
                  </div>
                </WorkbenchRegion>
              </section>
              {tab === 'preview' ? (
                <section
                  className="studio-preview studio-stack"
                  aria-label={m.studio_workspace_preview_region({}, options)}
                >
                  <h2>{documentTitle}</h2>
                  <p className="studio-preview-notice">
                    {selected.dirty
                      ? m.studio_workspace_preview_unsaved({}, options)
                      : m.studio_workspace_preview_saved({}, options)}
                  </p>
                  <DocumentBody
                    {...presentation.reader?.(selected.source.revision.exact)}
                    document={selected.body}
                    visitKey={`${input.visitKey}:${postId}:preview:${selected.editorGeneration}`}
                  />
                </section>
              ) : null}
              <div hidden={tab !== 'versions'}>
                <StudioVersions key={postId} controller={controller} state={state} presentation={presentation} />
              </div>
            </>
          ) : (
            <section className="studio-empty">
              <h2>{m.studio_workspace_empty_heading({}, options)}</h2>
              <p>
                {input.canCreateDraft
                  ? m.studio_workspace_empty_create({}, options)
                  : m.studio_workspace_empty_open({}, options)}
              </p>
              {input.canCreateDraft && !input.nativeDrafts ? (
                <NewDraft controller={controller} disabled={blocked} />
              ) : null}
            </section>
          )}
          <div className="studio-publication-region">
            {!input.canPublish || input.publicationUnavailableReason ? (
              <p className="studio-help" role="status">
                {input.publicationUnavailableReason ?? m.studio_release_unavailable({}, options)}
              </p>
            ) : null}
            <WorkbenchRegion
              title={copy.publication}
              attention={
                Boolean(state.review || state.published) ||
                state.operation === 'review' ||
                state.operation === 'withdraw-review'
              }
            >
              <p className="studio-help">{m.studio_workspace_private_help({}, options)}</p>
              {publicationTools}
              <StudioPublication controller={controller} state={state} />
              {hostedReleaseReader ? <HostedReleaseReaderLink binding={hostedReleaseReader} /> : null}
            </WorkbenchRegion>
          </div>
        </div>
      </fieldset>
      {starter ? (
        <div className="studio-book-start-region">
          <HostedBookStartAction
            state={startState}
            eligible={Boolean(savedOpeningForBook(state)) && !unresolved && starter.isCurrent()}
            start={starter.start}
            retry={starter.retry}
          />
        </div>
      ) : null}
    </section>
  );
}
function NewDraft({ controller, disabled }: { controller: StudioController; disabled: boolean }) {
  const [title, setTitle] = useState('');
  const options = { locale: getLocale() };
  const id = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await controller.createDraft(title)) setTitle('');
  }
  return (
    <form className="studio-new-draft studio-stack" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id}>{m.studio_workspace_new_title({}, options)}</label>
      <Input id={id} value={title} required disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
      <Button type="submit" disabled={disabled || !title.trim()}>
        {m.studio_workspace_create({}, options)}
      </Button>
      {disabled ? <p className="studio-help">{m.studio_workspace_create_wait({}, options)}</p> : null}
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
    if (!selectedId || selectedId === lastCreatedId.current || state.result !== 'native-created') return;
    lastCreatedId.current = selectedId;
    setBoardId('');
    setTitle('');
    setBody('');
    setSubjects('');
    setMedia('');
  }, [selectedId, state.result]);
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
                      className="studio-toc-open whitespace-normal [overflow-wrap:anywhere]"
                      href={localizeHref(hostedOwnerBookHref(book, page.viewer), { locale })}
                    >
                      {book.title ?? m.studio_books_open({ id: book.catalogueId }, { locale })}
                    </a>
                    <a
                      className="studio-toc-open whitespace-normal [overflow-wrap:anywhere]"
                      href={localizeHref(hostedOwnerBookHref(book, page.viewer, true), { locale })}
                    >
                      {m.studio_root_append_entry({}, { locale })}
                    </a>
                    <a
                      className="studio-toc-open whitespace-normal [overflow-wrap:anywhere]"
                      href={localizeHref(`${hostedOwnerBookHref(book, page.viewer)}&points=1`, { locale })}
                    >
                      {m.studio_draft_point_entry({}, { locale })}
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
