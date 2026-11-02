import { useId, useState } from 'react';
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
}: {
  row: MangaRow;
  read: MangaReady;
  type: MangaType;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  onChange: (row: MangaRow) => void;
  onRemove: () => void;
}) {
  const o = { locale: locale as never };
  const property = read.release.properties[row.statement.property.id]!;
  const title = pickText(property.labels, locale);
  const [qualifier, setQualifier] = useState('');
  const qualifierId = useId();
  const citationPart = row.statement.references?.[0]?.parts.find((part) => part.property.id === 'schema:url');
  const citation =
    citationPart?.value.type === 'value' && typeof citationPart.value.content === 'string'
      ? citationPart.value.content
      : '';
  const authored = row.authored ?? newAuthoredField();
  const update = (statement: StatementInput) => onChange({ ...row, statement });
  const updateAuthored = (next: AuthoredField) =>
    onChange({ ...row, authored: next, statement: { ...row.statement, value: authoredFieldValue(next) } });
  const name = (id: string) => pickText(read.release.properties[id]?.labels ?? {}, locale).text;
  const control = (part: SnakInput, statement: (value: SnakInput['value']) => StatementInput) => {
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
          onChange({ ...row, statement: statement(value), targets: { ...row.targets, [part.property.id]: items } })
        }
      />
    ) : (
      <ScalarControl
        part={part}
        definition={definition}
        read={{ release: read.release, public: { related: read.public?.related ?? {} } }}
        locale={locale}
        onChange={(value) => update(statement(value))}
      />
    );
  };
  return (
    <section
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
          disabled={disabled}
          data-content-item-slot="preview"
          className="min-w-0 space-y-4 [&_label]:whitespace-normal [&_label]:text-start"
        >
          {property.datatype === 'document' ? (
            <>
              <p className="text-sm text-muted-foreground">{m.authored_citation_hint({}, o)}</p>
              <Field className="min-w-0">
                <FieldLabel htmlFor={`language-${row.id}`}>{m.authored_language({}, o)}</FieldLabel>
                <Input
                  id={`language-${row.id}`}
                  value={authored.language}
                  onChange={(event) => updateAuthored({ ...authored, language: event.target.value })}
                />
              </Field>
              <Field className="min-w-0">
                <FieldLabel htmlFor={`licence-${row.id}`}>{m.authored_licence({}, o)}</FieldLabel>
                <Input
                  id={`licence-${row.id}`}
                  value={authored.licence}
                  onChange={(event) => updateAuthored({ ...authored, licence: event.target.value })}
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
                  checked={row.original ?? false}
                  onCheckedChange={(value) => onChange({ ...row, original: value === true })}
                />
                <FieldLabel htmlFor={`original-${row.id}`}>{m.authored_original({}, o)}</FieldLabel>
              </Field>
            </>
          ) : (
            control(row.statement, (value) => ({ ...row.statement, value }))
          )}
          {(row.statement.qualifiers ?? []).map((part, index) => (
            <div key={index} className="min-w-0 space-y-2 border-s-2 ps-3">
              <ContentItemHeading
                level={4}
                className="font-sans text-sm font-medium"
                lang={pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).lang ?? undefined}
              >
                {name(part.property.id)}
              </ContentItemHeading>
              {control(part, (value) => ({
                ...row.statement,
                qualifiers: row.statement.qualifiers!.map((snak, at) => (at === index ? { ...snak, value } : snak)),
              }))}
            </div>
          ))}
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
                  onChange={(event) => setQualifier(event.target.value)}
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
          <Field className="min-w-0">
            <FieldLabel htmlFor={`citation-${row.id}`}>{m.relation_citation({}, o)}</FieldLabel>
            <Input
              type="url"
              id={`citation-${row.id}`}
              value={citation}
              onChange={(event) => {
                const url = event.target.value;
                update({
                  ...row.statement,
                  references: url.trim()
                    ? [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url.trim() } }] }]
                    : [],
                });
              }}
            />
          </Field>
          <Button
            className="h-auto min-h-11 max-w-full whitespace-normal text-start"
            type="button"
            variant="ghost"
            onClick={onRemove}
          >
            {m.recipe_remove_field({}, o)}
          </Button>
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
