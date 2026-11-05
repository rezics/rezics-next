import { metaText } from '@rezics/ui/meta-line';
import { useId } from 'react';
import type { CopiesPageData } from './copies-read';
import { m } from '../paraglide/messages.js';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';

const submitTarget =
  'min-h-11 min-w-11 h-auto rounded-lg bg-primary px-4 py-3 font-medium whitespace-normal break-words text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

/** Each ordinary form offers one advertised kind's statuses; the kernel still validates the current pair. */
export function CopiesFallback({ page, csrfToken }: { page: CopiesPageData; csrfToken?: string | null | undefined }) {
  const formId = useId();
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
            <Input id="fallback-copy-subject" name="subjectId" required className="min-h-11" />
          </Field>
          <button type="submit" className={submitTarget}>
            {m.library_copy_add()}
          </button>
        </form>
      ) : null}
      {page.profile?.kinds.length ? (
        <details className="space-y-4">
          <summary className="min-h-11 min-w-11 cursor-pointer rounded-lg px-4 py-3 whitespace-normal break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            {m.library_copy_add()}
          </summary>
          {page.profile.kinds.map((kind, index) => {
            const kindId = `${formId}-kind-${index}`;
            const statusId = `${formId}-status-${index}`;
            return (
              <form key={kind.id} method="post" aria-labelledby={kindId} className="space-y-4">
                {identity()}
                {hidden('intent', 'create')}
                {hidden('kind', kind.id)}
                <FieldSet className="min-w-0 rounded-lg border p-4">
                  <FieldLegend id={kindId} className="max-w-full whitespace-normal break-words">
                    {kind.label}
                  </FieldLegend>
                  <Field className="min-w-0">
                    <FieldLabel htmlFor={statusId} className="whitespace-normal break-words">
                      {metaText([kind.label, m.library_copy_status()])}
                    </FieldLabel>
                    <NativeSelect id={statusId} name="status" className="w-full [&_select]:min-h-11">
                      {kind.statuses.map((status) => (
                        <NativeSelectOption key={status.id} value={status.id}>
                          {status.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <button type="submit" className={submitTarget}>
                    {m.library_copy_add_submit()}
                  </button>
                </FieldSet>
              </form>
            );
          })}
        </details>
      ) : null}
    </div>
  );
}
