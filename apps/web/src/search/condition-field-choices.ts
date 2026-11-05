import { conditionChoiceLabels } from './condition-editor-model';

type ConditionFieldChoice = { value: string; label: string };

/** Keep a retained choice visible by its exact identity and disambiguate it with the available choices. */
export function conditionFieldChoices(
  choices: readonly ConditionFieldChoice[],
  selected: string,
  selectedLabel: string,
) {
  const retained = !!selected && !choices.some(({ value }) => value === selected);
  const labelled = conditionChoiceLabels(retained ? [{ value: selected, label: selectedLabel }, ...choices] : choices);
  if (!retained) return labelled;

  const suffix = ` (${selected})`;
  return labelled.map((choice) =>
    choice.value !== selected || choice.label === selected || choice.label.endsWith(suffix)
      ? choice
      : { ...choice, label: `${choice.label}${suffix}` },
  );
}
