import * as SharedSelect from '@rezics/ui/shadcn/select';
import type { DocumentSnapshot } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale, localizeUrl } from '../../paraglide/runtime.js';
import { DocumentBody } from '../../document-body';
import { draftFetch, InlinePostEditor, PostComposer } from '../../threads/composer';
import { revisePost, startThread } from '../../threads/actions';
import type { RealmAppearanceCallerLifetime } from '../realm-appearance-caller-lifetime';
import type {
  RealmAppearanceAdapter,
  RealmAppearanceSelection,
  RealmAppearanceSnapshot,
  RealmAppearanceState,
} from '../realm-presentation';
import type { RulesAuthoringRead, RulesAuthoringResponse } from './contract';

const nativeRuleLicence = 'LicenseRef-rezics-terms' as const;

type Control = Readonly<{
  getSnapshot: () => RealmAppearanceState;
  choose: (slot: 'rules', selection: RealmAppearanceSelection) => void;
  save: () => Promise<void>;
  refresh: () => Promise<void>;
  reviewConflict: (options?: { resetDraft?: boolean }) => void;
}>;
type PublishedRulesRevision = Readonly<{
  postId: string;
  revisionId: string;
  title: string | null;
  authorId: string;
  boardId: string;
  boardTitle: string | null;
  body: DocumentSnapshot;
  language: string | null;
  licence: string;
  sha256: string;
}>;
type Mode = 'closed' | 'create' | 'edit' | 'review';

function exactHref(postId: string, revisionId: string) {
  return localizeUrl(new URL(`/posts/${postId}/revisions/${revisionId}`, 'https://rezics.local')).pathname;
}

function primaryLanguage(body: DocumentSnapshot): string | null {
  for (const node of body.doc.content ?? []) {
    const value = node.attrs?.lang;
    if (typeof value === 'string') return value;
  }
  return null;
}

function rulesReadLabel(read: RulesAuthoringRead): string {
  if (read.kind === 'denied') return m.community_management_denied();
  if (read.kind === 'unavailable') return m.realm_appearance_unavailable();
  switch (read.value.current.state) {
    case 'none':
      return m.realm_appearance_no_rules();
    case 'erased':
      return m.realm_rules_authoring_current_erased();
    case 'concealed':
      return m.realm_rules_authoring_current_concealed();
    case 'unavailable':
      return m.realm_appearance_rules_unavailable();
    case 'available':
      return '';
  }
}

function sameReference(
  left: { postId: string; revisionId: string } | null | undefined,
  right: { postId: string; revisionId: string } | null | undefined,
) {
  return left?.postId === right?.postId && left?.revisionId === right?.revisionId;
}

function ReferenceIds({ reference }: { reference: { postId: string; revisionId: string } | null }) {
  if (!reference) return <p>{m.realm_appearance_no_rules()}</p>;
  return (
    <dl className="grid min-w-0 gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
      <dt>{m.realm_rules_authoring_revision()}</dt>
      <dd className="break-all">{reference.postId} / {reference.revisionId}</dd>
    </dl>
  );
}

function CurrentRules({
  read,
  reference,
  appearanceRead,
}: {
  read: RulesAuthoringRead | null;
  reference: { postId: string; revisionId: string } | null;
  appearanceRead: RealmAppearanceState['read'];
}) {
  if (appearanceRead.kind === 'hidden') return <p role="alert">{m.community_management_denied()}</p>;
  if (appearanceRead.kind === 'unavailable') return <p role="status">{m.realm_appearance_unavailable()}</p>;
  if (!read || read.kind !== 'ready') return <p role="status">{rulesReadLabel(read ?? { kind: 'unavailable' })}</p>;

  const current = read.value.current;
  const currentReference = current.state === 'none' ? null : current.reference;
  if (!sameReference(currentReference, reference))
    return <p role="status">{m.realm_appearance_unavailable()}</p>;
  if (current.state !== 'available') return <p role="status">{rulesReadLabel(read)}</p>;

  return (
    <div className="min-w-0 space-y-3 rounded-xl bg-muted p-4" data-current-rules>
      <h4 className="font-medium">{current.title ?? m.realm_rules_authoring_title_unknown()}</h4>
      <ReferenceIds reference={current.reference} />
      <dl className="grid min-w-0 gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt>{m.realm_rules_authoring_board()}</dt>
        <dd className="break-words">{current.boardTitle ?? current.boardId}</dd>
        <dt>{m.realm_rules_authoring_author()}</dt>
        <dd className="break-all">{current.authorId}</dd>
        <dt>{m.thread_history_licence()}</dt>
        <dd className="break-words">{current.licence}</dd>
        <dt>{m.realm_rules_authoring_language()}</dt>
        <dd>{current.language ?? m.realm_rules_authoring_language_unknown()}</dd>
      </dl>
      <div
        lang={current.language ?? undefined}
        className="max-h-96 min-w-0 overflow-auto break-words rounded-lg border bg-background p-3"
      >
        <DocumentBody
          document={current.body}
          locale={getLocale()}
          renderImage={() => <span>{m.realm_rules_authoring_image_unavailable()}</span>}
        />
      </div>
      <a
        className="text-sm text-primary underline"
        href={exactHref(current.reference.postId, current.reference.revisionId)}
      >
        {m.realm_appearance_open_revision()}
      </a>
    </div>
  );
}

export function RealmRulesAuthoringPanel({
  realmId,
  snapshot,
  state,
  adapter,
  control,
  lifetime,
  onModeChange,
}: {
  realmId: string;
  snapshot: RealmAppearanceSnapshot;
  state: RealmAppearanceState;
  adapter: RealmAppearanceAdapter;
  control: Control;
  lifetime?: RealmAppearanceCallerLifetime;
  onModeChange: (active: boolean) => void;
}) {
  const ids = useId();
  const [prepared, setPrepared] = useState<RulesAuthoringRead | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<Mode>('closed');
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());
  const [boardId, setBoardId] = useState('');
  const [licence, setLicence] = useState('');
  const [attribution, setAttribution] = useState(false);
  const [published, setPublished] = useState<PublishedRulesRevision | null>(null);
  const [candidateReadingOpen, setCandidateReadingOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachOutcome, setAttachOutcome] = useState<
    'none' | 'saved' | 'conflict' | 'uncertain' | 'denied' | 'unavailable'
  >('none');
  const [confirmExit, setConfirmExit] = useState(false);
  const [editKey, setEditKey] = useState('');
  const activeRead = useRef<AbortController | null>(null);
  const readGeneration = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const focusGeneration = useRef(0);
  const reviewFocusGeneration = useRef<number | null>(null);
  const current = prepared?.kind === 'ready' ? prepared.value.current : null;
  const destinationPage = prepared?.kind === 'ready' ? prepared.value.destinations : null;
  const destinations = destinationPage?.state === 'available' ? destinationPage.items : [];
  const chosenDestination = destinations.find((item) => item.boardId === boardId);
  const canCreate = chosenDestination?.create.state === 'allowed';
  const canAttach = prepared?.kind === 'ready' && prepared.value.actions.attach.state === 'allowed';
  const editAdvice = prepared?.kind === 'ready' ? prepared.value.actions.edit.state : 'unavailable';
  const attachedReference = state.read.kind === 'ready' ? state.read.snapshot.presentation.rules : null;
  const candidateAttached = Boolean(
    published &&
      (attachOutcome === 'saved' ||
        (attachedReference &&
          attachedReference.postId === published.postId &&
          attachedReference.revisionId === published.revisionId)),
  );
  const pendingCandidate = Boolean(
    published &&
      (!candidateAttached || attachOutcome === 'conflict' || attachOutcome === 'uncertain' || attachOutcome === 'unavailable'),
  );
  const createPermitted = Boolean(
    prepared?.kind === 'ready' &&
      prepared.value.actions.create.state === 'allowed' &&
      destinationPage?.state === 'available' &&
      destinations.some((item) => item.create.state === 'allowed'),
  );
  const head = snapshot.head;
  const previousHead = useRef(head);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++readGeneration.current;
    activeRead.current?.abort();
    activeRead.current = controller;
    setPrepared(null);
    const read = adapter.prepareRules
      ? adapter.prepareRules(realmId, cursor, controller.signal)
      : Promise.resolve({ kind: 'unavailable' as const });
    void read.then((next) => {
      if (
        controller.signal.aborted ||
        generation !== readGeneration.current ||
        (lifetime && (!lifetime.current() || lifetime.realmId !== realmId))
      )
        return;
      setPrepared(next);
      if (next.kind === 'ready' && next.value.destinations.state === 'available') {
        setBoardId((selected) =>
          next.value.destinations.state === 'available' &&
          next.value.destinations.items.some((item) => item.boardId === selected)
            ? selected
            : '',
        );
      }
    });
    return () => {
      controller.abort();
      if (generation === readGeneration.current) readGeneration.current++;
    };
  }, [adapter, cursor, head, lifetime, realmId, reload]);

  useLayoutEffect(() => {
    if (mode !== 'review') return;
    if (reviewFocusGeneration.current === focusGeneration.current) reviewHeading.current?.focus();
    reviewFocusGeneration.current = null;
  }, [mode, published]);
  useEffect(() => {
    const recordFocus = () => {
      focusGeneration.current++;
    };
    document.addEventListener('focusin', recordFocus, true);
    return () => document.removeEventListener('focusin', recordFocus, true);
  }, []);
  useEffect(() => onModeChange(mode !== 'closed'), [mode, onModeChange]);
  useEffect(() => {
    if (previousHead.current === head) return;
    previousHead.current = head;
    if (mode === 'create' || mode === 'edit') {
      setMode('closed');
      setConfirmExit(false);
      setBoardId('');
      setLicence('');
      setAttribution(false);
      setCreateKey(crypto.randomUUID());
      setEditKey('');
    }
  }, [head, mode]);

  function beginCreate() {
    if (!lifetime?.current() && lifetime) return;
    reviewFocusGeneration.current = null;
    setPublished(null);
    setCandidateReadingOpen(false);
    setAttachOutcome('none');
    setBoardId('');
    setLicence('');
    setAttribution(false);
    setCreateKey(crypto.randomUUID());
    setMode('create');
  }

  function beginEdit() {
    if (current?.state !== 'available' || editAdvice !== 'allowed' || (lifetime && !lifetime.current())) return;
    reviewFocusGeneration.current = null;
    setPublished(null);
    setCandidateReadingOpen(false);
    setAttachOutcome('none');
    setEditKey(crypto.randomUUID());
    setMode('edit');
  }

  async function attachExactRevision() {
    if (!published || !canAttach || attaching || (lifetime && !lifetime.current())) {
      if (!canAttach && (!lifetime || lifetime.current())) setAttachOutcome('denied');
      return;
    }
    const phase = control.getSnapshot().phase;
    if (phase === 'conflict' || phase === 'uncertain' || phase === 'saving') return;
    setAttaching(true);
    setAttachOutcome('none');
    try {
      const selected = await adapter.select({
        kind: 'rules',
        realmId,
        postId: published.postId,
        revisionId: published.revisionId,
      });
      if (
        (lifetime && !lifetime.current()) ||
        selected.kind !== 'rules' ||
        selected.rules.postId !== published.postId ||
        selected.rules.revisionId !== published.revisionId
      ) {
        setAttachOutcome('denied');
        return;
      }
      control.choose('rules', selected);
      await control.save();
      if (lifetime && !lifetime.current()) return;
      const after = control.getSnapshot();
      if (after.phase === 'saved') setAttachOutcome('saved');
      else if (after.phase === 'conflict') setAttachOutcome('conflict');
      else if (after.phase === 'uncertain' || after.attempt) setAttachOutcome('uncertain');
      else setAttachOutcome(after.notice === 'denied' ? 'denied' : 'uncertain');
      if (after.phase === 'saved' || after.phase === 'conflict') setReload((value) => value + 1);
    } catch {
      if (!lifetime || lifetime.current()) setAttachOutcome('unavailable');
    } finally {
      if (!lifetime || lifetime.current()) setAttaching(false);
    }
  }

  async function retryOriginalAttach() {
    if (lifetime && !lifetime.current()) return;
    setAttaching(true);
    try {
      await control.save();
      if (lifetime && !lifetime.current()) return;
      const after = control.getSnapshot();
      setAttachOutcome(after.phase === 'saved' ? 'saved' : after.phase === 'conflict' ? 'conflict' : 'uncertain');
      if (after.phase === 'saved' || after.phase === 'conflict') setReload((value) => value + 1);
    } catch {
      if (!lifetime || lifetime.current()) setAttachOutcome('uncertain');
    } finally {
      if (!lifetime || lifetime.current()) setAttaching(false);
    }
  }

  async function reviewCurrentSettings() {
    await control.refresh();
    if (lifetime && !lifetime.current()) return;
    control.reviewConflict({ resetDraft: true });
    setAttachOutcome('none');
    setReload((value) => value + 1);
  }

  function leaveEditor() {
    if (mode === 'create' || mode === 'edit') setConfirmExit(true);
    else setMode('closed');
  }

  function openReview() {
    reviewFocusGeneration.current = focusGeneration.current;
    setMode('review');
  }

  if (!snapshot.canManage || (lifetime && !lifetime.current())) return null;
  const noPostAdvice =
    prepared?.kind === 'ready' &&
    prepared.value.destinations.state === 'available' &&
    prepared.value.destinations.items.length > 0 &&
    prepared.value.destinations.items.every((item) => item.create.state === 'denied');
  const preparedReference =
    prepared?.kind === 'ready'
      ? prepared.value.current.state === 'none'
        ? null
        : prepared.value.current.reference
      : undefined;
  const currentReadMatchesAttachment =
    prepared?.kind === 'ready' && sameReference(preparedReference, attachedReference);
  const attachedStatus = (() => {
    if (state.read.kind === 'hidden') return m.community_management_denied();
    if (state.read.kind === 'unavailable') return m.realm_appearance_unavailable();
    if (!attachedReference) return m.realm_appearance_no_rules();
    if (prepared?.kind === 'ready') {
      if (!currentReadMatchesAttachment) return m.realm_appearance_unavailable();
      const readLabel = rulesReadLabel(prepared);
      if (readLabel) return readLabel;
      return prepared.value.current.state === 'available'
        ? prepared.value.current.title ?? m.realm_rules_authoring_title_unknown()
        : m.realm_appearance_rules_unavailable();
    }
    return state.read.snapshot.rules.state === 'available'
      ? state.read.snapshot.rules.value.title
      : m.realm_appearance_rules_unavailable();
  })();
  const candidateReference = published ? { postId: published.postId, revisionId: published.revisionId } : null;

  return (
    <section className="space-y-3 rounded-xl border p-4" aria-labelledby={ids + '-heading'} data-rules-authoring>
      <h3 id={ids + '-heading'} className="font-medium">
        {m.realm_rules_authoring_open()}
      </h3>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4" data-primary-work>
          <section className="min-w-0 space-y-2 rounded-xl bg-muted p-4" aria-labelledby={ids + '-current-title'}>
            <h4 id={ids + '-current-title'} className="font-medium">
              {m.realm_appearance_current()}
            </h4>
            <p role={state.read.kind === 'hidden' ? 'alert' : 'status'} className="break-words">
              {attachedStatus}
            </p>
            {state.read.kind === 'ready' ? <ReferenceIds reference={attachedReference} /> : null}
          </section>

          {prepared === null ? <p role="status">{m.realm_appearance_unavailable()}</p> : null}
          {prepared?.kind === 'denied' ? <p role="alert">{m.community_management_denied()}</p> : null}
          {prepared?.kind === 'unavailable' ? <p role="status">{m.realm_appearance_unavailable()}</p> : null}
          {prepared?.kind === 'ready' ? (
            <>
              {prepared.value.actions.create.state === 'denied' ? (
                <p role="status">{m.thread_write_forbidden()}</p>
              ) : null}
              {prepared.value.actions.create.state === 'unavailable' ? (
                <p role="status">{m.realm_appearance_unavailable()}</p>
              ) : null}
              {prepared.value.actions.create.state === 'stale' ? (
                <p role="status">{m.realm_rules_authoring_stale()}</p>
              ) : null}
              {noPostAdvice ? <p role="status">{m.thread_write_forbidden()}</p> : null}
              {destinationPage?.state === 'available' && destinations.length === 0 ? (
                <p role="status">{m.realm_rules_authoring_no_destinations()}</p>
              ) : null}
              {destinationPage?.state === 'denied' ? <p role="alert">{m.thread_write_forbidden()}</p> : null}
              {destinationPage?.state === 'unavailable' ? <p role="status">{m.realm_boards_unavailable()}</p> : null}
              {destinationPage?.state === 'available' && destinationPage.next ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={mode !== 'closed'}
                  onClick={() => setCursor(destinationPage.next ?? undefined)}
                >
                  {m.realm_boards_more()}
                </Button>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={mode !== 'closed' || !createPermitted || pendingCandidate}
                  onClick={beginCreate}
                >
                  {m.board_start_thread()}
                </Button>
                {prepared.value.current.state === 'available' ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={mode !== 'closed' || editAdvice !== 'allowed' || pendingCandidate}
                    onClick={beginEdit}
                  >
                    {m.thread_content_edit()}
                  </Button>
                ) : null}
              </div>
              {editAdvice === 'stale' ? <p role="status">{m.realm_rules_authoring_stale()}</p> : null}
              {prepared.value.current.state === 'available' && editAdvice === 'denied' ? (
                <p role="status">{m.thread_edit_forbidden()}</p>
              ) : null}
              {prepared.value.current.state === 'available' && editAdvice === 'unavailable' ? (
                <p role="status">{m.realm_appearance_unavailable()}</p>
              ) : null}
            </>
          ) : null}

          {mode === 'create' ? (
            <section className="min-w-0 space-y-4 rounded-xl border p-4" aria-labelledby={ids + '-create-title'}>
              <h4 id={ids + '-create-title'} className="font-medium">
                {m.board_start_thread()}
              </h4>
              <Field className="space-y-2">
                <FieldLabel htmlFor={ids + '-board'}>
                  {m.realm_rules_authoring_destination()}
                </FieldLabel>
                <SharedSelect.Select
                  value={boardId || null}
                  required
                  disabled={!destinations.length || destinationPage?.state !== 'available'}
                  items={[
                    { value: null, label: m.realm_rules_authoring_choose_destination() },
                    ...destinations.map((item) => ({
                      value: item.boardId,
                      label:
                        (item.title ?? item.boardId) +
                        (item.create.state === 'allowed' ? '' : ' (' + m.thread_write_forbidden() + ')'),
                    })),
                  ]}
                  onValueChange={(value) => setBoardId(value ?? '')}
                >
                  <SharedSelect.SelectTrigger
                    id={ids + '-board'}
                    aria-describedby={ids + '-destination-help'}
                    className="w-full min-w-0 break-all"
                  >
                    <SharedSelect.SelectValue />
                  </SharedSelect.SelectTrigger>
                  <SharedSelect.SelectContent>
                    <SharedSelect.SelectGroup>
                      <SharedSelect.SelectItem value={null}>
                        {m.realm_rules_authoring_choose_destination()}
                      </SharedSelect.SelectItem>
                      {destinations.map((item) => (
                        <SharedSelect.SelectItem key={item.boardId} value={item.boardId}>
                          <span className="break-all">{item.title ?? item.boardId}</span>
                          {item.create.state === 'allowed' ? '' : ' (' + m.thread_write_forbidden() + ')'}
                        </SharedSelect.SelectItem>
                      ))}
                    </SharedSelect.SelectGroup>
                  </SharedSelect.SelectContent>
                </SharedSelect.Select>
                <p id={ids + '-destination-help'} role={chosenDestination && !canCreate ? 'status' : undefined}>
                  {chosenDestination && !canCreate ? m.thread_write_forbidden() : null}
                </p>
              </Field>
              <fieldset className="min-w-0 space-y-3 rounded-lg border p-3" aria-describedby={ids + '-rules-help'}>
                <legend className="px-1 font-medium">{m.thread_history_licence()}</legend>
                <Field className="space-y-2">
                  <FieldLabel htmlFor={ids + '-licence'}>{m.thread_history_licence()}</FieldLabel>
                  <SharedSelect.Select
                    value={licence || null}
                    required
                    items={[
                      { value: null, label: m.realm_appearance_choose() },
                      { value: nativeRuleLicence, label: nativeRuleLicence },
                    ]}
                    onValueChange={(value) => setLicence(value ?? '')}
                  >
                    <SharedSelect.SelectTrigger
                      id={ids + '-licence'}
                      aria-describedby={ids + '-rules-help'}
                      className="w-full min-w-0 break-words"
                    >
                      <SharedSelect.SelectValue />
                    </SharedSelect.SelectTrigger>
                    <SharedSelect.SelectContent>
                      <SharedSelect.SelectGroup>
                        <SharedSelect.SelectItem value={null}>{m.realm_appearance_choose()}</SharedSelect.SelectItem>
                        <SharedSelect.SelectItem value={nativeRuleLicence}>{nativeRuleLicence}</SharedSelect.SelectItem>
                      </SharedSelect.SelectGroup>
                    </SharedSelect.SelectContent>
                  </SharedSelect.Select>
                </Field>
                <Field className="flex flex-row items-start gap-3">
                  <Checkbox
                    id={ids + '-attribution'}
                    className="mt-1 shrink-0"
                    aria-required="true"
                    aria-describedby={ids + '-rules-help'}
                    checked={attribution}
                    onCheckedChange={(checked) => setAttribution(checked === true)}
                  />
                  <FieldLabel
                    htmlFor={ids + '-attribution'}
                    className="flex flex-1 items-start text-sm leading-6"
                  >
                    {m.realm_rules_authoring_attribution()}
                  </FieldLabel>
                </Field>
                <p id={ids + '-rules-help'} role="status">
                  {m.realm_appearance_rules_help()}
                </p>
              </fieldset>
              <PostComposer<PublishedRulesRevision, { boardId: string; licence: typeof nativeRuleLicence }>
                key={JSON.stringify([realmId, createKey, snapshot.head])}
                initialKey={createKey}
                titleRequired
                localDraft={false}
                canSubmit={Boolean(
                  canCreate && boardId && licence === nativeRuleLicence && attribution && lifetime?.current(),
                )}
                boardId={boardId}
                submissionContext={{ boardId, licence: nativeRuleLicence }}
                onSubmit={async ({ title, body, idempotencyKey, mediaIds, submissionContext }) => {
                  reviewFocusGeneration.current = focusGeneration.current;
                  if (!lifetime?.current() || !lifetime.csrfToken || !submissionContext || !canCreate)
                    return { ok: false as const, reason: 'unavailable' as const };
                  const result = await startThread({
                    data: {
                      kind: 'rules',
                      boardId: submissionContext.boardId,
                      title,
                      body,
                      licence: submissionContext.licence,
                      idempotencyKey,
                      ...(mediaIds.length ? { mediaIds } : {}),
                    },
                    headers: { 'X-CSRF-Token': lifetime.csrfToken },
                    fetch: draftFetch(body),
                  });
                  if (!lifetime.current()) return { ok: false as const, reason: 'unavailable' as const };
                  if (!result.ok) return result;
                  const post = result.thread.firstPost;
                  if (post.availability !== 'available' || !('revisionId' in post) || !post.body)
                    return { ok: false as const, reason: 'unavailable' as const };
                  if (result.thread.title === null) return { ok: false as const, reason: 'unavailable' as const };
                  const exact: PublishedRulesRevision = {
                    postId: post.id,
                    revisionId: post.revisionId,
                    title: result.thread.title,
                    authorId: result.thread.authorId,
                    boardId: result.thread.boardId,
                    boardTitle: chosenDestination?.title ?? null,
                    body: post.body,
                    language: primaryLanguage(post.body),
                    licence: result.thread.licence,
                    sha256: post.sha256,
                  };
                  return { ok: true as const, value: exact };
                }}
                onSuccess={(revision) => {
                  if (!lifetime?.current()) return;
                  setPublished(revision);
                  setCandidateReadingOpen(true);
                  setMode('review');
                }}
              />
            </section>
          ) : null}

          {mode === 'edit' && current?.state === 'available' ? (
            <section className="min-w-0 space-y-3 rounded-xl border p-4" aria-labelledby={ids + '-edit-title'}>
              <h4 id={ids + '-edit-title'} className="font-medium">
                {m.thread_content_edit()}
              </h4>
              <InlinePostEditor
                key={JSON.stringify([realmId, current.reference.postId, current.reference.revisionId, editKey])}
                initialBody={current.body}
                initialMediaIds={current.mediaIds}
                revisionId={current.reference.revisionId}
                idempotencyKey={editKey}
                containerId={current.threadId}
                onSubmit={async (input) => {
                  reviewFocusGeneration.current = focusGeneration.current;
                  if (!lifetime?.current() || !lifetime.csrfToken)
                    return { ok: false as const, reason: 'unavailable' as const };
                  const result = await revisePost({
                    data: {
                      postId: current.reference.postId,
                      revisionId: input.revisionId,
                      body: input.body,
                      idempotencyKey: input.idempotencyKey,
                      licence: current.licence,
                      ...(input.mediaIds.length ? { mediaIds: input.mediaIds } : {}),
                    },
                    headers: { 'X-CSRF-Token': lifetime.csrfToken },
                    fetch: draftFetch(input.body),
                  });
                  if (!lifetime.current()) return { ok: false as const, reason: 'unavailable' as const };
                  return result;
                }}
                onCancel={leaveEditor}
                onRevisionReplacement={() => {
                  setMode('closed');
                  setEditKey('');
                  setReload((value) => value + 1);
                }}
                onSuccess={(post) => {
                  if (!lifetime?.current() || post.availability !== 'available' || !('revisionId' in post) || !post.body)
                    return;
                  setPublished({
                    postId: post.id,
                    revisionId: post.revisionId,
                    title: current.title,
                    authorId: current.authorId,
                    boardId: current.boardId,
                    boardTitle: current.boardTitle,
                    body: post.body,
                    language: primaryLanguage(post.body),
                    licence: post.licence,
                    sha256: post.sha256,
                  });
                  setCandidateReadingOpen(true);
                  setMode('review');
                }}
              />
            </section>
          ) : null}

          {confirmExit ? (
            <div
              role="alertdialog"
              aria-labelledby={ids + '-exit-title'}
              aria-describedby={ids + '-exit-copy'}
              className="space-y-3 rounded-xl border p-4"
            >
              <h4 id={ids + '-exit-title'} className="font-medium">
                {m.thread_authoring_discard_title()}
              </h4>
              <p id={ids + '-exit-copy'}>{m.realm_rules_authoring_exit()}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    setConfirmExit(false);
                    setMode('closed');
                  }}
                >
                  {m.thread_authoring_discard()}
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirmExit(false)}>
                  {m.thread_authoring_stay()}
                </Button>
              </div>
            </div>
          ) : null}

          {mode === 'review' && published ? (
            <section className="min-w-0 space-y-3 rounded-xl border p-4" aria-labelledby={ids + '-review-title'}>
              <h4
                ref={reviewHeading}
                id={ids + '-review-title'}
                tabIndex={-1}
                className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.realm_rules_authoring_review()}
              </h4>
              <div className="min-w-0 space-y-2 rounded-lg bg-muted p-3">
                <p role="status">
                  {candidateAttached ? m.realm_appearance_saved() : m.realm_rules_authoring_published()}
                </p>
                <h5 className="break-words text-lg font-semibold">
                  {published.title ?? m.realm_rules_authoring_title_unknown()}
                </h5>
                <ReferenceIds reference={candidateReference} />
              </div>
              {attachOutcome === 'conflict' ? (
                <div role="alert" className="space-y-3">
                  <p>{m.realm_rules_authoring_attach_conflict()}</p>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <div className="min-w-0 rounded-lg border p-3">
                      <h5 className="font-medium">{m.realm_appearance_current()}</h5>
                      {state.read.kind === 'ready' ? (
                        <ReferenceIds reference={attachedReference} />
                      ) : (
                        <p>
                          {state.read.kind === 'hidden'
                            ? m.community_management_denied()
                            : m.realm_appearance_unavailable()}
                        </p>
                      )}
                    </div>
                    <div className="min-w-0 rounded-lg border p-3">
                      <h5 className="font-medium">{m.realm_rules_authoring_published()}</h5>
                      <ReferenceIds reference={candidateReference} />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={attaching || state.busy}
                      onClick={() => void reviewCurrentSettings()}
                    >
                      {m.realm_appearance_refresh()}
                    </Button>
                    {state.reviewed && canAttach ? (
                      <Button
                        type="button"
                        disabled={attaching || control.getSnapshot().phase === 'conflict'}
                        onClick={() => void attachExactRevision()}
                      >
                        {m.realm_rules_authoring_attach()}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {attachOutcome === 'uncertain' ? (
                <div role="alert" className="space-y-2">
                  <p>{m.realm_appearance_uncertain()}</p>
                  <Button type="button" disabled={attaching} onClick={() => void retryOriginalAttach()}>
                    {m.realm_appearance_retry()}
                  </Button>
                </div>
              ) : null}
              {attachOutcome === 'denied' ? (
                <p role="alert">{m.community_management_denied()}</p>
              ) : null}
              {attachOutcome === 'unavailable' ? (
                <p role="status">{m.realm_appearance_unavailable()}</p>
              ) : null}
              {prepared?.kind === 'ready' && prepared.value.actions.attach.state === 'denied' ? (
                <p role="status">{m.community_management_denied()}</p>
              ) : null}
              {prepared?.kind === 'ready' && prepared.value.actions.attach.state === 'unavailable' ? (
                <p role="status">{m.realm_appearance_unavailable()}</p>
              ) : null}
              {attachOutcome === 'none' && !candidateAttached ? (
                <Button
                  type="button"
                  disabled={
                    attaching ||
                    !canAttach ||
                    Boolean(lifetime && !lifetime.current()) ||
                    control.getSnapshot().phase === 'conflict'
                  }
                  onClick={() => void attachExactRevision()}
                >
                  {attaching ? m.realm_appearance_saving() : m.realm_rules_authoring_attach()}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={() => setMode('closed')}>
                {m.editor_cancel()}
              </Button>
            </section>
          ) : null}

          {mode === 'closed' && published ? (
            <section className="min-w-0 space-y-3 rounded-xl border p-4" aria-labelledby={ids + '-candidate-title'}>
              <h4 id={ids + '-candidate-title'} className="font-medium">
                {m.realm_rules_authoring_review()}
              </h4>
              <div className="min-w-0 space-y-2 rounded-lg bg-muted p-3">
                <p role="status">
                  {candidateAttached ? m.realm_appearance_saved() : m.realm_rules_authoring_published()}
                </p>
                <h5 className="break-words text-lg font-semibold">
                  {published.title ?? m.realm_rules_authoring_title_unknown()}
                </h5>
                <ReferenceIds reference={candidateReference} />
              </div>
              {attachOutcome === 'conflict' ? (
                <div role="alert" className="space-y-3">
                  <p>{m.realm_rules_authoring_attach_conflict()}</p>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <div className="min-w-0 rounded-lg border p-3">
                      <h5 className="font-medium">{m.realm_appearance_current()}</h5>
                      {state.read.kind === 'ready' ? (
                        <ReferenceIds reference={attachedReference} />
                      ) : (
                        <p>
                          {state.read.kind === 'hidden'
                            ? m.community_management_denied()
                            : m.realm_appearance_unavailable()}
                        </p>
                      )}
                    </div>
                    <div className="min-w-0 rounded-lg border p-3">
                      <h5 className="font-medium">{m.realm_rules_authoring_published()}</h5>
                      <ReferenceIds reference={candidateReference} />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={attaching || state.busy}
                      onClick={() => void reviewCurrentSettings()}
                    >
                      {m.realm_appearance_refresh()}
                    </Button>
                    {state.reviewed && canAttach ? (
                      <Button
                        type="button"
                        disabled={attaching || control.getSnapshot().phase === 'conflict'}
                        onClick={() => void attachExactRevision()}
                      >
                        {m.realm_rules_authoring_attach()}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {attachOutcome === 'uncertain' ? (
                <div role="alert" className="space-y-2">
                  <p>{m.realm_appearance_uncertain()}</p>
                  <Button type="button" disabled={attaching} onClick={() => void retryOriginalAttach()}>
                    {m.realm_appearance_retry()}
                  </Button>
                </div>
              ) : null}
              {attachOutcome === 'denied' ? (
                <p role="alert">{m.community_management_denied()}</p>
              ) : null}
              {attachOutcome === 'unavailable' ? (
                <p role="status">{m.realm_appearance_unavailable()}</p>
              ) : null}
              <Button type="button" variant="outline" onClick={openReview}>
                {m.realm_rules_authoring_review()}
              </Button>
            </section>
          ) : null}

          {mode === 'create' && !confirmExit ? (
            <Button type="button" variant="outline" onClick={leaveEditor}>
              {m.thread_edit_cancel()}
            </Button>
          ) : null}
          {prepared?.kind === 'ready' && current?.state === 'available' && mode === 'closed' ? (
            <div className="sr-only" aria-live="polite">
              {current.currentRevision ? '' : m.thread_edit_stale()}
            </div>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-3" data-supporting-reading>
          <details className="min-w-0 rounded-xl border p-4">
            <summary className="cursor-pointer font-medium">{m.realm_appearance_current()}</summary>
            <CurrentRules read={prepared} reference={attachedReference} appearanceRead={state.read} />
          </details>
          {published ? (
            <details
              className="min-w-0 rounded-xl border p-4"
              open={candidateReadingOpen}
              onToggle={(event) => setCandidateReadingOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer font-medium">{m.realm_rules_authoring_review()}</summary>
              <div className="min-w-0 space-y-3 pt-2">
                <h4 className="break-words font-medium">
                  {published.title ?? m.realm_rules_authoring_title_unknown()}
                </h4>
                <dl className="grid min-w-0 gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
                  <dt>{m.realm_rules_authoring_board()}</dt>
                  <dd className="break-words">{published.boardTitle ?? published.boardId}</dd>
                  <dt>{m.realm_rules_authoring_author()}</dt>
                  <dd className="break-all">{published.authorId}</dd>
                  <dt>{m.realm_rules_authoring_revision()}</dt>
                  <dd className="break-all">{published.postId} / {published.revisionId}</dd>
                  <dt>{m.thread_history_licence()}</dt>
                  <dd className="break-words">{published.licence}</dd>
                  <dt>{m.realm_rules_authoring_language()}</dt>
                  <dd className="break-words">{published.language ?? m.realm_rules_authoring_language_unknown()}</dd>
                </dl>
                <div
                  lang={published.language ?? undefined}
                    className="max-h-96 min-w-0 overflow-auto break-words rounded-lg border bg-background p-3"
                >
                  <DocumentBody
                    document={published.body}
                    locale={getLocale()}
                    renderImage={() => <span>{m.realm_rules_authoring_image_unavailable()}</span>}
                  />
                </div>
                <a
                  className="break-all text-sm text-primary underline"
                  href={exactHref(published.postId, published.revisionId)}
                >
                  {m.realm_appearance_open_revision()}
                </a>
              </div>
            </details>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
