import { useState } from 'react';
import { AuthShell } from './frame';
import { RouteFailureView } from './route-failure-view';
import type { RouteRetryState } from './route-failure';

export default {
  title: 'Pages/Auth/Route recovery',
  parameters: {
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' } },
      },
    },
  },
};

function Example({ kind, initial, dark = false }: { kind: 'failure' | 'missing'; initial: RouteRetryState; dark?: boolean }) {
  const [state, setState] = useState(initial);
  const retry = () => {
    if (state === 'pending') return;
    setState('pending');
    window.setTimeout(() => setState('failed'), 650);
  };
  return (
    <div className={dark ? 'dark' : ''}>
      <AuthShell>
        <RouteFailureView kind={kind} state={state} onRetry={retry} />
      </AuthShell>
    </div>
  );
}

export const Recoverable = { render: () => <Example kind="failure" initial="ready" /> };
export const RetryPending = { render: () => <Example kind="failure" initial="pending" /> };
export const RetryFailed = { render: () => <Example kind="failure" initial="failed" /> };
export const MissingPage = { render: () => <Example kind="missing" initial="ready" /> };
export const DarkRecovery = { render: () => <Example kind="failure" initial="ready" dark /> };
