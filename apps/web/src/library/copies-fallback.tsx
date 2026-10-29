import type { CopiesPageData } from './copies-read';
import { m } from '../paraglide/messages.js';

/** Ordinary forms remain usable before hydration or with JavaScript disabled. The kernel checks the pair. */
export function CopiesFallback({ page, csrfToken }: { page: CopiesPageData; csrfToken?: string | null }) {
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const identity = () => (
    <>
      {hidden('csrf_token', csrfToken ?? '')}
      {hidden('idempotencyKey', page.addKey)}
      {hidden('sendKind', String(page.sendKind ?? false))}
      {hidden('subjectId', page.subjectId ?? '')}
    </>
  );
  return (
    <div className="space-y-4">
      {!page.subjectId ? (
        <form method="get">
          <label>
            {m.library_copy_edition()}
            <input name="subjectId" required />
          </label>
          <button>{m.library_copy_add()}</button>
        </form>
      ) : null}
      {page.profile?.kinds.length ? (
        <details>
          <summary>{m.library_copy_add()}</summary>
          <form method="post" className="space-y-4">
            {identity()}
            {hidden('intent', 'create')}
            {page.profile.kinds.length === 1 ? (
              hidden('kind', page.profile.kinds[0]!.id)
            ) : (
              <label>
                {m.library_copy_kind()}
                <select name="kind">
                  {page.profile.kinds.map((kind) => (
                    <option key={kind.id} value={kind.id}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {m.library_copy_status()}
              <select name="status">
                {page.profile.kinds.flatMap((kind) =>
                  kind.statuses.map((status) => (
                    <option key={`${kind.id}:${status.id}`} value={status.id}>
                      {kind.label} · {status.label}
                    </option>
                  )),
                )}
              </select>
            </label>
            <button type="submit">{m.library_copy_add_submit()}</button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
