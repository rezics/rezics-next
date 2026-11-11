import { useId, type ReactNode, type Ref } from 'react';
import { Field, FieldLabel } from '../shadcn/field.tsx';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select.tsx';
import { cn } from '../utils.ts';

export type ChoiceSelectOption = Readonly<{
  value: string | null;
  label: ReactNode;
  disabled?: boolean;
  lang?: string;
}>;

type ChoiceSelectName =
  | { label: ReactNode; ariaLabel?: never; ariaLabelledBy?: never }
  | { label?: never; ariaLabel: string; ariaLabelledBy?: never }
  | { label?: never; ariaLabel?: never; ariaLabelledBy: string };

type ChoiceSelectBaseProps = {
  id?: string;
  name?: string;
  form?: string;
  required?: boolean;
  disabled?: boolean;
  options: readonly ChoiceSelectOption[];
  placeholder?: ReactNode;
  ariaDescribedBy?: string;
  ariaDetails?: string;
  fieldClassName?: string;
  labelClassName?: string;
  triggerClassName?: string;
  triggerDataAttributes?: Record<`data-${string}`, string | number | boolean | undefined>;
  triggerLang?: string;
  triggerRef?: Ref<HTMLButtonElement>;
};

export type ChoiceSelectProps = ChoiceSelectBaseProps &
  ChoiceSelectName & {
    value?: string | null;
    defaultValue?: string | null;
    onValueChange?: (value: string | null) => void;
  };

/** A labelled field composition for common Select choices; option values stay caller-owned. */
export function ChoiceSelect(props: ChoiceSelectProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const labelId = props.label !== undefined ? `${id}-label` : undefined;
  const items = props.options.map(({ value, label }) => ({ value, label }));
  const control = <SelectControl {...props} id={id} labelId={labelId} items={items} />;

  if (props.label === undefined) return control;

  return (
    <Field className={props.fieldClassName}>
      <FieldLabel id={labelId} htmlFor={id} className={props.labelClassName}>
        {props.label}
      </FieldLabel>
      {control}
    </Field>
  );
}

function SelectControl(
  props: ChoiceSelectProps & {
    id: string;
    labelId: string | undefined;
    items: { value: string | null; label: ReactNode }[];
  },
) {
  const trigger = (
    <SelectTrigger
      ref={props.triggerRef}
      id={props.id}
      lang={props.triggerLang}
      {...props.triggerDataAttributes}
      aria-label={props.ariaLabel}
      aria-labelledby={props.labelId ?? props.ariaLabelledBy}
      aria-describedby={props.ariaDescribedBy}
      aria-details={props.ariaDetails}
      className={cn('min-h-11 h-auto w-full', props.triggerClassName)}
    >
      <SelectValue placeholder={props.placeholder} />
    </SelectTrigger>
  );
  const options = (
    <SelectContent alignItemWithTrigger={false}>
      <SelectGroup>
        {props.options.map((option, index) => (
          <SelectItem
            key={`${option.value ?? 'empty'}-${index}`}
            value={option.value}
            disabled={option.disabled}
            lang={option.lang}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectGroup>
    </SelectContent>
  );

  return (
    <Select<string, false>
      id={props.id}
      name={props.name}
      form={props.form}
      required={props.required}
      disabled={props.disabled}
      items={props.items}
      value={props.value}
      defaultValue={props.defaultValue}
      onValueChange={props.onValueChange}
    >
      {trigger}
      {options}
    </Select>
  );
}
