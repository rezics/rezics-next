import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { EntityPicker } from '@rezics/ui/entity-picker';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { coverSrc } from '../media/cover-src';
import { localizedLabel } from './results';
import { useWorkspaceAdmission, useReaderAddress } from '../session/reader';
import { conditionPresetCatalogue, type ConditionPresetCatalogue } from './condition-preset-model';
import { ConditionPresetName } from './condition-preset';
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
import { conditionDraftNodeAt, createConditionEditFocus } from './condition-edit-focus';
import { createRequestResourceConditionExtension } from './resource-condition-editor';
import type { RequestResourceInput } from './resource-condition-model';
import {
  appendConditionEntity,
  conditionEntityRequestIdentity,
  ConditionEntityLookupError,
  isConditionEntityIdentifier,
  resolveConditionEntityLabels,
  searchConditionEntities,
  type ConditionEntityContext,
  type ConditionEntityFailure,
} from './condition-entity';
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
  disabled: boolean;
  issues: readonly ConditionIssue[];
  values: Record<string, Choice[]>;
  entityLookup?: ConditionEntityContext | undefined;
  announce(message: string, pointer: string): void;
  canEditTree(path: ConditionTreePath, edit: ConditionTreeEdit): boolean;
  editTree(path: ConditionTreePath, edit: ConditionTreeEdit): boolean;
  changeCondition(path: ConditionTreePath, value: FilterDocument | undefined, retain: boolean): void;
  presets: ConditionPresetCatalogue;
  presetOwner: object;
  canSelectSavedFilter(path: ConditionTreePath, id: string, mode: SavedFilterEditMode): boolean;
  selectSavedFilter(path: ConditionTreePath, id: string, mode: SavedFilterEditMode): boolean;
  extension?: ConditionExtension | undefined;
};
/** A consumer can compose additional shared grammar leaves without a second tree editor or evaluator. */
export type ConditionExtension = {
  choices: { label: string; value: FilterDocument }[];
  label?(value: FilterDocument, context?: { locale: string }): string | undefined;
  render(
    value: FilterDocument,
    onChange: (value: FilterDocument) => void,
    context?: { pointer: string; locale: string; issues: readonly ConditionIssue[] },
  ): ReactNode;
};

const PRESET_OPERATIONS = [] as const;

const EMPTY_REQUEST_RESOURCES: RequestResourceInput = Object.freeze({});

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
  entityLookup,
  languages,
  onLanguages,
  extension,
  requestResources,
  embedded = false,
  requestIdentity,
}: {
  value?: FilterDocument | undefined;
  onChange(value: FilterDocument | undefined): void;
  metadata?: ConditionMetadata | undefined;
  locale: string;
  issues?: readonly ConditionIssue[];
  values?: Record<string, Choice[]>;
  disabled?: boolean;
  entityLookup?: ConditionEntityContext | undefined;
  languages?: string[] | undefined;
  onLanguages?(languages: string[]): void;
  extension?: ConditionExtension;
  /** Optional native labels for request-only resource IDs; labels are display data and never resolve IDs. */
  requestResources?: RequestResourceInput | false;
  embedded?: boolean;
  requestIdentity?: string | undefined;
}) {
  const options = messageOptions(locale);
  const { store, value: reader } = useWorkspaceAdmission(PRESET_OPERATIONS);
  const address = useReaderAddress(null, undefined, locale);
  const readerKey = JSON.stringify([reader.subject, reader.viewer, reader.observation?.id]);
  const presetCurrent = () => {
    const now = store.read();
    return address.isCurrent() && readerKey === JSON.stringify([now.subject, now.viewer, now.observation?.id]);
  };
  const root = useRef<HTMLDivElement>(null);
  const serial = useRef(0);
  const nextKey = () => ++serial.current;
  let [session, setSession] = useState(() => ({
    value,
    lifetime: {},
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
  const focusOwner = JSON.stringify([
    locale,
    readerKey,
    address.key,
    requestIdentity,
    metadata?.digest,
    entityLookup ? conditionEntityRequestIdentity('condition-editor', '', [], entityLookup) : null,
  ]);
  const focusOwnerRef = useRef(focusOwner);
  const focusMetadataRef = useRef(metadata);
  if (focusOwnerRef.current !== focusOwner || focusMetadataRef.current !== metadata) {
    focusMetadataRef.current = metadata;
    recovery.current.cancel();
    focusOwnerRef.current = focusOwner;
  }
  // Only documents emitted by this session inherit its drafts. Revert and external
  // replacements start fresh, even when they reuse an earlier document object.
  if (session.value !== value) {
    recovery.current.cancel();
    session = { value, lifetime: {}, node: value ? createConditionDraftNode(value, nextKey) : undefined };
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
    session = { value: next, node, lifetime: session.lifetime };
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
  const presets = useMemo(
    () => (metadata ? conditionPresetCatalogue(metadata, locale) : undefined),
    [metadata, locale],
  );
  const presetOwner = useMemo(() => ({}), [presets, focusOwner, session.lifetime]);
  const getSavedFilterEdit = (path: ConditionTreePath, id: string, mode: SavedFilterEditMode) => {
    if (!value || !admitsCondition || !presetCurrent()) return undefined;
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
  const requestResourceInput = embedded
    ? undefined
    : requestResources === undefined
      ? !extension
        ? EMPTY_REQUEST_RESOURCES
        : undefined
      : requestResources || undefined;
  const resourceExtension = useMemo(
    () => (requestResourceInput ? createRequestResourceConditionExtension(requestResourceInput, locale) : undefined),
    [requestResourceInput, locale],
  );
  const activeExtension = useMemo(() => {
    if (!extension) return resourceExtension;
    if (!resourceExtension) return extension;
    return {
      choices: [...extension.choices, ...resourceExtension.choices],
      label: (node: FilterDocument, detail?: { locale: string }) =>
        resourceExtension.label?.(node, detail) ?? extension.label?.(node, detail),
      render: (
        node: FilterDocument,
        change: (value: FilterDocument) => void,
        detail?: { pointer: string; locale: string; issues: readonly ConditionIssue[] },
      ) => resourceExtension.render(node, change, detail) ?? extension.render(node, change, detail),
    } satisfies ConditionExtension;
  }, [extension, resourceExtension]);
  const admissionOptions = useMemo(
    () =>
      requestResourceInput
        ? { requestResources: true, ...(extension ? { owner: true as const } : {}) }
        : extension
          ? { owner: true as const }
          : undefined,
    [requestResourceInput, extension],
  );
  const admitsCondition = useMemo(
    () => (metadata ? conditionTreeAdmission(metadata, admissionOptions) : undefined),
    [metadata, admissionOptions],
  );
  const context: EditorContext | undefined = metadata
    ? {
        metadata,
        locale,
        options,
        disabled,
        issues,
        values,
        ...(entityLookup ? { entityLookup } : {}),
        announce,
        canEditTree,
        editTree,
        changeCondition: (path, next, retain) =>
          editTree(path, next ? { type: 'replace', value: next } : { type: 'remove' }, retain),
        presets: presets!,
        presetOwner,
        canSelectSavedFilter,
        selectSavedFilter,
        extension: activeExtension,
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

type QualifierDraftIdentity = {
  draftKey: number;
  values: readonly FilterQualifier[];
  keys: string[];
};

function reconcileQualifierKeys(
  previous: QualifierDraftIdentity | undefined,
  draftKey: number,
  values: readonly FilterQualifier[],
  nextKey: () => string,
): QualifierDraftIdentity {
  if (!previous || previous.draftKey !== draftKey) return { draftKey, values, keys: values.map(() => nextKey()) };
  const used = new Set<number>();
  const keys = values.map((value, index) => {
    const sameOccurrence = previous.values.findIndex((candidate, at) => candidate === value && !used.has(at));
    if (sameOccurrence >= 0) {
      used.add(sameOccurrence);
      return previous.keys[sameOccurrence]!;
    }
    if (previous.values[index]?.property === value.property && !used.has(index)) {
      used.add(index);
      return previous.keys[index]!;
    }
    return nextKey();
  });
  return { draftKey, values, keys };
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
  const qualifierIdentity = useRef<QualifierDraftIdentity | undefined>(undefined);
  const qualifierSerial = useRef(0);
  const qualifiers = 'statement' in value ? (value.statement.qualifiers ?? []) : [];
  const qualifierDraft = reconcileQualifierKeys(
    qualifierIdentity.current,
    draft.key,
    qualifiers,
    () => `qualifier-${++qualifierSerial.current}`,
  );
  qualifierIdentity.current = qualifierDraft;
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
  const extensionLabel = context.extension?.label?.(value, { locale: context.locale });
  const label =
    extensionLabel ??
    (operator === 'and' ? (
      m.condition_and({}, options)
    ) : operator === 'or' ? (
      m.condition_or({}, options)
    ) : operator === 'not' ? (
      m.condition_not({}, options)
    ) : 'saved' in value ? (
      <>
        {m.condition_saved_filter_reference({}, options)}:{' '}
        <ConditionPresetName id={value.saved} catalogue={context.presets} />
      </>
    ) : 'type' in value ? (
      m.search_type({}, options)
    ) : 'statement' in value ? (
      m.condition_statement({}, options)
    ) : (
      m.condition_leaf({}, options)
    ));
  const extensionLeaf = context.extension?.render(value, onChange, {
    pointer,
    locale: context.locale,
    issues: context.issues,
  });
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
            catalogue={context.presets}
            owner={context.presetOwner}
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
                    {(props) =>
                      range.type === 'time' ? (
                        <Input
                          {...props}
                          type="text"
                          value={range[bound] ?? ''}
                          onChange={(event) => {
                            const next = { ...range };
                            if (event.target.value === '') delete next[bound];
                            else next[bound] = event.target.value;
                            replaceStatement({ range: next });
                          }}
                        />
                      ) : (
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
                      )
                    }
                  </EditorField>
                );
              })}
              {definition?.datatype === 'time' && range.type !== 'time' && (
                <p className="text-sm text-muted-foreground">{m.refinement_year_hint({}, options)}</p>
              )}
              {range.type !== 'time' && (definition?.datatype !== 'time' || range.unit !== undefined) && (
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
                entity={
                  definition?.datatype === 'wikibase-item' && property
                    ? {
                        property,
                        targets: definition.targets ?? [],
                        occurrence: `${draft.key}:statement`,
                        nodeKey: draft.key,
                      }
                    : undefined
                }
                onChange={(selected) => replaceStatement({ in: selected })}
              />
            )
          )}
          {value.statement.qualifiers?.map((qualifier, index) => (
            <FieldSet
              key={qualifierDraft.keys[index]}
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
                entity={
                  context.metadata.properties[qualifier.property]?.datatype === 'wikibase-item'
                    ? {
                        property: qualifier.property,
                        targets: context.metadata.properties[qualifier.property]?.targets ?? [],
                        occurrence: `${draft.key}:${qualifierDraft.keys[index]}`,
                        nodeKey: draft.key,
                      }
                    : undefined
                }
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
          catalogue={context.presets}
          owner={context.presetOwner}
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

function conditionEntityFailure(error: unknown): ConditionEntityFailure {
  return error instanceof ConditionEntityLookupError ? error.failure : 'unavailable';
}

function conditionEntityFailureText(failure: ConditionEntityFailure, options: MessageOptions): string {
  if (failure === 'restart') return m.search_suggestions_restart({}, options);
  if (failure === 'credentials') return m.search_suggestions_credentials({}, options);
  if (failure === 'invalid') return m.search_suggestions_invalid({}, options);
  if (failure === 'metadata') return m.condition_metadata_unavailable({}, options);
  return m.search_suggestions_unavailable({}, options);
}

function ConditionEntityValues({
  values,
  onChange,
  pointer,
  property,
  targets,
  occurrence,
  nodeKey,
  lookup,
  context,
}: {
  values: readonly string[];
  onChange(values: string[]): void;
  pointer: string;
  property: string;
  targets: readonly string[];
  occurrence: string;
  nodeKey: number;
  lookup: ConditionEntityContext;
  context: EditorContext;
}) {
  const { options } = context;
  const targetsKey = JSON.stringify(targets);
  const valuesKey = JSON.stringify(values);
  const requestIdentity = conditionEntityRequestIdentity(occurrence, property, targets, lookup);
  const requestContext = useMemo(() => lookup, [requestIdentity]);
  const targetTypes = useMemo(() => targets, [targetsKey]);
  const identifiers = [
    ...new Set(values.filter(isConditionEntityIdentifier).map((value) => value.toLowerCase())),
  ].slice(0, FILTER_LIMITS.in);
  const [resolved, setResolved] = useState<Record<string, { label: string; type: string }>>({});
  const [resolveFailure, setResolveFailure] = useState<ConditionEntityFailure>();
  const [suggestionFailure, setSuggestionFailure] = useState<ConditionEntityFailure>();
  const [resolving, setResolving] = useState(identifiers.length > 0 && !context.disabled);
  const [retry, setRetry] = useState(0);
  const attempted = useRef(new Set<string>());
  const [withheld, setWithheld] = useState<string[]>([]);
  const emptyValueIndex = values.findIndex((value) => value === '');
  const pickerNumber = emptyValueIndex >= 0 ? emptyValueIndex + 1 : values.length + 1;
  const chooserPointer = `${pointer}/chooser`;

  useEffect(() => {
    const current = new Set(identifiers);
    for (const id of attempted.current) if (!current.has(id)) attempted.current.delete(id);
    setResolved((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => current.has(id))));
    setWithheld((previous) => previous.filter((id) => current.has(id)));
    setResolveFailure(undefined);
    setSuggestionFailure(undefined);
  }, [identifiers.join('|')]);

  useEffect(() => {
    if (context.disabled) {
      setResolving(false);
      return;
    }
    const needed = identifiers.filter((id) => !resolved[id] && !attempted.current.has(id));
    if (!needed.length) {
      setResolving(false);
      return;
    }
    if (!requestContext.available || targetTypes.length === 0) {
      setResolveFailure(requestContext.available ? 'metadata' : 'unavailable');
      setResolving(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    let completed = false;
    for (const id of needed) attempted.current.add(id);
    setResolveFailure(undefined);
    setResolving(true);
    void resolveConditionEntityLabels(needed, targetTypes, requestContext, controller.signal)
      .then(({ labels, withheld: hidden }) => {
        if (!active) return;
        completed = true;
        setResolved((previous) => ({ ...previous, ...labels }));
        setWithheld((previous) => [...new Set([...previous.filter((id) => !needed.includes(id)), ...hidden])]);
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        completed = true;
        setResolveFailure(conditionEntityFailure(error));
      })
      .finally(() => {
        if (active) setResolving(false);
      });
    return () => {
      active = false;
      controller.abort();
      if (!completed) for (const id of needed) attempted.current.delete(id);
    };
  }, [context.disabled, identifiers.join('|'), requestContext, retry, resolved, targetTypes]);

  const search = useCallback(
    async (query: string, signal: AbortSignal) => {
      setSuggestionFailure(undefined);
      try {
        return await searchConditionEntities(query, targetTypes, requestContext, signal);
      } catch (error) {
        if (!signal.aborted) setSuggestionFailure(conditionEntityFailure(error));
        throw error;
      }
    },
    [requestContext, targetTypes],
  );

  const removeValue = (index: number) => {
    const next = values.filter((_, at) => at !== index);
    onChange(next.length ? next : ['']);
    context.announce(
      m.condition_removed({}, options),
      requestContext.available && targetTypes.length > 0
        ? chooserPointer
        : pointer.replace(/\/(type|statement).*$/, ''),
    );
  };
  const unresolved = identifiers.filter((id) => !resolved[id]);
  const hasInvalidOperand = values.some((value) => value !== '' && !isConditionEntityIdentifier(value));
  const hasWithheld = unresolved.some((id) => withheld.includes(id));
  const failure = suggestionFailure ?? resolveFailure;
  const missingLabel = !resolving && unresolved.length > 0;
  const repairText = hasInvalidOperand
    ? m.condition_entity_invalid({}, options)
    : hasWithheld
      ? m.condition_entity_unresolved({}, options)
      : failure
        ? conditionEntityFailureText(failure, options)
        : missingLabel
          ? m.search_suggestions_unavailable({}, options)
          : undefined;
  const canResolve = requestContext.available && targetTypes.length > 0 && !context.disabled;
  const retryLabels = () => {
    const retryIds = new Set(unresolved);
    for (const id of retryIds) attempted.current.delete(id);
    setWithheld((previous) => previous.filter((id) => !retryIds.has(id)));
    setResolveFailure(undefined);
    setRetry((version) => version + 1);
  };

  return (
    <div
      className="min-w-0 space-y-2"
      data-condition-entity-property={property}
      data-condition-pointer={pointer}
      data-condition-node={nodeKey}
      aria-busy={resolving}
    >
      {values.map((value, index) => {
        const selected = resolved[value.toLowerCase()];
        return (
          <div key={`${occurrence}:${index}`} className="flex items-end gap-1">
            <EditorField
              context={context}
              pointer={`${pointer}/${index}`}
              label={m.condition_value({ number: index + 1 }, options)}
            >
              {(props) => (
                <div className="min-w-0 flex-1 space-y-1">
                  {selected ? (
                    <p dir="auto" className="break-words text-sm font-medium">
                      {selected.label}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{selected.type}</span>
                    </p>
                  ) : null}
                  <Input {...props} readOnly value={value} placeholder={m.condition_choose_value({}, options)} />
                </div>
              )}
            </EditorField>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={m.refinement_remove({ value: m.condition_value({ number: index + 1 }, options) }, options)}
              onClick={() => removeValue(index)}
            >
              {m.condition_remove({}, options)}
            </Button>
          </div>
        );
      })}
      {values.length === 0 ? (
        <div className="flex items-end gap-1">
          <EditorField context={context} pointer={`${pointer}/0`} label={m.condition_value({ number: 1 }, options)}>
            {(props) => <Input {...props} readOnly value="" placeholder={m.condition_choose_value({}, options)} />}
          </EditorField>
        </div>
      ) : null}
      {requestContext.available && targetTypes.length > 0 ? (
        <Field className="min-w-0" data-condition-pointer={chooserPointer} data-condition-node={nodeKey} tabIndex={-1}>
          <FieldLabel>{m.condition_value({ number: pickerNumber }, options)}</FieldLabel>
          <EntityPicker
            key={`${occurrence}:${valuesKey}`}
            search={search}
            src={coverSrc}
            label={m.condition_value({ number: pickerNumber }, options)}
            placeholder={m.condition_choose_value({}, options)}
            value={[]}
            onValueChange={(selected) => {
              const candidate = selected[0];
              if (!candidate) return;
              const next = appendConditionEntity(values, candidate.id);
              if (next.some((entry, index) => entry !== values[index])) {
                onChange(next);
                context.announce(m.condition_added({}, options), chooserPointer);
              }
            }}
            disabled={context.disabled || (values.length >= FILTER_LIMITS.in && !values.includes(''))}
            className="min-w-0"
          />
        </Field>
      ) : null}
      {repairText ? (
        <p role="alert" className="text-sm text-destructive">
          {repairText}
        </p>
      ) : null}
      {canResolve && missingLabel && !context.disabled ? (
        <Button type="button" variant="outline" size="sm" onClick={retryLabels}>
          {m.subject_view_retry({}, options)}
        </Button>
      ) : null}
      {!requestContext.available && !repairText ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_suggestions_unavailable({}, options)}
        </p>
      ) : null}
      {requestContext.available && targetTypes.length === 0 && !repairText ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.condition_metadata_unavailable({}, options)}
        </p>
      ) : null}
    </div>
  );
}

function ValueFields({
  values,
  choices,
  onChange,
  pointer,
  context,
  closed = false,
  entity,
}: {
  values: readonly string[];
  choices?: Choice[] | undefined;
  onChange(values: string[]): void;
  pointer: string;
  context: EditorContext;
  closed?: boolean;
  entity?: { property: string; targets: readonly string[]; occurrence: string; nodeKey: number } | undefined;
}) {
  if (entity && context.entityLookup)
    return (
      <ConditionEntityValues
        key={conditionEntityRequestIdentity(entity.occurrence, entity.property, entity.targets, context.entityLookup)}
        values={values}
        onChange={onChange}
        pointer={pointer}
        property={entity.property}
        targets={entity.targets}
        occurrence={entity.occurrence}
        nodeKey={entity.nodeKey}
        lookup={context.entityLookup}
        context={context}
      />
    );
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
