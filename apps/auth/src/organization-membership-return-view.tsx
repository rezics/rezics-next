import { useLayoutEffect, useRef } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { MembershipHistory, MembershipHistoryKind } from './organization-membership-return';

function historyText(kind: MembershipHistoryKind) {
  switch (kind) {
    case 'unsent':
      return m.auth_members_return_unsent();
    case 'unresolved':
      return m.auth_members_unknown();
    case 'acknowledged':
      return m.auth_members_acknowledged();
    case 'refused':
      return m.auth_members_return_refused();
  }
}

export function OrganizationMembershipReturnView({
  history,
  retired = false,
  dismiss,
}: {
  history: MembershipHistory;
  retired?: boolean;
  dismiss: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const classification = history.join(',');
  useLayoutEffect(() => {
    if (classification) heading.current?.focus();
  }, [classification, retired]);
  if (!history.length) return null;
  return (
    <Alert aria-labelledby="membership-history-heading" className="space-y-3 break-words">
      <h2
        id="membership-history-heading"
        ref={heading}
        tabIndex={-1}
        className="outline-offset-4 focus-visible:outline-2"
      >
        {m.auth_members_return_heading()}
      </h2>
      <AlertDescription role="status">
        {history.map((kind) => (
          <p key={kind}>{historyText(kind)}</p>
        ))}
        <p>{m.auth_members_return_boundary()}</p>
      </AlertDescription>
      <Button type="button" variant="outline" onClick={dismiss}>
        {m.auth_members_return_dismiss()}
      </Button>
    </Alert>
  );
}
