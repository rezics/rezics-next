import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { useEffect, useState } from 'react';
import { CopyEditionPicker } from '../copy-edition-picker';
import { m } from '../../paraglide/messages.js';

export function VndbTargetSearch({
  disabled,
  value,
  onChange,
}: {
  disabled?: boolean;
  value: EntityPickerSubject | null;
  onChange: (target: EntityPickerSubject | null) => void;
}) {
  const [picked, setPicked] = useState<EntityPickerSubject | null>(value);
  useEffect(() => setPicked(value), [value]);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{m.library_vndb_target_help()}</p>
      <CopyEditionPicker
        value={picked}
        disabled={!!disabled}
        onChange={(subject) => {
          setPicked(subject);
          onChange(subject);
        }}
      />
      {value ? (
        <p className="break-words">{m.library_vndb_target_selected({ title: value.title, id: value.id })}</p>
      ) : null}
    </div>
  );
}
