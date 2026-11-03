import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../../paraglide/messages.js';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import type { TermDraft } from './create-subject';
import { createSubjectGuidance } from './create-subject-guidance';
import type { PublicationCorrection, PublicationTerm } from './publication-editor-guidance';
import { publicationTermControl } from './publication-editor-guidance';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-w-0 min-h-11 md:pointer-fine:min-h-8';
const labelClassName = 'min-w-0 max-w-full flex-wrap [overflow-wrap:anywhere]';

export function PublicationTerms({
  id,
  terms,
  locale,
  disabled,
  errors,
  onChange,
  onAdd,
  onRemove,
}: {
  id: string;
  terms: PublicationTerm[];
  locale: string;
  disabled: boolean;
  errors: PublicationCorrection[];
  onChange: (id: number, field: keyof TermDraft, value: string) => void;
  onAdd: () => void;
  onRemove: (id: number) => boolean;
}) {
  const o = { locale: locale as never };
  const invalid = (target: string) => errors.some((error) => error.target === target);
  const message = (target: string, field: keyof TermDraft, index: number) =>
    errors
      .filter((error) => error.target === target)
      .map((error) =>
        error.instruction ||
        createSubjectGuidance(
          { pointer: '', code: 'invalid_format' },
          field,
          { type: '', rows: terms, index },
          locale,
        ),
      )
      .filter(Boolean)
      .join(' ');
  return (
    <div className="min-w-0 space-y-4">
      {terms.map((term, index) => {
        const rowId = `${id}-${term.id}`;
        return (
          <fieldset key={term.id} id={rowId} className="min-w-0 space-y-3">
            <legend className="text-sm font-semibold">{m.catalogue_create_terms({}, o)}</legend>
            {(['label', 'language', 'description', 'aliases'] as const).map((field) => {
              const control = publicationTermControl(id, field, term.id);
              const described =
                [
                  field !== 'description' ? `${control}-help` : undefined,
                  invalid(control) ? `${control}-error` : undefined,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined;
              const label =
                field === 'language'
                  ? m.catalogue_create_language({}, o)
                  : field === 'label'
                    ? m.catalogue_create_label({}, o)
                    : field === 'description'
                      ? m.catalogue_create_description({}, o)
                      : m.catalogue_create_aliases({}, o);
              return (
                <Field key={field} data-invalid={invalid(control) || undefined}>
                  <FieldLabel className={labelClassName} htmlFor={control}>
                    {label}
                  </FieldLabel>
                  {field === 'aliases' ? (
                    <Textarea
                      className={inputClassName}
                      id={control}
                      value={term[field]}
                      rows={3}
                      aria-invalid={invalid(control) || undefined}
                      aria-describedby={described}
                      onChange={(event) => onChange(term.id, field, event.target.value)}
                    />
                  ) : (
                    <Input
                      className={inputClassName}
                      id={control}
                      value={term[field]}
                      maxLength={field === 'language' ? 64 : 250}
                      required={field === 'language' || field === 'label'}
                      aria-invalid={invalid(control) || undefined}
                      aria-describedby={described}
                      onChange={(event) => onChange(term.id, field, event.target.value)}
                    />
                  )}
                  {field === 'language' && (
                    <FieldDescription id={`${control}-help`} className="text-start">
                      {m.catalogue_create_language_help({}, o)}
                    </FieldDescription>
                  )}
                  {field === 'aliases' && (
                    <FieldDescription id={`${control}-help`} className="text-start">
                      {m.catalogue_create_aliases_help({}, o)}
                    </FieldDescription>
                  )}
                  {field === 'label' && (
                    <FieldDescription id={`${control}-help`} className="text-start">
                      {m.catalogue_create_duplicate_help({}, o)}
                    </FieldDescription>
                  )}
                  {invalid(control) && <FieldError id={`${control}-error`}>{message(control, field, index)}</FieldError>}
                </Field>
              );
            })}
            {terms.length > 1 && (
              <CreateSubjectLanguageRemove
                locale={locale}
                populated={!!(term.language || term.label || term.description || term.aliases)}
                rowId={rowId}
                focusId={
                  terms[index + 1]
                    ? publicationTermControl(id, 'language', terms[index + 1]!.id)
                    : `${id}-add-language`
                }
                disabled={disabled}
                onRemove={() => onRemove(term.id)}
              />
            )}
          </fieldset>
        );
      })}
      <Button
        id={`${id}-add-language`}
        className={actionClassName}
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={onAdd}
      >
        {m.catalogue_create_add_language({}, o)}
      </Button>
    </div>
  );
}
