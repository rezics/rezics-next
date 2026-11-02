import { useId, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import {
  correctProgressAddress,
  type ProgressAddressField,
  type ProgressIndexAddress,
  type ProgressSessionAddress,
} from './progress-address';

export function ProgressAddressCorrection({
  address,
  issue,
  pending = false,
}: {
  address: ProgressIndexAddress | ProgressSessionAddress;
  issue?: ProgressAddressField;
  pending?: boolean;
}) {
  const router = useRouter();
  const labels = {
    subjectId: m.library_progress_address_subject(),
    cursor: m.library_progress_address_cursor(),
    id: m.library_progress_address_session(),
    changes: m.library_progress_address_changes(),
    units: m.library_progress_address_units(),
    logs: m.library_progress_address_logs(),
  };
  const fields: ProgressAddressField[] = 'id' in address ? ['id', 'changes', 'units', 'logs'] : ['subjectId', 'cursor'];
  const navigate = (field: ProgressAddressField, replacement?: string) => {
    const next = correctProgressAddress(address, field, replacement);
    if ('id' in next) {
      const { id, ...search } = next;
      void router.navigate({ to: '/library/progress/$id', params: { id }, search });
    } else void router.navigate({ to: '/library/progress', search: next });
  };
  return (
    <section className="space-y-4" aria-label={m.library_progress_address_heading()}>
      <p role="status">
        {pending
          ? m.library_progress_address_pending()
          : issue
            ? m.library_progress_address_invalid({ field: labels[issue] })
            : m.library_progress_address_heading()}
      </p>
      {fields.map((field) => (
        <AddressField
          key={JSON.stringify([field, address])}
          field={field}
          label={labels[field]}
          value={(address as Partial<Record<ProgressAddressField, string>>)[field] ?? ''}
          invalid={field === issue}
          pending={pending}
          onApply={(value) => navigate(field, value)}
          onReset={field === 'id' ? undefined : () => navigate(field)}
        />
      ))}
    </section>
  );
}
function AddressField({
  label,
  value,
  invalid,
  pending,
  onApply,
  onReset,
}: {
  field: ProgressAddressField;
  label: string;
  value: string;
  invalid: boolean;
  pending: boolean;
  onApply: (value: string) => void;
  onReset?: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value.startsWith('\0') ? value.slice(1) : value);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) onApply(draft);
      }}
    >
      <div className="min-w-0 flex-1">
        <label htmlFor={id}>{label}</label>
        <Input
          id={id}
          value={draft}
          aria-invalid={invalid}
          disabled={pending}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {m.library_progress_address_apply()}
      </Button>
      {onReset ? (
        <Button type="button" variant="outline" disabled={pending} onClick={onReset}>
          {m.library_progress_address_clear()}
        </Button>
      ) : null}
    </form>
  );
}
