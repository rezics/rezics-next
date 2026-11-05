import type { CopyItem } from '../copies-read';
import { m } from '../../paraglide/messages.js';

export const hasUnresolvedHistory = (copy: CopyItem) =>
  copy.meaning !== 'known' || !copy.kindLabel || !copy.statusLabel;

/** Historical display consumes the row's supplied presentation, never current definitions. */
export function CopyInventoryHistory({ copy }: { copy: CopyItem }) {
  if (!hasUnresolvedHistory(copy)) return null;
  return (
    <div className="mt-2">
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.library_copy_history_details()}
        </summary>
        <div className="space-y-2 pt-2 text-muted-foreground">
          <p>
            {copy.meaning === 'unknown' ? m.library_copy_meaning_unknown() : m.library_history_unavailable()}
          </p>
          <dl className="space-y-2">
            <div>
              <dt>{m.library_copy_kind()}</dt>
              <dd className="break-all text-foreground">
                <code>{copy.kind ?? 'null'}</code>
              </dd>
            </div>
            <div>
              <dt>{m.library_copy_status()}</dt>
              <dd className="break-all text-foreground">
                <code>{copy.status}</code>
              </dd>
            </div>
          </dl>
        </div>
      </details>
    </div>
  );
}
