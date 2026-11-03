import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../../paraglide/messages.js';
import type { TermEdit, TermField, TermsPatch } from './subject-terms';
import {
  formatTermPresence,
  replacementPresence,
  resolutionKey,
  type ResolutionKind,
  type TermFieldChange,
  type TermPresence,
} from './subject-terms-resolution';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-h-11 md:pointer-fine:min-h-8';
const frameClassName = 'm-1 flex min-w-0 flex-col gap-4 p-3 sm:p-4';
const selectClassName = 'min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11 md:pointer-fine:[&_select]:min-h-8';

function readout(presence: TermPresence, language: string, absent: string) {
  return (
    <span lang={language} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {presence.present ? formatTermPresence(presence) : absent}
    </span>
  );
}

export function TermsConflictResolution({
  changes,
  choices,
  replacements,
  unresolved,
  omittedLanguages,
  removals,
  patch,
  etag,
  revision,
  reviewed,
  locale,
  fieldLabel,
  controlId,
  disabled,
  onChoose,
  onReplacement,
  onReview,
}: {
  changes: readonly TermFieldChange[];
  choices: Readonly<Record<string, ResolutionKind>>;
  replacements: Readonly<Record<string, TermEdit>>;
  unresolved: readonly TermFieldChange[];
  omittedLanguages: readonly string[];
  removals: readonly { language: string; field: TermField }[];
  patch: TermsPatch;
  etag: string;
  revision: number;
  reviewed: boolean;
  locale: string;
  fieldLabel: (field: TermField) => string;
  controlId: (part: string) => string;
  disabled: boolean;
  onChoose: (language: string, field: TermField, kind: ResolutionKind | '') => void;
  onReplacement: (language: string, field: TermField, value: string) => void;
  onReview: () => void;
}) {
  const options = { locale: locale as never };
  const absent = m.catalogue_terms_absent({}, options);
  const overlaps = changes.filter((change) => change.overlap);
  const classified = changes.filter((change) => !change.overlap);
  const classLabel = (change: TermFieldChange) =>
    change.currentUnchanged
      ? m.catalogue_terms_class_current_unchanged({}, options)
      : change.userUnchanged
        ? m.catalogue_terms_class_user_unchanged({}, options)
        : m.catalogue_terms_class_same_result({}, options);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby={controlId('resolve')}>
        <ContentItemHeading id={controlId('resolve')} className="font-semibold">
          {m.catalogue_terms_resolve_title({}, options)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.catalogue_terms_resolve_help({}, options)}</p>
        {overlaps.map((change) => {
          const key = resolutionKey(change.language, change.field);
          const kind = choices[key] ?? '';
          const edit = replacements[key] ?? { mode: 'set' as const, value: formatTermPresence(change.intended) };
          const invalid = kind === 'replacement' && !replacementPresence(change.field, edit);
          const errorId = invalid ? controlId(`resolve-${key}-error`) : undefined;
          return (
            <FieldSet key={key} disabled={disabled} className="min-w-0 gap-0">
              <FieldLegend className="px-1">
                {change.language}: {fieldLabel(change.field)}
              </FieldLegend>
              <ContentItemFrame as="div" className={frameClassName}>
                <p className="text-sm text-muted-foreground">{m.catalogue_terms_class_overlap({}, options)}</p>
                <dl className="flex min-w-0 flex-col gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{m.catalogue_terms_original({}, options)}</dt>
                    <dd className="mt-1">{readout(change.original, change.language, absent)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.catalogue_terms_current({}, options)}</dt>
                    <dd className="mt-1">{readout(change.current, change.language, absent)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.catalogue_terms_intended({}, options)}</dt>
                    <dd className="mt-1">{readout(change.intended, change.language, absent)}</dd>
                  </div>
                </dl>
                <Field data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
                  <FieldLabel htmlFor={controlId(`resolve-${key}-choice`)}>
                    {m.catalogue_terms_resolve_choice({}, options)}
                  </FieldLabel>
                  <NativeSelect
                    className={selectClassName}
                    id={controlId(`resolve-${key}-choice`)}
                    value={kind}
                    aria-invalid={invalid}
                    aria-describedby={errorId}
                    onChange={(event) =>
                      onChoose(change.language, change.field, event.target.value as ResolutionKind | '')
                    }
                  >
                    <NativeSelectOption value="">{m.catalogue_terms_resolve_choose({}, options)}</NativeSelectOption>
                    <NativeSelectOption value="current">
                      {m.catalogue_terms_keep_current({}, options)}
                    </NativeSelectOption>
                    <NativeSelectOption value="draft">{m.catalogue_terms_use_draft({}, options)}</NativeSelectOption>
                    <NativeSelectOption value="replacement">
                      {m.catalogue_terms_edit_replacement({}, options)}
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                {kind === 'replacement' && (
                  <Field data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
                    <FieldLabel htmlFor={controlId(`resolve-${key}`)}>
                      {m.catalogue_terms_replacement({}, options)}
                    </FieldLabel>
                    {change.field === 'aliases' ? (
                      <Textarea
                        className="min-w-0 [overflow-wrap:anywhere] focus:outline-2 focus:outline-offset-2 focus:outline-ring"
                        id={controlId(`resolve-${key}`)}
                        lang={change.language}
                        value={edit.value}
                        rows={3}
                        aria-invalid={invalid}
                        aria-describedby={[controlId('aliases-help'), errorId].filter(Boolean).join(' ')}
                        onChange={(event) => onReplacement(change.language, change.field, event.target.value)}
                      />
                    ) : (
                      <Input
                        className={`${inputClassName} focus:outline-2 focus:outline-offset-2 focus:outline-ring`}
                        id={controlId(`resolve-${key}`)}
                        lang={change.language}
                        value={edit.value}
                        maxLength={250}
                        aria-invalid={invalid}
                        aria-describedby={errorId}
                        onChange={(event) => onReplacement(change.language, change.field, event.target.value)}
                      />
                    )}
                    {change.field === 'aliases' && (
                      <FieldDescription id={controlId('aliases-help')}>
                        {m.catalogue_terms_alias_limits({}, options)}
                      </FieldDescription>
                    )}
                    {invalid && (
                      <FieldError
                        id={errorId}
                        errors={[
                          {
                            message:
                              change.field === 'labels'
                                ? m.catalogue_terms_validation_name({}, options)
                                : change.field === 'descriptions'
                                  ? m.catalogue_terms_validation_description({}, options)
                                  : m.catalogue_terms_validation_alias({}, options),
                          },
                        ]}
                      />
                    )}
                  </Field>
                )}
              </ContentItemFrame>
            </FieldSet>
          );
        })}
        {classified.length > 0 && (
          <ul className="flex min-w-0 flex-col gap-2 text-sm">
            {classified.map((change) => (
              <li key={resolutionKey(change.language, change.field)}>
                {change.language}: {fieldLabel(change.field)} — {classLabel(change)}
              </li>
            ))}
          </ul>
        )}
        {unresolved.length > 0 && <p role="status">{m.catalogue_terms_unresolved({}, options)}</p>}
        <Button
          className={actionClassName}
          type="button"
          variant="outline"
          disabled={disabled || unresolved.length > 0}
          onClick={onReview}
        >
          {m.catalogue_terms_review({}, options)}
        </Button>
      </section>
      {reviewed && (
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby={controlId('patch-review')}>
          <ContentItemHeading id={controlId('patch-review')} className="font-semibold">
            {m.catalogue_terms_review_title({}, options)}
          </ContentItemHeading>
          <p>{m.catalogue_terms_review_help({ revision: String(revision), etag }, options)}</p>
          <dl className="flex min-w-0 flex-col gap-2 text-sm">
            {termPatchRows(patch, fieldLabel, absent).map((row) => (
              <div key={row.key}>
                <dt className="font-medium">
                  {row.language}: {row.field}
                </dt>
                <dd lang={row.language} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            {m.catalogue_terms_review_omitted({}, options)}:{' '}
            {omittedLanguages.length ? omittedLanguages.join(', ') : m.catalogue_terms_review_none({}, options)}
          </p>
          <p className="text-sm">
            {m.catalogue_terms_review_removals({}, options)}:{' '}
            {removals.length
              ? removals.map((row) => `${row.language}: ${fieldLabel(row.field)}`).join(', ')
              : m.catalogue_terms_review_none({}, options)}
          </p>
        </section>
      )}
    </div>
  );
}

function termPatchRows(patch: TermsPatch, fieldLabel: (field: TermField) => string, absent: string) {
  return (['labels', 'descriptions', 'aliases'] as const).flatMap((field) =>
    Object.entries(patch[field] ?? {}).map(([language, value]) => ({
      key: resolutionKey(language, field),
      language,
      field: fieldLabel(field),
      value:
        value === null || (Array.isArray(value) && value.length === 0)
          ? absent
          : formatTermPresence({ present: true, value }),
    })),
  );
}
