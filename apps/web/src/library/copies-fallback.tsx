import { metaText } from '@rezics/ui/meta-line';
import type { CopiesPageData } from './copies-read';
import { m } from '../paraglide/messages.js';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';

/** Ordinary forms remain usable before hydration or with JavaScript disabled. The kernel checks the pair. */
export function CopiesFallback({ page, csrfToken }: { page: CopiesPageData; csrfToken?: string | null | undefined }) {
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
          <Field>
            <FieldLabel htmlFor="fallback-copy-subject">{m.library_copy_edition()}</FieldLabel>
            <Input id="fallback-copy-subject" name="subjectId" required />
          </Field>
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
              <Field>
                <FieldLabel htmlFor="fallback-copy-kind">{m.library_copy_kind()}</FieldLabel>
                <NativeSelect id="fallback-copy-kind" name="kind">
                  {page.profile.kinds.map((kind) => (
                    <NativeSelectOption key={kind.id} value={kind.id}>
                      {kind.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="fallback-copy-status">{m.library_copy_status()}</FieldLabel>
              <NativeSelect id="fallback-copy-status" name="status">
                {page.profile.kinds.flatMap((kind) =>
                  kind.statuses.map((status) => (
                    <NativeSelectOption key={`${kind.id}:${status.id}`} value={status.id}>
                      {metaText([kind.label, status.label])}
                    </NativeSelectOption>
                  )),
                )}
              </NativeSelect>
            </Field>
            <button type="submit">{m.library_copy_add_submit()}</button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
