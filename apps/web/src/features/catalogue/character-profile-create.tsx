import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useId, useRef, useState, useLayoutEffect, type MouseEvent } from 'react';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { DefinitionMeaning } from './definition-meaning';
import {
  EditorFailure,
  StatementFields,
  statementHolderKey,
  type StatementFieldsRead,
} from './statement-editor-view';
import { emptyCreationStatement, editableScalar, type SnakInput, type StatementInput } from './statement-editor';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import {
  characterCreateCorrections,
  characterCorrectionTargets,
  characterFactId,
  type CharacterCorrection,
} from './character-create-guidance';
import { CharacterCreateReview, characterCreateDrafts, characterCreateFingerprint } from './character-create-review';
import {
  applyReuse,
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { ReferenceReusePanel } from './reference-reuse-view';
import { controlId } from './statement-validation-presentation';
import {
  characterDraft,
  characterGroups,
  characterType,
  type CharacterCommand,
  type CharacterTransport,
} from './character-profile';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const labelClassName = 'min-w-0 max-w-full flex-wrap whitespace-normal [overflow-wrap:anywhere]';

/** Addition intent is independent of the existing removal handoff. */
function useCharacterAdditionFocus() {
  const pending = useRef<{
    origin: HTMLButtonElement;
    targetId: string;
    admitted: () => boolean;
    dispose: () => void;
  } | null>(null);
  const cancel = () => {
    pending.current?.dispose();
    pending.current = null;
  };
  useLayoutEffect(() => {
    const intent = pending.current;
    cancel();
    if (!intent) return;
    const { origin, targetId, admitted } = intent;
    const document = origin.ownerDocument;
    // Adding a fact clears its choice and disables Add during this commit.
    const disabledBlur = origin.matches(':disabled') && document.activeElement === document.body;
    if (!origin.isConnected || (document.activeElement !== origin && !disabledBlur) || !admitted()) return;
    const target = origin.ownerDocument.getElementById(targetId);
    if (target && origin.form?.contains(target) && !target.matches(':disabled')) target.focus();
  });
  useLayoutEffect(() => cancel, []);
  return (event: MouseEvent<HTMLButtonElement>, targetId: string, admitted: () => boolean) => {
    cancel();
    const origin = event.currentTarget;
    if (event.detail !== 0 || origin.ownerDocument.activeElement !== origin) return;
    // Leaving and returning before the commit must still cancel this intent.
    const leave = (event: FocusEvent) => {
      if (!origin.matches(':disabled') || event.relatedTarget !== null) cancel();
    };
    const move = (event: FocusEvent) => {
      if (event.target !== origin) cancel();
    };
    origin.addEventListener('focusout', leave);
    origin.ownerDocument.addEventListener('focusin', move);
    pending.current = {
      origin,
      targetId,
      admitted,
      dispose: () => {
        origin.removeEventListener('focusout', leave);
        origin.ownerDocument.removeEventListener('focusin', move);
      },
    };
  };
}

/** Confirm against the stable row that owns this control, rather than a changing list index. */
function DraftRemoval({
  label,
  description,
  populated = true,
  disabled,
  locale,
  onRemove,
}: {
  label: string;
  description: string;
  populated?: boolean;
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const o = { locale: locale as never };
  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming]);
  return confirming ? (
    <div className="space-y-2" role="group" aria-label={m.candidate_confirm_title({ action: description }, o)}>
      <p>{m.candidate_confirm_title({ action: description }, o)}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={cancel}
          type="button"
          variant="outline"
          className={actionClassName}
          disabled={disabled}
          onClick={() => {
            restoreFocus.current = true;
            setConfirming(false);
          }}
        >
          {m.candidate_cancel({}, o)}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className={actionClassName}
          disabled={disabled}
          onClick={() => {
            if (!disabled) onRemove();
          }}
        >
          {label}
        </Button>
      </div>
    </div>
  ) : (
    <Button
      ref={trigger}
      type="button"
      variant="ghost"
      className={actionClassName}
      disabled={disabled}
      onClick={() => {
        if (!disabled) populated ? setConfirming(true) : onRemove();
      }}
    >
      {label}
    </Button>
  );
}

function CharacterItemValue({
  id,
  address = 'fact',
  part,
  release,
  locale,
  search,
  disabled,
  change,
}: {
  id: string;
  address?: string;
  part: SnakInput;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  change: (value: SnakInput['value']) => void;
}) {
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const definition = release.properties[part.property.id];
  const content = part.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : '';
  const o = { locale: locale as never };
  return (
    <div id={controlId(id, address, 'value')}>
      <EntityPicker
        label={pickText(definition?.labels ?? {}, locale).text || m.subject_value_unlabelled({}, o)}
        disabled={disabled}
        value={
          picked.filter((item) => item.id === content).length
            ? picked.filter((item) => item.id === content)
            : content
              ? [
                  {
                    id: content,
                    title: m.subject_value_unlabelled({}, o),
                    types: [],
                    typeLabel: '',
                    cover: null,
                  },
                ]
              : []
        }
        src={coverSrc}
        search={async (text, signal) => {
          const entries = await search(text, signal);
          const targets = definition?.targets ?? [];
          return targets.length
            ? entries.filter((item) => item.types.some((type) => targets.includes(type)))
            : entries;
        }}
        onValueChange={(items) => {
          change({ type: 'value', content: items[0]?.id ?? '' });
          setPicked(items);
        }}
      />
    </div>
  );
}

type CharacterProfileCreateProps = {
  release: Release;
  locale: string;
  transport: CharacterTransport;
  search?: EntityPickerSearch;
  onCreated: (result: Extract<CreateResult, { ok: true }>) => void;
  onRefreshDefinitions?: () => Promise<Release>;
};

/** Initial terms and explicitly added facts use the existing validators, scalar controls and subject POST. */
export const CharacterProfileCreate = catalogueEditor(function CharacterProfileCreateGuarded(
  props: CharacterProfileCreateProps,
) {
  return (
    <AuthoringDepartureBoundary>
      <CharacterProfileCreateLive {...props} />
    </AuthoringDepartureBoundary>
  );
});

function CharacterProfileCreateLive({
  release: suppliedRelease,
  locale,
  transport,
  search,
  onCreated,
  onRefreshDefinitions,
}: CharacterProfileCreateProps) {
  const lifetime = useEditorLifetime();
  const retired = useRef(false);
  const isCurrent = () => lifetime.active() && !retired.current;
  const o = { locale: locale as never };
  const termsId = useId();
  const [definitions, setDefinitions] = useState<{ source: Release; value: Release }>();
  const release = definitions?.source === suppliedRelease ? definitions.value : suppliedRelease;
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [definitionsRequired, setDefinitionsRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRunning = useRef(false);
  const nextTermId = useRef(1);
  const form = useRef<HTMLFormElement>(null);
  const focusAfterChange = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusAfterChange.current || !isCurrent()) return;
    form.current?.ownerDocument.getElementById(focusAfterChange.current)?.focus();
    focusAfterChange.current = null;
  });
  const [terms, setTerms] = useState<(TermDraft & { id: number })[]>([
    { id: 0, language: locale, label: '', description: '', aliases: '' },
  ]);
  const [facts, setFacts] = useState<StatementInput[]>([]);
  const [field, setField] = useState('');
  const [fieldWithdrawn, setFieldWithdrawn] = useState(false);
  const [failure, setFailure] = useState<CreateFailure>();
  const [corrections, setCorrections] = useState<CharacterCorrection[]>([]);
  const factIds = useRef(new WeakMap<StatementInput, number>());
  const nextFactId = useRef(0);
  const factId = (fact: StatementInput) => {
    let id = factIds.current.get(fact);
    if (id === undefined) {
      id = nextFactId.current++;
      factIds.current.set(fact, id);
    }
    return id;
  };
  const addressedFacts = facts.map((fact) => ({ fact, id: factId(fact) }));
  const available = Object.values(characterGroups(release))
    .flat()
    .filter((id) => editableScalar(release.properties[id]) && id !== 'schema:alternateName');
  const selectedField = available.includes(field) ? field : '';
  if (field && !selectedField) {
    // Require a deliberate new choice even if a later release offers this field again.
    setField('');
    setFieldWithdrawn(true);
  }
  const targets = characterCorrectionTargets(
    termsId,
    terms,
    addressedFacts.filter(({ fact }) => available.includes(fact.property.id)),
    release,
  );
  const displayedCorrections =
    failure?.reason === 'invalid'
      ? corrections.map((error) =>
          error.target && targets.has(error.target)
            ? error
            : {
                ...error,
                target: undefined,
                instruction: `${error.reason} ${m.character_create_correction_fallback({}, o)}`,
              },
        )
      : [];
  const associated = new Map<string, string[]>();
  for (const error of displayedCorrections) {
    if (!error.target) continue;
    const ids = associated.get(error.target) ?? [];
    ids.push(error.id);
    associated.set(error.target, ids);
  }
  const feedback = (target: string) => ({
    'aria-invalid': associated.has(target) ? (true as const) : undefined,
    'aria-describedby': associated.get(target)?.join(' '),
  });
  function reportFailure(next: CreateFailure, currentRelease = release) {
    setFailure(next);
    setCorrections(
      next.reason === 'invalid'
        ? characterCreateCorrections(next.errors ?? [], terms, addressedFacts, currentRelease, locale, termsId)
        : [],
    );
  }
  const [busy, setBusy] = useState(false);
  const pending = useRef<CharacterCommand | null>(null);
  const running = useRef(false);
  const [review, setReview] = useState<{ status: 'closed' | 'current' | 'stale'; fingerprint?: string }>({
    status: 'closed',
  });
  const [reuse, setReuse] = useState<{
    source: ReuseSource;
    selected: string[];
    capture: ReuseCapture;
    applied: { holder: string; property: string; index: number }[];
    refused: { holder: string; property: string; reason: ReuseRefusal }[];
    trigger: HTMLButtonElement | null;
  } | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ holder: string; index: number; nonce: number } | null>(null);
  const fingerprint = characterCreateFingerprint(release, terms, facts);
  if (review.status === 'current' && review.fingerprint !== fingerprint)
    setReview({ status: 'stale', fingerprint: review.fingerprint });
  const termEditIsAdmitted = () => isCurrent() && !running.current && !refreshRunning.current && !pending.current;
  const changeTerm = (id: number, key: keyof TermDraft, value: string) => {
    if (!termEditIsAdmitted()) return;
    setTerms((previous) => {
      if (!termEditIsAdmitted()) return previous;
      return previous.map((row) => (row.id === id ? { ...row, [key]: value } : row));
    });
  };
  const hasMeaningfulWork = () =>
    terms.length > 1 ||
    terms.some(
      (term) => term.language !== locale || term.label !== '' || term.description !== '' || term.aliases !== '',
    ) ||
    facts.length > 0 ||
    field !== '';
  const departure = useAuthoringDeparture(
    () => isCurrent() && (hasMeaningfulWork() || pending.current !== null),
    () => isCurrent() && pending.current !== null,
    'character-profile-create',
    undefined,
    () => {
      retired.current = true;
      pending.current = null;
    },
  );
  const locked = busy || refreshing || !!pending.current;
  const scalarAdmission = useRef({ release, locked });
  scalarAdmission.current = { release, locked };
  const additionRows = useRef({ terms, facts });
  additionRows.current = { terms, facts };
  const focusAddition = useCharacterAdditionFocus();
  const additionIsCurrent = () =>
    isCurrent() &&
    scalarAdmission.current.release === release &&
    !scalarAdmission.current.locked &&
    !running.current &&
    !refreshRunning.current &&
    !pending.current;
  async function refreshDefinitions() {
    if (!isCurrent() || !onRefreshDefinitions || refreshRunning.current || pending.current) return;
    refreshRunning.current = true;
    setRefreshing(true);
    try {
      const next = await onRefreshDefinitions();
      if (!isCurrent()) return;
      setDefinitions({ source: suppliedRelease, value: next });
      // Reconcile private input against the admitted release without sending a command.
      const draft = characterDraft(next, terms, facts);
      if (draft.errors.length) reportFailure({ ok: false, reason: 'invalid', errors: draft.errors }, next);
      else {
        setFailure(undefined);
        setCorrections([]);
      }
      setDefinitionsRequired(false);
      setRefreshFailed(false);
    } catch {
      // A metadata failure does not turn a known rejection into an uncertain creation.
      if (isCurrent()) setRefreshFailed(true);
    } finally {
      refreshRunning.current = false;
      if (isCurrent()) setRefreshing(false);
    }
  }
  async function send() {
    if (!pending.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await transport.create(pending.current);
      if (!isCurrent()) return;
      if (result.ok) {
        pending.current = null;
        departure.release();
        onCreated(result);
      } else {
        reportFailure(result);
        if (result.reason !== 'unavailable' && result.reason !== 'conflict') {
          pending.current = null;
          if (result.refreshDefinitions) setDefinitionsRequired(true);
        }
        if (result.refreshDefinitions) await refreshDefinitions();
      }
    } catch {
      if (!isCurrent()) return;
      reportFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!isCurrent()) return;
      running.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (!isCurrent()) return;
    if (running.current || refreshRunning.current || failure?.reason === 'conflict') return;
    if (pending.current) {
      await send();
      return;
    }
    if (definitionsRequired) return;
    const draft = characterDraft(release, terms, facts);
    if (draft.errors.length) {
      reportFailure({ ok: false, reason: 'invalid', errors: draft.errors });
      setReview({ status: 'closed' });
      return;
    }
    if (review.status === 'current' && review.fingerprint === fingerprint) {
      pending.current = { item: draft.item, key: crypto.randomUUID() };
      setReview({ status: 'closed' });
      await send();
      return;
    }
    setFailure(undefined);
    setCorrections([]);
    setReview({ status: 'current', fingerprint });
  }
  return (
    <form
      ref={form}
      aria-label={m.character_create_correction_form({}, o)}
      aria-busy={busy}
      className="min-w-0 space-y-5 [overflow-wrap:anywhere]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <a
        className={buttonVariants({ variant: 'outline', className: actionClassName })}
        href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
      >
        {m.catalogue_create_search({}, o)}
      </a>
      <p className="text-sm text-muted-foreground">{m.character_create_help({}, o)}</p>
      <fieldset disabled={locked} className="min-w-0 space-y-5">
        <legend className="font-semibold">{m.catalogue_create_terms({}, o)}</legend>
        <p id={`${termsId}-language-help`} className="text-sm text-muted-foreground">
          {m.catalogue_create_language_help({}, o)}
        </p>
        <p id={`${termsId}-aliases-help`} className="text-sm text-muted-foreground">
          {m.catalogue_create_aliases_help({}, o)}
        </p>
        {terms.map((term, index) => (
          <ContentItemFrame
            as="div"
            key={term.id}
            data-slot="character-create-language"
            className="min-w-0 max-w-full py-3 sm:py-4"
          >
            <fieldset id={`${termsId}-${term.id}`} className="min-w-0 space-y-3">
              <legend className="mb-3 max-w-full font-medium">
                {m.character_create_correction_term({ number: index + 1 }, o)}
                {term.language && <span className="ms-2 text-sm text-muted-foreground">{term.language}</span>}
              </legend>
              <FieldGroup className="grid min-w-0 gap-4 sm:grid-cols-2">
                {(['language', 'label', 'description', 'aliases'] as const).map((key) => (
                  <Field key={key} className="min-w-0">
                    <FieldLabel className={labelClassName} htmlFor={`${termsId}-${key}-${term.id}`}>
                      {
                        {
                          language: m.catalogue_create_language({}, o),
                          label: m.catalogue_create_label({}, o),
                          description: m.catalogue_create_description({}, o),
                          aliases: m.catalogue_create_aliases({}, o),
                        }[key]
                      }
                    </FieldLabel>
                    {key === 'aliases' ? (
                      <Textarea
                        className="min-w-0 max-w-full"
                        id={`${termsId}-${key}-${term.id}`}
                        {...feedback(`${termsId}-${key}-${term.id}`)}
                        aria-describedby={
                          [feedback(`${termsId}-${key}-${term.id}`)['aria-describedby'], `${termsId}-aliases-help`]
                            .filter(Boolean)
                            .join(' ') || undefined
                        }
                        lang={/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(term.language) ? term.language : undefined}
                        dir="auto"
                        value={term[key]}
                        onChange={(event) => changeTerm(term.id, key, event.target.value)}
                      />
                    ) : (
                      <Input
                        className="min-h-11 min-w-0 max-w-full md:pointer-fine:min-h-8"
                        id={`${termsId}-${key}-${term.id}`}
                        {...feedback(`${termsId}-${key}-${term.id}`)}
                        aria-describedby={
                          [
                            feedback(`${termsId}-${key}-${term.id}`)['aria-describedby'],
                            key === 'language' ? `${termsId}-${key}-help` : undefined,
                          ]
                            .filter(Boolean)
                            .join(' ') || undefined
                        }
                        lang={
                          key !== 'language' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(term.language)
                            ? term.language
                            : undefined
                        }
                        dir={key === 'language' ? 'ltr' : 'auto'}
                        aria-required={key === 'label' || undefined}
                        value={term[key]}
                        onChange={(event) => changeTerm(term.id, key, event.target.value)}
                      />
                    )}
                  </Field>
                ))}
              </FieldGroup>
              {index > 0 && (
                <DraftRemoval
                  locale={locale}
                  label={m.catalogue_create_remove_language({}, o)}
                  description={`${m.catalogue_create_remove_language({}, o)} · ${m.character_create_correction_term({ number: index + 1 }, o)} · ${term.language}`}
                  populated={!!(term.language || term.label || term.description || term.aliases)}
                  disabled={locked}
                  onRemove={() => {
                    if (!isCurrent() || locked || running.current || pending.current) return;
                    focusAfterChange.current = terms[index + 1]
                      ? `${termsId}-language-${terms[index + 1]!.id}`
                      : `${termsId}-add`;
                    setTerms((previous) => previous.filter((row) => row.id !== term.id));
                  }}
                />
              )}
            </fieldset>
          </ContentItemFrame>
        ))}
        <Button
          id={`${termsId}-add`}
          className={actionClassName}
          type="button"
          variant="outline"
          disabled={locked}
          onClick={(event) => {
            if (locked || running.current || pending.current) return;
            const id = nextTermId.current++;
            focusAddition(
              event,
              `${termsId}-language-${id}`,
              () => additionIsCurrent() && additionRows.current.terms.some((row) => row.id === id),
            );
            setTerms((previous) => [...previous, { id, language: '', label: '', description: '', aliases: '' }]);
          }}
        >
          {m.catalogue_create_add_language({}, o)}
        </Button>
      </fieldset>
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        <legend className="mb-3 max-w-full font-semibold">{m.character_initial_fact({}, o)}</legend>
        <Field className="min-w-0">
          <FieldLabel className={labelClassName} htmlFor={`${termsId}-initial-field`}>
            {m.character_initial_fact({}, o)}
          </FieldLabel>
          <NativeSelect
            id={`${termsId}-initial-field`}
            className="w-full [&>select]:min-h-11"
            value={selectedField}
            aria-describedby={fieldWithdrawn ? `${termsId}-field-withdrawn` : undefined}
            onChange={(event) => {
              setField(event.target.value);
              setFieldWithdrawn(false);
            }}
          >
            <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
            {available.map((id) => (
              <NativeSelectOption
                key={id}
                value={id}
                lang={pickText(release.properties[id]!.labels, locale).lang ?? undefined}
              >
                {pickText(release.properties[id]!.labels, locale).text || m.candidate_value_unavailable({}, o)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {fieldWithdrawn && (
            <p id={`${termsId}-field-withdrawn`} role="status" className="text-sm text-muted-foreground">
              {m.character_initial_fact_withdrawn({}, o)}
            </p>
          )}
        </Field>
        <Button
          className={actionClassName}
          type="button"
          variant="outline"
          disabled={locked || !selectedField}
          onClick={(event) => {
            if (locked || running.current || !available.includes(field)) return;
            const fact = emptyCreationStatement(field, release);
            const id = factId(fact);
            focusAddition(
              event,
              `${characterFactId(termsId, id)}-group`,
              () =>
                additionIsCurrent() &&
                additionRows.current.facts.some((row) => factId(row) === id) &&
                available.includes(fact.property.id),
            );
            setFacts([...facts, fact]);
            setField('');
          }}
        >
          {m.character_add_fact({}, o)}
        </Button>
        {facts.map((fact, index) => {
          const definition = release.properties[fact.property.id];
          const name = pickText(definition?.labels ?? {}, locale);
          const address = characterFactId(termsId, factId(fact));
          const supported = available.includes(fact.property.id);
          return (
            <fieldset key={factId(fact)} data-slot="character-initial-fact" className="min-w-0 max-w-full">
              <legend className="max-w-full" lang={name.lang ?? undefined}>
                <ContentItemHeading level={3} className="text-lg font-semibold">
                  {name.text || m.candidate_value_unavailable({}, o)}
                </ContentItemHeading>
              </legend>
              <ContentItemFrame
                as="div"
                id={`${address}-group`}
                tabIndex={-1}
                className="min-w-0 space-y-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&_label]:max-w-full [&_label]:flex-wrap [&_label]:whitespace-normal [&_label]:[overflow-wrap:anywhere]"
              >
                <p className="text-sm text-muted-foreground">
                  <DefinitionMeaning values={definition?.descriptions} locale={locale} />
                </p>
                {supported ? (
                  <>
                    <Field className="min-w-0">
                      <FieldLabel className={labelClassName} htmlFor={`${address}-rank`}>
                        {m.candidate_rank({}, o)}
                      </FieldLabel>
                      <NativeSelect
                        id={`${address}-rank`}
                        className="w-full [&>select]:min-h-11"
                        value={fact.rank === 'preferred' ? 'preferred' : 'normal'}
                        {...feedback(`${address}-rank`)}
                        onChange={(event) => {
                          const admitted = () =>
                            isCurrent() &&
                            !locked &&
                            !scalarAdmission.current.locked &&
                            scalarAdmission.current.release === release &&
                            !running.current &&
                            !refreshRunning.current &&
                            !pending.current;
                          if (!admitted()) return;
                          const rank = event.target.value === 'preferred' ? 'preferred' : 'normal';
                          setFacts((previous) => {
                            if (!admitted() || !previous.includes(fact)) return previous;
                            return previous.map((row) => {
                              if (row !== fact) return row;
                              const next = { ...row, rank };
                              factIds.current.set(next, factId(row));
                              return next;
                            });
                          });
                        }}
                      >
                        <NativeSelectOption value="normal">{m.candidate_rank_normal({}, o)}</NativeSelectOption>
                        <NativeSelectOption value="preferred">{m.candidate_rank_preferred({}, o)}</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    <StatementFields
                      creation
                      localDraft
                      stablePartAddresses
                      draft={fact}
                      current={
                        {
                          release,
                          source: null,
                          public: { related: {}, subject: { type: characterType } },
                        } satisfies StatementFieldsRead
                      }
                      locale={locale}
                      feedback={{
                        id: address,
                        errors: displayedCorrections.filter(
                          (error): error is CharacterCorrection & { target: string } =>
                            !!error.target && (error.target === address || error.target.startsWith(`${address}-`)),
                        ),
                      }}
                      guideReturn={`/${locale}/catalogue/character`}
                      heading="h4"
                      partControl={
                        search
                          ? (part, change) =>
                              release.properties[part.property.id]?.datatype === 'wikibase-item' ? (
                                <CharacterItemValue
                                  id={address}
                                  address={`part-${statementHolderKey(part) ?? ''}`}
                                  part={part}
                                  release={release}
                                  locale={locale}
                                  search={search}
                                  disabled={locked}
                                  change={change}
                                />
                              ) : undefined
                          : undefined
                      }
                      reuse={{
                        disabled: locked,
                        onReuse: (index) => {
                          if (!isCurrent() || locked || pending.current) return;
                          const group = fact.references[index];
                          if (!group) return;
                          const source = {
                            holder: String(factId(fact)),
                            property: fact.property.id,
                            groupIndex: index,
                            snapshot: cloneReferenceGroup(group),
                          };
                          const drafts = characterCreateDrafts(
                            addressedFacts.filter((row) => available.includes(row.fact.property.id)),
                          );
                          setReuse({
                            source,
                            selected: [],
                            capture: captureReuse(source, drafts),
                            applied: [],
                            refused: [],
                            trigger:
                              document.activeElement instanceof HTMLButtonElement ? document.activeElement : null,
                          });
                        },
                      }}
                      focusReference={
                        focusCopy && String(factId(fact)) === focusCopy.holder
                          ? { index: focusCopy.index, nonce: focusCopy.nonce }
                          : undefined
                      }
                      change={(next) => {
                        const admitted = () =>
                          isCurrent() &&
                          !locked &&
                          !scalarAdmission.current.locked &&
                          scalarAdmission.current.release === release &&
                          !running.current &&
                          !refreshRunning.current &&
                          !pending.current;
                        if (!admitted()) return;
                        setFacts((previous) => {
                          if (!admitted() || !previous.includes(fact)) return previous;
                          return previous.map((row) => {
                            if (row !== fact) return row;
                            factIds.current.set(next, factId(row));
                            return next;
                          });
                        });
                      }}
                    />
                  </>
                ) : (
                  <>
                    <EditorFailure reason="stale" locale={locale} />
                    <details className="min-w-0 text-sm">
                      <summary className="min-h-11 cursor-pointer py-2">
                        {m.catalogue_creation_technical_details({}, o)}
                      </summary>
                      <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        <code>{JSON.stringify(fact, null, 2)}</code>
                      </pre>
                    </details>
                  </>
                )}
                <DraftRemoval
                  locale={locale}
                  label={m.recipe_remove_field({}, o)}
                  description={`${m.recipe_remove_field({}, o)} · ${m.character_create_correction_fact({ number: index + 1 }, o)} · ${name.text || m.candidate_value_unavailable({}, o)}`}
                  disabled={locked}
                  onRemove={() => {
                    if (!isCurrent() || locked || running.current || pending.current) return;
                    focusAfterChange.current = facts[index + 1]
                      ? `${characterFactId(termsId, factId(facts[index + 1]!))}-group`
                      : `${termsId}-initial-field`;
                    const removed = factId(fact);
                    setFacts((previous) => previous.filter((row) => factId(row) !== removed));
                  }}
                />
              </ContentItemFrame>
            </fieldset>
          );
        })}
      </fieldset>
      {failure && (
        <ContentItemFrame
          as="div"
          role="alert"
          data-slot="character-create-recovery"
          className="min-w-0 space-y-2 py-3 sm:py-4"
        >
          <EditorFailure reason={failure.reason === 'conflict' ? 'stale' : failure.reason} locale={locale} />
          {failure.reason === 'unavailable' && <p>{m.catalogue_create_uncertain({}, o)}</p>}
          {failure.reason === 'conflict' && <p>{m.catalogue_create_conflict({}, o)}</p>}
          {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, o)}</p>}
          {refreshFailed && (
            <>
              <p>{m.correction_unavailable({}, o)}</p>
              <Button
                type="button"
                variant="outline"
                className={actionClassName}
                disabled={locked}
                onClick={() => void refreshDefinitions()}
              >
                {m.correction_reload({}, o)}
              </Button>
            </>
          )}
          {failure.reason === 'invalid' && displayedCorrections.length === 0 && (
            <p>{m.character_create_correction_fallback({}, o)}</p>
          )}
          {displayedCorrections.length > 0 && (
            <section aria-label={m.character_create_correction_summary({}, o)} className="min-w-0 space-y-2">
              <h2 className="font-semibold">{m.character_create_correction_summary({}, o)}</h2>
              <ul className="list-disc space-y-3 ps-5 text-sm">
                {displayedCorrections.map((error) => (
                  <li key={error.id} id={error.id}>
                    {error.target ? (
                      <a
                        className="inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        href={`#${encodeURIComponent(error.target)}`}
                        onClick={(event) => {
                          event.preventDefault();
                          if (!isCurrent()) return;
                          const control = event.currentTarget.ownerDocument.getElementById(error.target!);
                          control?.focus();
                          control?.scrollIntoView?.({ block: 'center' });
                        }}
                      >
                        {error.label}
                      </a>
                    ) : (
                      <p className="font-medium">{error.label}</p>
                    )}
                    <p>{error.instruction}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!failure.errors?.length && (
            <details className="min-w-0 text-sm">
              <summary className="min-h-11 cursor-pointer py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                {m.catalogue_creation_technical_details({}, o)}
              </summary>
              <pre
                tabIndex={0}
                className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <code className="select-all">{JSON.stringify(failure.errors, null, 2)}</code>
              </pre>
            </details>
          )}
          {failure.reason === 'conflict' && (
            <Button
              className={actionClassName}
              type="button"
              onClick={() => {
                pending.current = null;
                setFailure(undefined);
              }}
            >
              {m.catalogue_create_review_new({}, o)}
            </Button>
          )}
        </ContentItemFrame>
      )}
      {review.status !== 'closed' && (
        <CharacterCreateReview
          item={characterDraft(release, terms, facts).item}
          facts={addressedFacts}
          release={release}
          locale={locale}
          stale={review.status === 'stale' || review.fingerprint !== fingerprint}
          onJumpTerm={(language) => {
            const term = terms.find((row) => row.language.trim() === language);
            if (!term || !isCurrent()) return;
            form.current?.ownerDocument.getElementById(`${termsId}-language-${term.id}`)?.focus();
          }}
          onJumpFact={(id) => {
            if (!isCurrent()) return;
            form.current?.ownerDocument.getElementById(`${characterFactId(termsId, id)}-group`)?.focus();
          }}
          onBack={() => {
            if (isCurrent() && !pending.current) setReview({ status: 'closed' });
          }}
        />
      )}
      {reuse && (
        <ReferenceReusePanel
          source={reuse.source}
          drafts={characterCreateDrafts(addressedFacts.filter((row) => available.includes(row.fact.property.id)))}
          selected={reuse.selected}
          read={{ release, public: { related: {} } }}
          locale={locale}
          capture={reuse.capture}
          applied={reuse.applied}
          refused={reuse.refused}
          onSelected={(selected) => isCurrent() && setReuse({ ...reuse, selected, applied: [], refused: [] })}
          onRefresh={() => {
            if (!isCurrent()) return;
            const origin = facts.find((row) => String(factId(row)) === reuse.source.holder);
            const group = origin?.references[reuse.source.groupIndex];
            if (!origin || !group) return;
            const source = { ...reuse.source, snapshot: cloneReferenceGroup(group) };
            const drafts = characterCreateDrafts(
              addressedFacts.filter((row) => available.includes(row.fact.property.id)),
            );
            setReuse({
              ...reuse,
              source,
              capture: captureReuse(source, drafts),
              applied: [],
              refused: [],
            });
          }}
          onApply={() => {
            if (!isCurrent() || locked || pending.current) return;
            const drafts = characterCreateDrafts(
              addressedFacts.filter((row) => available.includes(row.fact.property.id)),
            );
            const result = applyReuse(drafts, reuse.source, reuse.selected, release);
            const nextByHolder = new Map(result.drafts.map((draft) => [draft.holder, draft.statement]));
            setFacts(
              facts.map((row) => {
                const id = factId(row);
                const replacement = nextByHolder.get(String(id));
                if (!replacement || replacement === row) return row;
                factIds.current.set(replacement, id);
                return replacement;
              }),
            );
            setReuse({ ...reuse, applied: result.applied, refused: result.refused });
            const first = result.applied[0];
            if (first) setFocusCopy({ holder: first.holder, index: first.index, nonce: Date.now() });
          }}
          onCancel={() => {
            const trigger = reuse.trigger;
            setReuse(null);
            if (isCurrent() && trigger?.isConnected) trigger.focus();
          }}
          onOpen={(holder, index) => isCurrent() && setFocusCopy({ holder, index, nonce: Date.now() })}
        />
      )}
      <Button
        className={actionClassName}
        type="submit"
        disabled={busy || refreshing || failure?.reason === 'conflict' || (definitionsRequired && !pending.current)}
      >
        {busy
          ? m.catalogue_create_saving({}, o)
          : pending.current
            ? m.correction_retry({}, o)
            : review.status === 'current' && review.fingerprint === fingerprint
              ? m.character_create({}, o)
              : m.character_create_review({}, o)}
      </Button>
    </form>
  );
}
