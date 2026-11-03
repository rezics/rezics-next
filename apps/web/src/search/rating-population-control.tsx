import { useId } from 'react';
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
}: {
  readiness: RealmRatingReadiness;
  restartHref: string;
}) {
  switch (readiness.status) {
    case 'ready':
      return (
        <p role="status" aria-live="polite">
          Native Realm rating order is ready for the standard question and one subject partition.
        </p>
      );
    case 'preparing':
      return (
        <p role="status" aria-live="polite">
          Realm rating order is being prepared. The selected population and search conditions are kept in place.{' '}
          <a className="underline underline-offset-2" href={restartHref}>
            Check again
          </a>
          .
        </p>
      );
    case 'unavailable':
      return (
        <p role="alert">
          Realm rating order is unavailable. Native Search did not rank a loaded preview or replace this order with
          Global rating.{' '}
          <a className="underline underline-offset-2" href={restartHref}>
            Retry this Realm search
          </a>
          .
        </p>
      );
    case 'refused':
      return (
        <p role="alert">
          Native Search refused this Realm rating request. The population choice is separate from resource
          membership; review the supported Realm choice or search conditions, or select Relevance.
        </p>
      );
    case 'generation-change':
      return (
        <p role="status" aria-live="polite">
          Realm ranking changed during this traversal.{' '}
          <a className="underline underline-offset-2" href={restartHref}>
            Restart the same search
          </a>{' '}
          with the current population and filters. This is a recovery step, not a correction to your conditions.
        </p>
      );
  }
}

export function RatingPopulationControl({
  populations,
  selectedPopulationId,
  readiness,
  restartHref,
  disabled = false,
}: {
  populations?: readonly RealmRatingPopulationOption[] | undefined;
  selectedPopulationId?: string | undefined;
  readiness?: RealmRatingReadiness | undefined;
  restartHref: string;
  disabled?: boolean;
}) {
  const id = useId();
  const choices = supportedRealmRatingPopulations(populations);
  const selected = canonicalRealmRatingPopulationId(selectedPopulationId);
  const selectedIsListed = selected ? choices.some((choice) => choice.id === selected) : true;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:max-w-full">
      <Field orientation="vertical" className="min-w-0 gap-1">
        <FieldLabel htmlFor={id} className="text-sm">
          Rating population
        </FieldLabel>
        <NativeSelect
          id={id}
          name={disabled ? undefined : RATING_POPULATION_FIELD}
          disabled={disabled}
          defaultValue={selected ?? ''}
          className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <NativeSelectOption value="">Global</NativeSelectOption>
          {selected && !selectedIsListed && (
            <NativeSelectOption value={selected}>Selected Realm population</NativeSelectOption>
          )}
          {choices.map((choice) => (
            <NativeSelectOption key={choice.id} value={choice.id}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className="max-w-prose text-xs text-muted-foreground">
          This choice sets the rating population only. It does not add or remove a Realm or Collection membership
          filter.
        </p>
      </Field>
      {disabled && selected && <input type="hidden" name={RATING_POPULATION_FIELD} value={selected} />}
      {selected && readiness && <ReadinessMessage readiness={readiness} restartHref={restartHref} />}
    </div>
  );
}
