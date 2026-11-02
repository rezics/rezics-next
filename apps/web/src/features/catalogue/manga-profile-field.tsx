import { useId, useLayoutEffect, useRef, useState } from 'react';
import { hasDocumentContent } from '@rezics/document';
import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { RichTextEditor } from '@rezics/ui/rich-text-editor';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { editorLabels } from '../../threads/composer';
import { authoredFieldValue, newAuthoredField, type AuthoredField } from './authored-field';
import { ScalarControl } from './statement-editor-view';
import { editableScalar, type SnakInput, type StatementInput } from './statement-editor';
import { mangaTarget, type MangaType } from './manga-profile';
import type { StatementFeedback } from './statement-validation-presentation';
import type { MangaReady } from './manga-profile-view';

export type MangaRow = {
  id: string;
  statement: StatementInput;
  label?: ReturnType<typeof pickText>;
  original?: boolean;
  authored?: AuthoredField;
  targets?: Record<string, EntityPickerSubject[]>;
};
export function MangaInitialField({
  row,
  read,
  type,
  locale,
  search,
  disabled,
  onChange,
  onRemove,
  feedback,
}: {
  row: MangaRow;
  read: MangaReady;
  type: MangaType;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  onChange: (row: MangaRow) => void;
  onRemove: () => void;
  feedback: StatementFeedback;
}) {
  const o = { locale: locale as never };
  const property = read.release.properties[row.statement.property.id]!;
  const title = pickText(property.labels, locale);
  const invalid = (id: string) => ({
    'aria-invalid': feedback.errors.some((error) => error.target === id) || undefined,
    'aria-describedby':
      feedback.errors
        .filter((error) => error.target === id)
        .map((error) => error.id)
        .join(' ') || undefined,
  });
  const [qualifier, setQualifier] = useState('');
  const qualifierId = useId();
  const section = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [confirmingRow, setConfirmingRow] = useState<string | null>(null);
  const confirming = confirmingRow === row.id;
  // Late editor emissions and an already-open confirmation must obey the current lock.
  const current = useRef({ disabled, id: row.id });
  current.current = { disabled, id: row.id };
  const editable = () => !current.current.disabled && current.current.id === row.id;
  const change = (next: MangaRow) => {
    if (editable()) onChange(next);
  };
  useLayoutEffect(() => {
    if (disabled) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  const cancelRemoval = () => {
    restoreFocus.current = true;
    setConfirmingRow(null);
  };
  const remove = () => {
    if (!editable() || !section.current?.isConnected) return;
    const root = section.current;
    const controls = [...((root.closest('form') ?? root.parentElement)?.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex="0"], [contenteditable="true"]',
    ) ?? [])];
    const first = controls.findIndex((control) => root.contains(control));
    const last = controls.findLastIndex((control) => root.contains(control));
    const surviving = [...controls.slice(last + 1), ...controls.slice(0, first).reverse()];
    surviving.find((control) =>
      !control.matches(':disabled, [aria-disabled="true"]') && !control.closest('[hidden], [inert]'),
    )?.focus();
    onRemove();
  };
  const citationPart = row.statement.references?.[0]?.parts.find((part) => part.property.id === 'schema:url');
  const citation =
    citationPart?.value.type === 'value' && typeof citationPart.value.content === 'string'
      ? citationPart.value.content
      : '';
  const authored = row.authored ?? newAuthoredField();
  const hasValue = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return Object.values(value).some(hasValue);
    return true;
  };
  const populated =
    row.statement.value.type !== 'value' ||
    (property.datatype === 'document'
      ? hasDocumentContent(authored.document) || !!authored.language.trim() || !!authored.licence.trim()
      : hasValue(row.statement.value.content)) ||
    !!row.original ||
    !!row.statement.qualifiers?.length ||
    !!row.statement.references?.some((reference) => reference.parts.length) ||
    !!Object.values(row.targets ?? {}).some((targets) => targets.length);
  const update = (statement: StatementInput) => change({ ...row, statement });
  const updateAuthored = (next: AuthoredField) =>
    change({ ...row, authored: next, statement: { ...row.statement, value: authoredFieldValue(next) } });
  const name = (id: string) => pickText(read.release.properties[id]?.labels ?? {}, locale).text;
  const control = (part: SnakInput, address: string, statement: (value: SnakInput['value']) => StatementInput) => {
    const definition = read.release.properties[part.property.id];
    return definition?.datatype === 'wikibase-item' ? (
      <PickedTarget
        part={part}
        label={name(part.property.id)}
        read={read}
        search={search}
        disabled={disabled}
        picked={row.targets?.[part.property.id] ?? []}
        mangaWork={type === 'schema:PublicationVolume' && part.property.id === 'wdt:P179'}
        onChange={(value, items) =>
          change({ ...row, statement: statement(value), targets: { ...row.targets, [part.property.id]: items } })
        }
      />
    ) : (
      <ScalarControl
        part={part}
        definition={definition}
        read={{ release: read.release, public: { related: read.public?.related ?? {} } }}
        locale={locale}
        feedback={{ ...feedback, address }}
        onChange={(value) => update(statement(value))}
      />
    );
  };
  return (
    <section
      ref={section}
      id={`manga-row-${row.id}`}
      tabIndex={-1}
      aria-label={title.text}
      className="min-w-0 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <ContentItemFrame as="div" className="min-w-0 space-y-4 py-3 sm:py-4">
        <ContentItemHeading level={3} className="font-sans text-lg font-semibold" lang={title.lang ?? undefined}>
          {title.text}
        </ContentItemHeading>
        <fieldset
          id={`${feedback.id}-fields`}
          tabIndex={-1}
          disabled={disabled}
          data-content-item-slot="preview"
          className="min-w-0 space-y-4 [&_label]:whitespace-normal [&_label]:text-start"
        >
          <div
            id={`${feedback.id}-fact`}
            data-manga-picker={property.datatype === 'wikibase-item' ? '' : undefined}
            tabIndex={-1}
            className="min-w-0 space-y-4"
          >
            {property.datatype === 'document' ? (
              <>
                <p className="text-sm text-muted-foreground">{m.authored_citation_hint({}, o)}</p>
                <Field className="min-w-0">
                  <FieldLabel htmlFor={`language-${row.id}`}>{m.authored_language({}, o)}</FieldLabel>
                  <Input
                    id={`language-${row.id}`}
                    {...invalid(`language-${row.id}`)}
                    value={authored.language}
                    onChange={(event) =>
                      updateAuthored({
                        ...authored,
                        language: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field className="min-w-0">
                  <FieldLabel htmlFor={`licence-${row.id}`}>{m.authored_licence({}, o)}</FieldLabel>
                  <Input
                    id={`licence-${row.id}`}
                    {...invalid(`licence-${row.id}`)}
                    value={authored.licence}
                    onChange={(event) =>
                      updateAuthored({
                        ...authored,
                        licence: event.target.value,
                      })
                    }
                  />
                </Field>
                <RichTextEditor
                  label={title.text}
                  labels={editorLabels()}
                  lang={authored.language}
                  value={authored.document}
                  disabled={disabled}
                  onChange={(document) => updateAuthored({ ...authored, document })}
                />
                <Field orientation="horizontal">
                  <Checkbox
                    id={`original-${row.id}`}
                    {...invalid(`original-${row.id}`)}
                    checked={row.original ?? false}
                    onCheckedChange={(value) => change({ ...row, original: value === true })}
                  />
                  <FieldLabel htmlFor={`original-${row.id}`}>{m.authored_original({}, o)}</FieldLabel>
                </Field>
              </>
            ) : (
              control(row.statement, 'fact', (value) => ({
                ...row.statement,
                value,
              }))
            )}
          </div>
          <div id={`${feedback.id}-qualifiers`} tabIndex={-1} className="min-w-0 space-y-4">
            {(row.statement.qualifiers ?? []).map((part, index) => (
              <div
                key={index}
                id={`${feedback.id}-qualifier-${index}`}
                data-manga-picker={
                  read.release.properties[part.property.id]?.datatype === 'wikibase-item' ? '' : undefined
                }
                tabIndex={-1}
                className="min-w-0 space-y-2 border-s-2 ps-3"
              >
                <ContentItemHeading
                  level={4}
                  className="font-sans text-sm font-medium"
                  lang={pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).lang ?? undefined}
                >
                  {name(part.property.id)}
                </ContentItemHeading>
                {control(part, `qualifier-${index}`, (value) => ({
                  ...row.statement,
                  qualifiers: row.statement.qualifiers!.map((snak, at) => (at === index ? { ...snak, value } : snak)),
                }))}
              </div>
            ))}
          </div>
          {!!property.qualifiers.filter(
            (id) =>
              read.release.properties[id]?.datatype === 'wikibase-item' || editableScalar(read.release.properties[id]),
          ).length && (
            <div className="flex min-w-0 flex-wrap items-end gap-3">
              <Field className="min-w-0 basis-full sm:basis-48 sm:flex-1">
                <FieldLabel htmlFor={qualifierId}>{m.correction_add_qualifier({}, o)}</FieldLabel>
                <NativeSelect
                  id={qualifierId}
                  className="w-full min-w-0"
                  aria-label={m.correction_add_qualifier({}, o)}
                  value={qualifier}
                  onChange={(event) => {
                    if (editable()) setQualifier(event.target.value);
                  }}
                >
                  <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                  {property.qualifiers
                    .filter(
                      (id) =>
                        (read.release.properties[id]?.datatype === 'wikibase-item' ||
                          editableScalar(read.release.properties[id])) &&
                        !(row.statement.qualifiers ?? []).some((part) => part.property.id === id),
                    )
                    .map((id) => (
                      <NativeSelectOption
                        key={id}
                        value={id}
                        lang={pickText(read.release.properties[id]?.labels ?? {}, locale).lang ?? undefined}
                      >
                        {name(id)}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
              <Button
                className="h-auto min-h-11 max-w-full whitespace-normal text-start"
                type="button"
                variant="outline"
                disabled={!qualifier}
                onClick={() => {
                  update({
                    ...row.statement,
                    qualifiers: [
                      ...(row.statement.qualifiers ?? []),
                      { property: { id: qualifier }, value: { type: 'value', content: '' } },
                    ],
                  });
                  setQualifier('');
                }}
              >
                {m.relation_add_qualifier({}, o)}
              </Button>
            </div>
          )}
          <Field id={`${feedback.id}-references`} tabIndex={-1} className="min-w-0">
            <FieldLabel htmlFor={`citation-${row.id}`}>{m.relation_citation({}, o)}</FieldLabel>
            <Input
              type="url"
              id={`citation-${row.id}`}
              {...invalid(`citation-${row.id}`)}
              value={citation}
              onChange={(event) => {
                const url = event.target.value;
                const references = structuredClone(row.statement.references);
                const reference = references[0] ?? { parts: [] };
                const at = reference.parts.findIndex((part) => part.property.id === 'schema:url');
                const part = {
                  property: { id: 'schema:url' },
                  value: { type: 'value' as const, content: url.trim() },
                };
                if (url.trim()) {
                  if (at < 0) reference.parts.push(part);
                  else
                    reference.parts[at] = {
                      ...reference.parts[at]!,
                      value: part.value,
                    };
                } else if (at >= 0) reference.parts.splice(at, 1);
                if (!references.length && reference.parts.length) references.push(reference);
                if (references[0]?.parts.length === 0) references.shift();
                update({
                  ...row.statement,
                  references,
                });
              }}
            />
          </Field>
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
                <Button ref={cancel} type="button" variant="outline" disabled={disabled} onClick={cancelRemoval}>
                  {m.candidate_cancel({}, o)}
                </Button>
                <Button type="button" variant="destructive" disabled={disabled} onClick={remove}>
                  {m.recipe_remove_field({}, o)}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              ref={trigger}
              className="h-auto min-h-11 max-w-full whitespace-normal text-start"
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                if (editable()) populated ? setConfirmingRow(row.id) : remove();
              }}
            >
              {m.recipe_remove_field({}, o)}
            </Button>
          )}
        </fieldset>
      </ContentItemFrame>
    </section>
  );
}

function PickedTarget({
  part,
  label,
  read,
  search,
  disabled,
  mangaWork,
  picked,
  onChange,
}: {
  part: SnakInput;
  label: string;
  read: MangaReady;
  search: EntityPickerSearch;
  disabled: boolean;
  mangaWork: boolean;
  picked: EntityPickerSubject[];
  onChange: (value: SnakInput['value'], items: EntityPickerSubject[]) => void;
}) {
  return (
    <EntityPicker
      label={label}
      disabled={disabled}
      value={picked}
      src={coverSrc}
      search={async (query, signal) =>
        (await search(query, signal)).filter((entry) =>
          entry.types.some(
            (type) =>
              mangaTarget(read.release, part.property.id, type) && (!mangaWork || type === 'schema:ComicSeries'),
          ),
        )
      }
      onValueChange={(items) => {
        onChange({ type: 'value', content: items[0]?.id ?? '' }, items);
      }}
    />
  );
}
