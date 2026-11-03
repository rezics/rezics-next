import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { catalogueEditor, useEditorLifetime, useCurrentReadingVisible } from './editor-lifetime';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { controlId, type StatementFeedback } from './statement-validation-presentation';
import { gameGroups, gameTarget, type GameRead } from './game-profile';
import { InitialFieldChoice } from './initial-field-choice';
import { StatementFields, EditorFailure, type StatementFieldsRead } from './statement-editor-view';
import { statementInput, type SnakInput, type StatementInput } from './statement-editor';
import {
  advanceChangedSetReview,
  changedSetFingerprint,
  factHolder,
  factLocked,
  factWritable,
  includedChanges,
  sealFacts,
  sendFacts,
  type ChangedSetReview,
  type FactDraft,
  type FactResult,
  type FactsCurrent,
  type FactsTransport,
} from './subject-facts';
import { AuthoringDepartureBoundary } from '../../threads/authoring-departure';
import { GameFactsDeparture } from './game-classification-departure';
import { GameClassificationAssertion } from './game-classification-view';
import {
  applyGameReuse,
  bindGameClassificationReview,
  GameClassificationReuse,
  GameClassificationReviewControls,
  openGameReuse,
  refreshGameReuse,
  type GameCopiedGroup,
  type GameOrphanDiagnostic,
  type GameReuseSession,
} from './game-classification-review';
import { factStatementFeedback, StatementViolationFeedback } from './fact-violation-feedback';

const gameActionClass =
  'min-h-8 min-w-8 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(max-width:639px)_and_(pointer:coarse)]:h-auto [@media(max-width:639px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:639px)_and_(pointer:coarse)]:min-w-11';
const gamePropertySelectClass =
  'w-fit min-w-0 max-w-full [&>select]:max-w-full [@media(max-width:639px)_and_(pointer:coarse)]:w-full [@media(max-width:639px)_and_(pointer:coarse)]:[&>select]:min-h-11';
// Raise native controls individually above the shared surface, without a panel-wide hit target.
const gameFieldFrameClass =
  'min-w-0 max-w-full space-y-4 p-4 [overflow-wrap:anywhere] [&_a]:relative [&_a]:z-10 [&_button]:relative [&_button]:z-10 [&_label]:relative [&_label]:z-10 [&_input]:relative [&_input]:z-10 [&_select]:relative [&_select]:z-10 [&_textarea]:relative [&_textarea]:z-10 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-2 [&_input:focus-visible]:outline-ring [&_select:focus-visible]:outline-2 [&_select:focus-visible]:outline-offset-2 [&_select:focus-visible]:outline-ring';

type Ready = Extract<GameRead, { ok: true }>;
export function gameGroupLabel(group: string, locale: string) {
  const o = { locale: locale as never };
  return group === 'credits'
    ? m.game_profile_credits({}, o)
    : group === 'classification'
      ? m.game_profile_classification({}, o)
      : group === 'relations'
        ? m.game_profile_relations({}, o)
        : m.game_profile_facts({}, o);
}
function GameItemControl({
  part,
  context,
  locale,
  search,
  change,
  editAllowed,
}: {
  part: SnakInput;
  context: StatementFieldsRead;
  locale: string;
  search: EntityPickerSearch;
  change: (value: SnakInput['value']) => void;
  editAllowed?: (() => boolean) | undefined;
}) {
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const property = part.property.id;
  const definition = context.release.properties[property]!;
  const label = pickText(definition.labels, locale);
  const value = part.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : '';
  const related = value ? context.public.related[value] : undefined;
  const relatedName = related ? pickText(related.labels, locale) : undefined;
  const target = value ? picked.find((item) => item.id === value) : undefined;
  return (
    <div className="min-w-0 space-y-2">
    <EntityPicker
      label={label.text}
      src={coverSrc}
      value={
        value
          ? [
              {
                id: value,
                title:
                  relatedName?.text ||
                  target?.title ||
                  m.subject_value_unlabelled({}, { locale: locale as never }),
                types: target?.types ?? [],
                typeLabel: target?.typeLabel ?? '',
                cover: target?.cover ?? null,
              },
            ]
          : []
      }
      search={async (text, signal) =>
        (await search(text, signal)).filter((item) =>
          item.types.some((type) => gameTarget(context.release, property, type)),
        )
      }
      onValueChange={(items) => {
        if (editAllowed && !editAllowed()) return;
        setPicked(items);
        change({ type: 'value', content: items[0]?.id ?? '' });
      }}
    />
      {value && (
        <p className="text-sm text-muted-foreground">
          {m.game_classification_target({ id: value }, { locale: locale as never })}
          {!related && (
            <>
              {' '}
              {m.candidate_value_unavailable({}, { locale: locale as never })}
            </>
          )}
        </p>
      )}
    </div>
  );
}
export function GameStatementFields({
  statement,
  context,
  locale,
  search,
  change: onChange,
  editAllowed,
  id,
  feedback,
  valueControl,
  reuse,
  focusReference,
}: {
  id?: string;
  feedback?: StatementFeedback | undefined;
  /** A profile-specific picker can own the main value while this editor keeps qualifiers and evidence. */
  valueControl?: ReactNode | undefined;
  statement: StatementInput;
  context: StatementFieldsRead;
  locale: string;
  search: EntityPickerSearch;
  change: (next: StatementInput) => void;
  editAllowed?: (() => boolean) | undefined;
  reuse?: { disabled?: boolean; onReuse: (index: number, keyboard: boolean) => void } | undefined;
  focusReference?: { index: number; nonce: number } | undefined;
}) {
  const change = (next: StatementInput) => {
    if (!editAllowed || editAllowed()) onChange(next);
  };
  const feedbackId = feedback?.id ?? id;
  const control = (part: SnakInput, update: (value: SnakInput['value']) => void) => {
    if (context.release.properties[part.property.id]?.datatype !== 'wikibase-item') return;
    const qualifier = statement.qualifiers?.indexOf(part) ?? -1;
    const reference = statement.references.findIndex((item) => item.parts.includes(part));
    const address =
      part === statement
        ? 'fact'
        : qualifier >= 0
          ? `qualifier-${qualifier}`
          : `reference-${reference}-part-${statement.references[reference]?.parts.indexOf(part)}`;
    return (
      <div id={feedbackId ? controlId(feedbackId, address, 'value') : undefined}>
        <GameItemControl
          part={part}
          context={context}
          locale={locale}
          search={search}
          change={update}
          editAllowed={editAllowed}
        />
      </div>
    );
  };
  return (
    <StatementFields
      draft={statement}
      feedback={feedback ?? (id ? { id, errors: [] } : undefined)}
      current={context}
      locale={locale}
      change={change}
      valueControl={valueControl ?? control(statement, (value) => change({ ...statement, value }))}
      partControl={control}
      stablePartAddresses
      reuse={reuse}
      focusReference={focusReference}
    />
  );
}
/** Confirm only whole unsent facts; keep their editors mounted so item summaries survive Cancel. */
export function GameInitialFactRemove({
  row,
  disabled,
  locale,
  onRemove,
}: {
  row: { key: string; statement: StatementInput };
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const o = { locale: locale as never };
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [confirmingKey, setConfirmingKey] = useState<string>();
  const confirming = confirmingKey === row.key;
  const current = useRef({ disabled, key: row.key, onRemove });
  current.current = { disabled, key: row.key, onRemove };
  const editable = () =>
    !current.current.disabled && current.current.key === row.key && !holder.current?.closest('fieldset:disabled');
  useLayoutEffect(() => {
    if (!editable()) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  const cancelRemoval = () => {
    restoreFocus.current = true;
    setConfirmingKey(undefined);
  };
  const remove = () => {
    const section = holder.current?.closest('section');
    if (!editable() || !section?.isConnected) return;
    const controls = [
      ...((section.closest('form') ?? section.closest('fieldset'))?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex="0"], [contenteditable="true"]',
      ) ?? []),
    ];
    const first = controls.findIndex((control) => section.contains(control));
    const last = controls.findLastIndex((control) => section.contains(control));
    [...controls.slice(last + 1), ...controls.slice(0, first).reverse()]
      .find(
        (control) =>
          !control.matches(':disabled, [aria-disabled="true"], [type="hidden"]') &&
          !control.closest('[hidden], [inert]'),
      )
      ?.focus();
    current.current.onRemove();
  };
  const hasContent = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value == null) return false;
    if (typeof value === 'object') return Object.values(value).some(hasContent);
    return true;
  };
  const populatedPart = (part: SnakInput) => part.value.type !== 'value' || hasContent(part.value.content);
  const populated =
    populatedPart(row.statement) ||
    row.statement.qualifiers?.some(populatedPart) ||
    row.statement.references.some((reference) => reference.parts.some(populatedPart));
  return (
    <div ref={holder}>
      {confirming ? (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action: m.recipe_remove_field({}, o) }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRemoval();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action: m.recipe_remove_field({}, o) }, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={cancel}
              className={gameActionClass}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={cancelRemoval}
            >
              {m.candidate_cancel({}, o)}
            </Button>
            <Button
              className={gameActionClass}
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={remove}
            >
              {m.recipe_remove_field({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={gameActionClass}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (editable()) populated ? setConfirmingKey(row.key) : remove();
          }}
        >
          {m.recipe_remove_field({}, o)}
        </Button>
      )}
    </div>
  );
}

export function GameInitialFacts({
  type,
  release,
  locale,
  search,
  statements,
  disabled,
  change,
  editAllowed,
  omitProperties = [],
}: {
  type: string;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  statements: { key: string; statement: StatementInput }[];
  disabled: boolean;
  change: (rows: { key: string; statement: StatementInput }[]) => void;
  editAllowed?: (() => boolean) | undefined;
  omitProperties?: readonly string[] | undefined;
}) {
  const o = { locale: locale as never };
  const groups = gameGroups(release, type);
  const context: StatementFieldsRead = { release, source: null, public: { subject: { type }, related: {} } };
  const holder = useRef<HTMLFieldSetElement>(null);
  const observation = useMemo(() => ({}), [type, release, disabled, editAllowed]);
  const current = useRef({ observation, statements, change });
  current.current = { observation, statements, change };
  const editable = (row?: (typeof statements)[number]) =>
    current.current.observation === observation &&
    !disabled &&
    (!editAllowed || editAllowed()) &&
    !!holder.current?.isConnected &&
    !holder.current.closest('fieldset:disabled') &&
    (!row || current.current.statements.includes(row));
  const additionAdmission = useRef({ type, release, editable });
  additionAdmission.current = { type, release, editable };
  const publish = (next: typeof statements) => {
    current.current.statements = next;
    current.current.change(next);
  };
  return (
    <fieldset ref={holder} disabled={disabled} className="min-w-0 max-w-full space-y-5">
      <legend className="font-sans text-lg font-semibold">{m.game_profile_initial({}, o)}</legend>
      <p className="text-sm text-muted-foreground">{m.game_profile_optional({}, o)}</p>
      <InitialFieldChoice
        groups={Object.entries(groups)
          .map(([group, properties]) => ({
            label: gameGroupLabel(group, locale),
            properties: properties.filter((property) => !omitProperties.includes(property)),
          }))
          .filter((group) => group.properties.length > 0)}
        release={release}
        occupied={statements.map((row) => row.statement.property.id)}
        locale={locale}
        disabled={disabled}
        atLimit={statements.length >= 32}
        fieldClassName="min-w-0 max-w-full"
        labelClassName="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
        selectClassName={gamePropertySelectClass}
        buttonClassName={gameActionClass}
        add={(property) => {
          if (!editable() || current.current.statements.length >= 32) return false;
          const key = crypto.randomUUID();
          publish([
            ...current.current.statements,
            {
              key,
              statement: {
                property: { id: property },
                value: { type: 'value', content: '' },
                qualifiers: [],
                references: [],
                rank: 'normal',
              },
            },
          ]);
          return {
            targetId: `game-initial-${key}-fact`,
            current: () =>
              additionAdmission.current.type === type &&
              additionAdmission.current.release === release &&
              additionAdmission.current.editable() &&
              current.current.statements.some((row) => row.key === key),
          };
        }}
      />
      {statements.map((row) => {
        const label = pickText(release.properties[row.statement.property.id]?.labels ?? {}, locale);
        return (
          <section key={row.key} className="min-w-0 max-w-full">
            <ContentItemFrame as="div" data-slot="game-initial-fact" className={gameFieldFrameClass}>
              <ContentItemHeading
                level={2}
                className="min-w-0 max-w-full whitespace-normal break-words font-sans text-lg font-semibold"
                lang={label.lang ?? undefined}
              >
                {label.text}
              </ContentItemHeading>
              <GameStatementFields
                id={`game-initial-${row.key}`}
                statement={row.statement}
                context={context}
                locale={locale}
                search={search}
                editAllowed={() => editable(row)}
                change={(statement) => {
                  if (!editable(row)) return;
                  publish(current.current.statements.map((item) => (item === row ? { ...item, statement } : item)));
                }}
              />
              <GameInitialFactRemove
                row={row}
                disabled={disabled}
                locale={locale}
                onRemove={() => {
                  if (editable(row)) publish(current.current.statements.filter((item) => item !== row));
                }}
              />
            </ContentItemFrame>
          </section>
        );
      })}
    </fieldset>
  );
}
/** Local confirmation belongs to one exact unsent row and its admitted current reading. */
function GameClassificationDiscard({
  draft,
  disabled,
  locale,
  allowed,
  discard,
}: {
  draft: FactDraft;
  disabled: boolean;
  locale: string;
  allowed: (row: FactDraft) => boolean;
  discard: (row: FactDraft) => void;
}) {
  const lifetime = useEditorLifetime();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const [confirmation, setConfirmation] = useState<{ row: FactDraft; active: () => boolean }>();
  const current = useRef({ draft, allowed, discard });
  current.current = { draft, allowed, discard };
  const confirming = confirmation?.row === draft && confirmation.active() && !disabled;
  const o = { locale: locale as never };
  const title = m.candidate_confirm_title({ action: m.authored_discard({}, o) }, o);
  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current && !disabled) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming, disabled]);
  const cancelDiscard = () => {
    restoreFocus.current = true;
    setConfirmation(undefined);
  };
  const discardDraft = () => {
    if (
      !lifetime.active() ||
      !holder.current?.isConnected ||
      current.current.draft !== draft ||
      !current.current.allowed(draft)
    )
      return;
    current.current.discard(draft);
  };
  // Property/rank and empty scaffolding alone are not assertion content.
  const hasContent = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value == null) return false;
    if (typeof value === 'object') return Object.values(value).some(hasContent);
    return true;
  };
  const populatedPart = (part: SnakInput) => part.value.type !== 'value' || hasContent(part.value.content);
  const populated =
    populatedPart(draft.statement) ||
    draft.statement.qualifiers?.some(populatedPart) ||
    draft.statement.references.some((reference) => reference.parts.some(populatedPart));
  return (
    <div ref={holder}>
      {confirming ? (
        <div
          role="group"
          aria-label={title}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelDiscard();
            }
          }}
        >
          <p>{title}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={cancel} className={gameActionClass} type="button" variant="outline" onClick={cancelDiscard}>
              {m.candidate_cancel({}, o)}
            </Button>
            <Button
              className={gameActionClass}
              type="button"
              variant="destructive"
              onClick={() => {
                if (confirmation.row === draft && confirmation.active()) discardDraft();
              }}
            >
              {m.authored_discard({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={gameActionClass}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (!lifetime.active() || !current.current.allowed(draft)) return;
            if (populated) setConfirmation({ row: draft, active: lifetime.active });
            else discardDraft();
          }}
        >
          {m.authored_discard({}, o)}
        </Button>
      )}
    </div>
  );
}

/** Common per-field sealing/retry and review, with item controls for native classification slots. */
export const GameClassifications = catalogueEditor(function GameClassificationsBoundary(
  props: Parameters<typeof GameClassificationsLive>[0],
) {
  return (
    <AuthoringDepartureBoundary>
      <GameClassificationsLive {...props} />
    </AuthoringDepartureBoundary>
  );
});

function GameClassificationsLive({
  read,
  locale,
  search,
  transport,
  review,
  reread,
}: {
  read: Ready & { public: NonNullable<Ready['public']> };
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  reread?: (() => Promise<void>) | undefined;
}) {
  const feedbackId = useId();
  const lifetime = useEditorLifetime();
  const visible = useCurrentReadingVisible();
  const context = { ...read, source: null } as FactsCurrent;
  const fields = gameGroups(read.release, read.public.subject.type).classification;
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [draftReleases, setDraftReleases] = useState<Record<string, Release>>({});
  const [busy, setBusy] = useState(false);
  const [changedReview, setChangedReview] = useState<ChangedSetReview>({ status: 'closed' });
  const [reuse, setReuse] = useState<GameReuseSession | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ holder: string; index: number; nonce: number } | null>(null);
  const [copies, setCopies] = useState<GameCopiedGroup[]>([]);
  const [orphans, setOrphans] = useState<GameOrphanDiagnostic[]>([]);
  const running = useRef(false);
  const holder = useRef<HTMLElement>(null);
  const focusAfterDiscard = useRef<FactDraft | null>(null);
  const focusAfterOpen = useRef<{
    draft: FactDraft;
    active: () => boolean;
    cancel: () => void;
  } | null>(null);
  useLayoutEffect(() => () => focusAfterOpen.current?.cancel(), []);
  const current = useRef({ drafts, busy, lifetime, fields, read, changedReview });
  current.current = { drafts, busy, lifetime, fields, read, changedReview };
  const canEdit = (draft: FactDraft, rows = current.current.drafts) => {
    const active = current.current;
    return (
      active.lifetime === lifetime &&
      active.lifetime.active() &&
      active.read === read &&
      active.fields.includes(draft.property) &&
      rows.some((row) => row === draft) &&
      !running.current &&
      !active.busy &&
      !draft.command &&
      !factLocked(draft)
    );
  };
  const canDiscard = (row: FactDraft) =>
    current.current.lifetime.active() &&
    !running.current &&
    !current.current.busy &&
    current.current.drafts.includes(row) &&
    !row.command &&
    !factLocked(row);
  const propertySection = (property: string) =>
    [...(holder.current?.querySelectorAll<HTMLElement>('[data-classification-property]') ?? [])].find(
      (node) => node.dataset.classificationProperty === property,
    );
  const openHolder = (id: string, index?: number) => {
    if (index != null) setFocusCopy({ holder: id, index, nonce: Date.now() });
    const target =
      holder.current?.querySelector<HTMLElement>(`[data-fact-holder="${CSS.escape(id)}"]`) ??
      propertySection(drafts.find((row) => factHolder(row) === id)?.property ?? id)?.querySelector('fieldset');
    target?.focus();
    target?.scrollIntoView?.({ block: 'center' });
  };
  useLayoutEffect(() => {
    const intent = focusAfterOpen.current;
    if (!intent) return;
    focusAfterOpen.current = null;
    const admitted = intent.active() && canEdit(intent.draft);
    intent.cancel();
    const section = propertySection(intent.draft.property);
    const target = section?.querySelector('fieldset');
    if (admitted && target?.isConnected && !target.closest('[hidden]')) target.focus();
  });
  useLayoutEffect(() => {
    const row = focusAfterDiscard.current;
    if (!row || !lifetime.active()) return;
    focusAfterDiscard.current = null;
    const section = propertySection(row.property);
    const controls = [...(section?.querySelectorAll<HTMLButtonElement>('button[data-classification-source]') ?? [])];
    (controls.find((button) => button.dataset.classificationSource === (row.source ?? '')) ?? controls[0])?.focus();
  }, [drafts, lifetime]);
  const [address, setAddress] = useState<{ property: string; candidate: string; session?: string | undefined }>();
  const [comparison, setComparison] = useState<CandidateTransport>();
  const o = { locale: locale as never };
  const withdrawnDrafts = drafts.filter((row) => !fields.includes(row.property));
  const properties = [...fields, ...withdrawnDrafts.map((row) => row.property)];
  const admittedDrafts = drafts.filter((row) => fields.includes(row.property));
  const fingerprint = changedSetFingerprint(admittedDrafts);
  const nextReview = advanceChangedSetReview(changedReview, fingerprint);
  if (
    nextReview.status !== changedReview.status ||
    (nextReview.status !== 'closed' &&
      changedReview.status !== 'closed' &&
      nextReview.fingerprint !== changedReview.fingerprint)
  )
    setChangedReview(nextReview);
  const boundReview = useMemo(
    () =>
      bindGameClassificationReview(
        review,
        reread,
        () => lifetime.active() && current.current.read === read,
        (property) => {
          const section = propertySection(property);
          (section?.querySelector<HTMLElement>('[data-fact-holder]') ?? section)?.focus();
        },
      ),
    [review, reread, lifetime, read],
  );
  const wasVisible = useRef(visible);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    running.current = false;
    setBusy(false);
    if (!visible) {
      setAddress(undefined);
      setComparison(undefined);
      setReuse(null);
      setDrafts((rows) =>
        rows.map((row) => (row.command && !row.result ? { ...row, result: { ok: false, reason: 'uncertain' } } : row)),
      );
    }
  }
  async function submit() {
    const active = current.current;
    if (!active.lifetime.active() || active.read !== read || running.current) return;
    const pending = active.drafts.filter((row) => active.fields.includes(row.property));
    const changed = includedChanges(pending);
    if (!changed.length) return;
    if (changed.some((row) => !row.command) && active.changedReview.status !== 'current') return;
    running.current = true;
    setBusy(true);
    const sealed = sealFacts(read.public.subject.id, read.release, pending);
    const sealedByHolder = new Map(sealed.map((row) => [factHolder(row), row]));
    setDrafts(active.drafts.map((row) => sealedByHolder.get(factHolder(row)) ?? row));
    const invalid = sealed.find((row) => row.result && !row.result.ok && row.result.reason === 'invalid');
    if (invalid) openHolder(factHolder(invalid));
    try {
      await sendFacts(
        sealed,
        transport.propose,
        (property, result) =>
          lifetime.active() &&
          current.current.read === read &&
          setDrafts((rows) =>
            rows.map((row) => {
              const sealedRow = sealedByHolder.get(factHolder(row));
              return sealedRow && row.property === property && row.submission === sealedRow.submission
                ? { ...row, result }
                : row;
            }),
          ),
      );
    } finally {
      if (!lifetime.active() || current.current.read !== read) return;
      running.current = false;
      setBusy(false);
    }
  }
  const content =
    visible && (fields.length > 0 || withdrawnDrafts.length > 0) ? (
      <section ref={holder} className="min-w-0 max-w-full space-y-5" aria-busy={busy}>
        <h2 className="font-sans text-xl font-semibold">{m.game_profile_classification({}, o)}</h2>
        <p className="text-sm text-muted-foreground">{m.facts_separate_results({}, o)}</p>
        {properties.map((property) => {
          const admitted = fields.includes(property);
          const draft = drafts.find((row) => row.property === property);
          const editorRelease = admitted ? read.release : draftReleases[property];
          const definition = editorRelease?.properties[property];
          const label = definition ? pickText(definition.labels, locale) : { text: property, lang: undefined };
          const selected = admitted ? (read.public.subject.statements[property] ?? []) : [];
          const editorContext = editorRelease ? { ...context, release: editorRelease } : context;
          const feedback =
            admitted && draft && editorRelease
              ? factStatementFeedback(draft, editorRelease, locale, `${feedbackId}-${property}`)
              : undefined;
          const stage = (source: (typeof selected)[number] | null, opener: HTMLElement, keyboard: boolean) => {
            const canStage = (rows = current.current.drafts) =>
              current.current.lifetime === lifetime &&
              current.current.lifetime.active() &&
              current.current.read === read &&
              current.current.fields.includes(property) &&
              !running.current &&
              !current.current.busy &&
              !rows.some((row) => row.property === property) &&
              (source === null
                ? !selected.length || read.release.properties[property]!.multivalued
                : selected.includes(source));
            if (!canStage()) return;
            const baseline = source ? statementInput(source) : null;
            const draft: FactDraft = {
              holder: crypto.randomUUID(),
              property,
              source: source?.id ?? null,
              baseline,
              included: true,
              statement: baseline
                ? structuredClone(baseline)
                : {
                    property: { id: property },
                    value: { type: 'value', content: '' },
                    qualifiers: [],
                    references: [],
                    rank: 'normal',
                  },
            };
            focusAfterOpen.current?.cancel();
            focusAfterOpen.current = null;
            const document = opener.ownerDocument;
            if (keyboard && document.activeElement === opener) {
              let moved = false;
              const cancel = () => {
                moved = true;
                document.removeEventListener('focusin', cancel);
              };
              document.addEventListener('focusin', cancel);
              focusAfterOpen.current = {
                draft,
                active: () =>
                  !moved &&
                  lifetime.active() &&
                  current.current.lifetime === lifetime &&
                  current.current.read === read &&
                  (document.activeElement === opener ||
                    (!opener.isConnected && document.activeElement === document.body)),
                cancel,
              };
            }
            setDraftReleases((rows) => ({ ...rows, [property]: read.release }));
            setDrafts((rows) => (canStage(rows) ? [...rows, draft] : rows));
          };
          return (
            <section key={property} data-classification-property={property} className="min-w-0 max-w-full">
              <ContentItemFrame as="div" data-slot="game-classification" className={gameFieldFrameClass}>
                <ContentItemHeading
                  level={3}
                  className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] font-sans font-semibold"
                  lang={label.lang ?? undefined}
                >
                  {label.text}
                </ContentItemHeading>
                {!selected.length && <p>{m.facts_no_value({}, o)}</p>}
                {selected.map((statement) => (
                  <div
                    key={statement.id}
                    className="min-w-0 max-w-full space-y-2 border-s-2 ps-3 [overflow-wrap:anywhere]"
                  >
                    <GameClassificationAssertion
                      statement={statement}
                      rank={statement.rank}
                      read={editorContext}
                      locale={locale}
                      missing={m.facts_no_value({}, o)}
                    />
                    {!draft && (
                      <Button
                        className={gameActionClass}
                        type="button"
                        variant="outline"
                        disabled={busy}
                        data-classification-source={statement.id}
                        onClick={(event) => stage(statement, event.currentTarget, event.detail === 0)}
                      >
                        {m.facts_edit_field({}, o)}
                      </Button>
                    )}
                  </div>
                ))}
                {!draft && (!selected.length || read.release.properties[property]!.multivalued) && (
                  <Button
                    className={gameActionClass}
                    type="button"
                    variant="outline"
                    disabled={busy}
                    data-classification-source=""
                    onClick={(event) => stage(null, event.currentTarget, event.detail === 0)}
                  >
                    {m.facts_add_value({}, o)}
                  </Button>
                )}
                {draft && (
                  <>
                    <fieldset
                      tabIndex={-1}
                      data-fact-holder={factHolder(draft)}
                      aria-label={`${label.text}: ${m.facts_private({}, o)}`}
                      className="space-y-4 focus:outline-2 focus:outline-offset-2 focus:outline-ring"
                      disabled={busy || !admitted || factLocked(draft) || !!draft.command}
                    >
                      <div
                        id={feedback ? `${feedback.id}-fields` : undefined}
                        role={feedback ? 'group' : undefined}
                        aria-label={feedback ? m.correction_title({}, o) : undefined}
                        tabIndex={feedback ? -1 : undefined}
                      >
                        <GameStatementFields
                          statement={draft.statement}
                          context={editorContext}
                          locale={locale}
                          search={search}
                          feedback={feedback}
                          editAllowed={() => canEdit(draft)}
                          reuse={
                            factWritable(draft) && admitted
                              ? {
                                  disabled: busy || factLocked(draft) || !!draft.command,
                                  onReuse: (index) => {
                                    if (!lifetime.active() || !canEdit(draft)) return;
                                    const next = openGameReuse(draft, index, current.current.drafts);
                                    if (next) setReuse(next);
                                  },
                                }
                              : undefined
                          }
                          focusReference={
                            focusCopy && factHolder(draft) === focusCopy.holder ? focusCopy : undefined
                          }
                          change={(statement) =>
                            canEdit(draft) &&
                            setDrafts((rows) =>
                              canEdit(draft, rows)
                                ? rows.map((row) =>
                                    row === draft
                                      ? {
                                          ...row,
                                          statement,
                                          result: undefined,
                                          command: undefined,
                                          submission: undefined,
                                        }
                                      : row,
                                  )
                                : rows,
                            )
                          }
                        />
                      </div>
                    </fieldset>
                    <GameClassificationDiscard
                      draft={draft}
                      disabled={busy || !!draft.command || factLocked(draft) || !lifetime.active()}
                      locale={locale}
                      allowed={canDiscard}
                      discard={(row) => {
                        if (!canDiscard(row)) return;
                        focusAfterDiscard.current = row;
                        if (row.result && !row.result.ok)
                          setOrphans((items) => [
                            ...items,
                            { holder: factHolder(row), property: row.property, result: row.result as FactResult },
                          ]);
                        setCopies((items) => items.filter((item) => item.holder !== factHolder(row)));
                        setDrafts((rows) => rows.filter((item) => item !== row));
                        setDraftReleases((rows) => {
                          const next = { ...rows };
                          delete next[row.property];
                          return next;
                        });
                      }}
                    />
                    {!admitted && <p role="status">{m.game_profile_support({}, o)}</p>}
                    {admitted && draft.result && !draft.result.ok && (
                      <EditorFailure reason={draft.result.reason} locale={locale} />
                    )}
                    <StatementViolationFeedback feedback={feedback} locale={locale} />
                    {draft.result?.ok && (
                      <div role="status">
                        <p>{m.correction_proposed({}, o)}</p>
                        <Button
                          className={gameActionClass}
                          type="button"
                          onClick={() => {
                            if (lifetime.active() && draft.result?.ok) {
                              setAddress({
                                property,
                                candidate: draft.result.candidate,
                                session: draft.result.session,
                              });
                              setComparison(boundReview(property, draft.result.session));
                            }
                          }}
                        >
                          {m.correction_review({}, o)}
                        </Button>
                      </div>
                    )}
                    {admitted && draft.command && draft.result && !draft.result.ok && !factLocked(draft) && (
                      <Button
                        className={gameActionClass}
                        type="button"
                        variant="outline"
                        onClick={() =>
                          lifetime.active() &&
                          setDrafts((rows) =>
                            rows.map((row) =>
                              row.property === property
                                ? { ...row, command: undefined, result: undefined, submission: undefined }
                                : row,
                            ),
                          )
                        }
                      >
                        {m.catalogue_create_review_new({}, o)}
                      </Button>
                    )}
                  </>
                )}
              </ContentItemFrame>
            </section>
          );
        })}
        <GameClassificationReviewControls
          drafts={drafts}
          admitted={fields}
          read={context}
          locale={locale}
          busy={busy}
          review={changedReview}
          copies={copies}
          orphans={orphans}
          onReview={() => lifetime.active() && setChangedReview({ status: 'current', fingerprint })}
          onSubmit={() => void submit()}
          onJump={(id) => {
            if (!lifetime.active()) return;
            setChangedReview(advanceChangedSetReview(changedReview, fingerprint, true));
            openHolder(id);
          }}
        />
        {reuse && (
          <GameClassificationReuse
            reuse={reuse}
            drafts={drafts}
            read={context}
            locale={locale}
            onSelected={(selected) =>
              lifetime.active() && setReuse({ ...reuse, selected, applied: [], refused: [] })
            }
            onRefresh={() => {
              if (!lifetime.active()) return;
              const next = refreshGameReuse(reuse, drafts);
              if (next) setReuse(next);
            }}
            onApply={() => {
              if (!lifetime.active() || busy || running.current) return;
              const result = applyGameReuse(drafts, reuse, read.release);
              setDrafts(result.drafts);
              setReuse(result.reuse);
              setCopies((items) => [
                ...items.filter((item) => !result.copies.some((copy) => copy.holder === item.holder && copy.index === item.index)),
                ...result.copies,
              ]);
              setChangedReview({ status: 'stale', fingerprint: changedSetFingerprint(result.drafts.filter((row) => fields.includes(row.property))) });
              const first = result.reuse.applied[0];
              if (first) openHolder(first.holder, first.index);
            }}
            onCancel={() => {
              const trigger = reuse.trigger;
              setReuse(null);
              if (lifetime.active() && trigger?.isConnected) trigger.focus();
            }}
            onOpen={(id, index) => lifetime.active() && openHolder(id, index)}
          />
        )}
        {address && comparison && (
          <CandidateReview
            key={address.candidate}
            id={read.public.subject.id}
            locale={locale}
            initialProperty={address.property}
            exactCandidate={address.candidate}
            transport={comparison}
          />
        )}
      </section>
    ) : null;
  return (
    <>
      <GameFactsDeparture drafts={drafts} />
      {content}
    </>
  );
}
