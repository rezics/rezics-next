import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldTitle } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useId } from 'react';

export function PathField({
  name,
  path,
  disabled,
  pick,
  clear,
  fallback = 'No selection',
}: {
  name: string;
  path: string | undefined;
  disabled: boolean;
  pick: () => void;
  clear?: () => void;
  fallback?: string;
}) {
  const label = useId();
  return (
    <Field aria-labelledby={label} data-disabled={disabled || undefined}>
      <FieldTitle id={label}>{name}</FieldTitle>
      <div className="actions">
        <span className="path" title={path}>
          {path ?? fallback}
        </span>
        <Button
          type="button"
          variant="outline"
          aria-label={`Choose ${name.toLowerCase()}`}
          disabled={disabled}
          onClick={pick}
        >
          Choose…
        </Button>
        {clear && path && (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={clear}
            aria-label={`Clear ${name.toLowerCase()}`}
          >
            Clear
          </Button>
        )}
      </div>
    </Field>
  );
}

type InstanceFieldProps = { id: string; value: string; change: (value: string) => void; disabled: boolean };

export function InstanceNameField({ id, value, change, disabled }: InstanceFieldProps) {
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        id={id}
        name="name"
        required
        value={value}
        maxLength={120}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      />
    </Field>
  );
}

export function InstanceSubjectField({ id, value, change, disabled }: InstanceFieldProps) {
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>REZICS Subject ID (optional)</FieldLabel>
      <Input
        id={id}
        name="subjectId"
        value={value}
        maxLength={36}
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      />
    </Field>
  );
}
