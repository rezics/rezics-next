import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import type { ComponentProps, ReactNode } from 'react';

export const actionClass = 'h-auto min-h-7 max-w-full shrink whitespace-normal [overflow-wrap:anywhere]';

export function BangumiAction(props: ComponentProps<typeof Button>) {
  return <Button className={actionClass} {...props} />;
}

export function BangumiCheck({
  id,
  checked,
  disabled,
  label,
  onToggle,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  label: ReactNode;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="min-w-0">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(value === true)}
      />
      <FieldLabel className="h-auto min-w-0 items-center whitespace-normal [overflow-wrap:anywhere]" htmlFor={id}>
        {label}
      </FieldLabel>
    </Field>
  );
}
