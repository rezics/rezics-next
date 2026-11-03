import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Release } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import {
  EditorFailure,
  PartValue,
  ScalarControl,
  StatementFields,
  statementHolderKey,
  type StatementFieldsRead,
} from './statement-editor-view';
import { creationStatement, emptyCreationStatement, type SnakInput, type StatementInput } from './statement-editor';
import { controlId, presentStatementViolations, type PresentedViolation } from './statement-validation-presentation';
import { ReferenceReusePanel } from './reference-reuse-view';
import { screenCreateFactsRead, type ScreenReuseState } from './screen-create-review';
import { screenFactId, screenGroups, screenName, screenTarget, type ScreenGroup } from './screen-profile';

const screenActionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const screenSelectClassName =
  'w-full min-w-0 max-w-full max-md:[&>select]:min-h-11 md:pointer-fine:[&>select]:min-h-8 pointer-coarse:[&>select]:min-h-11';
const screenLabelClassName = 'min-w-0 max-w-full flex-wrap whitespace-normal [overflow-wrap:anywhere]';

export type ScreenRow = { key: string; statement: StatementInput };
export const screenRowId = (row: ScreenRow) => `${screenFactId(row.statement.property.id)}-${row.key}`;

/** Decode only addresses for controls this local creation editor supports. */
export function screenCreationControl(pointer: string, rows: ScreenRow[], release: Release, locale: string) {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  const whole = /^\/statements\/((?:[^/~]|~[01])+)$/.exec(pointer);
  if (whole) {
    const property = whole[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
    const row = rows.find((entry) => entry.statement.property.id === property);
    if (!row) return;
    return { id: screenRowId(row), label: screenName(release, property, locale).text };
  }
  const indexed = /^\/statements\/((?:[^/~]|~[01])+)\/(0|[1-9]\d*)$/.exec(pointer);
  if (indexed) {
    const property = indexed[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
    const row = rows.filter((entry) => entry.statement.property.id === property)[Number(indexed[2])];
    if (!row) return;
    return { id: screenRowId(row), label: screenName(release, property, locale).text };
  }
  const match = /^\/statements\/((?:[^/~]|~[01])+)\/(0|[1-9]\d*)(\/.*)$/.exec(pointer);
  if (!match) return;
  const property = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
  const row = rows.filter((entry) => entry.statement.property.id === property)[Number(match[2])];
  if (!row) return;
  if (!release.properties[property] || release.properties[property]?.disclosure === 'sourceOrConsent')
    return { id: screenRowId(row), label: screenName(release, property, locale).text };
  const statement = creationStatement(row.statement, release);
  let part: SnakInput = statement;
  let id = screenRowId(row);
  const nested = match[3]!.slice(1).split('/');
  const qualifier = nested[0] === 'qualifiers' && /^(0|[1-9]\d*)$/.test(nested[1] ?? '');
  const reference =
    nested[0] === 'references' &&
    /^(0|[1-9]\d*)$/.test(nested[1] ?? '') &&
    nested[2] === 'parts' &&
    /^(0|[1-9]\d*)$/.test(nested[3] ?? '');
  let address = 'fact';
  let stableAddress = 'fact';
  if (qualifier) {
    const index = Number(nested[1]);
    const found = statement.qualifiers?.[index];
    if (!found) return;
    part = found;
    address = `qualifier-${index}`;
  } else if (reference) {
    const group = Number(nested[1]);
    const index = Number(nested[3]);
    const found = statement.references[group]?.parts[index];
    if (!found) return;
    part = found;
    address = `reference-${group}-part-${index}`;
  }
  if (part !== statement) {
    const key = statementHolderKey(part);
    if (key === undefined) return;
    stableAddress = `part-${key}`;
  }
  const definition = release.properties[part.property.id];
  const name = screenName(release, property, locale).text;
  const partName = screenName(release, part.property.id, locale).text;
  const label = `${name} ${Number(match[2]) + 1} · ${partName}`;
  const path = match[3]!;
  const presented = presentStatementViolations(
    [{ pointer: `/statement${path}`, code: 'invalid_format' }],
    statement,
    release,
    locale,
    id,
  )[0]!;
  const nativeAddress = qualifier || reference ? address : 'fact';
  if (definition?.datatype === 'wikibase-item' && path.endsWith('/value/content'))
    return { id: controlId(id, stableAddress, 'value'), label: `${label} · ${presented.label}` };
  const field = (
    ['state', 'value', 'date', 'amount', 'unit', 'lowerBound', 'upperBound', 'text', 'language'] as const
  ).find((candidate) => presented.target === controlId(id, nativeAddress, candidate));
  if (!field) return;
  let target = controlId(id, stableAddress, field);
  if (definition?.datatype === 'time') {
    if (path.endsWith('/value/content/precision')) target = controlId(id, stableAddress, 'precision');
    else if (path.endsWith('/value/content/time')) target = controlId(id, stableAddress, 'year');
  }
  return { id: target, label: `${label} · ${presented.label}` };
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
  change: (value: SnakInput['value']) => boolean;
}) {
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const definition = release.properties[part.property.id];
  const content = part.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : '';
  if (definition?.datatype === 'wikibase-item')
    return (
      <div id={controlId(id, address, 'value')}>
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
            if (change({ type: 'value', content: items[0]?.id ?? '' })) setPicked(items);
          }}
        />
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ScalarControl
        feedback={{ id, address, errors: [] }}
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
  omitProperties = [],
  canEdit,
  errors = [],
  reuse = null,
  focusCopy,
  onReuse,
  onReuseSelected,
  onReuseApply,
  onReuseCancel,
  onReuseRefresh,
  onReuseOpen,
}: {
  type: string;
  rows: ScreenRow[];
  change: (rows: ScreenRow[]) => void;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  omitProperties?: readonly string[] | undefined;
  canEdit?: () => boolean;
  errors?: readonly { pointer: string; code: string }[];
  reuse?: ScreenReuseState | null;
  focusCopy?: { holder: string; index: number; nonce: number };
  onReuse?: (row: ScreenRow, index: number) => void;
  onReuseSelected?: (holders: string[]) => void;
  onReuseApply?: () => void;
  onReuseCancel?: () => void;
  onReuseRefresh?: () => void;
  onReuseOpen?: (holder: string, index: number) => void;
}) {
  const o = { locale: locale as never };
  const propertySelectId = useId();
  const [property, setProperty] = useState('');
  const groups = screenGroups(release, type);
  const fields = Object.entries(groups)
    .filter(([group]) => group !== 'authored')
    .flatMap(([, ids]) => ids)
    .filter((id) => !omitProperties.includes(id) && release.properties[id]?.disclosure !== 'sourceOrConsent');
  const current = useRef({ rows, disabled, change, release, fields, property });
  current.current = { rows, disabled, change, release, fields, property };
  const mounted = useRef(true);
  const pendingFocus = useRef<{ row: ScreenRow; trigger: HTMLButtonElement } | undefined>(undefined);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingFocus.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    const intent = pendingFocus.current;
    if (!intent) return;
    const state = current.current;
    const propertyId = intent.row.statement.property.id;
    if (
      !mounted.current ||
      state.disabled ||
      !state.fields.includes(propertyId) ||
      !state.release.properties[propertyId] ||
      !intent.trigger.isConnected ||
      intent.trigger.disabled
    ) {
      pendingFocus.current = undefined;
      return;
    }
    const row = state.rows.find((item) => item.key === intent.row.key);
    if (!row) return;
    if (row.statement !== intent.row.statement) {
      pendingFocus.current = undefined;
      return;
    }
    const section = document.getElementById(screenRowId(row));
    const target = section?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, [role="combobox"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
    );
    if (!target || document.activeElement !== intent.trigger) {
      pendingFocus.current = undefined;
      return;
    }
    pendingFocus.current = undefined;
    target.focus();
  }, [rows, disabled, release, type]);
  const writeStatement = (row: ScreenRow, statement: StatementInput) => {
    const state = current.current;
    if (!mounted.current || state.disabled) return;
    const currentRow = state.rows.find((item) => item.key === row.key);
    if (!currentRow || currentRow.statement !== row.statement) return;
    const next = state.rows.map((item) => (item.key === row.key ? { ...item, statement } : item));
    current.current = { ...state, rows: next };
    state.change(next);
  };
  const removeRow = (rowKey: string, propertyId: string) => {
    const state = current.current;
    if (!mounted.current || state.disabled) return;
    if (!state.rows.some((row) => row.key === rowKey && row.statement.property.id === propertyId)) return;
    const next = state.rows.filter((row) => row.key !== rowKey);
    current.current = { ...state, rows: next };
    state.change(next);
  };
  const addRow = (keyboard: boolean, trigger: HTMLButtonElement) => {
    pendingFocus.current = undefined;
    const state = current.current;
    const definition = state.release.properties[state.property];
    if (
      !mounted.current ||
      state.disabled ||
      !state.fields.includes(state.property) ||
      !definition ||
      (!definition.multivalued && state.rows.some((row) => row.statement.property.id === state.property))
    )
      return;
    const row: ScreenRow = {
      key: crypto.randomUUID(),
      statement: emptyCreationStatement(state.property, state.release),
    };
    const next = [...state.rows, row];
    if (keyboard && document.activeElement === trigger) pendingFocus.current = { row, trigger };
    current.current = { ...state, rows: next };
    state.change(next);
    setProperty('');
  };
  const name = (id: string) => screenName(release, id, locale);
  const context: StatementFieldsRead = {
    release,
    source: null,
    public: { related: {}, subject: { type } },
  };
  const admittedRows = rows.filter((row) => fields.includes(row.statement.property.id));
  const reuseDrafts = admittedRows.map((row) => ({
    holder: screenRowId(row),
    property: row.statement.property.id,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
  const editable = () => (canEdit ? canEdit() : !disabled);
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
          onChange={(event) => {
            const state = current.current;
            const selected = event.target.value;
            if (mounted.current && !state.disabled && (!selected || state.fields.includes(selected))) {
              pendingFocus.current = undefined;
              setProperty(selected);
            }
          }}
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
        onPointerDown={() => {
          pendingFocus.current = undefined;
        }}
        onBlur={(event) => {
          if (pendingFocus.current?.trigger === event.currentTarget) pendingFocus.current = undefined;
        }}
        onClick={(event) => addRow(event.detail === 0, event.currentTarget)}
      >
        {m.correction_add({}, o)}
      </Button>
      {/* Keep each error anchor's heading a direct child of its native section. */}
      {rows.map((row) => {
        const property = row.statement.property.id;
        const admitted = fields.includes(property);
        const id = screenRowId(row);
        const indexAmong = rows
          .filter((entry) => entry.statement.property.id === property)
          .findIndex((entry) => entry.key === row.key);
        const encoded = property.replaceAll('~', '~0').replaceAll('/', '~1');
        const prefix = `/statements/${encoded}/${indexAmong}`;
        const fieldPrefix = `/statements/${encoded}`;
        const presented: PresentedViolation[] = presentStatementViolations(
          errors.flatMap((error) => {
            if (error.pointer === fieldPrefix)
              return [{ pointer: '/statement', code: error.code as never }];
            if (error.pointer !== prefix && !error.pointer.startsWith(`${prefix}/`)) return [];
            return [{ pointer: `/statement${error.pointer.slice(prefix.length)}`, code: error.code as never }];
          }),
          row.statement,
          release,
          locale,
          id,
        );
        return (
          <ContentItemFrame as="div" key={row.key} className="min-w-0 py-4 sm:py-5">
            <section id={id} className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
              <ContentItemHeading
                level={3}
                lang={name(property).lang ?? undefined}
                className="min-w-0 max-w-full font-sans font-semibold [overflow-wrap:anywhere]"
              >
                {name(property).text}
              </ContentItemHeading>
              {admitted ? (
                <StatementFields
                  creation
                  localDraft
                  stablePartAddresses
                  draft={row.statement}
                  current={context}
                  locale={locale}
                  feedback={{ id, errors: presented }}
                  guideReturn={`/${locale}/catalogue/screen`}
                  heading="h4"
                  valueControl={
                    release.properties[property]?.datatype === 'wikibase-item' ? (
                      <InitialValue
                        id={id}
                        part={row.statement}
                        release={release}
                        locale={locale}
                        search={search}
                        disabled={disabled}
                        change={(value) => {
                          writeStatement(row, { ...row.statement, value });
                          return true;
                        }}
                      />
                    ) : undefined
                  }
                  partControl={(part, changePart) =>
                    release.properties[part.property.id]?.datatype === 'wikibase-item' ? (
                      <InitialValue
                        id={id}
                        address={`part-${statementHolderKey(part) ?? ''}`}
                        part={part}
                        release={release}
                        locale={locale}
                        search={search}
                        disabled={disabled}
                        change={(value) => {
                          changePart(value);
                          return true;
                        }}
                      />
                    ) : undefined
                  }
                  change={(statement) => writeStatement(row, statement)}
                  reuse={
                    onReuse && editable() && admittedRows.length > 1
                      ? { disabled, onReuse: (index) => onReuse(row, index) }
                      : undefined
                  }
                  focusReference={focusCopy && focusCopy.holder === id ? focusCopy : undefined}
                />
              ) : (
                <>
                  <EditorFailure reason="stale" locale={locale} />
                  <PartValue part={row.statement} read={context} locale={locale} />
                </>
              )}
              <ScreenInitialRemove
                row={row}
                disabled={disabled}
                locale={locale}
                onRemove={() => removeRow(row.key, row.statement.property.id)}
              />
            </section>
          </ContentItemFrame>
        );
      })}
      {reuse && onReuseSelected && onReuseApply && onReuseCancel && onReuseRefresh && onReuseOpen && (
        <ReferenceReusePanel
          source={reuse.source}
          drafts={reuseDrafts}
          selected={reuse.selected}
          read={screenCreateFactsRead(release, type)}
          locale={locale}
          capture={reuse.capture}
          applied={reuse.applied}
          refused={reuse.refused}
          onSelected={onReuseSelected}
          onApply={onReuseApply}
          onCancel={onReuseCancel}
          onRefresh={onReuseRefresh}
          onOpen={onReuseOpen}
        />
      )}
      <p className="text-sm text-muted-foreground">{m.screen_authored_after({}, o)}</p>
    </fieldset>
  );
}
