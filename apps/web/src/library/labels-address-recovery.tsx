import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import type { LabelsAddressIssue } from './labels-address';

export function LabelsAddressRecovery({
  issue,
  query,
  rawQuery,
  rawCursor,
}: {
  issue: LabelsAddressIssue;
  query: string | null;
  rawQuery: string | null;
  rawCursor: string | null;
}) {
  const prefixIssue = issue === 'prefix';

  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{m.library_labels_heading()}</h1>
      <section className="space-y-3" aria-labelledby="labels-address-title">
        <h2 id="labels-address-title" className="text-lg font-medium">
          {prefixIssue ? m.library_labels_address_prefix_title() : m.library_labels_address_cursor_title()}
        </h2>
        <p role="alert">
          {prefixIssue ? m.library_labels_address_prefix_description() : m.library_labels_address_cursor_description()}
        </p>
        <form method="get" className="space-y-3">
          {prefixIssue ? (
            <label className="grid gap-1">
              <span>{m.library_labels_address_prefix_label()}</span>
              <Input name="q" type="text" defaultValue={rawQuery ?? ''} />
            </label>
          ) : (
            <>
              {query !== null ? <input type="hidden" name="q" value={query} /> : null}
              <label className="grid gap-1">
                <span>{m.library_labels_address_cursor_label()}</span>
                <Input name="cursor" type="text" defaultValue={rawCursor ?? ''} />
              </label>
            </>
          )}
          <Button type="submit">{m.library_labels_address_continue()}</Button>
        </form>
        <form method="get">
          <Button type="submit" variant="outline">
            {m.library_labels_address_clear()}
          </Button>
        </form>
      </section>
    </main>
  );
}
