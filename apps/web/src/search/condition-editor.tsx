import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  FILTER_LIMITS,
  facetProperties,
  type FilterDocument,
  type FilterQualifier,
  type FilterRange,
} from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { localizedLabel } from './results';
import { ConditionRangeInput } from './condition-range-input';
import { ConditionLanguages } from './condition-languages';
import { ConditionSavedFilter, editSavedFilterTree, type SavedFilterEditMode } from './condition-saved-filter';
import {
  CONDITION_POINTER,
  conditionChoiceLabels,
  conditionFieldIssues,
  conditionTreeAdmission,
  type ConditionIssue,
  type ConditionMetadata,
} from './condition-editor-model';
import { findConditionErrorTarget, isConditionEditorPointer } from './condition-error-target';
import { conditionFieldChoices as buildConditionFieldChoices } from './condition-field-choices';
import {
  changeQualifierProperty,
  changeStatementProperty,
  resolveConditionPropertyChange,
} from './condition-property-edit';
import {
  conditionDraftNodeAt,
  createConditionEditFocus,
} from './condition-edit-focus';
import {
  conditionTreeCanSubmit,
  createConditionDraftNode,
  editConditionDraftNode,
  editConditionTree,
  type ConditionDraftNode,
  type ConditionTreeEdit,
  type ConditionTreePath,
} from './condition-tree-edit';

type Choice = { value: string; labels: Record<string, string> };
type MessageOptions = { locale: (typeof locales)[number] };
type PendingPropertyChange =
  | { kind: 'statement'; property: string }
  | { kind: 'qualifier'; index: number; property: string };
type EditorContext = {
  metadata: ConditionMetadata;
  locale: string;
  options: MessageOptions;
  issues: readonly ConditionIssue[];
  values: Record<string, Choice[]>;
  announce(message: string, pointer: string): void;
  canEditTree(path: ConditionTreePath, edit: ConditionTreeEdit): boolean;
  editTree(path: ConditionTreePath, edit: ConditionTreeEdit): boolean;
  changeCondition(path: ConditionTreePath, value: FilterDocument | undefined, retain: boolean): void;
  savedFilters: readonly string[];
  canSelectSavedFilter(path: ConditionTreePath, id: string, mode: SavedFilterEditMode): boolean;
  selectSavedFilter(path: ConditionTreePath, id: string, mode: SavedFilterEditMode): boolean;
  extension?: ConditionExtension | undefined;
};
/** A consumer can compose additional shared grammar leaves without a second tree editor or evaluator. */
export type ConditionExtension = {
  choices: { label: string; value: FilterDocument }[];
  render(value: FilterDocument, onChange: (value: FilterDocument) => void): ReactNode;
};

function messageOptions(locale: string): MessageOptions {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function fieldErrorText(code: string, field: string, options: MessageOptions) {
  if (code === 'required') return m.search_reader_condition_required({ field }, options);
  if (code === 'unsupported' || code === 'unknown_field')
    return m.search_reader_condition_unsupported({ field }, options);
  if (code === 'invalid_type') return m.search_reader_condition_type({ field }, options);
  if (code === 'invalid_format') return m.search_reader_condition_format({ field }, options);
  return m.search_reader_condition_invalid({ field }, options);
}

function summaryErrorText(issue: ConditionIssue, options: MessageOptions) {
  if (issue.pointer.startsWith('/text')) return m.condition_text_error({}, options);
  if (issue.pointer.startsWith('/cursor')) return m.condition_cursor_error({}, options);
  if (issue.code === 'out_of_range') return m.search_reader_condition_filter_review({}, options);
  return m.search_reader_condition_fields_review({}, options);
}

/** The existing Filters form composes shared fields; shadcn has no FilterDocument tree editor. */
export function ConditionEditor({
  value,
  onChange,
  metadata,
  locale,
  issues = [],
  values = {},
  disabled = false,
  languages,
  onLanguages,
  extension,
  embedded = false,
}: {
  value?: FilterDocument | undefined;
  onChange(value: FilterDocument | undefined): void;
  metadata?: ConditionMetadata | undefined;
  locale: string;
  issues?: readonly ConditionIssue[];
  values?: Record<string, Choice[]>;
  disabled?: boolean;
  languages?: string[] | undefined;
  onLanguages?(languages: string[]): void;
  extension?: ConditionExtension;
  embedded?: boolean;
}) {
  const options = messageOptions(locale);
  const root = useRef<HTMLDivElement>(null);
  const serial = useRef(0);
  const nextKey = () => ++serial.current;
  let [session, setSession] = useState(() => ({
    value,
    node: value ? createConditionDraftNode(value, nextKey) : undefined,
  }));
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const recovery = useRef(
    createConditionEditFocus({
      root: () => root.current,
      current: () => Boolean(root.current?.isConnected) && !disabledRef.current,
    }),
  );
  // Only documents emitted by this session inherit its drafts. Revert and external
  // replacements start fresh, even when they reuse an earlier document object.
  if (session.value !== value) {
    recovery.current.cancel();
    session = { value, node: value ? createConditionDraftNode(value, nextKey) : undefined };
    setSession(session);
  }
  useEffect(() => {
    const focus = recovery.current;
    return () => focus.cancel();
  }, []);
  useEffect(() => {
    if (disabled) recovery.current.cancel();
  }, [disabled]);
  const publish = (next: FilterDocument | undefined, node: ConditionDraftNode | undefined) => {
    session = { value: next, node };
    setSession(session);
    onChange(next);
  };
  const [announcement, setAnnouncement] = useState({ text: '', version: 0 });
  const announce = (message: string, pointer: string) => {
    setAnnouncement((previous) => ({ text: message, version: previous.version + 1 }));
    recovery.current.recover({
      pointer,
      nodeKey: conditionDraftNodeAt(session.node, pointer)?.key,
      source: root.current?.ownerDocument.activeElement ?? null,
    });
  };
  const canEditTree = (path: ConditionTreePath, edit: ConditionTreeEdit) =>
    value !== undefined && editConditionTree(value, path, edit).accepted;
  const editTree = (path: ConditionTreePath, edit: ConditionTreeEdit, retainReplacement = false) => {
    if (value === undefined) return false;
    const result = editConditionTree(value, path, edit);
    if (!result.accepted) return false;
    publish(result.value, editConditionDraftNode(session.node!, path, edit, nextKey, retainReplacement));
    return true;
  };
  const admitsCondition = useMemo(
    () => (metadata ? conditionTreeAdmission(metadata, extension ? { owner: true } : undefined) : undefined),
    [metadata, extension !== undefined],
  );
  const savedFilters = metadata ? Object.keys(metadata.filters ?? {}) : [];
  const getSavedFilterEdit = (path: ConditionTreePath, id: string, mode: SavedFilterEditMode) => {
    if (!value || !admitsCondition) return undefined;
    return editSavedFilterTree(value, path, id, mode, admitsCondition);
  };
  const canSelectSavedFilter = (path: ConditionTreePath, id: string, mode: SavedFilterEditMode) =>
    getSavedFilterEdit(path, id, mode) !== undefined;
  const selectSavedFilter = (path: ConditionTreePath, id: string, mode: SavedFilterEditMode) => {
    const next = getSavedFilterEdit(path, id, mode);
    if (!next) return false;
    const edit: ConditionTreeEdit =
      mode === 'append' ? { type: 'append', value: { saved: id } } : { type: 'replace', value: { saved: id } };
    publish(next, editConditionDraftNode(session.node!, path, edit, nextKey));
    return true;
  };
  const context: EditorContext | undefined = metadata
    ? {
        metadata,
        locale,
        options,
        issues,
        values,
        announce,
        canEditTree,
        editTree,
        changeCondition: (path, next, retain) =>
          editTree(path, next ? { type: 'replace', value: next } : { type: 'remove' }, retain),
        savedFilters,
        canSelectSavedFilter,
        selectSavedFilter,
        extension,
      }
    : undefined;
  return (
    <div ref={root} className="min-w-0 space-y-3 border-t border-border/60 pt-4" data-condition-editor>
      <h2 className="font-medium">{m.condition_heading({}, options)}</h2>
      <p className="text-sm text-muted-foreground">
        {embedded ? m.library_rule_hint({}, options) : m.condition_hint({}, options)}
      </p>
      {!embedded && (
        <details className="text-sm">
          <summary className="min-h-10 cursor-pointer content-center rounded-lg px-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
            {m.search_reader_condition_limits_title({}, options)}
          </summary>
          <p className="mt-1 text-muted-foreground">{m.search_reader_condition_limits({}, options)}</p>
        </details>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        <span key={announcement.version}>{announcement.text}</span>
      </p>
      {onLanguages && (
        <ConditionLanguages languages={languages ?? []} locale={locale} disabled={disabled} onChange={onLanguages} />
      )}
      {issues.length > 0 && (
        <div role="alert" tabIndex={-1} data-condition-errors className="space-y-1 text-sm text-destructive">
          {issues.map((issue, index) => (
            <p
              key={`${issue.pointer}:${issue.code}:${index}`}
              data-error-pointer={issue.pointer}
              data-error-code={issue.code}
            >
              {summaryErrorText(issue, options)}
              {isConditionEditorPointer(issue.pointer) && (
                <button
                  type="button"
                  className="ml-2 font-medium underline underline-offset-2"
                  onClick={() => findConditionErrorTarget(root.current, issue.pointer)?.element.focus()}
                >
                  {m.condition_error_jump_target({}, options)}
                </button>
              )}
            </p>
          ))}
        </div>
      )}
      <fieldset disabled={disabled} className="min-w-0">
        {context ? (
          <>
            {value ? (
              <NodeEditor
                key={session.node!.key}
                draft={session.node!}
                value={value}
                pointer={CONDITION_POINTER}
                path={[]}
                context={context}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const next: FilterDocument = { and: [{ type: { in: [''] } }] };
                  publish(next, createConditionDraftNode(next, nextKey));
                  announce(m.condition_added({}, options), `${CONDITION_POINTER}/and/0`);
                }}
              >
                {m.condition_add({}, options)}
              </Button>
            )}
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {m.condition_metadata_unavailable({}, options)}
          </p>
        )}
      </fieldset>
      {value && <input type="hidden" name="condition" value={JSON.stringify(value)} />}
      {!embedded && (
        <Button type="submit" variant="outline" disabled={disabled || !conditionTreeCanSubmit(value)}>
          {m.search_apply({}, options)}
        </Button>
      )}
    </div>
  );
}

function EditorField({
  context,
  pointer,
  label,
  children,
  exact = false,
}: {
  context: EditorContext;
  pointer: string;
  label: string;
  exact?: boolean;
  children(props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }): ReactNode;
}) {
  const id = useId();
  const errors = conditionFieldIssues(context.issues, pointer).filter(
    (issue) => !exact || issue.pointer === pointer || pointer.startsWith(`${issue.pointer}/`),
  );
  const firstError = errors[0];
  const fieldSpecific = firstError && !exact && firstError.pointer === pointer && firstError.code !== 'out_of_range';
  return (
    <Field data-invalid={errors.length > 0 || undefined} data-condition-field-pointer={pointer}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children({
        id,
        'aria-invalid': errors.length > 0,
        ...(errors.length ? { 'aria-describedby': `${id}-error` } : {}),
      })}
      {errors.length > 0 && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {fieldSpecific
            ? fieldErrorText(firstError!.code, label, context.options)
            : m.search_reader_condition_filter_review({}, context.options)}
        </p>
      )}
    </Field>
  );
}

function NodeEditor({
  value,
  draft,
  pointer,
  path,
  context,
}: {
  value: FilterDocument;
  draft: ConditionDraftNode;
  pointer: string;
  path: ConditionTreePath;
  context: EditorContext;
}) {
  const { options } = context;
  const onChange = (next: FilterDocument | undefined) => {
    const replacesRange =
      next &&
      'statement' in value &&
      'statement' in next &&
      value.statement.property !== next.statement.property &&
      ('range' in value.statement ? value.statement.range : undefined) !==
        ('range' in next.statement ? next.statement.range : undefined);
    context.changeCondition(path, next, !replacesRange);
  };
  const groupOperator = 'and' in value ? 'and' : 'or' in value ? 'or' : undefined;
  const operator = groupOperator ?? ('not' in value ? 'not' : '');
  const group = 'and' in value ? value.and : 'or' in value ? value.or : undefined;
  const label =
    operator === 'and'
      ? m.condition_and({}, options)
      : operator === 'or'
        ? m.condition_or({}, options)
        : operator === 'not'
          ? m.condition_not({}, options)
          : 'saved' in value
            ? m.condition_saved_filter_label({ id: value.saved }, options)
            : 'type' in value
              ? m.search_type({}, options)
              : 'statement' in value
                ? m.condition_statement({}, options)
                : m.condition_leaf({}, options);
  const extensionLeaf = context.extension?.render(value, onChange);
  const name = (labels: Record<string, string> | undefined, fallback: string) =>
    localizedLabel(labels ?? {}, context.locale).text || fallback;
  const property = 'statement' in value ? value.statement.property : undefined;
  const definition = property ? context.metadata.properties[property] : undefined;
  const range = 'statement' in value && 'range' in value.statement ? value.statement.range : undefined;
  const [pendingPropertyChange, setPendingPropertyChange] = useState<PendingPropertyChange>();
  const propertyChangeDialog = useRef<HTMLDialogElement>(null);
  const propertyChangeId = useId();
  useEffect(() => {
    if (pendingPropertyChange && propertyChangeDialog.current && !propertyChangeDialog.current.open) {
      propertyChangeDialog.current.showModal();
    }
  }, [pendingPropertyChange]);
  const properties = facetProperties(context.metadata, Object.keys(context.metadata.types));
  const fieldChoices = (ids: readonly string[], selected: string) => {
    const choices = ids.map((id) => ({
      value: id,
      label: name(context.metadata.properties[id]?.labels, id),
    }));
    return buildConditionFieldChoices(choices, selected, name(context.metadata.properties[selected]?.labels, selected));
  };
  const replaceStatement = (
    next: Partial<{
      property: string;
      in: readonly string[];
      range: FilterRange;
      qualifiers: readonly FilterQualifier[];
    }>,
  ) => {
    if (!('statement' in value)) return;
    onChange({ statement: { ...value.statement, ...next } });
  };
  const selectStatementProperty = (nextProperty: string) => {
    const transition = changeStatementProperty(value, nextProperty, context.metadata.properties);
    setPendingPropertyChange(undefined);
    if (transition.requiresConfirmation) setPendingPropertyChange({ kind: 'statement', property: nextProperty });
    else onChange(transition.next);
  };
  const selectQualifierProperty = (index: number, nextProperty: string) => {
    const transition = changeQualifierProperty(value, index, nextProperty, context.metadata.properties);
    setPendingPropertyChange(undefined);
    if (transition.requiresConfirmation) setPendingPropertyChange({ kind: 'qualifier', index, property: nextProperty });
    else onChange(transition.next);
  };
  const resolvePendingPropertyChange = (confirmed: boolean) => {
    if (!pendingPropertyChange) return;
    const transition =
      pendingPropertyChange.kind === 'statement'
        ? changeStatementProperty(value, pendingPropertyChange.property, context.metadata.properties)
        : changeQualifierProperty(
            value,
            pendingPropertyChange.index,
            pendingPropertyChange.property,
            context.metadata.properties,
          );
    onChange(resolveConditionPropertyChange(transition, confirmed));
    setPendingPropertyChange(undefined);
  };
  const remove = () => {
    if (context.editTree(path, { type: 'remove' }))
      context.announce(m.condition_removed({}, options), pointer.replace(/\/(and|or)\/\d+$|\/not$/, ''));
  };
  return (
    <FieldSet
      className="min-w-0 gap-3 rounded-lg border border-border/60 p-3"
      data-condition-pointer={pointer}
      data-condition-node={draft.key}
      tabIndex={-1}
    >
      <FieldLegend variant="label">{label}</FieldLegend>
      <div className="flex flex-wrap items-end gap-2">
        <EditorField context={context} pointer={pointer} label={m.condition_group({}, options)} exact>
          {(props) => (
            <NativeSelect
              {...props}
              value={operator}
              onChange={(event) => {
                const next = event.currentTarget.value;
                const changed =
                  next === 'and' || next === 'or' || next === 'not'
                    ? context.editTree(path, { type: 'operator', operator: next })
                    : next === '' && 'not' in value
                      ? context.editTree(path, { type: 'unwrap' })
                      : false;
                if (changed) context.announce(m.condition_group_changed({}, options), pointer);
              }}
            >
              <NativeSelectOption value="" disabled={!!group}>
                {operator === 'not' ? m.condition_unwrap({}, options) : m.condition_leaf({}, options)}
              </NativeSelectOption>
              <NativeSelectOption
                value="and"
                disabled={!context.canEditTree(path, { type: 'operator', operator: 'and' })}
              >
                {m.condition_and({}, options)}
              </NativeSelectOption>
              <NativeSelectOption
                value="or"
                disabled={!context.canEditTree(path, { type: 'operator', operator: 'or' })}
              >
                {m.condition_or({}, options)}
              </NativeSelectOption>
              <NativeSelectOption
                value="not"
                disabled={operator === 'not' || !context.canEditTree(path, { type: 'operator', operator: 'not' })}
              >
                {m.condition_not({}, options)}
              </NativeSelectOption>
            </NativeSelect>
          )}
        </EditorField>
        <Button type="button" variant="ghost" size="sm" onClick={remove}>
          {m.condition_remove({}, options)}
        </Button>
      </div>
      {group && (
        <>
          {group.length === 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              {m.condition_tree_empty_group({}, options)}
            </p>
          )}
          {group.map((child, index) => (
            <NodeEditor
              key={draft.children[index]!.key}
              draft={draft.children[index]!}
              value={child}
              pointer={`${pointer}/${operator}/${index}`}
              path={[...path, groupOperator!, index]}
              context={context}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {(['type', 'statement'] as const).map((kind) => {
              const node: FilterDocument =
                kind === 'type' ? { type: { in: [''] } } : { statement: { property: '', in: [''] } };
              const edit = { type: 'append', value: node } as const;
              return (
                <Button
                  key={kind}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!context.canEditTree(path, edit)}
                  onClick={() => {
                    if (context.editTree(path, edit))
                      context.announce(m.condition_added({}, options), `${pointer}/${operator}/${group.length}`);
                  }}
                >
                  {kind === 'type' ? m.condition_add_type({}, options) : m.condition_add_statement({}, options)}
                </Button>
              );
            })}
          </div>
          {context.extension?.choices.map((choice, index) => (
            <Button
              key={index}
              type="button"
              variant="outline"
              size="sm"
              disabled={!context.canEditTree(path, { type: 'append', value: choice.value })}
              onClick={() => {
                if (context.editTree(path, { type: 'append', value: choice.value }))
                  context.announce(m.condition_added({}, options), `${pointer}/${operator}/${group.length}`);
              }}
            >
              {choice.label}
            </Button>
          ))}
          <ConditionSavedFilter
            filters={context.savedFilters}
            locale={context.locale}
            canSelect={(id) => context.canSelectSavedFilter(path, id, 'append')}
            onSelect={(id) => {
              const added = context.selectSavedFilter(path, id, 'append');
              if (added) context.announce(m.condition_added({}, options), `${pointer}/${operator}/${group.length}`);
              return added;
            }}
          />
        </>
      )}
      {'not' in value && (
        <NodeEditor
          key={draft.children[0]!.key}
          draft={draft.children[0]!}
          value={value.not}
          pointer={`${pointer}/not`}
          path={[...path, 'not']}
          context={context}
        />
      )}
      {extensionLeaf}
      {'type' in value && (
        <ValueFields
          context={context}
          closed
          pointer={`${pointer}/type/in`}
          values={value.type.in}
          choices={Object.entries(context.metadata.types).map(([value, definition]) => ({
            value,
            labels: definition.labels ?? {},
          }))}
          onChange={(selected) => onChange({ type: { in: selected } })}
        />
      )}
      {'statement' in value && (
        <>
          <EditorField
            context={context}
            pointer={`${pointer}/statement/property`}
            label={m.refinement_property({}, options)}
          >
            {(props) => (
              <NativeSelect
                {...props}
                value={property}
                onChange={(event) => {
                  selectStatementProperty(event.currentTarget.value);
                }}
              >
                <NativeSelectOption value="">{m.refinement_choose_property({}, options)}</NativeSelectOption>
                {fieldChoices(properties, property ?? '').map(({ value, label }) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </EditorField>
          <p className="text-sm text-muted-foreground">{definition?.datatype}</p>
          {range ? (
            <>
              {(['gte', 'lte'] as const).map((bound) => {
                const label = bound === 'gte' ? m.refinement_lower({}, options) : m.refinement_upper({}, options);
                return (
                  <EditorField
                    key={bound}
                    context={context}
                    pointer={`${pointer}/statement/range/${bound}`}
                    label={label}
                  >
                    {(props) => (
                      <ConditionRangeInput
                        {...props}
                        draft={draft.ranges[bound]}
                        datatype={definition?.datatype === 'time' ? 'time' : 'quantity'}
                        locale={context.locale}
                        label={label}
                        value={range[bound]}
                        onValue={(number) => {
                          const next = { ...range };
                          if (number === undefined) delete next[bound];
                          else next[bound] = number;
                          replaceStatement({ range: next });
                        }}
                      />
                    )}
                  </EditorField>
                );
              })}
              {definition?.datatype === 'time' && (
                <p className="text-sm text-muted-foreground">{m.refinement_year_hint({}, options)}</p>
              )}
              {(definition?.datatype !== 'time' || range.unit !== undefined) && (
                <EditorField
                  context={context}
                  pointer={`${pointer}/statement/range/unit`}
                  label={m.refinement_unit({}, options)}
                >
                  {(props) => (
                    <NativeSelect
                      {...props}
                      value={range.unit ?? ''}
                      onChange={(event) => {
                        const next = { ...range };
                        if (event.currentTarget.value) next.unit = event.currentTarget.value;
                        else delete next.unit;
                        replaceStatement({ range: next });
                      }}
                    >
                      <NativeSelectOption value="">{m.condition_choose_value({}, options)}</NativeSelectOption>
                      {range.unit && !definition?.units?.includes(range.unit) && (
                        <NativeSelectOption value={range.unit}>{range.unit}</NativeSelectOption>
                      )}
                      {definition?.units?.map((unit) => (
                        <NativeSelectOption key={unit} value={unit}>
                          {unit}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </EditorField>
              )}
            </>
          ) : (
            'in' in value.statement && (
              <ValueFields
                context={context}
                pointer={`${pointer}/statement/in`}
                values={value.statement.in}
                choices={context.values[property ?? '']}
                onChange={(selected) => replaceStatement({ in: selected })}
              />
            )
          )}
          {value.statement.qualifiers?.map((qualifier, index) => (
            <FieldSet
              key={index}
              className="min-w-0 gap-3 border-t border-border/60 pt-3"
              data-condition-pointer={`${pointer}/statement/qualifiers/${index}`}
              tabIndex={-1}
            >
              <FieldLegend variant="label">{m.condition_qualifier({}, options)}</FieldLegend>
              <EditorField
                context={context}
                pointer={`${pointer}/statement/qualifiers/${index}/property`}
                label={m.refinement_property({}, options)}
              >
                {(props) => (
                  <NativeSelect
                    {...props}
                    value={qualifier.property}
                    onChange={(event) => selectQualifierProperty(index, event.currentTarget.value)}
                  >
                    <NativeSelectOption value="">{m.refinement_choose_property({}, options)}</NativeSelectOption>
                    {fieldChoices(definition?.qualifiers ?? [], qualifier.property).map(({ value, label }) => (
                      <NativeSelectOption key={value} value={value}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </EditorField>
              <ValueFields
                context={context}
                pointer={`${pointer}/statement/qualifiers/${index}/in`}
                values={qualifier.in}
                choices={context.values[qualifier.property]}
                onChange={(selected) =>
                  replaceStatement({
                    qualifiers: value.statement.qualifiers!.map((entry, at) =>
                      at === index ? { ...entry, in: selected } : entry,
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const qualifiers = value.statement.qualifiers!.filter((_, at) => at !== index);
                  const { qualifiers: _old, ...statement } = value.statement;
                  onChange({ statement: { ...statement, ...(qualifiers.length ? { qualifiers } : {}) } });
                  context.announce(m.condition_removed({}, options), pointer);
                }}
              >
                {m.condition_remove({}, options)}
              </Button>
            </FieldSet>
          ))}
          {!!definition?.qualifiers?.length && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={(value.statement.qualifiers?.length ?? 0) >= FILTER_LIMITS.qualifiers}
              onClick={() => {
                replaceStatement({ qualifiers: [...(value.statement.qualifiers ?? []), { property: '', in: [''] }] });
                context.announce(m.condition_added({}, options), pointer);
              }}
            >
              {m.condition_add_qualifier({}, options)}
            </Button>
          )}
        </>
      )}
      {'saved' in value && !extensionLeaf && (
        <ConditionSavedFilter
          filters={context.savedFilters}
          value={value.saved}
          locale={context.locale}
          canSelect={(id) => context.canSelectSavedFilter(path, id, 'replace')}
          onSelect={(id) => context.selectSavedFilter(path, id, 'replace')}
        />
      )}
      {'owner' in value && !extensionLeaf && (
        <p className="text-sm text-muted-foreground">{m.condition_retained({}, options)}</p>
      )}
      {pendingPropertyChange && (
        <dialog
          ref={propertyChangeDialog}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`${propertyChangeId}-title`}
          aria-describedby={`${propertyChangeId}-description`}
          className="max-w-lg rounded-lg border border-border bg-background p-4 text-foreground shadow-xl backdrop:bg-black/50"
          onCancel={(event) => {
            event.preventDefault();
            resolvePendingPropertyChange(false);
          }}
        >
          <h2 id={`${propertyChangeId}-title`} className="font-semibold">
            {m.condition_property_change_title({}, options)}
          </h2>
          <p className="mt-2 font-medium">
            {pendingPropertyChange.property
              ? name(
                  context.metadata.properties[pendingPropertyChange.property]?.labels,
                  pendingPropertyChange.property,
                )
              : m.refinement_choose_property({}, options)}
          </p>
          <p id={`${propertyChangeId}-description`} className="mt-2 text-sm text-muted-foreground">
            {m.condition_property_change_message({}, options)}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" autoFocus onClick={() => resolvePendingPropertyChange(false)}>
              {m.condition_property_change_cancel({}, options)}
            </Button>
            <Button type="button" onClick={() => resolvePendingPropertyChange(true)}>
              {m.condition_property_change_confirm({}, options)}
            </Button>
          </div>
        </dialog>
      )}
    </FieldSet>
  );
}

function ValueFields({
  values,
  choices,
  onChange,
  pointer,
  context,
  closed = false,
}: {
  values: readonly string[];
  choices?: Choice[] | undefined;
  onChange(values: string[]): void;
  pointer: string;
  context: EditorContext;
  closed?: boolean;
}) {
  const choicesId = useId();
  const options = closed
    ? conditionChoiceLabels(
        (choices ?? []).map(({ value, labels }) => ({ value, label: localizedLabel(labels, context.locale).text })),
      )
    : [];
  return (
    <div className="min-w-0 space-y-2">
      {!closed && !!choices?.length && (
        <datalist id={choicesId}>
          {choices.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {localizedLabel(entry.labels, context.locale).text || entry.value}
            </option>
          ))}
        </datalist>
      )}
      {values.map((value, index) => (
        <div key={index} className="flex items-end gap-1">
          <EditorField
            context={context}
            pointer={`${pointer}/${index}`}
            label={m.condition_value({ number: index + 1 }, context.options)}
          >
            {(props) =>
              closed && choices?.length ? (
                <NativeSelect
                  {...props}
                  value={value}
                  onChange={(event) =>
                    onChange(values.map((entry, at) => (at === index ? event.currentTarget.value : entry)))
                  }
                >
                  <NativeSelectOption value="">{m.condition_choose_value({}, context.options)}</NativeSelectOption>
                  {value && !choices.some((entry) => entry.value === value) && (
                    <NativeSelectOption value={value}>{value}</NativeSelectOption>
                  )}
                  {options.map((entry) => (
                    <NativeSelectOption key={entry.value} value={entry.value}>
                      {entry.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  {...props}
                  value={value}
                  list={choices?.length ? choicesId : undefined}
                  onChange={(event) =>
                    onChange(values.map((entry, at) => (at === index ? event.currentTarget.value : entry)))
                  }
                />
              )
            }
          </EditorField>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={m.refinement_remove(
              { value: m.condition_value({ number: index + 1 }, context.options) },
              context.options,
            )}
            onClick={() => {
              onChange(values.filter((_, at) => at !== index));
              context.announce(m.condition_removed({}, context.options), pointer.replace(/\/(type|statement).*$/, ''));
            }}
          >
            {m.condition_remove({}, context.options)}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={values.length >= FILTER_LIMITS.in}
        onClick={() => {
          onChange([...values, '']);
          context.announce(m.condition_added({}, context.options), pointer.replace(/\/(type|statement).*$/, ''));
        }}
      >
        {m.condition_add_value({}, context.options)}
      </Button>
    </div>
  );
}
