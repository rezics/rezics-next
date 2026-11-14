import type { ComponentProps, ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';

/** Presentation only: callers retain disclosure, selection, focus and command ownership. */
export function ManagementReference({ children }: { children: string }) {
  return (
    <span
      dir="ltr"
      className="inline-block max-w-full select-all whitespace-normal break-all font-mono text-xs leading-6"
    >
      {children}
    </span>
  );
}

export function ManagementField({
  label,
  children,
  className = '',
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 space-y-1 ${className}`}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function ManagementReferences({
  children,
  label = m.realm_review_details_heading(),
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <details className="min-w-0 text-sm">
      <summary className="min-h-11 min-w-11 cursor-pointer content-center rounded-md py-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {label}
      </summary>
      <dl className="grid min-w-0 gap-3 py-3 sm:grid-cols-2">{children}</dl>
    </details>
  );
}

/** A supplied label leads; references stay selectable and never imply a profile destination. */
export function ManagementIdentity({ label, reference }: { label: ReactNode; reference?: string }) {
  return (
    <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
      <div className="font-semibold leading-6">{label}</div>
      {reference ? (
        <p className="text-muted-foreground">
          <ManagementReference>{reference}</ManagementReference>
        </p>
      ) : null}
    </div>
  );
}

export function ManagementRow({
  title,
  metadata,
  state,
  actions,
  children,
  preview,
  headingLevel = 3,
}: {
  title: ReactNode;
  metadata?: ReactNode;
  state?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  preview?: ReactNode;
  headingLevel?: 3 | 4;
}) {
  const Heading = headingLevel === 4 ? 'h4' : 'h3';
  return (
    <li className="min-w-0 border-b px-1 py-4 last:border-b-0 sm:px-3 [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1 basis-48 space-y-2">
          <Heading className="min-w-0 font-semibold leading-6">{title}</Heading>
          {metadata}
        </div>
        {state || actions ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {state}
            {actions}
          </div>
        ) : null}
      </div>
      {children || preview ? <div className="mt-4 min-w-0">{children ?? preview}</div> : null}
    </li>
  );
}

export function ManagementNotice({ children, role = 'status', ...props }: ComponentProps<'div'>) {
  return (
    <div
      role={role}
      {...props}
      className={`min-w-0 space-y-3 rounded-lg border bg-muted/20 p-4 text-sm leading-6 ${props.className ?? ''}`}
    >
      {children}
    </div>
  );
}

/** An inline action review, using the existing nonmodal review and focus contract. */
export function ManagementReview({
  title,
  children,
  actions,
  destructive = false,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  title: string;
  actions?: ReactNode;
  destructive?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      {...props}
      className={`min-w-0 space-y-4 rounded-xl border bg-background p-4 sm:p-5 ${destructive ? 'border-destructive/40' : ''} ${props.className ?? ''}`}
    >
      {!props['aria-labelledby'] ? <p className="font-semibold leading-6">{title}</p> : null}
      <div className="min-w-0 space-y-3 text-sm leading-6">{children}</div>
      {actions ? <div className="flex min-w-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
