import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import type { ComponentProps, ReactNode } from 'react';

export const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export function AniListAction(props: ComponentProps<typeof Button>) {
  return <Button size="lg" className={actionClass} {...props} />;
}

export function AniListCheck({
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
        className="size-11 after:inset-0"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(value === true)}
      />
      <FieldLabel className="min-h-11 min-w-0 items-center whitespace-normal [overflow-wrap:anywhere]" htmlFor={id}>
        {label}
      </FieldLabel>
    </Field>
  );
}
