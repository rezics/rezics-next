import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import {
  canonicalRealmRatingPopulationId,
  RATING_POPULATION_FIELD,
  supportedRealmRatingPopulations,
  type RealmRatingPopulationOption,
  type RealmRatingReadiness,
} from './rating-population';

function ReadinessMessage({
  readiness,
  restartHref,
  locale,
}: {
  readiness: RealmRatingReadiness;
  restartHref: string;
  locale: string;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const messages = {
    ready: m.search_population_ready,
    preparing: m.search_population_preparing,
    unavailable: m.search_population_unavailable,
    refused: m.search_population_refused,
    'generation-change': m.search_population_generation_change,
  };
  const action =
    readiness.status === 'preparing'
      ? m.search_population_check_again
      : readiness.status === 'unavailable'
        ? m.search_population_retry
        : readiness.status === 'generation-change'
          ? m.search_population_restart
          : undefined;
  return (
    <p
      role={readiness.status === 'unavailable' || readiness.status === 'refused' ? 'alert' : 'status'}
      aria-live="polite"
      className="text-sm"
    >
      {messages[readiness.status]({}, options)}
      {action && (
        <>
          {' '}
          <a className="underline underline-offset-2" href={restartHref}>
            {action({}, options)}
          </a>
        </>
      )}
    </p>
  );
}

export function RatingPopulationControl({
  locale = 'en',
  helpId,
  populations,
  selectedPopulationId,
  readiness,
  restartHref,
  disabled = false,
}: {
  locale?: string;
  helpId?: string;
  populations?: readonly RealmRatingPopulationOption[] | undefined;
  selectedPopulationId?: string | undefined;
  readiness?: RealmRatingReadiness | undefined;
  restartHref: string;
  disabled?: boolean;
}) {
  const id = useId();
  const descriptionId = helpId ?? `${id}-help`;
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const choices = supportedRealmRatingPopulations(populations);
  const selected = canonicalRealmRatingPopulationId(selectedPopulationId);
  const selectedIsListed = selected ? choices.some((choice) => choice.id === selected) : true;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 sm:max-w-full">
      <Field orientation="vertical" className="min-w-0 gap-1">
        <FieldLabel htmlFor={id} className="text-sm">
          {m.search_population_label({}, options)}
        </FieldLabel>
        <NativeSelect
          id={id}
          aria-describedby={descriptionId}
          className="w-full min-w-0 max-md:min-h-11 pointer-coarse:min-h-11"
          name={disabled ? undefined : RATING_POPULATION_FIELD}
          disabled={disabled}
          defaultValue={selected ?? ''}
        >
          <NativeSelectOption value="">{m.search_population_global({}, options)}</NativeSelectOption>
          {selected && !selectedIsListed && (
            <NativeSelectOption value={selected}>{m.search_population_selected({}, options)}</NativeSelectOption>
          )}
          {choices.map((choice) => (
            <NativeSelectOption key={choice.id} value={choice.id}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {helpId === undefined && (
          <p id={descriptionId} className="max-w-prose text-xs text-muted-foreground">
            {m.search_population_help({}, options)}
          </p>
        )}
      </Field>
      {disabled && selected && <input type="hidden" name={RATING_POPULATION_FIELD} value={selected} />}
      {selected && readiness && <ReadinessMessage readiness={readiness} restartHref={restartHref} locale={locale} />}
    </div>
  );
}
