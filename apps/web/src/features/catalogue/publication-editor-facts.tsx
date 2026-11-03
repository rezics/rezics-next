import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { DefinitionMeaning } from './definition-meaning';
import { emptyCreationStatement, type SnakInput, type StatementInput } from './statement-editor';
import {
  controlId,
  StatementFields,
  statementHolderKey,
  type StatementFieldsRead,
} from './statement-editor-view';
import {
  publicationFactId,
  publicationWorkId,
  type PublicationCorrection,
  type PublicationFactRow,
} from './publication-editor-guidance';
import { publicationTarget, type PublicationProfile } from './publication-editor';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const selectClassName = 'w-full min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
const labelClassName = 'min-w-0 max-w-full flex-wrap [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center underline [overflow-wrap:anywhere] md:pointer-fine:min-h-8';

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return !!value.trim();
  if (value == null) return false;
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return true;
}

function ItemValue({
  id,
  address = 'fact',
  part,
  release,
  locale,
  search,
  picked,
  disabled,
  admit,
  change,
}: {
  id: string;
  address?: string;
  part: SnakInput;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  picked: Record<string, EntityPickerSubject>;
  disabled: boolean;
  admit: (type: string) => boolean;
  change: (value: SnakInput['value'], item?: EntityPickerSubject) => void;
}) {
  const content = part.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : '';
  const selected = content ? picked[content] : undefined;
  return (
    <div id={controlId(id, address, 'value')}>
      <EntityPicker
        label={pickText(release.properties[part.property.id]?.labels ?? {}, locale).text}
        disabled={disabled}
        value={
          selected && selected.id === content
            ? [selected]
            : content
              ? [
                  {
                    id: content,
                    title: m.subject_value_unlabelled({}, { locale: locale as never }),
                    types: [],
                    typeLabel: '',
                    cover: null,
                  },
                ]
              : []
        }
        src={coverSrc}
        search={async (text, signal) => (await search(text, signal)).filter((item) => item.types.some(admit))}
        onValueChange={(items) => change({ type: 'value', content: items[0]?.id ?? '' }, items[0])}
      />
    </div>
  );
}

function FactRemoval({
  rowKey,
  populated,
  disabled,
  locale,
  onRemove,
}: {
  rowKey: string;
  populated: boolean;
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const o = { locale: locale as never };
  const [confirming, setConfirming] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const current = useRef({ rowKey, disabled, onRemove });
  current.current = { rowKey, disabled, onRemove };
  useLayoutEffect(() => {
    if (disabled) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  function cancelRemoval() {
    restoreFocus.current = true;
    setConfirming(false);
  }
  function remove() {
    const section = holder.current?.closest('fieldset');
    if (current.current.disabled || current.current.rowKey !== rowKey || !section?.isConnected) return;
    const controls = [
      ...(section.closest('form')?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]') ??
        []),
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
  }
  return (
    <div ref={holder}>
      {confirming ? (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action: m.relation_remove({}, o) }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRemoval();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action: m.relation_remove({}, o) }, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={cancel} className={actionClassName} type="button" variant="outline" disabled={disabled} onClick={cancelRemoval}>
              {m.candidate_cancel({}, o)}
            </Button>
            <Button className={actionClassName} type="button" variant="destructive" disabled={disabled} onClick={remove}>
              {m.relation_remove({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={actionClassName}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => (populated ? setConfirming(true) : remove())}
        >
          {m.relation_remove({}, o)}
        </Button>
      )}
    </div>
  );
}

export function PublicationFacts({
  id,
  work,
  workTitle,
  relation,
  workLink,
  facts,
  profile,
  currentProfile,
  release,
  locale,
  search,
  picked,
  disabled,
  reviewDefinitions,
  guideReturn,
  onWorkChange,
  onFactsChange,
  onPicked,
  onFieldChoice,
  field,
  errors,
}: {
  id: string;
  work: string;
  workTitle: string;
  relation: string;
  workLink: StatementInput;
  facts: PublicationFactRow[];
  profile: PublicationProfile;
  currentProfile?: PublicationProfile;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  picked: Record<string, EntityPickerSubject>;
  disabled: boolean;
  reviewDefinitions: boolean;
  guideReturn: string;
  onWorkChange: (statement: StatementInput) => void;
  onFactsChange: (facts: PublicationFactRow[]) => void;
  onPicked: (id: string, item?: EntityPickerSubject) => void;
  onFieldChoice: (property: string) => void;
  field: string;
  errors: PublicationCorrection[];
}) {
  const sectionErrors = (sectionId: string) =>
    errors.flatMap((error) =>
      error.target && (error.target === sectionId || error.target.startsWith(`${sectionId}-`))
        ? [{ id: error.id, target: error.target, label: error.label, instruction: error.instruction }]
        : [],
    );
  const o = { locale: locale as never };
  const name = (property: string) => pickText(release.properties[property]?.labels ?? {}, locale).text;
  const context: StatementFieldsRead = {
    release,
    source: null,
    public: {
      related: {
        [work]: { labels: workTitle ? { [locale]: workTitle } : {}, type: '' },
        ...Object.fromEntries(
          Object.values(picked).map((item) => [item.id, { labels: { [locale]: item.title }, type: item.types[0] ?? '' }]),
        ),
      },
      subject: { type: profile.id },
    },
  };
  const pendingFocus = useRef<{ row: PublicationFactRow; trigger: HTMLButtonElement } | undefined>(undefined);
  useLayoutEffect(() => {
    const intent = pendingFocus.current;
    if (!intent) return;
    pendingFocus.current = undefined;
    if (!intent.trigger.isConnected || document.activeElement !== intent.trigger) return;
    const section = document.getElementById(publicationFactId(id, intent.row.key));
    const target = section?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, [role="combobox"]',
    );
    target?.focus();
  });
  const admit = (property: string, type: string) => publicationTarget(release, type, property);
  const itemControl = (sectionId: string, statement: StatementInput, change: (next: StatementInput) => void) =>
    release.properties[statement.property.id]?.datatype === 'wikibase-item' ||
    release.properties[statement.property.id]?.relation ? (
      <ItemValue
        id={sectionId}
        part={statement}
        release={release}
        locale={locale}
        search={search}
        picked={picked}
        disabled={disabled}
        admit={(type) => admit(statement.property.id, type)}
        change={(value, item) => {
          if (item) onPicked(item.id, item);
          else if (statement.value.type === 'value' && typeof statement.value.content === 'string')
            onPicked(statement.value.content);
          change({ ...statement, value });
        }}
      />
    ) : undefined;
  const partControl = (sectionId: string) =>
    (part: SnakInput, change: (value: SnakInput['value']) => void) =>
      release.properties[part.property.id]?.datatype === 'wikibase-item' ? (
        <ItemValue
          id={sectionId}
          address={`part-${statementHolderKey(part) ?? ''}`}
          part={part}
          release={release}
          locale={locale}
          search={search}
          picked={picked}
          disabled={disabled}
          admit={(type) => admit(part.property.id, type)}
          change={(value, item) => {
            if (item) onPicked(item.id, item);
            change(value);
          }}
        />
      ) : undefined;
  const unsupported = (property: string) => reviewDefinitions && !currentProfile?.fields.includes(property);
  const fields = (readFields: string[]) =>
    readFields.filter(
      (property) =>
        release.properties[property]?.multivalued || !facts.some((row) => row.statement.property.id === property),
    );
  const populated = (statement: StatementInput) =>
    statement.value.type !== 'value' ||
    hasContent(statement.value.content) ||
    !!statement.qualifiers?.some((part) => part.value.type !== 'value' || hasContent(part.value.content)) ||
    statement.references.some((reference) =>
      reference.parts.some((part) => part.value.type !== 'value' || hasContent(part.value.content)),
    );
  return (
    <>
      <ContentItemFrame as="div" className="min-w-0 p-4 sm:p-6">
        <FieldSet disabled={disabled} className="min-w-0 gap-3">
          <FieldLegend className="max-w-full">
            <ContentItemHeading className="text-xl font-semibold [overflow-wrap:anywhere]">
              {m.publication_work_link({}, o)}
            </ContentItemHeading>
          </FieldLegend>
          <p className="text-sm text-muted-foreground">{workTitle || m.subject_value_unlabelled({}, o)}</p>
          <p className="text-sm font-mono [overflow-wrap:anywhere]">{work}</p>
          <section
            id={publicationWorkId(id)}
            data-publication-property={relation}
            className="min-w-0 space-y-4 [overflow-wrap:anywhere]"
          >
            <StatementFields
              creation
              localDraft
              stablePartAddresses
              draft={workLink}
              current={context}
              locale={locale}
              feedback={{ id: publicationWorkId(id), errors: sectionErrors(publicationWorkId(id)) }}
              guideReturn={guideReturn}
              heading="h4"
              valueControl={
                <p id={controlId(publicationWorkId(id), 'fact', 'value')} className="text-sm">
                  {workTitle || m.subject_value_unlabelled({}, o)}
                  <span className="ms-2 font-mono text-muted-foreground">{work}</span>
                </p>
              }
              partControl={partControl(publicationWorkId(id))}
              change={(next) =>
                onWorkChange({
                  ...next,
                  property: { id: relation },
                  value: { type: 'value', content: work },
                  rank: 'normal',
                })
              }
            />
          </section>
        </FieldSet>
      </ContentItemFrame>
      {facts.map((row) => {
        const property = row.statement.property.id;
        const sectionId = publicationFactId(id, row.key);
        const withdrawn = unsupported(property);
        return (
          <ContentItemFrame as="div" key={row.key} className="min-w-0 p-4 sm:p-6">
            <FieldSet
              id={sectionId}
              data-publication-property={property}
              disabled={disabled}
              tabIndex={-1}
              className="min-w-0 gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <FieldLegend className="max-w-full">
                <ContentItemHeading level={3} className="text-base font-semibold [overflow-wrap:anywhere]">
                  {name(property) || m.correction_preserved({}, o)}
                </ContentItemHeading>
              </FieldLegend>
              <p className="text-sm text-muted-foreground">
                <DefinitionMeaning values={release.properties[property]?.descriptions} locale={locale} />
              </p>
              {withdrawn ? (
                <>
                  <FieldError>{m.publication_choice_review({}, o)}</FieldError>
                  <details>
                    <summary className={linkClassName}>{m.publication_staged_value({}, o)}</summary>
                    <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(row.statement, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <StatementFields
                  creation
                  localDraft
                  stablePartAddresses
                  draft={row.statement}
                  current={context}
                  locale={locale}
                  feedback={{ id: sectionId, errors: sectionErrors(sectionId) }}
                  guideReturn={guideReturn}
                  heading="h4"
                  valueControl={itemControl(sectionId, row.statement, (next) =>
                    onFactsChange(facts.map((entry) => (entry.key === row.key ? { ...entry, statement: next } : entry))),
                  )}
                  partControl={partControl(sectionId)}
                  change={(next) =>
                    onFactsChange(
                      facts.map((entry) => (entry.key === row.key ? { ...entry, statement: { ...next, rank: 'normal' } } : entry)),
                    )
                  }
                />
              )}
              <FactRemoval
                rowKey={row.key}
                locale={locale}
                populated={populated(row.statement)}
                disabled={disabled}
                onRemove={() => onFactsChange(facts.filter((entry) => entry.key !== row.key))}
              />
            </FieldSet>
          </ContentItemFrame>
        );
      })}
      <ContentItemFrame as="div" className="min-w-0 p-4 sm:p-6">
        <FieldSet disabled={disabled} className="min-w-0 flex-row flex-wrap items-end gap-3">
          <FieldLegend className="sr-only">{m.publication_field({}, o)}</FieldLegend>
          <Field className="min-w-0 basis-full sm:flex-1 sm:basis-64">
            <FieldLabel className={labelClassName} htmlFor={`${id}-field`}>
              {m.publication_field({}, o)}
            </FieldLabel>
            <NativeSelect className={selectClassName} id={`${id}-field`} value={field} onChange={(event) => onFieldChoice(event.target.value)}>
              <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
              {fields(currentProfile?.fields ?? profile.fields).map((property) => (
                <NativeSelectOption key={property} value={property}>
                  {name(property)}
                </NativeSelectOption>
              ))}
              {field && currentProfile && !currentProfile.fields.includes(field) && (
                <NativeSelectOption value={field} disabled>
                  {name(field) || field}
                </NativeSelectOption>
              )}
            </NativeSelect>
            {field && currentProfile && !currentProfile.fields.includes(field) && (
              <FieldError>{m.publication_choice_review({}, o)}</FieldError>
            )}
          </Field>
          <Button
            className={actionClassName}
            type="button"
            variant="outline"
            disabled={
              disabled ||
              !field ||
              !currentProfile?.fields.includes(field) ||
              (!release.properties[field]?.multivalued && facts.some((row) => row.statement.property.id === field))
            }
            onBlur={(event) => {
              if (pendingFocus.current?.trigger === event.currentTarget) pendingFocus.current = undefined;
            }}
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              if (
                !field ||
                !currentProfile?.fields.includes(field) ||
                (!release.properties[field]?.multivalued && facts.some((row) => row.statement.property.id === field))
              )
                return;
              const row: PublicationFactRow = { key: crypto.randomUUID(), statement: emptyCreationStatement(field, release) };
              if (event.detail === 0) pendingFocus.current = { row, trigger: event.currentTarget };
              onFactsChange([...facts, row]);
              onFieldChoice('');
            }}
          >
            {m.correction_add({}, o)}
          </Button>
        </FieldSet>
      </ContentItemFrame>
    </>
  );
}
