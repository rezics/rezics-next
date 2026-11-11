import * as SharedSelect from '@rezics/ui/shadcn/select';
import { UI_LOCALES, zonePrimaryLanguage, type ZoneConfiguration, type ZoneLanguage } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useEffect, useRef } from 'react';
import { m } from '../../../paraglide/messages.js';

type Names = Pick<ZoneConfiguration, 'labels'> & { primaryLanguage: ZoneLanguage };

/** Shared only by the Zone create form and its configuration editor. No names are synthesized. */
export function ZoneNameFields({
  labels,
  primaryLanguage,
  locale,
  disabled,
  errors,
  descriptions,
  onChange,
}: {
  labels: ZoneConfiguration['labels'];
  primaryLanguage?: ZoneLanguage | undefined;
  locale: string;
  disabled: boolean;
  errors?: string[] | undefined;
  /** Optional editor-only descriptions. Create retains its pointer/error contract. */
  descriptions?: Readonly<Record<string, string>> | undefined;
  onChange: (names: Names) => void;
}) {
  const options = { locale: locale as never };
  const primary = zonePrimaryLanguage({ labels, ...(primaryLanguage ? { primaryLanguage } : {}) }) ?? 'en';
  const display = new Intl.DisplayNames([locale], { type: 'language' });
  const languageName = (language: string) => display.of(language) ?? language;
  const change = (next: ZoneConfiguration['labels'], language = primary) =>
    onChange({ labels: next, primaryLanguage: language });
  const invalid = (language: string) => errors?.includes(`/configuration/labels/${language}`) ?? false;
  const translations = useRef<HTMLDetailsElement>(null);
  const translationErrors = UI_LOCALES.filter((language) => language !== primary && invalid(language)).join(',');
  useEffect(() => {
    // An invalid translation must be reachable even when its optional section was closed.
    if (translationErrors && translations.current) translations.current.open = true;
  }, [translationErrors, errors]);
  const describedBy = (language: string) =>
    [
      'zone-name-help',
      invalid(language) ? `zone-label-${language}-error` : '',
      descriptions?.[`zone-label-${language}`],
    ]
      .filter(Boolean)
      .join(' ');
  const error = (language: string) =>
    invalid(language) ? (
      <FieldDescription id={`zone-label-${language}-error`} className="text-destructive">
        {m.zone_name_invalid({ language: languageName(language) }, options)}
      </FieldDescription>
    ) : null;
  const fields = (
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <legend className="mb-3 text-lg font-semibold">{m.zones_create_names({}, options)}</legend>
      <p id="zone-name-help" className="text-sm text-muted-foreground">
        {m.zones_create_names_help({}, options)}
      </p>
      <p className="text-sm text-muted-foreground">{m.zone_name_fallback({}, options)}</p>
      {!primaryLanguage ? <p className="text-sm text-muted-foreground">{m.zone_name_legacy({}, options)}</p> : null}
      <Field data-invalid={!!descriptions?.['zone-primary-language']}>
        <FieldLabel htmlFor="zone-primary-language">{m.zone_name_language({}, options)}</FieldLabel>
        <SharedSelect.Select
          value={primary}
          items={UI_LOCALES.map((language) => ({ value: language, label: languageName(language) }))}
          onValueChange={(value) => {
            if (value === null) return;
            const language = value as ZoneLanguage;
            change({ ...labels }, language);
          }}
        >
          <SharedSelect.SelectTrigger
            id="zone-primary-language"
            aria-invalid={!!descriptions?.['zone-primary-language']}
            aria-describedby={['zone-name-help', descriptions?.['zone-primary-language']].filter(Boolean).join(' ')}
            className="max-md:min-h-11 pointer-coarse:min-h-11"
          >
            <SharedSelect.SelectValue />
          </SharedSelect.SelectTrigger>
          <SharedSelect.SelectContent>
            <SharedSelect.SelectGroup>
              {UI_LOCALES.map((language) => (
                <SharedSelect.SelectItem key={language} value={language}>
                  {languageName(language)}
                </SharedSelect.SelectItem>
              ))}
            </SharedSelect.SelectGroup>
          </SharedSelect.SelectContent>
        </SharedSelect.Select>
      </Field>
      <Field data-invalid={invalid(primary)}>
        <FieldLabel htmlFor={`zone-label-${primary}`}>{m.zone_name_primary({}, options)}</FieldLabel>
        <Input
          id={`zone-label-${primary}`}
          lang={primary}
          value={labels[primary] ?? ''}
          required
          aria-invalid={invalid(primary)}
          aria-describedby={describedBy(primary)}
          onChange={(event) => change({ ...labels, [primary]: event.target.value })}
        />
        {error(primary)}
      </Field>
      <details ref={translations} className="min-w-0 space-y-4">
        <summary className="cursor-pointer font-medium">{m.zone_name_translations({}, options)}</summary>
        <p className="text-sm text-muted-foreground">{m.zone_name_translation_help({}, options)}</p>
        {UI_LOCALES.filter((language) => language !== primary && Object.hasOwn(labels, language)).map((language) => (
          <Field key={language} data-invalid={invalid(language)}>
            <FieldLabel htmlFor={`zone-label-${language}`}>{languageName(language)}</FieldLabel>
            <Input
              id={`zone-label-${language}`}
              lang={language}
              value={labels[language] ?? ''}
              aria-invalid={invalid(language)}
              required
              aria-describedby={describedBy(language)}
              onChange={(event) => change({ ...labels, [language]: event.target.value })}
            />
            {error(language)}
            <Button
              type="button"
              variant="outline"
              className="h-auto whitespace-normal text-start"
              onClick={() => {
                const next = { ...labels };
                delete next[language];
                change(next);
              }}
            >
              {m.zone_name_remove({ language: languageName(language) }, options)}
            </Button>
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor="zone-add-translation">{m.zone_name_add({}, options)}</FieldLabel>
          <SharedSelect.Select
            value={null}
            items={[
              { value: null, label: m.zone_name_choose({}, options) },
              ...UI_LOCALES.filter((language) => language !== primary && !Object.hasOwn(labels, language)).map(
                (language) => ({ value: language, label: languageName(language) }),
              ),
            ]}
            onValueChange={(value) => {
              if (value === null) return;
              const language = value as ZoneLanguage;
              change({ ...labels, [language]: '' });
            }}
          >
            <SharedSelect.SelectTrigger id="zone-add-translation" className="max-md:min-h-11 pointer-coarse:min-h-11">
              <SharedSelect.SelectValue />
            </SharedSelect.SelectTrigger>
            <SharedSelect.SelectContent>
              <SharedSelect.SelectGroup>
                <SharedSelect.SelectItem value={null}>{m.zone_name_choose({}, options)}</SharedSelect.SelectItem>
                {UI_LOCALES.filter((language) => language !== primary && !Object.hasOwn(labels, language)).map(
                  (language) => (
                    <SharedSelect.SelectItem key={language} value={language}>
                      {languageName(language)}
                    </SharedSelect.SelectItem>
                  ),
                )}
              </SharedSelect.SelectGroup>
            </SharedSelect.SelectContent>
          </SharedSelect.Select>
        </Field>
      </details>
    </fieldset>
  );
  return descriptions ? (
    <section
      id="zone-names"
      tabIndex={-1}
      data-correction-section=""
      aria-describedby={Object.entries(descriptions)
        .filter(([id]) => id === 'zone-names' || id === 'zone-primary-language' || id.startsWith('zone-label-'))
        .map(([, value]) => value)
        .join(' ')}
      className="min-w-0"
    >
      {fields}
    </section>
  ) : (
    fields
  );
}
