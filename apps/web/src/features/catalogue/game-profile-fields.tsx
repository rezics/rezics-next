import { useId, useLayoutEffect, useRef, useState } from 'react';
import { catalogueEditor, useEditorLifetime, useCurrentReadingVisible } from './editor-lifetime';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { controlId } from './statement-validation-presentation';
import { gameGroups, gameTarget, type GameRead } from './game-profile';
import { StatementFields, PartValue, EditorFailure, type StatementFieldsRead } from './statement-editor-view';
import { statementInput, type SnakInput, type StatementInput } from './statement-editor';
import { factChanged, factLocked, sealFacts, sendFacts, type FactDraft, type FactsTransport } from './subject-facts';

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
}: {
  part: SnakInput;
  context: StatementFieldsRead;
  locale: string;
  search: EntityPickerSearch;
  change: (value: SnakInput['value']) => void;
}) {
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const property = part.property.id;
  const definition = context.release.properties[property]!;
  const label = pickText(definition.labels, locale);
  const value = part.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : '';
  const target = value ? picked.find((item) => item.id === value) : undefined;
  return (
    <EntityPicker
      label={label.text}
      src={coverSrc}
      value={
        value
          ? [
              target ?? {
                id: value,
                title:
                  pickText(context.public.related[value]?.labels ?? {}, locale).text ||
                  m.subject_value_unlabelled({}, { locale: locale as never }),
                types: [],
                typeLabel: '',
                cover: null,
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
        setPicked(items);
        change({ type: 'value', content: items[0]?.id ?? '' });
      }}
    />
  );
}
export function GameStatementFields({
  statement,
  context,
  locale,
  search,
  change,
  id,
}: {
  id?: string;
  statement: StatementInput;
  context: StatementFieldsRead;
  locale: string;
  search: EntityPickerSearch;
  change: (next: StatementInput) => void;
}) {
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
      <div id={id ? controlId(id, address, 'value') : undefined}>
        <GameItemControl part={part} context={context} locale={locale} search={search} change={update} />
      </div>
    );
  };
  return (
    <StatementFields
      draft={statement}
      feedback={id ? { id, errors: [] } : undefined}
      current={context}
      locale={locale}
      change={change}
      valueControl={control(statement, (value) => change({ ...statement, value }))}
      partControl={control}
    />
  );
}
/** Confirm only whole unsent facts; keep their editors mounted so item summaries survive Cancel. */
function GameInitialFactRemove({
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
}: {
  type: string;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  statements: { key: string; statement: StatementInput }[];
  disabled: boolean;
  change: (rows: { key: string; statement: StatementInput }[]) => void;
}) {
  const propertySelectId = useId();
  const [property, setProperty] = useState('');
  const o = { locale: locale as never };
  const groups = gameGroups(release, type);
  const context: StatementFieldsRead = { release, source: null, public: { subject: { type }, related: {} } };
  return (
    <fieldset disabled={disabled} className="min-w-0 max-w-full space-y-5">
      <legend className="font-sans text-lg font-semibold">{m.game_profile_initial({}, o)}</legend>
      <p className="text-sm text-muted-foreground">{m.game_profile_optional({}, o)}</p>
      <Field className="min-w-0 max-w-full">
        <FieldLabel
          htmlFor={propertySelectId}
          className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
        >
          {m.character_add_fact({}, o)}
        </FieldLabel>
        <NativeSelect
          id={propertySelectId}
          className={gamePropertySelectClass}
          aria-label={m.character_add_fact({}, o)}
          value={property}
          onChange={(event) => setProperty(event.target.value)}
        >
          <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
          {Object.entries(groups)
            .filter(([, ids]) => ids.length)
            .map(([group, ids]) => (
              <optgroup key={group} label={gameGroupLabel(group, locale)}>
                {ids
                  .filter(
                    (id) =>
                      release.properties[id]!.multivalued ||
                      !statements.some((row) => row.statement.property.id === id),
                  )
                  .map((id) => {
                    const label = pickText(release.properties[id]!.labels, locale);
                    return (
                      <NativeSelectOption key={id} value={id} lang={label.lang ?? undefined}>
                        {label.text}
                      </NativeSelectOption>
                    );
                  })}
              </optgroup>
            ))}
        </NativeSelect>
      </Field>
      <Button
        type="button"
        className={gameActionClass}
        variant="outline"
        disabled={!Object.values(groups).flat().includes(property) || statements.length >= 32}
        onClick={() => {
          change([
            ...statements,
            {
              key: crypto.randomUUID(),
              statement: {
                property: { id: property },
                value: { type: 'value', content: '' },
                qualifiers: [],
                references: [],
                rank: 'normal',
              },
            },
          ]);
          setProperty('');
        }}
      >
        {m.correction_add({}, o)}
      </Button>
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
                change={(statement) =>
                  change(statements.map((item) => (item.key === row.key ? { ...item, statement } : item)))
                }
              />
              <GameInitialFactRemove
                row={row}
                disabled={disabled}
                locale={locale}
                onRemove={() => change(statements.filter((item) => item.key !== row.key))}
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
export const GameClassifications = catalogueEditor(GameClassificationsLive);

function GameClassificationsLive({
  read,
  locale,
  search,
  transport,
  review,
}: {
  read: Ready & { public: NonNullable<Ready['public']> };
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
}) {
  const lifetime = useEditorLifetime();
  const visible = useCurrentReadingVisible();
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const holder = useRef<HTMLElement>(null);
  const focusAfterDiscard = useRef<FactDraft | null>(null);
  const current = useRef({ drafts, busy, lifetime });
  current.current = { drafts, busy, lifetime };
  const canDiscard = (row: FactDraft) =>
    current.current.lifetime.active() &&
    !running.current &&
    !current.current.busy &&
    current.current.drafts.includes(row) &&
    !row.command &&
    !factLocked(row);
  useLayoutEffect(() => {
    const row = focusAfterDiscard.current;
    if (!row || !lifetime.active()) return;
    focusAfterDiscard.current = null;
    const section = [...(holder.current?.querySelectorAll<HTMLElement>('[data-classification-property]') ?? [])].find(
      (node) => node.dataset.classificationProperty === row.property,
    );
    const controls = [...(section?.querySelectorAll<HTMLButtonElement>('button[data-classification-source]') ?? [])];
    (controls.find((button) => button.dataset.classificationSource === (row.source ?? '')) ?? controls[0])?.focus();
  }, [drafts, lifetime]);
  const [address, setAddress] = useState<{ property: string; candidate: string; session?: string | undefined }>();
  const [comparison, setComparison] = useState<CandidateTransport>();
  const o = { locale: locale as never };
  const context = { ...read, source: null };
  const fields = gameGroups(read.release, read.public.subject.type).classification;
  const wasVisible = useRef(visible);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    running.current = false;
    setBusy(false);
    if (!visible) {
      setAddress(undefined);
      setComparison(undefined);
      setDrafts((rows) =>
        rows.map((row) => (row.command && !row.result ? { ...row, result: { ok: false, reason: 'uncertain' } } : row)),
      );
    }
  }
  async function submit() {
    if (!lifetime.active() || running.current) return;
    running.current = true;
    setBusy(true);
    const sealed = sealFacts(read.public.subject.id, read.release, drafts);
    setDrafts(sealed);
    try {
      await sendFacts(
        sealed,
        transport.propose,
        (property, result) =>
          lifetime.active() &&
          setDrafts((rows) => rows.map((row) => (row.property === property ? { ...row, result } : row))),
      );
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  if (!visible) return null;
  return (
    <section ref={holder} className="min-w-0 max-w-full space-y-5" aria-busy={busy}>
      <h2 className="font-sans text-xl font-semibold">{m.game_profile_classification({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.facts_separate_results({}, o)}</p>
      {fields.map((property) => {
        const label = pickText(read.release.properties[property]!.labels, locale);
        const selected = read.public.subject.statements[property] ?? [];
        const draft = drafts.find((row) => row.property === property);
        const stage = (source: (typeof selected)[number] | null) => {
          if (!lifetime.active()) return;
          const baseline = source ? statementInput(source) : null;
          setDrafts((rows) => [
            ...rows,
            {
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
            },
          ]);
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
                  <PartValue part={statement} read={context} locale={locale} />
                  {statement.qualifiers.map((part, i) => (
                    <div key={i} className="min-w-0 [overflow-wrap:anywhere]">
                      <span>{pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).text}: </span>
                      <PartValue part={part} read={context} locale={locale} />
                    </div>
                  ))}
                  {statement.references.map((reference, i) => (
                    <div key={i} className="min-w-0 [overflow-wrap:anywhere]">
                      {reference.parts.map((part, j) => (
                        <PartValue key={j} part={part} read={context} locale={locale} />
                      ))}
                    </div>
                  ))}
                  {!draft && (
                    <Button
                      className={gameActionClass}
                      type="button"
                      variant="outline"
                      disabled={busy}
                      data-classification-source={statement.id}
                      onClick={() => stage(statement)}
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
                  onClick={() => stage(null)}
                >
                  {m.facts_add_value({}, o)}
                </Button>
              )}
              {draft && (
                <>
                  <fieldset className="space-y-4" disabled={busy || factLocked(draft) || !!draft.command}>
                    <GameStatementFields
                      statement={draft.statement}
                      context={context}
                      locale={locale}
                      search={search}
                      change={(statement) =>
                        lifetime.active() &&
                        setDrafts((rows) =>
                          rows.map((row) =>
                            row.property === property
                              ? { ...row, statement, result: undefined, command: undefined }
                              : row,
                          ),
                        )
                      }
                    />
                  </fieldset>
                  <GameClassificationDiscard
                    draft={draft}
                    disabled={busy || !!draft.command || factLocked(draft) || !lifetime.active()}
                    locale={locale}
                    allowed={canDiscard}
                    discard={(row) => {
                      if (!canDiscard(row)) return;
                      focusAfterDiscard.current = row;
                      setDrafts((rows) => rows.filter((item) => item !== row));
                    }}
                  />
                  {draft.result && !draft.result.ok && <EditorFailure reason={draft.result.reason} locale={locale} />}
                  {draft.result?.ok && (
                    <div role="status">
                      <p>{m.correction_proposed({}, o)}</p>
                      <Button
                        className={gameActionClass}
                        type="button"
                        onClick={() => {
                          if (lifetime.active() && draft.result?.ok) {
                            setAddress({ property, candidate: draft.result.candidate, session: draft.result.session });
                            setComparison(review(property, draft.result.session));
                          }
                        }}
                      >
                        {m.correction_review({}, o)}
                      </Button>
                    </div>
                  )}
                  {draft.command && draft.result && !draft.result.ok && !factLocked(draft) && (
                    <Button
                      className={gameActionClass}
                      type="button"
                      variant="outline"
                      onClick={() =>
                        lifetime.active() &&
                        setDrafts((rows) =>
                          rows.map((row) =>
                            row.property === property ? { ...row, command: undefined, result: undefined } : row,
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
      <Button
        className={gameActionClass}
        type="button"
        disabled={
          busy ||
          drafts.some((row) => row.result && !row.result.ok && row.result.reason === 'stale') ||
          !drafts.some((row) => factChanged(row) && !row.result?.ok)
        }
        onClick={() => void submit()}
      >
        {m.facts_submit({}, o)}
      </Button>
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
  );
}
