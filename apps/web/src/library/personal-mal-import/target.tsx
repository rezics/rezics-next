import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useId, useState } from 'react';
import { CopyEditionPicker } from '../copy-edition-picker';
import { m } from '../../paraglide/messages.js';
import { SUBJECT_ID } from './contract';

export function MalTargetSearch({
  disabled,
  value,
  onChange,
}: {
  disabled?: boolean;
  value: string | null;
  onChange: (target: string | null) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState(value ?? '');
  const [picked, setPicked] = useState<EntityPickerSubject | null>(
    value ? { id: value, title: value, types: [], typeLabel: '', cover: null } : null,
  );
  function assign(next: string) {
    const id = next.trim();
    setTyped(id);
    onChange(SUBJECT_ID.test(id) ? id : null);
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{m.library_mal_target_help()}</p>
      <CopyEditionPicker
        value={picked}
        disabled={!!disabled}
        onChange={(subject) => {
          setPicked(subject);
          assign(subject?.id ?? '');
        }}
      />
      <Field>
        <FieldLabel htmlFor={id} className="min-h-11 items-center">
          {m.library_mal_target_id()}
        </FieldLabel>
        <Input
          id={id}
          data-mal-target
          value={typed}
          disabled={disabled}
          className="min-h-11"
          onChange={(event) => {
            setPicked(null);
            assign(event.target.value);
          }}
        />
      </Field>
    </div>
  );
}
