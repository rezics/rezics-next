import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Release } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { ScalarControl } from './statement-editor-view';
import type { SnakInput, StatementInput } from './statement-editor';
import { controlId, presentStatementViolations } from './statement-validation-presentation';
import { screenFactId, screenGroups, screenName, screenTarget, type ScreenGroup } from './screen-profile';

const screenActionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const screenSelectClassName =
  'w-full min-w-0 max-w-full max-md:[&>select]:min-h-11 md:pointer-fine:[&>select]:min-h-8 pointer-coarse:[&>select]:min-h-11';
const screenInputClassName = 'min-w-0 max-w-full max-md:min-h-11 md:pointer-fine:min-h-8 pointer-coarse:min-h-11';
const screenLabelClassName = 'min-w-0 max-w-full flex-wrap whitespace-normal [overflow-wrap:anywhere]';

export type ScreenRow = { key: string; statement: StatementInput };
export const screenRowId = (row: ScreenRow) => `${screenFactId(row.statement.property.id)}-${row.key}`;
// Nested addresses survive edits and removal of preceding parts without entering the native command.
const partKeys = new WeakMap<SnakInput, string>();
function partKey(part: SnakInput): string {
  if (!partKeys.has(part)) partKeys.set(part, crypto.randomUUID());
  return partKeys.get(part)!;
}
function partValue(part: SnakInput, value: SnakInput['value']): SnakInput {
  const next = { ...part, value };
  partKeys.set(next, partKey(part));
  return next;
}

/** Decode only addresses for controls this local creation editor supports. */
export function screenCreationControl(pointer: string, rows: ScreenRow[], release: Release, locale: string) {
  const match = /^\/statements\/((?:[^/~]|~[01])+)\/(0|[1-9]\d*)(\/.*)$/.exec(pointer);
  if (!match) return;
  const property = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
  const row = rows.filter((entry) => entry.statement.property.id === property)[Number(match[2])];
  if (!row) return;
  let part: SnakInput | undefined = row.statement;
  let id = screenRowId(row);
  let path = match[3]!;
  const qualifier = /^\/qualifiers\/(0|[1-9]\d*)(\/.*)$/.exec(path);
  const reference = /^\/references\/(0|[1-9]\d*)\/parts\/(0|[1-9]\d*)(\/.*)$/.exec(path);
  if (qualifier || reference) {
    part = qualifier
      ? row.statement.qualifiers?.[Number(qualifier[1])]
      : row.statement.references[Number(reference![1])]?.parts[Number(reference![2])];
    if (!part) return;
    id += `-${partKey(part)}`;
    path = qualifier ? qualifier[2]! : reference![3]!;
  }
  const definition = release.properties[part.property.id];
  const name = screenName(release, property, locale).text;
  const partName = screenName(release, part.property.id, locale).text;
  const label = `${name} ${Number(match[2]) + 1} · ${partName}`;
  if (reference) {
    if (part.property.id !== 'schema:url' || definition?.datatype !== 'url' || path !== '/value/content') return;
    return {
      id: controlId(id, 'fact', 'value'),
      label: `${label} · ${m.relation_citation({}, { locale: locale as never })}`,
    };
  }
  if (definition?.datatype === 'wikibase-item')
    return path === '/value/content' ? { id: controlId(id, 'fact', 'value'), label } : undefined;
  const presented = presentStatementViolations(
    [{ pointer: `/statement${path}`, code: 'invalid_format' }],
    { ...part, references: [], qualifiers: [] },
    release,
    locale,
    id,
  )[0]!;
  if (presented.target.startsWith(`${id}-fact-`))
    return { id: presented.target, label: `${label} · ${presented.label}` };
}
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
  id,
  part,
  release,
  locale,
  search,
  disabled,
  change,
}: {
  id: string;
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
      <div id={controlId(id, 'fact', 'value')}>
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
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ScalarControl
        feedback={{ id, address: 'fact', errors: [] }}
        part={part}
        definition={definition}
        read={{ release, public: { related: {} } }}
        locale={locale}
        onChange={change}
      />
      <p className="min-w-0 max-w-full text-sm text-muted-foreground empty:hidden [overflow-wrap:anywhere]">
        {content}
      </p>
    </div>
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
  const emptyCitation = useRef<SnakInput>({ property: { id: 'schema:url' }, value: { type: 'value', content: '' } });
  const citations = statement.references.flatMap((reference, group) =>
    reference.parts.flatMap((part, index) => (part.property.id === 'schema:url' ? [{ part, group, index }] : [])),
  );
  if (!property) return <p role="status">{m.correction_preserved({}, o)}</p>;
  return (
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <InitialValue
        id={screenRowId(row)}
        part={statement}
        release={release}
        locale={locale}
        search={search}
        disabled={disabled}
        change={(value) => change({ ...statement, value })}
      />
      {(statement.qualifiers ?? []).map((part, index) => (
        <div key={partKey(part)} data-screen-qualifier className="min-w-0 space-y-2 border-s-2 ps-3">
          <p
            lang={screenName(release, part.property.id, locale).lang ?? undefined}
            className="min-w-0 max-w-full text-sm font-medium [overflow-wrap:anywhere]"
          >
            {screenName(release, part.property.id, locale).text}
          </p>
          <InitialValue
            id={`${screenRowId(row)}-${partKey(part)}`}
            part={part}
            release={release}
            locale={locale}
            search={search}
            disabled={disabled}
            change={(value) =>
              change({
                ...statement,
                qualifiers: statement.qualifiers!.map((item, at) => (at === index ? partValue(item, value) : item)),
              })
            }
          />
          <ScreenQualifierRemove
            part={part}
            disabled={disabled}
            locale={locale}
            onRemove={() =>
              change({
                ...statement,
                qualifiers: statement.qualifiers!.filter((item) => partKey(item) !== partKey(part)),
              })
            }
          />
        </div>
      ))}
      {!!property.qualifiers.length && (
        <Field className="min-w-0">
          <FieldLabel className={screenLabelClassName} htmlFor={`screen-qualifier-${row.key}`}>
            {m.correction_add_qualifier({}, o)}
          </FieldLabel>
          <NativeSelect
            className={screenSelectClassName}
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
      {release.properties['schema:url']?.datatype === 'url' &&
        (citations.length ? citations : [{ part: emptyCitation.current, group: -1, index: -1 }]).map((citation) => {
          const id = controlId(`${screenRowId(row)}-${partKey(citation.part)}`, 'fact', 'value');
          const value = citation.part.value;
          return (
            <Field key={partKey(citation.part)} data-screen-citation className="min-w-0">
              <FieldLabel className={screenLabelClassName} htmlFor={id}>
                {m.relation_citation({}, o)}
              </FieldLabel>
              <Input
                className={screenInputClassName}
                id={id}
                type="url"
                value={value?.type === 'value' && typeof value.content === 'string' ? value.content : ''}
                onChange={(event) => {
                  const url = event.target.value.trim();
                  change({
                    ...statement,
                    references:
                      citation.group >= 0
                        ? statement.references.map((reference, group) =>
                            group !== citation.group
                              ? reference
                              : {
                                  ...reference,
                                  parts: reference.parts.map((part, index) =>
                                    index !== citation.index ? part : partValue(part, { type: 'value', content: url }),
                                  ),
                                },
                          )
                        : url
                          ? [
                              ...statement.references,
                              { parts: [partValue(citation.part, { type: 'value', content: url })] },
                            ]
                          : statement.references,
                  });
                }}
              />
              <p className="min-w-0 max-w-full text-sm text-muted-foreground empty:hidden [overflow-wrap:anywhere]">
                {value?.type === 'value' && typeof value.content === 'string' ? value.content : ''}
              </p>
              {citation.group >= 0 && (
                <ScreenCitationRemove
                  part={citation.part}
                  disabled={disabled}
                  locale={locale}
                  onRemove={() => {
                    const key = partKey(citation.part);
                    emptyCitation.current = { property: { id: 'schema:url' }, value: { type: 'value', content: '' } };
                    change({
                      ...statement,
                      references: statement.references.flatMap((reference) => {
                        if (!reference.parts.some((part) => partKey(part) === key)) return [reference];
                        const parts = reference.parts.filter((part) => partKey(part) !== key);
                        return parts.length ? [{ ...reference, parts }] : [];
                      }),
                    });
                  }}
                />
              )}
            </Field>
          );
        })}
    </div>
  );
}

/** Keep the URL mounted and address the pending removal by its private part identity. */
function ScreenCitationRemove({
  part,
  disabled,
  locale,
  onRemove,
}: {
  part: SnakInput;
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const o = { locale: locale as never };
  const key = partKey(part);
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [pending, setPending] = useState<string>();
  const confirming = pending === key;
  const current = useRef({ disabled, key, onRemove });
  current.current = { disabled, key, onRemove };
  const editable = () =>
    !current.current.disabled &&
    current.current.key === key &&
    !!holder.current?.isConnected &&
    !holder.current.closest('fieldset:disabled, [inert]');
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
    setPending(undefined);
  };
  const remove = () => {
    if (!editable()) return;
    const citation = holder.current!.closest('[data-screen-citation]')!;
    const parent = citation.parentElement!;
    const siblings = [...parent.querySelectorAll<HTMLElement>('[data-screen-citation]')];
    const index = siblings.indexOf(citation as HTMLElement);
    const controls = 'input, select, textarea, button, [tabindex="0"], [contenteditable="true"]';
    const candidates = [...siblings.slice(index + 1), ...siblings.slice(0, index).reverse(), parent].flatMap(
      (region) => [...region.querySelectorAll<HTMLElement>(controls)],
    );
    candidates
      .find(
        (control) =>
          !citation.contains(control) &&
          !control.matches(':disabled, [aria-disabled="true"], [type="hidden"]') &&
          !control.closest('[hidden], [inert]'),
      )
      ?.focus();
    current.current.onRemove();
  };
  const populated =
    part.value.type !== 'value' || typeof part.value.content !== 'string' || !!part.value.content.trim();
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
            <Button
              ref={cancel}
              className={screenActionClassName}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={cancelRemoval}
            >
              {m.candidate_cancel({}, o)}
            </Button>
            <Button
              className={screenActionClassName}
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={remove}
            >
              {m.relation_remove({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={screenActionClassName}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (editable()) populated ? setPending(key) : remove();
          }}
        >
          {m.relation_remove({}, o)}
        </Button>
      )}
    </div>
  );
}

/** Keep the value and picker mounted until this stable, unsent part is confirmed. */
function ScreenQualifierRemove({
  part,
  disabled,
  locale,
  onRemove,
}: {
  part: SnakInput;
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const o = { locale: locale as never };
  const key = partKey(part);
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [pending, setPending] = useState<string>();
  const confirming = pending === key;
  const current = useRef({ disabled, key, onRemove });
  current.current = { disabled, key, onRemove };
  const editable = () =>
    !current.current.disabled &&
    current.current.key === key &&
    !!holder.current?.isConnected &&
    !holder.current.closest('fieldset:disabled, [inert]');
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
    setPending(undefined);
  };
  const remove = () => {
    if (!editable()) return;
    const qualifier = holder.current!.closest('[data-screen-qualifier]')!;
    const parent = qualifier.parentElement!;
    const siblings = [...parent.querySelectorAll<HTMLElement>('[data-screen-qualifier]')];
    const index = siblings.indexOf(qualifier as HTMLElement);
    const controls = 'input, select, textarea, button, [tabindex="0"], [contenteditable="true"]';
    const candidates = [...siblings.slice(index + 1), ...siblings.slice(0, index).reverse(), parent].flatMap(
      (region) => [...region.querySelectorAll<HTMLElement>(controls)],
    );
    candidates
      .find(
        (control) =>
          !qualifier.contains(control) &&
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
  const populated = part.value.type !== 'value' || hasContent(part.value.content);
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
            <Button
              ref={cancel}
              className={screenActionClassName}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={cancelRemoval}
            >
              {m.candidate_cancel({}, o)}
            </Button>
            <Button
              className={screenActionClassName}
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={remove}
            >
              {m.relation_remove({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={screenActionClassName}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (editable()) populated ? setPending(key) : remove();
          }}
        >
          {m.relation_remove({}, o)}
        </Button>
      )}
    </div>
  );
}

/** Local recovery for one unsent row, including content outside its main value. */
function ScreenInitialRemove({
  row,
  disabled,
  locale,
  onRemove,
}: {
  row: ScreenRow;
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
  // Confirmations opened while editable must obey the latest command lock.
  const current = useRef({ disabled, key: row.key, onRemove });
  current.current = { disabled, key: row.key, onRemove };
  const editable = () => !current.current.disabled && current.current.key === row.key;
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
            <Button
              ref={cancel}
              className={screenActionClassName}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={cancelRemoval}
            >
              {m.candidate_cancel({}, o)}
            </Button>
            <Button
              className={screenActionClassName}
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={remove}
            >
              {m.relation_remove({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={screenActionClassName}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (editable()) populated ? setConfirmingKey(row.key) : remove();
          }}
        >
          {m.relation_remove({}, o)}
        </Button>
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
  const propertySelectId = useId();
  const [property, setProperty] = useState('');
  const groups = screenGroups(release, type);
  const fields = Object.entries(groups)
    .filter(([group]) => group !== 'authored')
    .flatMap(([, ids]) => ids)
    .filter((id) => release.properties[id]?.disclosure !== 'sourceOrConsent');
  const name = (id: string) => screenName(release, id, locale);
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-5">
      <legend className="min-w-0 max-w-full text-lg font-semibold [overflow-wrap:anywhere]">
        {m.screen_initial_facts({}, o)}
      </legend>
      <p className="text-sm text-muted-foreground">{m.screen_native_help({}, o)}</p>
      <Field className="min-w-0">
        <FieldLabel className={screenLabelClassName} htmlFor={propertySelectId}>
          {m.character_add_fact({}, o)}
        </FieldLabel>
        <NativeSelect
          className={screenSelectClassName}
          id={propertySelectId}
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
        className={screenActionClassName}
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
      {/* Keep each error anchor's heading a direct child of its native section. */}
      {rows.map((row) => (
        <ContentItemFrame as="div" key={row.key} className="min-w-0 py-4 sm:py-5">
          <section id={screenRowId(row)} className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
            <ContentItemHeading
              level={3}
              lang={name(row.statement.property.id).lang ?? undefined}
              className="min-w-0 max-w-full font-sans font-semibold [overflow-wrap:anywhere]"
            >
              {name(row.statement.property.id).text}
            </ContentItemHeading>
            <InitialStatement
              row={row}
              release={release}
              locale={locale}
              search={search}
              disabled={disabled}
              change={(statement) => change(rows.map((item) => (item.key === row.key ? { ...item, statement } : item)))}
            />
            <ScreenInitialRemove
              row={row}
              disabled={disabled}
              locale={locale}
              onRemove={() => change(rows.filter((item) => item.key !== row.key))}
            />
          </section>
        </ContentItemFrame>
      ))}
      <p className="text-sm text-muted-foreground">{m.screen_authored_after({}, o)}</p>
    </fieldset>
  );
}
