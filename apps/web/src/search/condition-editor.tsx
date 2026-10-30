import { useId, useRef, useState, type ReactNode } from 'react';
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
import {
  CONDITION_POINTER,
  conditionFieldIssues,
  type ConditionIssue,
  type ConditionMetadata,
} from './condition-editor-model';

type Choice = { value: string; labels: Record<string, string> };
type EditorContext = {
  metadata: ConditionMetadata;
  locale: string;
  issues: readonly ConditionIssue[];
  values: Record<string, Choice[]>;
  announce(message: string, pointer: string): void;
};

function errorText(code: string) {
  if (code === 'required') return m.condition_required();
  if (code === 'out_of_range') return m.condition_bounds();
  if (code === 'unsupported' || code === 'unknown_field') return m.condition_unsupported();
  return m.condition_invalid();
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
}) {
  const languageId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState({ text: '', version: 0 });
  const announce = (message: string, pointer: string) => {
    setAnnouncement((previous) => ({ text: message, version: previous.version + 1 }));
    requestAnimationFrame(() => {
      const region =
        Array.from(root.current?.querySelectorAll<HTMLElement>('[data-condition-pointer]') ?? []).find(
          (element) => element.dataset.conditionPointer === pointer,
        ) ?? root.current;
      region
        ?.querySelector<HTMLElement>(
          'select:not(:disabled), input:not([type="hidden"]):not(:disabled), button:not(:disabled)',
        )
        ?.focus();
    });
  };
  const context: EditorContext | undefined = metadata ? { metadata, locale, issues, values, announce } : undefined;
  return (
    <div ref={root} className="min-w-0 space-y-3 border-t border-border/60 pt-4" data-condition-editor>
      <h2 className="font-medium">{m.condition_heading()}</h2>
      <p className="text-sm text-muted-foreground">{m.condition_hint()}</p>
      <p role="status" aria-live="polite" className="sr-only">
        <span key={announcement.version}>{announcement.text}</span>
      </p>
      {onLanguages && (
        <Field>
          <FieldLabel htmlFor={languageId}>{m.condition_language()}</FieldLabel>
          <NativeSelect
            id={languageId}
            value={languages?.[0] ?? ''}
            onChange={(event) => {
              const selected = event.currentTarget.value;
              onLanguages(selected ? [selected, ...(languages?.slice(1).filter((tag) => tag !== selected) ?? [])] : []);
            }}
          >
            <NativeSelectOption value="">{m.condition_language_default()}</NativeSelectOption>
            {[...new Set([...locales, ...(languages ?? [])])].map((tag) => (
              <NativeSelectOption key={tag} value={tag}>
                {new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      {issues.length > 0 && (
        <div role="alert" tabIndex={-1} data-condition-errors className="space-y-1 text-sm text-destructive">
          {issues.map((issue, index) => (
            <p key={`${issue.pointer}:${issue.code}:${index}`} data-error-pointer={issue.pointer}>
              {issue.pointer.startsWith('/text')
                ? m.condition_text_error()
                : issue.pointer.startsWith('/cursor')
                  ? m.condition_cursor_error()
                  : errorText(issue.code)}
            </p>
          ))}
        </div>
      )}
      {context ? (
        <>
          {value ? (
            <NodeEditor value={value} onChange={onChange} pointer={CONDITION_POINTER} depth={1} context={context} />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onChange({ and: [{ type: { in: [] } }] });
                announce(m.condition_added(), `${CONDITION_POINTER}/and/0`);
              }}
            >
              {m.condition_add()}
            </Button>
          )}
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {m.condition_metadata_unavailable()}
        </p>
      )}
      {value && <input type="hidden" name="condition" value={JSON.stringify(value)} />}
      <Button type="submit" variant="outline" disabled={disabled}>
        {m.search_apply()}
      </Button>
    </div>
  );
}

function EditorField({
  context,
  pointer,
  label,
  children,
}: {
  context: EditorContext;
  pointer: string;
  label: string;
  children(props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }): ReactNode;
}) {
  const id = useId();
  const errors = conditionFieldIssues(context.issues, pointer);
  return (
    <Field data-invalid={errors.length > 0 || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children({
        id,
        'aria-invalid': errors.length > 0,
        ...(errors.length ? { 'aria-describedby': `${id}-error` } : {}),
      })}
      {errors.length > 0 && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {errorText(errors[0]!.code)}
        </p>
      )}
    </Field>
  );
}

function NodeEditor({
  value,
  onChange,
  pointer,
  depth,
  context,
}: {
  value: FilterDocument;
  onChange(value: FilterDocument | undefined): void;
  pointer: string;
  depth: number;
  context: EditorContext;
}) {
  const operator = 'and' in value ? 'and' : 'or' in value ? 'or' : 'not' in value ? 'not' : '';
  const group = 'and' in value ? value.and : 'or' in value ? value.or : undefined;
  const label =
    operator === 'and'
      ? m.condition_and()
      : operator === 'or'
        ? m.condition_or()
        : operator === 'not'
          ? m.condition_not()
          : 'type' in value
            ? m.search_type()
            : m.condition_statement();
  const name = (labels: Record<string, string> | undefined, fallback: string) =>
    localizedLabel(labels ?? {}, context.locale).text || fallback;
  const property = 'statement' in value ? value.statement.property : undefined;
  const definition = property ? context.metadata.properties[property] : undefined;
  const range = 'statement' in value && 'range' in value.statement ? value.statement.range : undefined;
  const properties = facetProperties(context.metadata, Object.keys(context.metadata.types));
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
  const remove = () => {
    onChange(undefined);
    context.announce(m.condition_removed(), pointer.replace(/\/(and|or)\/\d+$|\/not$/, ''));
  };
  return (
    <FieldSet className="min-w-0 gap-3 rounded-lg border border-border/60 p-3" data-condition-pointer={pointer}>
      <FieldLegend variant="label">{label}</FieldLegend>
      <div className="flex flex-wrap items-end gap-2">
        <EditorField context={context} pointer={pointer} label={m.condition_group()}>
          {(props) => (
            <NativeSelect
              {...props}
              value={operator}
              onChange={(event) => {
                const next = event.currentTarget.value;
                if (next === 'and' || next === 'or') {
                  const children = group ?? ('not' in value ? [value.not] : [value]);
                  onChange(next === 'and' ? { and: children } : { or: children });
                } else if (next === 'not') onChange({ not: value });
                else if ('not' in value) onChange(value.not);
                context.announce(m.condition_group_changed(), pointer);
              }}
            >
              <NativeSelectOption value="" disabled={!!group}>
                {operator === 'not' ? m.condition_unwrap() : m.condition_leaf()}
              </NativeSelectOption>
              <NativeSelectOption value="and" disabled={!operator && depth >= FILTER_LIMITS.depth}>
                {m.condition_and()}
              </NativeSelectOption>
              <NativeSelectOption value="or" disabled={!operator && depth >= FILTER_LIMITS.depth}>
                {m.condition_or()}
              </NativeSelectOption>
              <NativeSelectOption value="not" disabled={operator === 'not' || depth >= FILTER_LIMITS.depth}>
                {m.condition_not()}
              </NativeSelectOption>
            </NativeSelect>
          )}
        </EditorField>
        <Button type="button" variant="ghost" size="sm" onClick={remove}>
          {m.condition_remove()}
        </Button>
      </div>
      {group && (
        <>
          {group.map((child, index) => (
            <NodeEditor
              key={index}
              value={child}
              pointer={`${pointer}/${operator}/${index}`}
              depth={depth + 1}
              context={context}
              onChange={(next) => {
                const children = next
                  ? group.map((entry, at) => (at === index ? next : entry))
                  : group.filter((_, at) => at !== index);
                onChange(operator === 'and' ? { and: children } : { or: children });
              }}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {(['type', 'statement'] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  (operator === 'or' && group.length >= FILTER_LIMITS.or) ||
                  context.issues.some((issue) => issue.pointer === '/filter' && issue.code === 'out_of_range')
                }
                onClick={() => {
                  const node: FilterDocument =
                    kind === 'type' ? { type: { in: [] } } : { statement: { property: '', in: [''] } };
                  const children = [...group, node];
                  onChange(operator === 'and' ? { and: children } : { or: children });
                  context.announce(m.condition_added(), `${pointer}/${operator}/${group.length}`);
                }}
              >
                {kind === 'type' ? m.condition_add_type() : m.condition_add_statement()}
              </Button>
            ))}
          </div>
        </>
      )}
      {'not' in value && (
        <NodeEditor
          value={value.not}
          pointer={`${pointer}/not`}
          depth={depth + 1}
          context={context}
          onChange={(next) => onChange(next ? { not: next } : undefined)}
        />
      )}
      {'type' in value && (
        <ValueFields
          context={context}
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
          <EditorField context={context} pointer={`${pointer}/statement/property`} label={m.refinement_property()}>
            {(props) => (
              <NativeSelect
                {...props}
                value={property}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  const metadata = context.metadata.properties[next];
                  const ranged = metadata?.datatype === 'quantity' || metadata?.datatype === 'time';
                  onChange({
                    statement: {
                      property: next,
                      ...(ranged
                        ? {
                            range:
                              metadata.datatype === 'quantity' && metadata.units?.[0]
                                ? { unit: metadata.units[0] }
                                : {},
                          }
                        : { in: [''] }),
                    },
                  });
                }}
              >
                <NativeSelectOption value="">{m.refinement_choose_property()}</NativeSelectOption>
                {property && !properties.includes(property) && (
                  <NativeSelectOption value={property}>{name(definition?.labels, property)}</NativeSelectOption>
                )}
                {properties.map((property) => (
                  <NativeSelectOption key={property} value={property}>
                    {name(context.metadata.properties[property]?.labels, property)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </EditorField>
          <p className="text-sm text-muted-foreground">{definition?.datatype}</p>
          {range ? (
            <>
              {(['gte', 'lte'] as const).map((bound) => (
                <EditorField
                  key={bound}
                  context={context}
                  pointer={`${pointer}/statement/range/${bound}`}
                  label={bound === 'gte' ? m.refinement_lower() : m.refinement_upper()}
                >
                  {(props) => (
                    <RangeInput
                      {...props}
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
              ))}
              {definition?.datatype === 'time' ? (
                <p className="text-sm text-muted-foreground">{m.refinement_year_hint()}</p>
              ) : (
                <EditorField context={context} pointer={`${pointer}/statement/range/unit`} label={m.refinement_unit()}>
                  {(props) => (
                    <NativeSelect
                      {...props}
                      value={range.unit ?? ''}
                      onChange={(event) => replaceStatement({ range: { ...range, unit: event.currentTarget.value } })}
                    >
                      <NativeSelectOption value="">{m.condition_choose_value()}</NativeSelectOption>
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
            <FieldSet key={index} className="min-w-0 gap-3 border-t border-border/60 pt-3">
              <FieldLegend variant="label">{m.condition_qualifier()}</FieldLegend>
              <EditorField
                context={context}
                pointer={`${pointer}/statement/qualifiers/${index}/property`}
                label={m.refinement_property()}
              >
                {(props) => (
                  <NativeSelect
                    {...props}
                    value={qualifier.property}
                    onChange={(event) =>
                      replaceStatement({
                        qualifiers: value.statement.qualifiers!.map((entry, at) =>
                          at === index ? { ...entry, property: event.currentTarget.value } : entry,
                        ),
                      })
                    }
                  >
                    <NativeSelectOption value="">{m.refinement_choose_property()}</NativeSelectOption>
                    {qualifier.property && !definition?.qualifiers?.includes(qualifier.property) && (
                      <NativeSelectOption value={qualifier.property}>
                        {name(context.metadata.properties[qualifier.property]?.labels, qualifier.property)}
                      </NativeSelectOption>
                    )}
                    {definition?.qualifiers?.map((property) => (
                      <NativeSelectOption key={property} value={property}>
                        {name(context.metadata.properties[property]?.labels, property)}
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
                  context.announce(m.condition_removed(), pointer);
                }}
              >
                {m.condition_remove()}
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
                context.announce(m.condition_added(), pointer);
              }}
            >
              {m.condition_add_qualifier()}
            </Button>
          )}
        </>
      )}
      {('saved' in value || 'owner' in value) && (
        <p className="text-sm text-muted-foreground">{m.condition_retained()}</p>
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
}: {
  values: readonly string[];
  choices?: Choice[] | undefined;
  onChange(values: string[]): void;
  pointer: string;
  context: EditorContext;
}) {
  return (
    <div className="min-w-0 space-y-2">
      {values.map((value, index) => (
        <div key={index} className="flex items-end gap-1">
          <EditorField
            context={context}
            pointer={`${pointer}/${index}`}
            label={m.condition_value({ number: index + 1 })}
          >
            {(props) =>
              choices?.length ? (
                <NativeSelect
                  {...props}
                  value={value}
                  onChange={(event) =>
                    onChange(values.map((entry, at) => (at === index ? event.currentTarget.value : entry)))
                  }
                >
                  <NativeSelectOption value="">{m.condition_choose_value()}</NativeSelectOption>
                  {value && !choices.some((entry) => entry.value === value) && (
                    <NativeSelectOption value={value}>{value}</NativeSelectOption>
                  )}
                  {choices.map((entry) => (
                    <NativeSelectOption key={entry.value} value={entry.value}>
                      {localizedLabel(entry.labels, context.locale).text || entry.value}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  {...props}
                  value={value}
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
            aria-label={m.refinement_remove({ value: m.condition_value({ number: index + 1 }) })}
            onClick={() => {
              onChange(values.filter((_, at) => at !== index));
              context.announce(m.condition_removed(), pointer.replace(/\/(type|statement).*$/, ''));
            }}
          >
            {m.condition_remove()}
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
          context.announce(m.condition_added(), pointer.replace(/\/(type|statement).*$/, ''));
        }}
      >
        {m.condition_add_value()}
      </Button>
    </div>
  );
}

function RangeInput({
  value,
  onValue,
  ...props
}: {
  value: number | undefined;
  onValue(value: number | undefined): void;
  id: string;
  'aria-invalid': boolean;
  'aria-describedby'?: string;
}) {
  const [raw, setRaw] = useState(value?.toString() ?? '');
  const [previous, setPrevious] = useState(value);
  if (!Object.is(previous, value)) {
    setPrevious(value);
    setRaw(value?.toString() ?? '');
  }
  return (
    <Input
      {...props}
      type="text"
      inputMode="decimal"
      value={raw}
      onChange={(event) => {
        const text = event.currentTarget.value;
        const number = text === '' ? undefined : Number(text);
        setRaw(text);
        setPrevious(number);
        onValue(number);
      }}
    />
  );
}
