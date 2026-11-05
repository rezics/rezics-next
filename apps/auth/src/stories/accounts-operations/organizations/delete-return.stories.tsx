import { useRef, useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { OrganizationDeletionLoad } from '../../../organization-deletion';
import type { OrganizationDeletionHistoryView } from '../../../organization-deletion-return';
import { OrganizationDeletionReturnView } from '../../../organization-deletion-return-view';
import { AuthStory, authLocale, reviewParameters } from '../story';

export default {
  title: 'Pages/Account/Delete organization return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

function ReturnStory({
  history,
  initialAdvice = null,
  dark = false,
}: {
  history: OrganizationDeletionHistoryView;
  initialAdvice?: OrganizationDeletionLoad | null;
  dark?: boolean;
}) {
  const [advice, setAdvice] = useState(initialAdvice);
  const [pending, setPending] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const readCurrent = () => {
    setPending(true);
    window.setTimeout(() => {
      setAdvice({ kind: 'denied' });
      setPending(false);
    }, 450);
  };
  return (
    <AuthStory>
      <div className={dark ? 'dark' : undefined}>
        <main className="auth-login-form min-w-0 p-6">
          <h1>{m.auth_organization_delete_heading()}</h1>
          <p>{m.auth_organization_delete_effect()}</p>
          <p>{m.auth_organization_delete_remedies()}</p>
          <OrganizationDeletionReturnView
            history={history}
            advice={advice}
            pending={pending}
            readCurrent={readCurrent}
            headingRef={heading}
          />
        </main>
      </div>
    </AuthStory>
  );
}

export const KnownUnsent = {
  render: () => <ReturnStory history={['unsent']} />,
};

export const DispatchedUnresolved = {
  render: () => <ReturnStory history={['unresolved']} initialAdvice={{ kind: 'unavailable' }} />,
};

export const DispatchedUnresolvedSignedOut = {
  render: () => <ReturnStory history={['unresolved']} initialAdvice={{ kind: 'signed-out' }} />,
};

export const AcknowledgedLight = {
  render: () => <ReturnStory history={['acknowledged']} />,
};

export const AcknowledgedDark = {
  render: () => <ReturnStory history={['acknowledged']} dark />,
};
