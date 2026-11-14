import type { ReactNode } from 'react';

/** Shared responsive frames for the creator Offer journey. */
export function CreatorOfferWorkspace({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl min-w-0 space-y-8 px-4 py-6 sm:px-6 lg:py-8">{children}</div>;
}

export function CreatorOfferWorkspacePanel({
  children,
  className = '',
  role,
  ariaLabelledby,
}: {
  children: ReactNode;
  className?: string;
  role?: 'alert' | 'status';
  ariaLabelledby?: string;
}) {
  return (
    <div
      role={role}
      aria-labelledby={ariaLabelledby}
      className={`min-w-0 rounded-2xl border bg-card p-4 text-card-foreground [overflow-wrap:anywhere] sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function CreatorOfferWorkspaceDisclosure({
  title,
  children,
  className = '',
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`min-w-0 ${className}`}>
      <summary className="min-h-11 cursor-pointer content-center break-words text-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {title}
      </summary>
      <div className="min-w-0 space-y-4 py-4 [overflow-wrap:anywhere]">{children}</div>
    </details>
  );
}
