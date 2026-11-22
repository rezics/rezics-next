import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { contentSubjectPreset, searchContentSubjects } from '../threads/content-subject-search';

export function KnowledgeSubjectPicker({
  ids,
  anchorId,
  label,
  disabled,
  onChange,
}: {
  ids: readonly string[];
  anchorId?: string | undefined;
  label: string;
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<readonly EntityPickerSubject[]>([]);
  const selectedById = new Map(selected.map((subject) => [subject.id, subject]));
  const value = ids.map((id) => selectedById.get(id) ?? contentSubjectPreset(id, id));
  const capacity = !anchorId || ids.includes(anchorId) ? 64 : 63;
  return (
    <EntityPicker
      label={label}
      src={coverSrc}
      multiple
      value={value}
      disabled={disabled}
      search={async (text, signal) => {
        if (value.length >= capacity) return [];
        const results = await searchContentSubjects(text, signal);
        return results.filter((subject) => subject.id !== anchorId);
      }}
      onValueChange={(subjects) => {
        if (subjects.length > capacity) return;
        setSelected(subjects);
        onChange(subjects.map((subject) => subject.id));
      }}
    />
  );
}
