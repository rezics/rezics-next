import type { VisualNovelSubjectMatch } from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { useCallback, useState } from 'react';
import type { DesktopApi } from '../shared/desktop';

// Association uses textual matches. The shared Cover component renders its normal placeholder.
const coverSource = () => '';

function pickerSubject({ id, title, type }: VisualNovelSubjectMatch): EntityPickerSubject {
  return { id, title, types: [type], typeLabel: 'Visual novel', cover: null };
}

export function VisualNovelSubjectPicker({
  api,
  subjectId,
  linkedSubject,
  detectedTitle,
  change,
  disabled = false,
}: {
  api: Pick<DesktopApi, 'searchVisualNovelSubjects' | 'cancelVisualNovelSubjectSearch'>;
  subjectId: string;
  linkedSubject?: VisualNovelSubjectMatch | undefined;
  detectedTitle?: string | undefined;
  change: (id: string) => void;
  disabled?: boolean;
}) {
  const [picked, setPicked] = useState<EntityPickerSubject>();
  const selection =
    linkedSubject?.id === subjectId ? pickerSubject(linkedSubject) : picked?.id === subjectId ? picked : undefined;
  const search = useCallback(
    async (query: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      const cancel = () => void api.cancelVisualNovelSubjectSearch(requestId).catch(() => {});
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const results = await api.searchVisualNovelSubjects(query, requestId);
        signal.throwIfAborted();
        return results.map(pickerSubject);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
    [api],
  );

  return (
    <div className="grid min-w-0 gap-2">
      <EntityPicker
        label="Find a visual novel on REZICS"
        placeholder="Search by title, REZICS link or ID"
        search={search}
        suggestedSearch={{ query: subjectId ? undefined : detectedTitle, label: 'Search detected title' }}
        preserveSelectionOnSearch
        src={coverSource}
        disabled={disabled}
        value={selection ? [selection] : []}
        onValueChange={([value]) => {
          setPicked(value);
          change(value?.id ?? '');
        }}
      />
      {subjectId && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="justify-self-start"
          onClick={() => {
            setPicked(undefined);
            change('');
          }}
        >
          Remove link
        </Button>
      )}
    </div>
  );
}
