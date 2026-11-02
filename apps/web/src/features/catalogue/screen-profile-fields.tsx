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
type ScreenStatementEdit = (
  update: (statement: StatementInput, release: Release) => StatementInput | undefined,
  part?: SnakInput,
  allowMissingPart?: () => boolean,
) => boolean;
type ScreenQualifierAdd = (rowKey: string, propertyId: string, qualifierId: string) => boolean;

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
  change: (value: SnakInput['value']) => boolean;
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
            if (change({ type: 'value', content: items[0]?.id ?? '' })) setPicked(items);
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
  parentAdmitted,
  change,
  addQualifier,
}: {
  row: ScreenRow;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  parentAdmitted: boolean;
  change: ScreenStatementEdit;
  addQualifier: ScreenQualifierAdd;
}) {
  const o = { locale: locale as never };
  const statement = row.statement;
  const property = release.properties[statement.property.id]!;
  const qualifiers = statement.qualifiers ?? [];
  const qualifierOptions =
    property?.qualifiers.filter(
      (id) =>
        !!release.properties[id] &&
        qualifiers.length < 16 &&
        !qualifiers.some((part) => part.property.id === id),
    ) ?? [];
  const [qualifierChoice, setQualifierChoice] = useState('');
  const qualifierAllowed = qualifierOptions.includes(qualifierChoice);
  const qualifierState = useRef({ row, release, disabled, parentAdmitted, choice: qualifierChoice, qualifierOptions });
  qualifierState.current = { row, release, disabled, parentAdmitted, choice: qualifierChoice, qualifierOptions };
  const section = useRef<HTMLDivElement>(null);
  const qualifierFocus = useRef<{ cancel: () => void }>();
  const emptyCitation = useRef<SnakInput>({ property: { id: 'schema:url' }, value: { type: 'value', content: '' } });
  const citations = statement.references.flatMap((reference, group) =>
    reference.parts.flatMap((part, index) => (part.property.id === 'schema:url' ? [{ part, group, index }] : [])),
  );
  useLayoutEffect(() => {
    if (qualifierChoice && !qualifierAllowed) setQualifierChoice('');
  }, [qualifierChoice, qualifierAllowed]);
  useLayoutEffect(() => () => qualifierFocus.current?.cancel(), []);
  const deferQualifierFocus = (button: HTMLButtonElement, qualifier: string) => {
    qualifierFocus.current?.cancel();
    const document = button.ownerDocument;
    const view = document.defaultView;
    if (!view) return;
    let active = true;
    let frame = 0;
    const cancel = () => {
      if (!active) return;
      active = false;
      view.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', moved, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', tabbed, true);
      view.removeEventListener('blur', cancel);
      if (qualifierFocus.current?.cancel === cancel) qualifierFocus.current = undefined;
    };
    const moved = (event: FocusEvent) => {
      if (event.target !== button) cancel();
    };
    const tabbed = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    qualifierFocus.current = { cancel };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', tabbed, true);
    view.addEventListener('blur', cancel);
    frame = view.requestAnimationFrame(() => {
      const state = qualifierState.current;
      const latest = state.row.statement;
      const parent = state.release.properties[latest.property.id];
      const parts = latest.qualifiers ?? [];
      const group = [...(section.current?.querySelectorAll<HTMLElement>('[data-screen-qualifier]') ?? [])].find(
        (element) => element.dataset.screenQualifierProperty === qualifier,
      );
      const target = group?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea');
      const admitted =
        active &&
        !state.disabled &&
        state.parentAdmitted &&
        !!parent?.qualifiers.includes(qualifier) &&
        !!state.release.properties[qualifier] &&
        parts.length <= 16 &&
        parts.filter((part) => part.property.id === qualifier).length === 1 &&
        section.current?.isConnected &&
        button.isConnected &&
        !button.disabled &&
        document.activeElement === button;
      if (!admitted || !target?.isConnected || target.matches(':disabled')) {
        cancel();
        return;
      }
      cancel();
      target.focus();
    });
  };
  const commitQualifier = (button: HTMLButtonElement, keyboard: boolean) => {
    const state = qualifierState.current;
    const qualifier = state.choice;
    if (
      !qualifier ||
      !state.qualifierOptions.includes(qualifier) ||
      state.disabled ||
      !state.parentAdmitted ||
      !section.current?.isConnected ||
      !addQualifier(state.row.key, state.row.statement.property.id, qualifier)
    )
      return;
    setQualifierChoice('');
    if (keyboard && button.ownerDocument.activeElement === button) deferQualifierFocus(button, qualifier);
  };
  if (!property) return <p role="status">{m.correction_preserved({}, o)}</p>;
  return (
    <div ref={section} className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <InitialValue
        id={screenRowId(row)}
        part={statement}
        release={release}
        locale={locale}
        search={search}
        disabled={disabled}
        change={(value) => change((current) => ({ ...current, value }))}
      />
      {(statement.qualifiers ?? []).map((part, index) => (
        <div
          key={partKey(part)}
          data-screen-qualifier
          data-screen-qualifier-property={part.property.id}
          className="min-w-0 space-y-2 border-s-2 ps-3"
        >
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
              change(
                (current) => ({
                  ...current,
                  qualifiers: (current.qualifiers ?? []).map((item) =>
                    partKey(item) === partKey(part) ? partValue(item, value) : item,
                  ),
                }),
                part,
              )
            }
          />
          <ScreenQualifierRemove
            part={part}
            disabled={disabled}
            locale={locale}
            onRemove={() =>
              change(
                (current) => ({
                  ...current,
                  qualifiers: (current.qualifiers ?? []).filter((item) => partKey(item) !== partKey(part)),
                }),
                part,
              )
            }
          />
        </div>
      ))}
      {!!property.qualifiers.length && (
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="min-w-0 basis-full sm:basis-48 sm:flex-1">
            <FieldLabel className={screenLabelClassName} htmlFor={`screen-qualifier-${row.key}`}>
              {m.correction_add_qualifier({}, o)}
            </FieldLabel>
            <NativeSelect
              className={screenSelectClassName}
              id={`screen-qualifier-${row.key}`}
              value={qualifierAllowed ? qualifierChoice : ''}
              disabled={disabled || qualifiers.length >= 16}
              onChange={(event) => {
                const selected = event.target.value;
                const state = qualifierState.current;
                if (state.disabled || !state.parentAdmitted) return;
                if (!selected) setQualifierChoice('');
                else if (state.qualifierOptions.includes(selected)) setQualifierChoice(selected);
              }}
            >
              <NativeSelectOption value="">{m.correction_add_qualifier({}, o)}</NativeSelectOption>
              {qualifierOptions.map((id) => (
                <NativeSelectOption key={id} value={id} lang={screenName(release, id, locale).lang ?? undefined}>
                  {screenName(release, id, locale).text}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Button
            className={screenActionClassName}
            type="button"
            variant="outline"
            disabled={disabled || !parentAdmitted || !qualifierAllowed}
            onClick={(event) =>
              commitQualifier(
                event.currentTarget,
                event.detail === 0 && event.currentTarget.ownerDocument.activeElement === event.currentTarget,
              )
            }
          >
            {m.relation_add_qualifier({}, o)}
          </Button>
        </div>
      )}
      {release.properties['schema:url']?.datatype === 'url' &&
        (citations.length ? citations : [{ part: emptyCitation.current, group: -1, index: -1 }]).map((citation) => {
          const id = controlId(`${screenRowId(row)}-${partKey(citation.part)}`, 'fact', 'value');
          const key = partKey(citation.part);
          const activePlaceholder = () => citation.group < 0 && key === partKey(emptyCitation.current);
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
                  change(
                    (current) => {
                      let found = false;
                      const references = current.references.map((reference) => ({
                        ...reference,
                        parts: reference.parts.map((part) => {
                          if (partKey(part) !== key) return part;
                          found = true;
                          return partValue(part, { type: 'value', content: url });
                        }),
                      }));
                      if (found) return { ...current, references };
                      if (
                        activePlaceholder() &&
                        !current.references.some((reference) =>
                          reference.parts.some((part) => part.property.id === 'schema:url'),
                        )
                      )
                        return url
                          ? {
                              ...current,
                              references: [
                                ...current.references,
                                { parts: [partValue(citation.part, { type: 'value', content: url })] },
                              ],
                            }
                          : current;
                    },
                    citation.part,
                    activePlaceholder,
                  );
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
                    emptyCitation.current = { property: { id: 'schema:url' }, value: { type: 'value', content: '' } };
                    change(
                      (current) => ({
                        ...current,
                        references: current.references.flatMap((reference) => {
                          if (!reference.parts.some((part) => partKey(part) === key)) return [reference];
                          const parts = reference.parts.filter((part) => partKey(part) !== key);
                          return parts.length ? [{ ...reference, parts }] : [];
                        }),
                      }),
                      citation.part,
                    );
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
  const edit = (
    rowKey: string,
    propertyId: string,
    update: (statement: StatementInput, release: Release) => StatementInput | undefined,
    part?: SnakInput,
    allowMissingPart?: () => boolean,
  ) => {
    const state = current.current;
    if (!mounted.current || state.disabled) return false;
    const row = state.rows.find((item) => item.key === rowKey && item.statement.property.id === propertyId);
    if (!row) return false;
    if (part) {
      const key = partKey(part);
      const present =
        row.statement.qualifiers?.some((item) => partKey(item) === key) ||
        row.statement.references.some((reference) => reference.parts.some((item) => partKey(item) === key));
      if (!present && !allowMissingPart?.()) return false;
    }
    const statement = update(row.statement, state.release);
    if (!statement) return false;
    if (statement !== row.statement) {
      const next = state.rows.map((item) => (item.key === rowKey ? { ...item, statement } : item));
      current.current = { ...state, rows: next };
      state.change(next);
    }
    return true;
  };
  const addQualifier: ScreenQualifierAdd = (rowKey, propertyId, qualifierId) => {
    const state = current.current;
    const row = state.rows.find((item) => item.key === rowKey && item.statement.property.id === propertyId);
    const definition = state.release.properties[propertyId];
    const qualifiers = row?.statement.qualifiers ?? [];
    if (
      !mounted.current ||
      state.disabled ||
      !state.fields.includes(propertyId) ||
      !row ||
      !definition?.qualifiers.includes(qualifierId) ||
      !state.release.properties[qualifierId] ||
      qualifiers.length >= 16 ||
      qualifiers.some((part) => part.property.id === qualifierId)
    )
      return false;
    const next = state.rows.map((item) =>
      item.key === rowKey
        ? {
            ...item,
            statement: {
              ...item.statement,
              qualifiers: [
                ...qualifiers,
                { property: { id: qualifierId }, value: { type: 'value' as const, content: '' } },
              ],
            },
          }
        : item,
    );
    current.current = { ...state, rows: next };
    state.change(next);
    return true;
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
      statement: {
        property: { id: state.property },
        value: { type: 'value', content: '' },
        qualifiers: [],
        references: [],
        rank: 'normal',
      },
    };
    const next = [...state.rows, row];
    if (keyboard && document.activeElement === trigger) pendingFocus.current = { row, trigger };
    current.current = { ...state, rows: next };
    state.change(next);
    setProperty('');
  };
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
              parentAdmitted={fields.includes(row.statement.property.id)}
              change={(update, part, allowMissingPart) =>
                edit(row.key, row.statement.property.id, update, part, allowMissingPart)
              }
              addQualifier={addQualifier}
            />
            <ScreenInitialRemove
              row={row}
              disabled={disabled}
              locale={locale}
              onRemove={() => removeRow(row.key, row.statement.property.id)}
            />
          </section>
        </ContentItemFrame>
      ))}
      <p className="text-sm text-muted-foreground">{m.screen_authored_after({}, o)}</p>
    </fieldset>
  );
}
