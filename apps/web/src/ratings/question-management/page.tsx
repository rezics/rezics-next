import { useCallback, useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { useSession } from '../../session/query';
import {
  executeQuestionManagementIntent,
  readQuestionManagementForViewer,
  readQuestionManagementHistory,
} from './actions';
import { OwnVotesDeparture } from '../own-votes/departure';
import {
  captureQuestionManagementIntent,
  questionManagementIntentMatchesPage,
  validQuestionManagementBody,
} from './intent';
import type {
  ManagementQuestion,
  QuestionCaptionInput,
  QuestionDefinitionInput,
  QuestionLifecycleInput,
  QuestionManagementAction,
  QuestionManagementActionState,
  QuestionManagementAddress,
  QuestionManagementCommandResult,
  QuestionManagementHistoryRead,
  QuestionManagementIntent,
  QuestionManagementPageData,
  QuestionManagementRead,
  QuestionManagementVisit,
} from './types';

type PageAddress = Omit<QuestionManagementAddress, 'realmId'>;

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function grainLabel(grain: 'work' | 'release' | 'episode' | 'character') {
  switch (grain) {
    case 'work':
      return m.home_question_work();
    case 'release':
      return m.home_question_release();
    case 'episode':
      return m.home_question_episode();
    case 'character':
      return m.home_question_character();
  }
}

export function QuestionManagementInspection({
  question,
  onHeading,
}: {
  question: ManagementQuestion;
  onHeading?: (node: HTMLHeadingElement | null) => void;
}) {
  return (
    <section className="space-y-4 rounded-2xl border p-4 sm:p-6" aria-labelledby="realm-question-selected-heading">
      <h2 ref={onHeading} tabIndex={-1} id="realm-question-selected-heading" className="text-xl font-semibold">
        {m.home_presentation_question_information()}
      </h2>
      <h3 className="break-words text-lg font-medium">{question.label}</h3>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1 sm:col-span-2">
          <dt className="text-sm font-medium text-muted-foreground">{m.realm_question_management_meaning()}</dt>
          <dd className="break-words whitespace-pre-wrap">{question.meaning}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">{m.home_question_label()}</dt>
          <dd className="break-words whitespace-pre-wrap">{question.canonicalLabel}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">
            {m.realm_question_management_definition_revision({ revision: String(question.revision) })}
          </dt>
          <dd>{grainLabel(question.grain)}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">
            {m.realm_question_management_caption_revision({ revision: String(question.labelRevision) })}
          </dt>
          <dd className="break-words whitespace-pre-wrap">{question.label}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">
            {m.realm_question_management_lifecycle_revision({ revision: String(question.lifecycle.revision) })}
          </dt>
          <dd>
            {question.lifecycle.state === 'active'
              ? m.realm_question_management_active()
              : m.realm_question_management_retired()}
          </dd>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <dt className="text-sm font-medium text-muted-foreground">{m.realm_question_management_units()}</dt>
          <dd>
            {question.scale.min}–{question.scale.max};{' '}
            {m.realm_question_management_display_step({ step: String(question.scale.displayStep) })}
          </dd>
          <p className="text-sm text-muted-foreground">{m.realm_question_management_zero()}</p>
        </div>
      </dl>
    </section>
  );
}

export function QuestionManagementContent({
  page,
  address,
  onSelect,
  onNext,
  onSelectedHeading,
  onDirtyChange,
  onCreate,
  onCaption,
  onLifecycle,
  onRetryOriginal,
  commandStates = {},
  history,
  onMoreHistory,
  onRetryHistory,
  onRestartHistory,
  requireFreshInspection = false,
}: {
  page: QuestionManagementPageData;
  address: PageAddress;
  onSelect: (questionId: string) => void;
  onNext: (cursor: string) => void;
  onSelectedHeading?: (node: HTMLHeadingElement | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onCreate?: (body: QuestionDefinitionInput) => void;
  onCaption?: (body: QuestionCaptionInput) => void;
  onLifecycle?: (action: 'retire' | 'restore', body: QuestionLifecycleInput) => void;
  onRetryOriginal?: (action: QuestionManagementAction) => void;
  commandStates?: Partial<Record<QuestionManagementAction, QuestionManagementActionState>>;
  history?: QuestionManagementHistoryRead;
  onMoreHistory?: (cursor: string) => void;
  onRetryHistory?: () => void;
  onRestartHistory?: () => void;
  requireFreshInspection?: boolean;
}) {
  const createButton = useRef<HTMLButtonElement>(null);
  const createHeading = useRef<HTMLHeadingElement>(null);
  const captionButton = useRef<HTMLButtonElement>(null);
  const captionHeading = useRef<HTMLHeadingElement>(null);
  const lifecycleButton = useRef<HTMLButtonElement>(null);
  const focusCreateTriggerOnReturn = useRef(false);
  const focusCaptionTriggerOnReturn = useRef(false);
  const focusLifecycleTriggerOnReturn = useRef(false);
  const selectedId = page.selected?.question.id ?? null;
  const [createOpen, setCreateOpen] = useState(false);
  const [createReview, setCreateReview] = useState(false);
  const [definition, setDefinition] = useState<QuestionDefinitionInput>({
    meaning: '',
    label: '',
    grain: 'release',
    scale: { min: 0, max: 20, displayStep: 1 },
  });
  const [captionOpen, setCaptionOpen] = useState(false);
  const [captionReview, setCaptionReview] = useState(false);
  const [caption, setCaption] = useState(page.selected?.question.label ?? '');
  const [lifecycleConfirm, setLifecycleConfirm] = useState<'retire' | 'restore' | null>(null);
  const createState = commandStates.create ?? 'idle';
  const captionState = commandStates.caption ?? 'idle';
  const lifecycleAction = page.selected?.question.lifecycle.state === 'active' ? 'retire' : 'restore';
  const lifecycleState = commandStates[lifecycleAction] ?? 'idle';
  const actionBusy = Object.values(commandStates).some((state) => state === 'sending');
  const createValid = validQuestionManagementBody('create', definition);
  const captionValid =
    page.selected !== null &&
    validQuestionManagementBody('caption', {
      expectedLabelRevision: page.selected.question.labelRevision,
      label: caption,
    });
  const createDirty = createOpen && (definition.meaning.length > 0 || definition.label.length > 0);
  const captionDirty = captionOpen && caption !== (page.selected?.question.label ?? '');
  const dirty = createDirty || captionDirty || lifecycleConfirm !== null;

  useEffect(() => {
    if (createOpen) createHeading.current?.focus();
    else if (focusCreateTriggerOnReturn.current) {
      focusCreateTriggerOnReturn.current = false;
      createButton.current?.focus();
    }
  }, [createOpen, createReview]);
  useEffect(() => {
    if (captionOpen) captionHeading.current?.focus();
    else if (focusCaptionTriggerOnReturn.current) {
      focusCaptionTriggerOnReturn.current = false;
      captionButton.current?.focus();
    }
  }, [captionOpen, captionReview]);
  useEffect(() => {
    if (lifecycleConfirm === null && focusLifecycleTriggerOnReturn.current) {
      focusLifecycleTriggerOnReturn.current = false;
      lifecycleButton.current?.focus();
    }
  }, [lifecycleConfirm]);
  useEffect(() => {
    if (page.selected) {
      setCaption(page.selected.question.label);
      setCaptionOpen(false);
      setCaptionReview(false);
    }
    setCaptionOpen(false);
    setCaptionReview(false);
    setLifecycleConfirm(null);
  }, [selectedId, page.selected?.question.labelRevision, page.selected?.question.lifecycle.revision]);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const create = () => {
    onCreate?.(definition);
  };
  const saveCaption = () => {
    if (page.selected) onCaption?.({ expectedLabelRevision: page.selected.question.labelRevision, label: caption });
  };
  const confirmLifecycle = (action: 'retire' | 'restore') => {
    if (page.selected) onLifecycle?.(action, { expectedLifecycleRevision: page.selected.question.lifecycle.revision });
  };
  const notice = (action: QuestionManagementAction, state: QuestionManagementActionState) => {
    if (state === 'uncertain')
      return (
        <div className="space-y-2" role="status">
          <p>{m.realm_question_action_uncertain()}</p>
          <button
            type="button"
            className="rounded-md border px-3 py-2"
            disabled={actionBusy || requireFreshInspection}
            onClick={() => onRetryOriginal?.(action)}
          >
            {m.realm_question_retry_original()}
          </button>
        </div>
      );
    if (state === 'stale') return <p role="status">{m.realm_question_action_conflict()}</p>;
    if (state === 'denied') return <p role="status">{m.home_questions_denied()}</p>;
    if (state === 'invalid') return <p role="status">{m.home_questions_invalid()}</p>;
    if (state === 'unavailable') return <p role="status">{m.home_questions_unavailable()}</p>;
    if (state === 'sending') return <p role="status">{m.home_questions_loading()}</p>;
    return null;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 text-foreground sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{m.realm_question_management_link()}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{m.home_question_help()}</p>
      </header>

      <section className="space-y-4" aria-labelledby="realm-question-directory-heading">
        <h2 id="realm-question-directory-heading" className="text-xl font-semibold">
          {m.home_question_all()}
        </h2>
        {page.directory.ratingQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.home_questions_empty()}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {page.directory.ratingQuestions.map((question) => (
              <li key={question.id}>
                <button
                  type="button"
                  aria-current={address.selectedQuestionId === question.id ? 'page' : undefined}
                  className="w-full rounded-xl border p-4 text-start hover:bg-muted focus-visible:outline focus-visible:outline-2"
                  onClick={() => onSelect(question.id)}
                >
                  <span className="block font-medium">{question.label}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {m.home_question_metadata({
                      label: question.label,
                      revision: String(question.revision),
                      grain: grainLabel(question.grain),
                      min: String(question.scale.min),
                      max: String(question.scale.max),
                      step: String(question.scale.displayStep),
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {page.directory.next ? (
          <button type="button" className="rounded-md border px-4 py-2" onClick={() => onNext(page.directory.next!)}>
            {m.home_questions_next()}
          </button>
        ) : null}
      </section>

      {page.actions.create && onCreate ? (
        <section className="space-y-4 border-t pt-6" aria-labelledby="realm-question-create-heading">
          {!createOpen ? (
            <button
              ref={createButton}
              type="button"
              className="rounded-md border px-4 py-2"
              disabled={actionBusy || requireFreshInspection || createState === 'uncertain'}
              onClick={() => setCreateOpen(true)}
            >
              {m.realm_question_create()}
            </button>
          ) : (
            <div className="space-y-4 rounded-2xl border p-4 sm:p-6">
              <h2
                ref={createHeading}
                tabIndex={-1}
                id="realm-question-create-heading"
                className="text-xl font-semibold"
              >
                {createReview ? m.realm_question_review_definition() : m.realm_question_create()}
              </h2>
              <p className="max-w-prose text-sm text-muted-foreground">{m.realm_question_immutable_notice()}</p>
              {createReview ? (
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">
                      {m.realm_question_management_meaning()}
                    </dt>
                    <dd className="whitespace-pre-wrap">{definition.meaning}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">{m.home_question_label()}</dt>
                    <dd>{definition.label}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">{m.realm_question_grain()}</dt>
                    <dd>{grainLabel(definition.grain)}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">{m.realm_question_management_units()}</dt>
                    <dd>
                      {definition.scale.min}–{definition.scale.max};{' '}
                      {m.realm_question_management_display_step({ step: String(definition.scale.displayStep) })}
                    </dd>
                  </div>
                </dl>
              ) : (
                <form
                  className="grid gap-4 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (createValid) setCreateReview(true);
                  }}
                >
                  <label className="space-y-1 sm:col-span-2">
                    <span className="block text-sm font-medium">{m.realm_question_management_meaning()}</span>
                    <textarea
                      required
                      maxLength={4000}
                      rows={4}
                      className="w-full rounded-md border bg-background p-3"
                      value={definition.meaning}
                      disabled={createState === 'uncertain' || requireFreshInspection}
                      onChange={(event) =>
                        setDefinition((current) => ({ ...current, meaning: event.currentTarget.value }))
                      }
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-sm font-medium">{m.home_question_label()}</span>
                    <input
                      required
                      maxLength={400}
                      className="w-full rounded-md border bg-background px-3 py-2"
                      value={definition.label}
                      disabled={createState === 'uncertain' || requireFreshInspection}
                      onChange={(event) =>
                        setDefinition((current) => ({ ...current, label: event.currentTarget.value }))
                      }
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-sm font-medium">{m.home_question_all()}</span>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2"
                      value={definition.grain}
                      disabled={createState === 'uncertain' || requireFreshInspection}
                      onChange={(event) =>
                        setDefinition((current) => ({
                          ...current,
                          grain: event.currentTarget.value as QuestionDefinitionInput['grain'],
                        }))
                      }
                    >
                      {(['work', 'release', 'episode', 'character'] as const).map((grain) => (
                        <option key={grain} value={grain}>
                          {grainLabel(grain)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
                    <legend className="mb-2 text-sm font-medium">{m.realm_question_management_units()}</legend>
                    {(
                      [
                        ['min', m.guide_minimum()],
                        ['max', m.guide_maximum()],
                        [
                          'displayStep',
                          m.realm_question_management_display_step({ step: String(definition.scale.displayStep) }),
                        ],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="space-y-1">
                        <span className="block text-sm">{label}</span>
                        <input
                          type="number"
                          min={key === 'min' ? 0 : 1}
                          max={20}
                          step={1}
                          required
                          className="w-full rounded-md border bg-background px-3 py-2"
                          value={definition.scale[key]}
                          disabled={createState === 'uncertain' || requireFreshInspection}
                          onChange={(event) =>
                            setDefinition((current) => ({
                              ...current,
                              scale: { ...current.scale, [key]: Number(event.currentTarget.value) },
                            }))
                          }
                        />
                      </label>
                    ))}
                  </fieldset>
                  <div className="flex flex-wrap gap-3 sm:col-span-2">
                    <button
                      type="submit"
                      className="rounded-md border px-4 py-2"
                      disabled={actionBusy || requireFreshInspection || !createValid}
                    >
                      {m.realm_question_review_definition()}
                    </button>
                    <button
                      type="button"
                      className="rounded-md px-4 py-2"
                      disabled={createState === 'uncertain'}
                      onClick={() => {
                        setCreateOpen(false);
                        setCreateReview(false);
                        focusCreateTriggerOnReturn.current = true;
                      }}
                    >
                      {m.container_lifecycle_cancel()}
                    </button>
                  </div>
                </form>
              )}
              {notice('create', createState)}
              {createReview ? (
                <div className="flex flex-wrap gap-3">
                  {createState === 'uncertain' ? null : (
                    <button
                      type="button"
                      className="rounded-md border px-4 py-2"
                      disabled={actionBusy || requireFreshInspection}
                      onClick={create}
                    >
                      {m.realm_question_confirm_create()}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-md px-4 py-2"
                    disabled={actionBusy || createState === 'uncertain'}
                    onClick={() => {
                      setCreateReview(false);
                    }}
                  >
                    {m.container_lifecycle_cancel()}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {page.selected ? (
        <>
          <QuestionManagementInspection
            question={page.selected.question}
            {...(onSelectedHeading ? { onHeading: onSelectedHeading } : {})}
          />
          <section className="space-y-4 rounded-2xl border p-4 sm:p-6" aria-labelledby="realm-question-history-heading">
            <h2 id="realm-question-history-heading" className="text-xl font-semibold">
              {m.realm_question_caption_history()}
            </h2>
            {history?.state === 'loading' ? <p role="status">{m.home_questions_loading()}</p> : null}
            {history?.state === 'ready' ? (
              <>
                <ol className="space-y-3">
                  {history.page.labels.map((item) => (
                    <li key={item.labelRevision} className="rounded-xl border p-3">
                      <p className="break-words font-medium">{item.label}</p>
                      <p className="text-sm text-muted-foreground">
                        {m.realm_question_management_caption_revision({ revision: String(item.labelRevision) })}
                        {' · '}
                        {item.at ?? m.realm_question_time_unrecorded()}
                        {' · '}
                        {item.author
                          ? `${item.author.state === 'deleted' ? m.realm_question_author_deleted() : m.realm_question_author()} (${item.author.id})`
                          : m.realm_question_author_unavailable()}
                      </p>
                    </li>
                  ))}
                </ol>
                {history.page.next ? (
                  <button
                    type="button"
                    className="rounded-md border px-4 py-2"
                    disabled={actionBusy}
                    onClick={() => onMoreHistory?.(history.page.next!)}
                  >
                    {m.realm_question_history_more()}
                  </button>
                ) : null}
              </>
            ) : null}
            {history?.state === 'stale-cursor' ? (
              <div className="space-y-2" role="status">
                <p>{m.realm_question_history_stale()}</p>
                <button type="button" className="rounded-md border px-4 py-2" onClick={onRestartHistory}>
                  {m.realm_question_history_restart()}
                </button>
              </div>
            ) : null}
            {history?.state === 'unavailable' ? (
              <div className="space-y-2" role="status">
                <p>{m.realm_question_history_unavailable()}</p>
                <button type="button" className="rounded-md border px-4 py-2" onClick={onRetryHistory}>
                  {m.home_questions_retry()}
                </button>
              </div>
            ) : null}
          </section>

          {page.selected.actions.caption && onCaption ? (
            <section
              className="space-y-4 rounded-2xl border p-4 sm:p-6"
              aria-labelledby="realm-question-caption-heading"
            >
              {!captionOpen ? (
                <button
                  ref={captionButton}
                  type="button"
                  className="rounded-md border px-4 py-2"
                  disabled={actionBusy || requireFreshInspection || captionState === 'uncertain'}
                  onClick={() => setCaptionOpen(true)}
                >
                  {m.realm_question_caption_edit()}
                </button>
              ) : (
                <div className="space-y-4">
                  <h2
                    ref={captionHeading}
                    tabIndex={-1}
                    id="realm-question-caption-heading"
                    className="text-xl font-semibold"
                  >
                    {captionReview ? m.realm_question_review_definition() : m.realm_question_caption_edit()}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {m.realm_question_management_caption_revision({
                      revision: String(page.selected.question.labelRevision),
                    })}
                  </p>
                  {captionReview ? (
                    <p className="break-words font-medium">{caption}</p>
                  ) : (
                    <label className="block max-w-xl space-y-1">
                      <span className="block text-sm font-medium">{m.home_question_label()}</span>
                      <input
                        required
                        maxLength={400}
                        className="w-full rounded-md border bg-background px-3 py-2"
                        value={caption}
                        disabled={captionState === 'uncertain' || requireFreshInspection}
                        onChange={(event) => setCaption(event.currentTarget.value)}
                      />
                    </label>
                  )}
                  {notice('caption', captionState)}
                  <div className="flex flex-wrap gap-3">
                    {captionReview ? (
                      captionState === 'uncertain' ? null : (
                        <button
                          type="button"
                          className="rounded-md border px-4 py-2"
                          disabled={actionBusy || requireFreshInspection}
                          onClick={saveCaption}
                        >
                          {m.realm_question_caption_save()}
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="rounded-md border px-4 py-2"
                        disabled={actionBusy || requireFreshInspection || !captionValid}
                        onClick={() => setCaptionReview(true)}
                      >
                        {m.realm_question_review_definition()}
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded-md px-4 py-2"
                      disabled={actionBusy || captionState === 'uncertain'}
                      onClick={() => {
                        setCaptionOpen(false);
                        setCaptionReview(false);
                        setCaption(page.selected!.question.label);
                        focusCaptionTriggerOnReturn.current = true;
                      }}
                    >
                      {m.container_lifecycle_cancel()}
                    </button>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {page.selected.actions.lifecycle && onLifecycle ? (
            <section
              className="space-y-4 rounded-2xl border p-4 sm:p-6"
              aria-labelledby="realm-question-lifecycle-heading"
            >
              <h2 id="realm-question-lifecycle-heading" className="text-xl font-semibold">
                {page.selected.question.lifecycle.state === 'active'
                  ? m.realm_question_retire()
                  : m.realm_question_restore()}
              </h2>
              <p>
                {page.selected.question.lifecycle.state === 'active'
                  ? m.realm_question_confirm_retire_text()
                  : m.realm_question_confirm_restore_text()}
              </p>
              {notice(lifecycleAction, lifecycleState)}
              {lifecycleConfirm === null ? (
                <button
                  ref={lifecycleButton}
                  type="button"
                  className="rounded-md border px-4 py-2"
                  disabled={actionBusy || requireFreshInspection || lifecycleState === 'uncertain'}
                  onClick={() => setLifecycleConfirm(lifecycleAction)}
                >
                  {lifecycleAction === 'retire' ? m.realm_question_retire() : m.realm_question_restore()}
                </button>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {lifecycleState === 'uncertain' ? null : (
                    <button
                      type="button"
                      className="rounded-md border px-4 py-2"
                      disabled={actionBusy || requireFreshInspection}
                      onClick={() => confirmLifecycle(lifecycleConfirm)}
                    >
                      {m.container_lifecycle_confirm()}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-md px-4 py-2"
                    disabled={actionBusy || lifecycleState === 'uncertain'}
                    onClick={() => {
                      focusLifecycleTriggerOnReturn.current = true;
                      setLifecycleConfirm(null);
                    }}
                  >
                    {m.container_lifecycle_cancel()}
                  </button>
                </div>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function QuestionManagementPage({
  initial,
  address,
  locale,
  navigate,
}: {
  initial: QuestionManagementVisit;
  address: PageAddress | null;
  locale: string;
  navigate: (search: { selectedQuestionId?: string; cursor?: string }) => void;
}) {
  const session = useSession();
  const [read, setRead] = useState<QuestionManagementRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sessionCurrent, setSessionCurrent] = useState<boolean | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [history, setHistory] = useState<QuestionManagementHistoryRead | undefined>();
  const [intents, setIntents] = useState<Partial<Record<QuestionManagementAction, QuestionManagementIntent>>>({});
  const [commandStates, setCommandStates] = useState<
    Partial<Record<QuestionManagementAction, QuestionManagementActionState>>
  >({});
  const [dirty, setDirty] = useState(false);
  const [requiresFreshInspection, setRequiresFreshInspection] = useState(false);
  const generation = useRef(0);
  const selectedHeading = useRef<HTMLHeadingElement>(null);
  const commandControllers = useRef(new Map<QuestionManagementAction, AbortController>());
  const visitGeneration = useRef(0);
  const visitKey = JSON.stringify([initial, address, locale, session.state, session.subject, session.csrfToken]);
  const visitKeyRef = useRef(visitKey);
  visitKeyRef.current = visitKey;
  const intentRef = useRef(intents);
  const stateRef = useRef(commandStates);
  intentRef.current = intents;
  stateRef.current = commandStates;

  useEffect(() => {
    visitGeneration.current++;
    for (const controller of commandControllers.current.values()) controller.abort();
    commandControllers.current.clear();
    setIntents({});
    setCommandStates({});
    setHistory(undefined);
    setHistoryCursor(null);
    setRequiresFreshInspection(false);
    return () => {
      visitGeneration.current++;
      for (const controller of commandControllers.current.values()) controller.abort();
      commandControllers.current.clear();
    };
  }, [visitKey]);

  useEffect(() => {
    let alive = true;
    setSessionCurrent(null);
    if (session.state !== 'signed-in' || !session.subject || !session.csrfToken || !initial.csrfEpisode) {
      setSessionCurrent(false);
      return () => {
        alive = false;
      };
    }
    void digest(session.csrfToken).then((episode) => {
      if (alive)
        setSessionCurrent(
          session.subject === initial.viewer &&
            episode === initial.csrfEpisode &&
            initial.locale === locale &&
            initial.state === 'preparing',
        );
    });
    return () => {
      alive = false;
    };
  }, [initial, locale, session.csrfToken, session.state, session.subject]);

  useEffect(() => {
    const readGeneration = ++generation.current;
    const controller = new AbortController();
    if (!address || initial.state !== 'preparing' || sessionCurrent !== true) {
      setRead(null);
      setBusy(false);
      return () => {
        controller.abort();
      };
    }
    setBusy(true);
    setRead((previous) =>
      previous?.state === 'ready' &&
      previous.realmId === initial.realmId &&
      previous.selectedQuestionId === address.selectedQuestionId &&
      previous.cursor === address.cursor &&
      previous.viewer === initial.viewer &&
      previous.credentialEpisode === initial.credentialEpisode &&
      previous.csrfEpisode === initial.csrfEpisode
        ? previous
        : null,
    );
    void readQuestionManagementForViewer({
      data: {
        address: { realmId: initial.realmId, ...address },
        visit: initial,
      },
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted || generation.current !== readGeneration) return;
        if (result.state === 'ready' && result.page.viewer.accountId !== result.viewer) {
          setRead({ ...result, state: 'retired' });
          return;
        }
        setRead(result);
        if (result.state === 'ready' && requiresFreshInspection) setRequiresFreshInspection(false);
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === readGeneration)
          setRead({
            realmId: initial.realmId,
            selectedQuestionId: initial.selectedQuestionId,
            cursor: initial.cursor,
            locale,
            viewer: initial.viewer,
            state: 'unavailable',
          });
      })
      .finally(() => {
        if (!controller.signal.aborted && generation.current === readGeneration) setBusy(false);
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [address, initial, locale, retry, sessionCurrent]);

  useEffect(() => {
    if (read?.state === 'ready' && address?.selectedQuestionId) selectedHeading.current?.focus();
  }, [address?.selectedQuestionId, read]);

  const select = (questionId: string) => {
    navigate({ selectedQuestionId: questionId });
  };
  const restart = () => {
    navigate(address?.selectedQuestionId ? { selectedQuestionId: address.selectedQuestionId } : {});
  };
  const next = (cursor: string) => {
    navigate({
      ...(address?.selectedQuestionId ? { selectedQuestionId: address.selectedQuestionId } : {}),
      cursor,
    });
  };

  const setActionState = (action: QuestionManagementAction, state: QuestionManagementActionState) =>
    setCommandStates((current) => ({ ...current, [action]: state }));
  const removeIntent = (action: QuestionManagementAction) =>
    setIntents((current) => {
      const next = { ...current };
      delete next[action];
      return next;
    });

  const runCommand = async (
    action: QuestionManagementAction,
    body: QuestionDefinitionInput | QuestionCaptionInput | QuestionLifecycleInput,
    retryOriginal = false,
  ) => {
    if (sessionCurrent !== true || requiresFreshInspection || !address) return;
    const currentRead = read;
    if (!currentRead || currentRead.state !== 'ready') return;
    if (stateRef.current[action] === 'sending') return;
    let intent = retryOriginal ? intentRef.current[action] : undefined;
    if (retryOriginal && (!intent || stateRef.current[action] !== 'uncertain')) return;
    if (!intent) {
      if (intentRef.current[action]) return;
      try {
        intent = await captureQuestionManagementIntent({
          action,
          read: currentRead,
          visit: initial,
          locale,
          csrfToken: session.csrfToken!,
          body,
        });
      } catch {
        setActionState(action, 'stale');
        setRequiresFreshInspection(true);
        setRetry((value) => value + 1);
        return;
      }
    }
    if (!questionManagementIntentMatchesPage(intent, currentRead.page)) {
      setActionState(action, 'stale');
      setRequiresFreshInspection(true);
      setRetry((value) => value + 1);
      return;
    }

    if (visitKeyRef.current !== visitKey) return;
    const episode = visitGeneration.current;
    const commandVisitKey = visitKey;
    const controller = new AbortController();
    commandControllers.current.get(action)?.abort();
    commandControllers.current.set(action, controller);
    if (!retryOriginal) setIntents((current) => ({ ...current, [action]: intent! }));
    setActionState(action, 'sending');
    let result: QuestionManagementCommandResult;
    try {
      result = await executeQuestionManagementIntent({
        data: { visit: initial, intent },
        signal: controller.signal,
        headers: { 'x-csrf-token': intent.csrfToken },
      });
    } catch {
      result = { kind: 'uncertain' };
    }
    if (
      controller.signal.aborted ||
      visitGeneration.current !== episode ||
      visitKeyRef.current !== commandVisitKey ||
      commandControllers.current.get(action) !== controller
    )
      return;
    commandControllers.current.delete(action);

    if (result.kind === 'acknowledged') {
      removeIntent(action);
      setActionState(action, 'idle');
      setHistoryCursor(null);
      if (action === 'create' && result.questionId) {
        navigate({ selectedQuestionId: result.questionId });
      } else {
        setRetry((value) => value + 1);
      }
      return;
    }
    if (result.kind === 'uncertain') {
      setActionState(action, 'uncertain');
      return;
    }
    removeIntent(action);
    setActionState(action, result.kind);
    if (result.kind === 'stale') {
      setRequiresFreshInspection(true);
      setHistoryCursor(null);
      setRetry((value) => value + 1);
    }
  };

  const onCreate = (body: QuestionDefinitionInput) => void runCommand('create', body);
  const onCaption = (body: QuestionCaptionInput) => void runCommand('caption', body);
  const onLifecycle = (action: 'retire' | 'restore', body: QuestionLifecycleInput) => void runCommand(action, body);
  const retryOriginal = (action: QuestionManagementAction) => {
    const intent = intentRef.current[action];
    if (intent) void runCommand(action, intent.body, true);
  };

  const selectedHistoryId = address?.selectedQuestionId ?? null;
  useEffect(() => {
    const historyGeneration = generation.current;
    const controller = new AbortController();
    if (
      !selectedHistoryId ||
      sessionCurrent !== true ||
      !read ||
      read.state !== 'ready' ||
      read.selectedQuestionId !== selectedHistoryId
    ) {
      setHistory(undefined);
      return () => controller.abort();
    }
    const cursor = historyCursor;
    setHistory({ state: 'loading', questionId: selectedHistoryId, cursor });
    void readQuestionManagementHistory({
      data: { visit: initial, questionId: selectedHistoryId, cursor },
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted && generation.current === historyGeneration) setHistory(result);
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === historyGeneration)
          setHistory({ state: 'unavailable', questionId: selectedHistoryId, cursor });
      });
    return () => controller.abort();
  }, [historyCursor, historyRetry, initial, read, selectedHistoryId, sessionCurrent]);

  const reportDirty = useCallback((value: boolean) => setDirty(value), []);

  if (!address || initial.state === 'invalid-address') return <p role="alert">{m.home_questions_invalid()}</p>;
  if (session.state === 'signed-out' || read?.state === 'signed-out' || initial.state === 'signed-out')
    return <p role="status">{m.own_classifications_signed_out()}</p>;
  const keepDuringRequiredInspection = requiresFreshInspection && read?.state === 'ready';
  if (
    session.state === 'unknown' ||
    sessionCurrent === null ||
    (busy && !keepDuringRequiredInspection) ||
    (initial.state === 'preparing' && !read)
  )
    return <p role="status">{m.home_questions_loading()}</p>;
  if (sessionCurrent === false || read?.state === 'retired')
    return <p role="status">{m.own_classifications_stale()}</p>;
  if (initial.state === 'unavailable' || !read || read.state !== 'ready') {
    const staleCursor = read?.state === 'stale-cursor';
    const denied = read?.state === 'denied';
    return (
      <section className="space-y-3" aria-live="polite">
        <p role="status">
          {staleCursor
            ? m.home_questions_restart()
            : denied
              ? m.home_questions_denied()
              : m.home_questions_unavailable()}
        </p>
        <div className="flex flex-wrap gap-3">
          {staleCursor ? (
            <button type="button" className="rounded-md border px-4 py-2" onClick={restart}>
              {m.home_questions_restart_action()}
            </button>
          ) : (
            <button
              type="button"
              className="rounded-md border px-4 py-2"
              onClick={() => setRetry((value) => value + 1)}
            >
              {m.home_questions_retry()}
            </button>
          )}
        </div>
      </section>
    );
  }

  const { page } = read;
  return (
    <>
      {requiresFreshInspection ? (
        <p role="status" className="mx-auto max-w-5xl px-4 text-sm text-muted-foreground sm:px-6">
          {m.realm_question_action_conflict()}
        </p>
      ) : null}
      <QuestionManagementContent
        page={page}
        address={address}
        onSelect={select}
        onNext={next}
        onSelectedHeading={(node) => {
          selectedHeading.current = node;
        }}
        onDirtyChange={reportDirty}
        onCreate={onCreate}
        onCaption={onCaption}
        onLifecycle={onLifecycle}
        onRetryOriginal={retryOriginal}
        commandStates={commandStates}
        {...(history === undefined ? {} : { history })}
        onMoreHistory={(cursor) => setHistoryCursor(cursor)}
        onRetryHistory={() => setHistoryRetry((value) => value + 1)}
        onRestartHistory={() => {
          setHistoryCursor(null);
          setHistoryRetry((value) => value + 1);
        }}
        requireFreshInspection={requiresFreshInspection}
      />
      <OwnVotesDeparture
        dirty={dirty}
        locked={
          Object.values(commandStates).some((state) => state === 'sending' || state === 'uncertain') ||
          requiresFreshInspection
        }
        isCurrent={() => sessionCurrent === true && initial.state === 'preparing'}
      />
    </>
  );
}
