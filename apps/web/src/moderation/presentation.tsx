import { useId, type ReactNode } from 'react';
import { Badge } from '@rezics/ui/shadcn/badge';
import { m } from '../paraglide/messages.js';

/** Shared touch targets also wrap translated labels and long supplied references. */
export const moderationControl =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center gap-2 whitespace-normal break-words px-3 py-2 text-sm focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export const moderationLink =
  'inline-flex min-h-11 max-w-full items-center gap-2 py-2 text-sm underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type ModerationReferenceField = { label: string; value: ReactNode };

/** References remain selectable without competing with the retained human evidence. */
export function ModerationReference({
  fields,
  label = m.reporter_status_reference(),
  children,
}: {
  fields: readonly ModerationReferenceField[];
  label?: string;
  children?: ReactNode;
}) {
  return (
    <details className="min-w-0 border-t pt-2">
      <summary className="min-h-11 cursor-pointer rounded-sm py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {label}
      </summary>
      <dl className="grid min-w-0 gap-4 py-3 text-sm sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.label} className="min-w-0 space-y-1">
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd dir="ltr" className="select-text break-all font-mono leading-6">{field.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </details>
  );
}

/** Admission describes this read only; native action advice remains with each form. */
export function ModerationScope({
  kind,
  id,
  label,
  admitted,
}: {
  kind: 'board' | 'catalogue';
  id?: string;
  label?: string | null;
  admitted: boolean;
}) {
  return (
    <div className="min-w-0 space-y-2 border-l-2 border-primary pl-4">
      <p className="text-xs font-medium text-muted-foreground">{m.moderation_scope_label()}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 text-base font-semibold [overflow-wrap:anywhere]">
          {label || (kind === 'board' ? m.moderation_queue_board() : m.moderation_scope_catalogue())}
        </p>
        {admitted ? <Badge variant="secondary">{m.moderation_admission_current()}</Badge> : null}
      </div>
      {id ? <p dir="ltr" className="select-text break-all font-mono text-xs text-muted-foreground">{id}</p> : null}
    </div>
  );
}

/** One flat review region follows the evidence; command owners supply their own controls. */
export function ModerationActionRegion({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="min-w-0 space-y-4 border-t pt-5">
      <h3 id={heading} className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Keep dangerous operands visible even when the current target cannot be opened. */
export function ModerationActionTarget({
  kind,
  id,
  reference,
}: {
  kind: string;
  id: string;
  reference?: ModerationReferenceField;
}) {
  return (
    <div className="min-w-0 space-y-2 border-l-2 border-border pl-3 text-sm">
      <p className="font-medium">{m.moderation_action_target()}</p>
      <p className="min-w-0 [overflow-wrap:anywhere]">
        {kind} <code dir="ltr" className="select-text break-all">{id}</code>
      </p>
      {reference ? (
        <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {reference.label}: <code dir="ltr" className="select-text break-all">{reference.value}</code>
        </p>
      ) : null}
    </div>
  );
}
