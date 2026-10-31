import { UI_LOCALES, zonePrimaryLanguage, type ZoneConfiguration, type ZoneLanguage } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../../paraglide/messages.js';

type Names = Pick<ZoneConfiguration, 'labels'> & { primaryLanguage: ZoneLanguage };

/** Shared only by the Zone create form and its configuration editor. No names are synthesized. */
export function ZoneNameFields({
  labels,
  primaryLanguage,
  locale,
  disabled,
  errors,
  onChange,
}: {
  labels: ZoneConfiguration['labels'];
  primaryLanguage?: ZoneLanguage | undefined;
  locale: string;
  disabled: boolean;
  errors?: string[] | undefined;
  onChange: (names: Names) => void;
}) {
  const options = { locale: locale as never };
  const primary = zonePrimaryLanguage({ labels, ...(primaryLanguage ? { primaryLanguage } : {}) }) ?? 'en';
  const display = new Intl.DisplayNames([locale], { type: 'language' });
  const languageName = (language: string) => display.of(language) ?? language;
  const change = (next: ZoneConfiguration['labels'], language = primary) =>
    onChange({ labels: next, primaryLanguage: language });
  const invalid = (language: string) => errors?.includes(`/configuration/labels/${language}`) ?? false;
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <legend className="mb-3 text-lg font-semibold">{m.zones_create_names({}, options)}</legend>
      <p id="zone-name-help" className="text-sm text-muted-foreground">
        {m.zones_create_names_help({}, options)}
      </p>
      {!primaryLanguage ? <p className="text-sm text-muted-foreground">{m.zone_name_legacy({}, options)}</p> : null}
      <Field>
        <FieldLabel htmlFor="zone-primary-language">{m.zone_name_language({}, options)}</FieldLabel>
        <NativeSelect
          id="zone-primary-language"
          value={primary}
          aria-describedby="zone-name-help"
          onChange={(event) => {
            const language = event.target.value as ZoneLanguage;
            change({ ...labels, [language]: labels[language] ?? '' }, language);
          }}
        >
          {UI_LOCALES.map((language) => (
            <NativeSelectOption key={language} value={language}>
              {languageName(language)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field data-invalid={invalid(primary)}>
        <FieldLabel htmlFor={`zone-label-${primary}`}>{m.zone_name_primary({}, options)}</FieldLabel>
        <Input
          id={`zone-label-${primary}`}
          lang={primary}
          value={labels[primary] ?? ''}
          required
          aria-invalid={invalid(primary)}
          aria-describedby="zone-name-help"
          onChange={(event) => change({ ...labels, [primary]: event.target.value })}
        />
      </Field>
      <details className="min-w-0 space-y-4">
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
              aria-describedby="zone-name-help"
              onChange={(event) => change({ ...labels, [language]: event.target.value })}
            />
            <Button
              type="button"
              variant="outline"
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
          <NativeSelect
            id="zone-add-translation"
            value=""
            onChange={(event) => {
              const language = event.target.value as ZoneLanguage;
              if (language) change({ ...labels, [language]: '' });
            }}
          >
            <NativeSelectOption value="">{m.zone_name_choose({}, options)}</NativeSelectOption>
            {UI_LOCALES.filter((language) => language !== primary && !Object.hasOwn(labels, language)).map(
              (language) => (
                <NativeSelectOption key={language} value={language}>
                  {languageName(language)}
                </NativeSelectOption>
              ),
            )}
          </NativeSelect>
          <FieldDescription>{m.zone_name_translation_help({}, options)}</FieldDescription>
        </Field>
      </details>
    </fieldset>
  );
}
