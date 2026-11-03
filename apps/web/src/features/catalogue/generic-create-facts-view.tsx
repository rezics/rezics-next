import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { EntityPicker } from '@rezics/ui/entity-picker';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useLayoutEffect, useRef, useState } from 'react';
import { coverSrc } from '../../media/cover-src';
import { quantityUnitLabel } from '../../subject/quantity-presentation';
import { m } from '../../paraglide/messages.js';
import { relationTargetSearch } from './relation-editor-search';
import { pageText } from '../pages/data';
import { presentStatementViolations } from './statement-validation-presentation';
import { PartValue, StatementFields, type StatementFieldsRead } from './statement-editor-view';
import {
  applyReuse,
  captureReuse,
  cloneReferenceGroup,
  reuseTargetLimit,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { ReferenceReusePanel } from './reference-reuse-view';
import { factHolder, type FactDraft } from './subject-facts';
import type { StatementInput, SnakInput } from './statement-editor';
import {
  canAddGenericFact,
  genericCreateDescriptor,
  genericCreateFact,
  genericCreateFactDefinitions,
  genericCreatePropertySupported,
  genericCreateRead,
  genericCreateSpecializedPath,
  genericCreateStatementEntered,
  genericCreateTargetIds,
  type GenericCreateDescriptor,
  type GenericCreateFact,
} from './generic-create-facts';
import type { InitialSubject } from './create-subject';
import type { Violation } from '@rezics/definitions/validate';

const wrap = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2';

function asFactDraft(
  fact: GenericCreateFact,
  descriptor: GenericCreateDescriptor | undefined,
  descriptorIssue: string | null,
): FactDraft {
  const definition = descriptor?.propertyDefinitions[fact.property];
  return {
    holder: fact.holder,
    property: fact.property,
    source: null,
    baseline: null,
    statement: fact.statement,
    included: true,
    locked:
      !!descriptorIssue ||
      !descriptor?.definition.properties.includes(fact.property) ||
      !genericCreatePropertySupported(definition),
  };
}

function valueTarget(value: unknown, targets: EntityPickerSubject[]) {
  return typeof value === 'string' ? targets.find((target) => target.id === value) : undefined;
}

function ItemTargetControl({
  part,
  definition,
  targets,
  locale,
  disabled,
  onChange,
  onTargetChange,
}: {
  part: SnakInput;
  definition: PropertyDefinition;
  targets: EntityPickerSubject[];
  locale: string;
  disabled: boolean;
  onChange: (value: SnakInput['value']) => void;
  onTargetChange: (previousId: string | undefined, selected: EntityPickerSubject | undefined, part: SnakInput) => void;
}) {
  const o = { locale: locale as never };
  const label = m.relation_target({}, o);
  const selected = part.value.type === 'value' ? valueTarget(part.value.content, targets) : undefined;
  const setValue = (value: SnakInput['value'], item?: EntityPickerSubject) => {
    const previousId =
      part.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : undefined;
    onTargetChange(previousId, item, part);
    onChange(value);
  };
  return (
    <div className="min-w-0 space-y-3">
      <Field className="min-w-0">
        <FieldLabel>{m.correction_value_state({}, o)}</FieldLabel>
        <NativeSelect
          aria-label={m.correction_value_state({}, o)}
          value={part.value.type}
          disabled={disabled}
          onChange={(event) => {
            const state = event.target.value;
            if (state === 'somevalue' || state === 'novalue') setValue({ type: state });
            else setValue({ type: 'value', content: selected?.id ?? '' }, selected);
          }}
        >
          <NativeSelectOption value="value">{m.correction_known({}, o)}</NativeSelectOption>
          <NativeSelectOption value="somevalue">{m.subject_value_unknown({}, o)}</NativeSelectOption>
          <NativeSelectOption value="novalue">{m.subject_value_none({}, o)}</NativeSelectOption>
        </NativeSelect>
      </Field>
      {part.value.type === 'value' && (
        <Field className="min-w-0">
          <FieldLabel>{label}</FieldLabel>
          <EntityPicker
            label={label}
            src={coverSrc}
            disabled={disabled}
            value={selected ? [selected] : []}
            search={async (text, signal) =>
              (await relationTargetSearch(text, signal, locale)).filter((item) =>
                item.types.some((type) => definition.targets?.includes(type)),
              )
            }
            onValueChange={(items) => {
              const item = items[0];
              if (item && item.types.some((type) => definition.targets?.includes(type)))
                setValue({ type: 'value', content: item.id }, item);
              else if (!item) setValue({ type: 'somevalue' });
            }}
          />
        </Field>
      )}
    </div>
  );
}

function RemoveFact({
  fact,
  disabled,
  locale,
  onRemove,
}: {
  fact: GenericCreateFact;
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const options = { locale: locale as never };
  const holder = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  const remove = () => {
    const row = holder.current?.closest('fieldset');
    if (!row) return;
    const controls = [
      ...(row.parentElement?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex="0"], [role="combobox"]',
      ) ?? []),
    ];
    const first = controls.findIndex((control) => row.contains(control));
    const last = controls.findLastIndex((control) => row.contains(control));
    [...controls.slice(last + 1), ...controls.slice(0, first).reverse()]
      .find(
        (control) =>
          !control.matches(':disabled, [aria-disabled="true"], [type="hidden"]') &&
          !control.closest('[hidden], [inert]'),
      )
      ?.focus();
    onRemove();
  };
  return (
    <div ref={holder} className="flex flex-wrap gap-2">
      {confirming ? (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action: m.people_profile_remove_fact({}, options) }, options)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setConfirming(false);
          }}
        >
          <p>{m.candidate_confirm_title({ action: m.people_profile_remove_fact({}, options) }, options)}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={cancel} type="button" variant="outline" className={wrap} onClick={() => setConfirming(false)}>
              {m.candidate_cancel({}, options)}
            </Button>
            <Button type="button" variant="destructive" className={wrap} onClick={remove}>
              {m.people_profile_remove_fact({}, options)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className={wrap}
          disabled={disabled}
          onClick={() => (genericCreateStatementEntered(fact.statement) ? setConfirming(true) : remove())}
        >
          {m.people_profile_remove_fact({}, options)}
        </Button>
      )}
    </div>
  );
}

function statementValue(part: SnakInput, read: StatementFieldsRead, locale: string, targets: EntityPickerSubject[]) {
  const definition = read.release.properties[part.property.id];
  if (definition?.datatype === 'wikibase-item' && part.value.type === 'value') {
    const item = valueTarget(part.value.content, targets);
    if (item)
      return (
        <span className="break-all">
          {item.title} <code>{item.id}</code>
        </span>
      );
  }
  if (
    definition?.datatype === 'quantity' &&
    part.value.type === 'value' &&
    part.value.content &&
    typeof part.value.content === 'object' &&
    'unit' in part.value.content &&
    typeof part.value.content.unit === 'string'
  )
    return (
      <span className="break-all">
        <PartValue part={part} read={read} locale={locale} /> <code>{part.value.content.unit}</code>
      </span>
    );
  return <PartValue part={part} read={read} locale={locale} />;
}

function StatementReview({
  statement,
  read,
  locale,
  targets,
}: {
  statement: StatementInput;
  read: StatementFieldsRead;
  locale: string;
  targets: EntityPickerSubject[];
}) {
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-3">
      <p>{statementValue(statement, read, locale, targets)}</p>
      <p className="text-sm">
        {m.candidate_rank({}, o)}: {m.candidate_rank_normal({}, o)}
      </p>
      {!!statement.qualifiers?.length && (
        <dl className="min-w-0 space-y-2 text-sm">
          {statement.qualifiers.map((part, index) => (
            <div key={index} className="min-w-0">
              <dt className="text-muted-foreground">
                {pageText(read.release.properties[part.property.id]?.labels, locale).text || part.property.id}
              </dt>
              <dd>{statementValue(part, read, locale, targets)}</dd>
            </div>
          ))}
        </dl>
      )}
      {!!statement.references.length && (
        <ol className="min-w-0 space-y-3">
          {statement.references.map((reference, index) => (
            <li key={index} className="min-w-0 border-s-2 border-border ps-3 text-sm">
              <p className="mb-1 text-muted-foreground">
                {m.correction_references({}, o)} {index + 1}
              </p>
              <ul className="space-y-1">
                {reference.parts.map((part, partIndex) => (
                  <li key={partIndex}>{statementValue(part, read, locale, targets)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function GenericCreateReview({
  item,
  descriptor,
  facts,
  factTargets,
  locale,
  stale,
  onJump,
}: {
  item: InitialSubject;
  descriptor: GenericCreateDescriptor;
  facts: GenericCreateFact[];
  factTargets: Record<string, string>;
  locale: string;
  stale: boolean;
  onJump: (id: string) => void;
}) {
  const options = { locale: locale as never };
  const properties = descriptor.propertyDefinitions;
  const includedHolders = new Set(
    Object.entries(factTargets).flatMap(([pointer, holder]) => {
      const match = /^\/statements\/((?:[^~]|~[01])+)\/(0|[1-9]\d*)$/.exec(pointer);
      if (!match) return [];
      const property = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
      return item.statements?.[property]?.[Number(match[2])] ? [holder] : [];
    }),
  );
  const omitted = facts.filter(
    (fact) =>
      genericCreateStatementEntered(fact.statement) &&
      !includedHolders.has(`generic-fact-${fact.holder}`) &&
      !genericCreatePropertySupported(descriptor.propertyDefinitions[fact.property]),
  );
  const read: StatementFieldsRead = {
    release: genericCreateRead(descriptor),
    source: null,
    public: { related: {}, subject: { type: item.type } },
  };
  const languages = [
    ...new Set([
      ...Object.keys(item.labels),
      ...Object.keys(item.descriptions ?? {}),
      ...Object.keys(item.aliases ?? {}),
    ]),
  ];
  const reviewTargets = (holder: string) => facts.find((fact) => fact.holder === holder)?.targets ?? [];
  return (
    <section
      data-generic-create-review
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={m.catalogue_create_review_title({}, options)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.catalogue_create_review_title({}, options)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.people_profile_review_intro({}, options)}</p>
      {stale && <p role="status">{m.catalogue_create_review_stale({}, options)}</p>}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{m.catalogue_create_type({}, options)}</h3>
        <p lang={descriptor.labelLanguage ?? undefined}>{descriptor.label || item.type}</p>
        <p>
          <code className="break-all">{item.type}</code>
        </p>
        <Button type="button" variant="outline" className={wrap} onClick={() => onJump('create-type')}>
          {m.people_profile_review_open({}, options)}
        </Button>
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.catalogue_create_terms({}, options)}</h3>
        {languages.map((language, index) => (
          <ContentItemFrame key={language} as="div" className="min-w-0 space-y-1 rounded-xl bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground">{language}</p>
            {item.labels[language] && (
              <p lang={language} className="font-medium">
                {item.labels[language]}
              </p>
            )}
            {item.descriptions?.[language] && <p lang={language}>{item.descriptions[language]}</p>}
            {!!item.aliases?.[language]?.length && <p lang={language}>{item.aliases[language]!.join(' · ')}</p>}
            <Button type="button" variant="outline" className={wrap} onClick={() => onJump(`create-label-${index}`)}>
              {m.people_profile_review_open({}, options)}
            </Button>
          </ContentItemFrame>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.people_profile_initial({}, options)}</h3>
        {Object.entries(item.statements ?? {}).map(([property, statements]) => {
          const label = pageText(properties[property]?.labels, locale);
          return (
            <ContentItemFrame key={property} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang ?? undefined}>
                {label.text || property}
              </ContentItemHeading>
              {statements.map((statement, index) => {
                const prefix = `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}/${index}`;
                const targetId = factTargets[prefix];
                const holder = targetId?.slice('generic-fact-'.length) ?? '';
                return (
                  <div key={targetId || index} className="min-w-0 space-y-2">
                    <StatementReview
                      statement={statement}
                      read={read}
                      locale={locale}
                      targets={reviewTargets(holder)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className={wrap}
                      onClick={() => onJump(targetId || `generic-fact-${holder}`)}
                    >
                      {m.people_profile_review_open({}, options)}
                    </Button>
                  </div>
                );
              })}
            </ContentItemFrame>
          );
        })}
        {!Object.keys(item.statements ?? {}).length && <p>{m.catalogue_create_review_terms_only({}, options)}</p>}
      </div>
      {!!omitted.length && (
        <div role="status" className="min-w-0 space-y-2 rounded-lg border border-border p-3">
          {omitted.map((fact) => (
            <p key={fact.holder} className="break-words">
              {pageText(properties[fact.property]?.labels, locale).text || fact.property}: {fact.property}.{' '}
              {m.catalogue_create_fact_unsupported({}, options)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

export function GenericCreateFactsWorkspace({
  type,
  descriptor: typeDescriptor,
  facts,
  onChange,
  disabled,
  canEdit,
  locale,
  errors,
  factTargets,
  onInvalidate,
  descriptorIssue,
  specializedPath,
}: {
  type: string;
  descriptor: ReturnType<typeof genericCreateDescriptor> | undefined;
  facts: GenericCreateFact[];
  onChange: (update: (facts: GenericCreateFact[]) => GenericCreateFact[]) => void;
  disabled: boolean;
  canEdit: () => boolean;
  locale: string;
  errors: Violation[];
  factTargets: Record<string, string>;
  onInvalidate: () => void;
  descriptorIssue: 'missing' | 'unavailable' | 'unadmitted' | null;
  specializedPath?: string | undefined;
}) {
  const options = { locale: locale as never };
  const descriptor = genericCreateDescriptor(typeDescriptor);
  const read: StatementFieldsRead | undefined = descriptor
    ? { release: genericCreateRead(descriptor), source: null, public: { related: {}, subject: { type } } }
    : undefined;
  const [choice, setChoice] = useState('');
  const [reuse, setReuse] = useState<
    | {
        source: ReuseSource;
        selected: string[];
        capture: ReturnType<typeof captureReuse>;
        applied: { holder: string; property: string; index: number }[];
        refused: { holder: string; property: string; reason: ReuseRefusal }[];
      }
    | undefined
  >();
  const [focusCopy, setFocusCopy] = useState<{ holder: string; index: number; nonce: number }>();
  const factsForReuse = () => facts.map((fact) => asFactDraft(fact, descriptor, descriptorIssue));
  const update = (holder: string, statement: StatementInput, targets?: EntityPickerSubject[]) => {
    if (!canEdit()) return;
    const currentDescriptor = descriptor;
    onChange((current) =>
      current.map((fact) =>
        fact.holder === holder
          ? {
              ...fact,
              statement,
              definitions: currentDescriptor
                ? genericCreateFactDefinitions(statement, currentDescriptor, fact.definitions)
                : fact.definitions,
              ...(targets ? { targets } : {}),
            }
          : fact,
      ),
    );
    onInvalidate();
  };
  const updateTarget = (
    holder: string,
    previousId: string | undefined,
    selected: EntityPickerSubject | undefined,
    part: SnakInput,
  ) => {
    if (!canEdit()) return;
    onChange((current) =>
      current.map((fact) => {
        if (fact.holder !== holder) return fact;
        const remaining = genericCreateTargetIds(fact.statement, part);
        const targets = fact.targets.filter((target) => target.id !== previousId || remaining.has(previousId ?? ''));
        if (selected && !targets.some((target) => target.id === selected.id)) targets.push(selected);
        return { ...fact, targets };
      }),
    );
  };
  const beginReuse = (fact: GenericCreateFact, index: number) => {
    if (!canEdit()) return;
    const group = fact.statement.references[index];
    if (!group) return;
    const source: ReuseSource = {
      holder: fact.holder,
      property: fact.property,
      groupIndex: index,
      snapshot: cloneReferenceGroup(group),
    };
    setReuse({ source, selected: [], capture: captureReuse(source, factsForReuse()), applied: [], refused: [] });
  };
  const applyReferenceReuse = () => {
    if (!reuse || !descriptor || !canEdit()) return;
    const current = factsForReuse();
    const result = applyReuse(current, reuse.source, reuse.selected.slice(0, reuseTargetLimit), read!.release);
    const next = facts.map((fact) => {
      const draft = result.drafts.find((item) => factHolder(item) === fact.holder);
      return draft
        ? {
            ...fact,
            statement: draft.statement,
            definitions: genericCreateFactDefinitions(draft.statement, descriptor, fact.definitions),
          }
        : fact;
    });
    onChange(() => next);
    onInvalidate();
    setReuse({
      ...reuse,
      selected: [],
      capture: captureReuse(reuse.source, result.drafts),
      applied: result.applied,
      refused: result.refused,
    });
  };
  const focusFact = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    (target.matches('input,select,textarea,button,[role="combobox"]')
      ? target
      : target.querySelector<HTMLElement>(
          'input:not([disabled]),select:not([disabled]),textarea,button:not([disabled])',
        )
    )?.focus();
  };
  const rowErrors = (fact: GenericCreateFact) => {
    const targetId = `generic-fact-${fact.holder}`;
    const prefix = Object.entries(factTargets).find(([, id]) => id === targetId)?.[0];
    if (!prefix) return [];
    return errors
      .filter((error) => error.pointer === prefix || error.pointer.startsWith(`${prefix}/`))
      .map((error) => ({ ...error, pointer: error.pointer.replace(prefix, '/statement') }));
  };
  const remove = (holder: string) => {
    if (disabled) return;
    onChange((current) => current.filter((fact) => fact.holder !== holder));
    if (reuse?.source.holder === holder) setReuse(undefined);
    onInvalidate();
  };
  const usable = descriptor ? new Set(descriptor.definition.properties) : new Set<string>();
  const selectedProperty = descriptor?.propertyDefinitions[choice];

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="generic-create-facts-title">
      <ContentItemHeading id="generic-create-facts-title" level={2} className="text-lg font-semibold">
        {m.people_profile_initial({}, options)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.people_profile_initial_help({}, options)}</p>
      {descriptorIssue && (
        <p role="alert">
          {descriptorIssue === 'missing'
            ? m.catalogue_create_type_retired({}, options)
            : descriptorIssue === 'unadmitted'
              ? m.related_work_type_unadmitted({}, options)
              : m.catalogue_create_type_read_failed({}, options)}
        </p>
      )}
      {specializedPath ? (
        <div role="status" className="min-w-0 space-y-3 rounded-lg border border-border p-4">
          <p>{m.catalogue_create_specialized_notice({}, options)}</p>
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={`/${locale}${specializedPath}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {m.catalogue_create_specialized_open({}, options)}
          </a>
        </div>
      ) : descriptor && read ? (
        <>
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <Field className="min-w-0 flex-1 basis-full sm:basis-64">
              <FieldLabel htmlFor="generic-create-property">{m.correction_add({}, options)}</FieldLabel>
              <NativeSelect
                id="generic-create-property"
                value={choice}
                disabled={disabled || !!descriptorIssue || !canEdit()}
                onChange={(event) => setChoice(event.target.value)}
              >
                <NativeSelectOption value="">{m.correction_choose({}, options)}</NativeSelectOption>
                {descriptor.definition.properties.map((property) => {
                  const definition = descriptor.propertyDefinitions[property];
                  const label = pageText(definition?.labels, locale).text || property;
                  const canAdd = canAddGenericFact(facts, definition);
                  return (
                    <NativeSelectOption key={property} value={property} disabled={!canAdd}>
                      {label}
                    </NativeSelectOption>
                  );
                })}
              </NativeSelect>
            </Field>
            <Button
              type="button"
              variant="outline"
              className={wrap}
              disabled={
                disabled || !!descriptorIssue || !canEdit() || !choice || !canAddGenericFact(facts, selectedProperty)
              }
              onClick={() => {
                if (!canEdit() || !descriptor || !selectedProperty) return;
                const fact = genericCreateFact(descriptor, choice);
                if (!fact) return;
                onChange((current) => [...current, fact]);
                setChoice('');
                onInvalidate();
              }}
            >
              {m.people_profile_add_fact(
                { field: pageText(selectedProperty?.labels, locale).text || choice || m.correction_value({}, options) },
                options,
              )}
            </Button>
          </div>
          {facts.map((fact) => {
            const admitted = usable.has(fact.property) && !!descriptor.propertyDefinitions[fact.property];
            const definition = admitted ? descriptor.propertyDefinitions[fact.property] : fact.definition;
            const supported = admitted && genericCreatePropertySupported(definition);
            const targetId = `generic-fact-${fact.holder}`;
            const localErrors = rowErrors(fact);
            const feedback =
              supported && localErrors.length
                ? {
                    id: targetId,
                    errors: presentStatementViolations(localErrors, fact.statement, read.release, locale, targetId),
                  }
                : undefined;
            const displayRead: StatementFieldsRead = {
              ...read,
              release: {
                ...read.release,
                properties: {
                  ...read.release.properties,
                  ...Object.fromEntries(
                    Object.entries(fact.definitions).filter(([id]) => !Object.hasOwn(read.release.properties, id)),
                  ),
                },
              },
            };
            const prefix = Object.entries(factTargets).find(([, id]) => id === targetId)?.[0];
            const targetFeedback = localErrors.length ? localErrors.map((error) => error.pointer) : [];
            return (
              <fieldset
                id={targetId}
                key={fact.holder}
                disabled={disabled}
                className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5"
                aria-invalid={!!targetFeedback.length || undefined}
              >
                <legend
                  className="max-w-full px-1 text-sm font-semibold [overflow-wrap:anywhere]"
                  lang={pageText(definition?.labels, locale).lang ?? undefined}
                >
                  {pageText(definition?.labels, locale).text || fact.property}
                </legend>
                {!admitted ? (
                  <div role="alert" className="space-y-2">
                    <p>{m.catalogue_create_fact_withdrawn({}, options)}</p>
                    <p className="break-all text-sm">
                      <code>{fact.property}</code>
                    </p>
                    <div className="min-w-0 space-y-2">
                      <p>{m.correction_preserved({}, options)}</p>
                      <PartValue part={fact.statement} read={displayRead} locale={locale} />
                    </div>
                  </div>
                ) : !supported ? (
                  <div role="status" className="space-y-2">
                    <p>{m.catalogue_create_fact_unsupported({}, options)}</p>
                    <PartValue part={fact.statement} read={displayRead} locale={locale} />
                  </div>
                ) : (
                  <fieldset disabled={disabled || !!descriptorIssue || !canEdit()} className="contents">
                    <StatementFields
                      draft={fact.statement}
                      current={read}
                      locale={locale}
                      creation
                      localDraft
                      stablePartAddresses
                      feedback={feedback}
                      unitLabel={(id) => quantityUnitLabel(id, read.public.related, locale) ?? id}
                      change={(statement) => update(fact.holder, statement)}
                      valueControl={
                        definition?.datatype === 'wikibase-item' && definition.targets?.length ? (
                          <ItemTargetControl
                            part={fact.statement}
                            definition={definition}
                            targets={fact.targets}
                            locale={locale}
                            disabled={disabled || !!descriptorIssue || !canEdit()}
                            onChange={(value) => update(fact.holder, { ...fact.statement, value })}
                            onTargetChange={(previousId, selected, part) =>
                              updateTarget(fact.holder, previousId, selected, part)
                            }
                          />
                        ) : undefined
                      }
                      partControl={(part, change) => {
                        const partDefinition = descriptor.propertyDefinitions[part.property.id];
                        if (partDefinition?.datatype !== 'wikibase-item' || !partDefinition.targets?.length)
                          return undefined;
                        return (
                          <ItemTargetControl
                            part={part}
                            definition={partDefinition}
                            targets={fact.targets}
                            locale={locale}
                            disabled={disabled || !!descriptorIssue || !canEdit()}
                            onChange={change}
                            onTargetChange={(previousId, selected, targetPart) =>
                              updateTarget(fact.holder, previousId, selected, targetPart)
                            }
                          />
                        );
                      }}
                      reuse={
                        facts.length > 1
                          ? { disabled: disabled || !canEdit(), onReuse: (index) => beginReuse(fact, index) }
                          : undefined
                      }
                      focusReference={
                        focusCopy?.holder === fact.holder
                          ? { index: focusCopy.index, nonce: focusCopy.nonce }
                          : undefined
                      }
                    />
                  </fieldset>
                )}
                {prefix && localErrors.length > 0 && (
                  <details className="min-w-0 text-sm">
                    <summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {m.catalogue_creation_technical_details({}, options)}
                    </summary>
                    <ul className="list-disc break-all ps-5">
                      {localErrors.map((error, index) => (
                        <li key={index}>
                          <code>{error.pointer}</code> · {error.code}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <RemoveFact fact={fact} disabled={disabled} locale={locale} onRemove={() => remove(fact.holder)} />
              </fieldset>
            );
          })}
          {reuse && (
            <ReferenceReusePanel
              source={reuse.source}
              drafts={factsForReuse()}
              selected={reuse.selected}
              read={{ release: read.release, public: { related: read.public.related } }}
              locale={locale}
              capture={reuse.capture}
              applied={reuse.applied}
              refused={reuse.refused}
              onSelected={(selected) => setReuse((current) => (current ? { ...current, selected } : current))}
              onApply={applyReferenceReuse}
              onCancel={() => setReuse(undefined)}
              onRefresh={() =>
                setReuse((current) =>
                  current ? { ...current, capture: captureReuse(current.source, factsForReuse()) } : current,
                )
              }
              onOpen={(holder, index) =>
                setFocusCopy((current) => ({ holder, index, nonce: (current?.nonce ?? 0) + 1 }))
              }
            />
          )}
        </>
      ) : (
        <p role="alert">{m.catalogue_create_type_read_failed({}, options)}</p>
      )}
    </section>
  );
}

export function genericCreateFactPointers(
  errors: Violation[],
  factTargets: Record<string, string>,
): Record<string, string> {
  const targets: Record<string, string> = Object.create(null);
  for (const error of errors) {
    const match = Object.entries(factTargets).find(
      ([prefix]) => error.pointer === prefix || error.pointer.startsWith(`${prefix}/`),
    );
    if (match) targets[error.pointer] = match[1];
  }
  return targets;
}
