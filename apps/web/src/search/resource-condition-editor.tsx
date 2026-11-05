import { useId, type ReactNode } from 'react';
import type { FilterDocument } from '@rezics/filter';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { localizedLabel } from './results';
import { conditionFieldIssues, type ConditionIssue } from './condition-editor-model';
import {
  requestResourceId,
  requestResourceKind,
  type RequestResourceInput,
  type RequestResourceKind,
} from './resource-condition-model';
import type { ConditionExtension } from './condition-editor';

type MessageOptions = { locale: (typeof locales)[number] };

function messageOptions(locale: string): MessageOptions {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function resourceLabel(kind: RequestResourceKind, options: MessageOptions) {
  return kind === 'collection' ? m.library_following_kind_collection({}, options) : m.space_realm_heading({}, options);
}

function unavailableCode(code: string) {
  return ['denied', 'forbidden', 'not_found', 'not_visible', 'resource_unavailable', 'unavailable'].includes(code);
}

function ResourceConditionFields({
  value,
  kind,
  pointer,
  issues,
  locale,
  labels,
  onChange,
}: {
  value: FilterDocument;
  kind: RequestResourceKind;
  pointer: string;
  issues: readonly ConditionIssue[];
  locale: string;
  labels: RequestResourceInput['labels'];
  onChange(value: FilterDocument): void;
}) {
  const options = messageOptions(locale);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const fieldPointer = `${pointer}/${kind}/id`;
  const fieldIssues = conditionFieldIssues(issues, fieldPointer).filter((entry) => entry.pointer === fieldPointer);
  const id = requestResourceId(value, kind) ?? '';
  const fieldLabel = `${resourceLabel(kind, options)} · ${m.access_identity_resource_id({}, options)}`;
  const deliveredLabel = labels?.find((entry) => entry.kind === kind && entry.id === id);
  const resolvedLabel = deliveredLabel ? localizedLabel(deliveredLabel.labels, locale).text : '';
  const unavailable = fieldIssues.some(({ code }) => unavailableCode(code));

  return (
    <div className="space-y-2">
      {resolvedLabel && <p className="text-sm text-muted-foreground">{resolvedLabel}</p>}
      <Field
        data-invalid={fieldIssues.length > 0 || undefined}
        data-condition-field-pointer={fieldPointer}
        data-resource-kind={kind}
      >
        <FieldLabel htmlFor={inputId}>{fieldLabel}</FieldLabel>
        <Input
          id={inputId}
          value={id}
          aria-invalid={fieldIssues.length > 0}
          {...(fieldIssues.length ? { 'aria-describedby': errorId } : {})}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange({ [kind]: { id: event.currentTarget.value } } as unknown as FilterDocument)}
        />
        {fieldIssues.length > 0 && (
          <p id={errorId} className="text-sm text-destructive">
            {unavailable
              ? m.search_reader_condition_unsupported({ field: fieldLabel }, options)
              : fieldIssues[0]!.code === 'required'
                ? m.search_reader_condition_required({ field: fieldLabel }, options)
                : fieldIssues[0]!.code === 'invalid_type'
                  ? m.search_reader_condition_type({ field: fieldLabel }, options)
                  : fieldIssues[0]!.code === 'invalid_format'
                    ? m.search_reader_condition_format({ field: fieldLabel }, options)
                    : m.search_reader_condition_invalid({ field: fieldLabel }, options)}
          </p>
        )}
      </Field>
    </div>
  );
}

export function createRequestResourceConditionExtension(
  input: RequestResourceInput,
  locale: string,
): ConditionExtension {
  const options = messageOptions(locale);
  const kinds: RequestResourceKind[] = ['collection', 'realm'];
  return {
    choices: kinds.map((kind) => ({
      label: `${m.condition_add({}, options)}: ${resourceLabel(kind, options)}`,
      value: { [kind]: { id: '' } } as unknown as FilterDocument,
    })),
    label(value, context) {
      const kind = requestResourceKind(value);
      return kind ? resourceLabel(kind, messageOptions(context?.locale ?? locale)) : undefined;
    },
    render(value, onChange, context): ReactNode {
      const kind = requestResourceKind(value);
      if (!kind || !context) return null;
      return (
        <ResourceConditionFields
          value={value}
          kind={kind}
          pointer={context.pointer}
          issues={context.issues}
          locale={context.locale}
          labels={input.labels}
          onChange={onChange}
        />
      );
    },
  };
}
