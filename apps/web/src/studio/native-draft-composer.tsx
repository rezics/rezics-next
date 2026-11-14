import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { fromPlainText, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { RichTextEditor } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PostReadingBody } from '../threads/post-reading-body';
import type { NativeDraftCreate } from './contract';
import type { StudioController } from './controller';
import { workspaceEditorLabels } from './workspace-language';

type DraftForm = {
  boardId: string;
  title: string;
  body: DocumentSnapshot;
  licence: string;
  subjects: string;
  media: string;
  snapshot: 'ready' | 'pending' | 'invalid';
  snapshotGeneration: number;
  version: number;
};
type Submission = { version: number; title: string; boardId: string };
// Each view entry owns a visit, so callbacks from an earlier preview cannot revive on return.
type DraftView = { mode: 'write' | 'preview' };

function emptyForm(): DraftForm {
  return {
    boardId: '',
    title: '',
    body: fromPlainText('', 'blocks'),
    licence: 'LicenseRef-rezics-terms',
    subjects: '',
    media: '',
    snapshot: 'ready',
    snapshotGeneration: 0,
    version: 0,
  };
}

/** One unsent document. The controller owns every sent intent and its explicit replay. */
export function NativeDraftComposer({
  controller,
  disabled,
  onDepartureRiskChange,
  onCommandPendingChange,
}: {
  controller: StudioController;
  disabled: boolean;
  onDepartureRiskChange: (atRisk: boolean) => void;
  onCommandPendingChange: (pending: boolean) => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [form, setForm] = useState(emptyForm);
  // The ref points at the same immutable form, allowing synchronous snapshot invalidation before React renders.
  const currentForm = useRef(form);
  const currentController = useRef(controller);
  currentController.current = controller;
  const [submission, setSubmission] = useState<Submission | null>(null);
  const submitted = useRef<Submission | null>(null);
  const [generation, setGeneration] = useState(0);
  const editorGeneration = useRef(0);
  const [view, setView] = useState<DraftView>({ mode: 'write' });
  const currentView = useRef(view);
  const [discard, setDiscard] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retained, setRetained] = useState(false);
  const mounted = useRef(false);
  const formElement = useRef<HTMLFormElement>(null);
  const titleElement = useRef<HTMLInputElement>(null);
  const id = useId();
  const locale = getLocale();
  const options = { locale };
  const labels = useMemo(() => workspaceEditorLabels(locale), [locale]);
  const ownsCommand = submission !== null;
  const editingBlocked = disabled && !ownsCommand;
  const atRisk = form.version !== 0 || ownsCommand;
  const previewReady = form.snapshot === 'ready' && hasDocumentContent(form.body);
  const ready =
    !disabled &&
    !ownsCommand &&
    previewReady &&
    Boolean(form.boardId.trim() && form.title.trim() && form.licence.trim());
  // Metadata edits keep the reader in place. Every structured snapshot lifecycle, including equal bytes,
  // replaces it. The identity describes only this unsent visit; it makes no persisted revision claim.
  const readerIdentity = useMemo(
    () => ({}),
    [controller, view, form.body, form.snapshotGeneration, generation, locale],
  );
  const previewVisitKey = `studio-unsent:${id}:${generation}:${form.snapshotGeneration}:${locale}`;
  const isReaderCurrent = () => {
    const live = currentForm.current;
    return (
      current() &&
      view.mode === 'preview' &&
      currentView.current === view &&
      live.body === form.body &&
      live.snapshotGeneration === form.snapshotGeneration &&
      live.snapshot === 'ready'
    );
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDepartureRiskChange(atRisk);
    return () => onDepartureRiskChange(false);
  }, [atRisk, onDepartureRiskChange]);
  useEffect(() => {
    onCommandPendingChange(ownsCommand);
    return () => onCommandPendingChange(false);
  }, [ownsCommand, onCommandPendingChange]);
  useEffect(() => {
    const attempt = submitted.current;
    if (!attempt || state.operation || !controller.current()) return;
    if (state.result === 'native-created') {
      submitted.current = null;
      setSubmission(null);
      // An acknowledgement belongs to the submitted form version, including its snapshot lifecycle.
      if (currentForm.current.version === attempt.version) reset();
      else setRetained(true);
    } else if (state.issue && !controller.hasUnresolvedCommand()) {
      // A replay can also finish with a definite rejection. Keep the working document editable.
      submitted.current = null;
      setSubmission(null);
      setFailed(true);
    }
  }, [controller, state.operation, state.result, state.issue]);

  function current() {
    return (
      mounted.current &&
      currentController.current === controller &&
      controller.current() &&
      getLocale() === locale &&
      editorGeneration.current === generation
    );
  }
  function changeView(mode: DraftView['mode']) {
    if (currentView.current.mode === mode) return;
    const next = { mode };
    currentView.current = next;
    setView(next);
  }
  function update(patch: Partial<DraftForm>) {
    if (!current()) return;
    const previous = currentForm.current;
    const next = {
      ...previous,
      ...patch,
      version: previous.version + 1,
      snapshotGeneration: previous.snapshotGeneration + (patch.snapshot === undefined ? 0 : 1),
    };
    currentForm.current = next;
    setForm(next);
  }
  function reset() {
    const next = emptyForm();
    currentForm.current = next;
    setForm(next);
    editorGeneration.current++;
    setGeneration(editorGeneration.current);
    changeView('write');
    setDiscard(false);
    setFailed(false);
    setRetained(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const draft = currentForm.current;
    if (!current() || disabled || submitted.current || draft.snapshot !== 'ready') return;
    if (!draft.boardId.trim() || !draft.title.trim() || !draft.licence.trim() || !hasDocumentContent(draft.body))
      return;
    const command: NativeDraftCreate = {
      boardId: draft.boardId,
      title: draft.title,
      body: draft.body,
      licence: draft.licence,
      subjectIds: draft.subjects.split(/[\s,]+/).filter(Boolean),
      mediaIds: draft.media.split(/[\s,]+/).filter(Boolean),
    };
    const attempt = { version: draft.version, title: draft.title, boardId: draft.boardId };
    submitted.current = attempt;
    setSubmission(attempt);
    setFailed(false);
    setRetained(false);
    setDiscard(false);
    await controller.createNativeDraft(command);
    if (!current() || submitted.current !== attempt) return;
    if (!controller.hasUnresolvedCommand() && controller.snapshot().result !== 'native-created') {
      submitted.current = null;
      setSubmission(null);
      setFailed(true);
    }
  }
  return (
    <form
      ref={formElement}
      className="studio-native-create studio-stack w-full max-w-3xl"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        // The workspace shortcut saves an acknowledged selection; this form has its own private create action.
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
          const handledByEditor = event.defaultPrevented;
          event.preventDefault();
          event.stopPropagation();
          if (!handledByEditor) formElement.current?.requestSubmit();
        }
      }}
      onInvalidCapture={(event) => {
        const details = (event.target as HTMLElement).closest('details');
        if (details) details.open = true;
      }}
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-privacy`}
    >
      <h2 id={`${id}-heading`}>{m.studio_account_create({}, options)}</h2>
      <p className="studio-help">{m.studio_account_intro({}, options)}</p>
      <p id={`${id}-privacy`} className="studio-help">
        {m.studio_workspace_private_help({}, options)}
      </p>
      <label htmlFor={`${id}-board`}>{m.studio_account_board({}, options)}</label>
      <Input
        id={`${id}-board`}
        value={form.boardId}
        required
        maxLength={128}
        disabled={editingBlocked}
        onChange={(event) => update({ boardId: event.target.value })}
      />
      <label htmlFor={`${id}-title`}>{m.studio_account_title({}, options)}</label>
      <Input
        ref={titleElement}
        id={`${id}-title`}
        value={form.title}
        required
        maxLength={512}
        disabled={editingBlocked}
        onChange={(event) => update({ title: event.target.value })}
      />
      <nav className="studio-action-row" aria-label={m.studio_workspace_views({}, options)}>
        <Button
          type="button"
          variant={view.mode === 'write' ? 'default' : 'outline'}
          aria-pressed={view.mode === 'write'}
          onClick={() => {
            if (current()) changeView('write');
          }}
        >
          {m.studio_workspace_write({}, options)}
        </Button>
        <Button
          type="button"
          variant={view.mode === 'preview' ? 'default' : 'outline'}
          aria-pressed={view.mode === 'preview'}
          disabled={!previewReady}
          onClick={() => {
            const live = currentForm.current;
            if (current() && live.snapshot === 'ready' && hasDocumentContent(live.body)) changeView('preview');
          }}
        >
          {m.studio_workspace_preview({}, options)}
        </Button>
      </nav>
      {/* Keep the editor mounted across preview so undo and pending snapshot ownership survive. */}
      <section
        hidden={view.mode !== 'write'}
        className="studio-stack"
        aria-label={m.studio_workspace_write_region({}, options)}
      >
        <RichTextEditor
          key={generation}
          value={form.body}
          label={m.studio_account_body({}, options)}
          labels={labels}
          lang={locale}
          className="studio-rich-text"
          toolbar="auto"
          disabled={editingBlocked}
          onChange={(body) => update({ body, snapshot: 'ready' })}
          onSnapshotPending={() => update({ snapshot: 'pending' })}
          onSnapshotError={() => update({ snapshot: 'invalid' })}
          onSave={() => formElement.current?.requestSubmit()}
        />
      </section>
      {view.mode === 'preview' && previewReady ? (
        <section className="studio-preview studio-stack" aria-label={m.studio_workspace_preview_region({}, options)}>
          <h3>{form.title.trim() || m.own_drafts_no_title({}, options)}</h3>
          <p className="studio-preview-notice">{m.studio_workspace_preview_unsaved({}, options)}</p>
          <PostReadingBody
            document={form.body}
            locale={locale}
            readerIdentity={readerIdentity}
            isReaderCurrent={isReaderCurrent}
            visitKey={previewVisitKey}
            wideVisitKey={previewVisitKey}
          />
        </section>
      ) : null}
      <p className="studio-help" role="status">
        {form.snapshot === 'invalid'
          ? m.studio_workspace_snapshot_error({}, options)
          : form.snapshot === 'pending'
            ? m.studio_workspace_snapshot_pending({}, options)
            : atRisk
              ? m.studio_workspace_unsaved({}, options)
              : m.studio_workspace_private_draft({}, options)}
      </p>
      <details className="studio-technical">
        <summary>{m.studio_native_metadata({}, options)}</summary>
        <div className="studio-stack">
          <label htmlFor={`${id}-licence`}>{m.own_drafts_licence({}, options)}</label>
          <Input
            id={`${id}-licence`}
            value={form.licence}
            required
            maxLength={128}
            disabled={editingBlocked}
            onChange={(event) => update({ licence: event.target.value })}
          />
          <label htmlFor={`${id}-subjects`}>{m.own_drafts_subjects({}, options)}</label>
          <Input
            id={`${id}-subjects`}
            value={form.subjects}
            disabled={editingBlocked}
            aria-describedby={`${id}-subject-help`}
            onChange={(event) => update({ subjects: event.target.value })}
          />
          <p id={`${id}-subject-help`} className="studio-help">
            {m.studio_account_subject_help({}, options)}
          </p>
          <label htmlFor={`${id}-media`}>{m.own_drafts_media({}, options)}</label>
          <Input
            id={`${id}-media`}
            value={form.media}
            disabled={editingBlocked}
            aria-describedby={`${id}-media-help`}
            onChange={(event) => update({ media: event.target.value })}
          />
          <p id={`${id}-media-help`} className="studio-help">
            {m.studio_account_media_help({}, options)}
          </p>
        </div>
      </details>
      {submission ? (
        <section className="studio-stack" aria-label={m.studio_native_submitted({}, options)} aria-live="polite">
          <p>
            {state.operation === 'native-create'
              ? m.studio_workspace_creating({}, options)
              : m.studio_native_replay_help({}, options)}
          </p>
          <dl>
            <dt>{m.studio_account_title({}, options)}</dt>
            <dd>{submission.title}</dd>
            <dt>{m.studio_account_board({}, options)}</dt>
            <dd className="break-all">{submission.boardId}</dd>
          </dl>
          {form.version !== submission.version ? <p>{m.studio_native_later_edits({}, options)}</p> : null}
          {state.issue && controller.hasUnresolvedCommand() ? (
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(state.operation)}
              onClick={() => void controller.retry()}
            >
              {m.studio_native_retry({}, options)}
            </Button>
          ) : null}
        </section>
      ) : null}
      {failed ? <p role="status">{m.studio_native_failed({}, options)}</p> : null}
      {retained ? <p role="status">{m.studio_native_retained({}, options)}</p> : null}
      {discard ? (
        <section className="studio-stack" aria-label={m.studio_native_discard_prompt({}, options)}>
          <p>{m.studio_native_discard_prompt({}, options)}</p>
          <div className="studio-action-row">
            <Button
              type="button"
              variant="outline"
              disabled={ownsCommand}
              onClick={() => {
                if (!current() || submitted.current) return;
                reset();
                titleElement.current?.focus({ preventScroll: true });
              }}
            >
              {m.studio_workspace_discard({}, options)}
            </Button>
            <Button type="button" variant="outline" onClick={() => setDiscard(false)}>
              {m.studio_workspace_keep_changes({}, options)}
            </Button>
          </div>
        </section>
      ) : null}
      <div className="studio-action-row">
        <Button type="submit" disabled={!ready}>
          {m.studio_account_create({}, options)}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!atRisk || ownsCommand || editingBlocked}
          onClick={() => setDiscard(true)}
        >
          {m.studio_workspace_discard_review({}, options)}
        </Button>
      </div>
      {disabled && !ownsCommand ? <p className="studio-help">{m.studio_workspace_create_wait({}, options)}</p> : null}
    </form>
  );
}
