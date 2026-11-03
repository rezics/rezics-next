import type { FilterDocument } from '@rezics/filter';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { savedQueryCreateHref } from './selection';

/** Private create address for an owned Collection or Library selection. */
export function SaveQueryLink({
  document,
  type,
  state,
  label,
  from,
}: {
  document?: FilterDocument;
  type?: string;
  state?: string;
  label?: string;
  from?: string;
}) {
  return (
    <a
      className="inline-flex min-h-11 items-center rounded-lg border border-border px-4"
      href={savedQueryCreateHref(getLocale(), { document, type, state, label, from })}
    >
      {m.library_saved_query_create()}
    </a>
  );
}
