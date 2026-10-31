import { useState } from 'react';
import type { Release } from '@rezics/definitions';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { ScalarControl } from './statement-editor-view';
import type { SnakInput, StatementInput } from './statement-editor';
import { screenFactId, screenGroups, screenName, screenTarget, type ScreenGroup } from './screen-profile';

export type ScreenRow = { key: string; statement: StatementInput };
export function screenGroupLabel(group: ScreenGroup, locale: string) {
  const o = { locale: locale as never };
  return {
    dates: m.facts_dates({}, o),
    amounts: m.facts_quantities({}, o),
    credits: m.screen_credits({}, o),
    parts: m.screen_parts({}, o),
    classification: m.screen_classification({}, o),
    text: m.facts_text({}, o),
    authored: m.authored_title({}, o),
  }[group];
}
function InitialValue({
  part,
  release,
  locale,
  search,
  disabled,
  change,
}: {
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
  if (definition?.datatype === 'wikibase-item')
    return (
      <EntityPicker
        label={screenName(release, part.property.id, locale).text}
        disabled={disabled}
        value={
          picked.filter((item) => item.id === content).length
            ? picked.filter((item) => item.id === content)
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
        search={async (text, signal) =>
          (await search(text, signal)).filter((item) =>
            item.types.some((type) => screenTarget(release, part.property.id, type)),
          )
        }
        onValueChange={(items) => {
          setPicked(items);
          change({ type: 'value', content: items[0]?.id ?? '' });
        }}
      />
    );
  return (
    <ScalarControl
      part={part}
      definition={definition}
      read={{ release, public: { related: {} } }}
      locale={locale}
      onChange={change}
    />
  );
}
function InitialStatement({
  row,
  release,
  locale,
  search,
  disabled,
  change,
}: {
  row: ScreenRow;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  change: (statement: StatementInput) => void;
}) {
  const o = { locale: locale as never };
  const statement = row.statement;
  const property = release.properties[statement.property.id]!;
  const citation = statement.references[0]?.parts.find((part) => part.property.id === 'schema:url')?.value;
  if (!property) return <p role="status">{m.correction_preserved({}, o)}</p>;
  return (
    <div className="space-y-4">
      <InitialValue
        part={statement}
        release={release}
        locale={locale}
        search={search}
        disabled={disabled}
        change={(value) => change({ ...statement, value })}
      />
      {(statement.qualifiers ?? []).map((part, index) => (
        <div key={`${part.property.id}:${index}`} className="space-y-2 border-s-2 ps-3">
          <p lang={screenName(release, part.property.id, locale).lang ?? undefined} className="text-sm font-medium">
            {screenName(release, part.property.id, locale).text}
          </p>
          <InitialValue
            part={part}
            release={release}
            locale={locale}
            search={search}
            disabled={disabled}
            change={(value) =>
              change({
                ...statement,
                qualifiers: statement.qualifiers!.map((item, at) => (at === index ? { ...item, value } : item)),
              })
            }
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => change({ ...statement, qualifiers: statement.qualifiers!.filter((_, at) => at !== index) })}
          >
            {m.relation_remove({}, o)}
          </Button>
        </div>
      ))}
      {!!property.qualifiers.length && (
        <Field>
          <FieldLabel htmlFor={`screen-qualifier-${row.key}`}>{m.correction_add_qualifier({}, o)}</FieldLabel>
          <NativeSelect
            id={`screen-qualifier-${row.key}`}
            value=""
            onChange={(event) => {
              if (property.qualifiers.includes(event.target.value))
                change({
                  ...statement,
                  qualifiers: [
                    ...(statement.qualifiers ?? []),
                    { property: { id: event.target.value }, value: { type: 'value', content: '' } },
                  ],
                });
            }}
          >
            <NativeSelectOption value="">{m.correction_add_qualifier({}, o)}</NativeSelectOption>
            {property.qualifiers
              .filter((id) => release.properties[id])
              .map((id) => (
                <NativeSelectOption key={id} value={id} lang={screenName(release, id, locale).lang ?? undefined}>
                  {screenName(release, id, locale).text}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Field>
      )}
      {release.properties['schema:url']?.datatype === 'url' && (
        <Field>
          <FieldLabel htmlFor={`screen-citation-${row.key}`}>{m.relation_citation({}, o)}</FieldLabel>
          <Input
            id={`screen-citation-${row.key}`}
            type="url"
            value={citation?.type === 'value' && typeof citation.content === 'string' ? citation.content : ''}
            onChange={(event) => {
              const url = event.target.value;
              change({
                ...statement,
                references: url.trim()
                  ? [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url.trim() } }] }]
                  : [],
              });
            }}
          />
        </Field>
      )}
    </div>
  );
}

/** Only explicitly added rows enter creation; a blank row remains invalid until edited or explicitly removed. */
export function ScreenInitialFields({
  type,
  rows,
  change,
  release,
  locale,
  search,
  disabled,
}: {
  type: string;
  rows: ScreenRow[];
  change: (rows: ScreenRow[]) => void;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
}) {
  const o = { locale: locale as never };
  const [property, setProperty] = useState('');
  const groups = screenGroups(release, type);
  const fields = Object.entries(groups)
    .filter(([group]) => group !== 'authored')
    .flatMap(([, ids]) => ids)
    .filter((id) => release.properties[id]?.disclosure !== 'sourceOrConsent');
  const name = (id: string) => screenName(release, id, locale);
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-5">
      <legend className="text-lg font-semibold">{m.screen_initial_facts({}, o)}</legend>
      <p className="text-sm text-muted-foreground">{m.screen_native_help({}, o)}</p>
      <Field>
        <FieldLabel htmlFor="screen-add-field">{m.character_add_fact({}, o)}</FieldLabel>
        <NativeSelect
          id="screen-add-field"
          value={fields.includes(property) ? property : ''}
          onChange={(event) => setProperty(event.target.value)}
        >
          <NativeSelectOption value="">{m.character_add_fact({}, o)}</NativeSelectOption>
          {Object.entries(groups)
            .filter(([group]) => group !== 'authored')
            .map(([group, ids]) => (
              <optgroup key={group} label={screenGroupLabel(group as ScreenGroup, locale)}>
                {ids
                  .filter(
                    (id) =>
                      fields.includes(id) &&
                      (release.properties[id]!.multivalued || !rows.some((row) => row.statement.property.id === id)),
                  )
                  .map((id) => (
                    <NativeSelectOption key={id} value={id} lang={name(id).lang ?? undefined}>
                      {name(id).text}
                    </NativeSelectOption>
                  ))}
              </optgroup>
            ))}
        </NativeSelect>
      </Field>
      <Button
        type="button"
        variant="outline"
        disabled={
          !fields.includes(property) ||
          (!release.properties[property]?.multivalued && rows.some((row) => row.statement.property.id === property))
        }
        onClick={() => {
          change([
            ...rows,
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
      {rows.map((row) => (
        <section
          key={row.key}
          id={
            rows.find((item) => item.statement.property.id === row.statement.property.id)?.key === row.key
              ? screenFactId(row.statement.property.id)
              : undefined
          }
          className="space-y-4 rounded-xl border border-border bg-card p-4"
        >
          <h3 lang={name(row.statement.property.id).lang ?? undefined} className="font-sans font-semibold">
            {name(row.statement.property.id).text}
          </h3>
          <InitialStatement
            row={row}
            release={release}
            locale={locale}
            search={search}
            disabled={disabled}
            change={(statement) => change(rows.map((item) => (item.key === row.key ? { ...item, statement } : item)))}
          />
          <Button type="button" variant="ghost" onClick={() => change(rows.filter((item) => item.key !== row.key))}>
            {m.relation_remove({}, o)}
          </Button>
        </section>
      ))}
      <p className="text-sm text-muted-foreground">{m.screen_authored_after({}, o)}</p>
    </fieldset>
  );
}
