import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { fromPlainText, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { RichTextEditor } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
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
  version: number;
};
type Submission = { version: number; title: string; boardId: string };

function emptyForm(): DraftForm {
  return {
    boardId: '',
    title: '',
    body: fromPlainText('', 'blocks'),
    licence: 'LicenseRef-rezics-terms',
    subjects: '',
    media: '',
    snapshot: 'ready',
    version: 0,
  };
}

/** One unsent document. The controller owns every sent intent and its explicit replay. */
export function NativeDraftComposer({
  controller,
  disabled,
  onDepartureRiskChange,
}: {
  controller: StudioController;
  disabled: boolean;
  onDepartureRiskChange: (atRisk: boolean) => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [form, setForm] = useState(emptyForm);
  // The ref points at the same immutable form, allowing synchronous snapshot invalidation before React renders.
  const currentForm = useRef(form);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const submitted = useRef<Submission | null>(null);
  const [generation, setGeneration] = useState(0);
  const editorGeneration = useRef(0);
  const mounted = useRef(false);
  const formElement = useRef<HTMLFormElement>(null);
  const id = useId();
  const locale = getLocale();
  const options = { locale };
  const labels = useMemo(() => workspaceEditorLabels(locale), [locale]);
  const ownsCommand = submission !== null;
  const editingBlocked = disabled && !ownsCommand;
  const atRisk = form.version !== 0 || ownsCommand;
  const ready =
    !disabled &&
    !ownsCommand &&
    form.snapshot === 'ready' &&
    Boolean(form.boardId.trim() && form.title.trim() && form.licence.trim()) &&
    hasDocumentContent(form.body);

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
    const attempt = submitted.current;
    if (!attempt || state.result !== 'native-created' || !controller.current()) return;
    submitted.current = null;
    setSubmission(null);
    // An acknowledgement belongs to the submitted form version, including its snapshot lifecycle.
    if (currentForm.current.version === attempt.version) reset();
  }, [controller, state.result]);

  function current() {
    return mounted.current && controller.current() && editorGeneration.current === generation;
  }
  function update(patch: Partial<DraftForm>) {
    if (!current()) return;
    const next = { ...currentForm.current, ...patch, version: currentForm.current.version + 1 };
    currentForm.current = next;
    setForm(next);
  }
  function reset() {
    const next = emptyForm();
    currentForm.current = next;
    setForm(next);
    editorGeneration.current++;
    setGeneration(editorGeneration.current);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const draft = currentForm.current;
    if (!current() || disabled || submitted.current || draft.snapshot !== 'ready') return;
    if (!draft.boardId.trim() || !draft.title.trim() || !draft.licence.trim() || !hasDocumentContent(draft.body)) return;
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
    await controller.createNativeDraft(command);
    if (!current() || submitted.current !== attempt) return;
    if (!controller.hasUnresolvedCommand() && controller.snapshot().result !== 'native-created') {
      submitted.current = null;
      setSubmission(null);
    }
  }
  return (
    <form
      ref={formElement}
      className="studio-native-create studio-stack"
      onSubmit={(event) => void submit(event)}
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`}>{m.studio_account_create({}, options)}</h2>
      <p className="studio-help">{m.studio_account_intro({}, options)}</p>
      <p className="studio-help">{m.studio_workspace_private_help({}, options)}</p>
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
        id={`${id}-title`}
        value={form.title}
        required
        maxLength={512}
        disabled={editingBlocked}
        onChange={(event) => update({ title: event.target.value })}
      />
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
      <p className="studio-help" role="status">
        {form.snapshot === 'invalid'
          ? m.studio_workspace_snapshot_error({}, options)
          : form.snapshot === 'pending'
            ? m.studio_workspace_snapshot_pending({}, options)
            : atRisk
              ? m.studio_workspace_unsaved({}, options)
              : m.studio_workspace_private_draft({}, options)}
      </p>
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
      <p id={`${id}-subject-help`} className="studio-help">{m.studio_account_subject_help({}, options)}</p>
      <label htmlFor={`${id}-media`}>{m.own_drafts_media({}, options)}</label>
      <Input
        id={`${id}-media`}
        value={form.media}
        disabled={editingBlocked}
        aria-describedby={`${id}-media-help`}
        onChange={(event) => update({ media: event.target.value })}
      />
      <p id={`${id}-media-help`} className="studio-help">{m.studio_account_media_help({}, options)}</p>
      <Button type="submit" disabled={!ready}>{m.studio_account_create({}, options)}</Button>
    </form>
  );
}
