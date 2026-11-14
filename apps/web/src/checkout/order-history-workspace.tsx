import type { ReactNode } from 'react';
import { PageHeading } from '../shell/page-heading';

function WorkspaceSlot({
  name,
  children,
  className,
}: {
  name: 'current-context' | 'primary-record' | 'permitted-next-action' | 'secondary-evidence';
  children: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <div data-order-history-slot={name} className={className}>
      {children}
    </div>
  );
}

export function OrderHistoryDirectoryFrame({
  heading,
  context,
  records,
  controls,
  status,
}: {
  heading: ReactNode;
  context: ReactNode;
  records: ReactNode;
  controls: ReactNode;
  status: ReactNode;
}) {
  return (
    <section className="max-w-4xl min-w-0 space-y-5 text-foreground" aria-labelledby="orders-heading">
      <PageHeading id="orders-heading" tabIndex={-1} className="text-foreground">
        {heading}
      </PageHeading>
      <WorkspaceSlot name="current-context">{context}</WorkspaceSlot>
      <div className="min-w-0 space-y-4">
        <WorkspaceSlot name="primary-record">{records}</WorkspaceSlot>
        <WorkspaceSlot name="permitted-next-action">{controls}</WorkspaceSlot>
      </div>
      {status}
    </section>
  );
}

export function OrderHistoryReceiptFrame({
  heading,
  context,
  primary,
  actions,
  evidence,
}: {
  heading: ReactNode;
  context: ReactNode;
  primary: ReactNode;
  actions: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <article className="max-w-3xl min-w-0 space-y-6 text-foreground">
      <WorkspaceSlot name="current-context">{context}</WorkspaceSlot>
      <PageHeading className="text-foreground">{heading}</PageHeading>
      <WorkspaceSlot name="primary-record" className="min-w-0 space-y-6">
        {primary}
      </WorkspaceSlot>
      <WorkspaceSlot name="permitted-next-action" className="min-w-0 space-y-5">
        {actions}
      </WorkspaceSlot>
      <WorkspaceSlot name="secondary-evidence" className="min-w-0">
        {evidence}
      </WorkspaceSlot>
    </article>
  );
}
