import { useState } from 'react';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';

export function SearchInputRecovery({
  parameter,
  value,
  onApply,
  onRemove,
}: {
  parameter: string;
  value: string;
  onApply: (value: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(value);

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.search_heading()}</PageHeading>
      <Empty className="border" role="alert">
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{m.search_input_recovery_title()}</EmptyTitle>
        </EmptyHeader>
        <p>{m.search_input_recovery_description({ parameter })}</p>
        <form
          className="w-full space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onApply(draft);
          }}
        >
          <label className="block space-y-2 text-sm font-medium" htmlFor="search-input-recovery-value">
            {m.search_input_recovery_input_label({ parameter })}
            <textarea
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="min-h-48 w-full rounded-md border bg-background p-3 font-mono text-sm text-foreground"
              id="search-input-recovery-value"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground" type="submit">
              {m.search_input_recovery_apply()}
            </button>
            <button className="rounded-md border px-4 py-2" type="button" onClick={onRemove}>
              {m.search_input_recovery_remove()}
            </button>
          </div>
        </form>
      </Empty>
    </section>
  );
}
