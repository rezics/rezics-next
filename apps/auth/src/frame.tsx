import { Card } from '@rezics/ui/shadcn/card';
import type { ReactNode } from 'react';
import { m } from './paraglide/messages.js';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <header className="auth-header">
        <div className="auth-header-inner">
          <a className="auth-brand" href="/" aria-label="REZICS">
            <svg aria-hidden="true" viewBox="0 142.857 1000 714.286" className="auth-mark">
              <path d="M0 571.429 642.857 142.857 571.429 428.571 1000 142.857v285.714L357.143 857.143l71.428-285.714L0 857.143Z" />
            </svg>
            <span>REZICS</span>
          </a>
        </div>
      </header>
      {children}
    </div>
  );
}

export function AuthPage({
  heading,
  children,
  returnToSecurity = false,
}: {
  heading: string;
  children?: ReactNode;
  returnToSecurity?: boolean;
}) {
  return (
    <main className="auth-main">
      <Card role="region" className="auth-card" aria-labelledby="auth-heading">
        <h1 id="auth-heading">{heading}</h1>
        {returnToSecurity ? (
          <nav className="auth-operation-exit" aria-label={m.auth_security_heading()}>
            <a href="/security">{m.auth_account_operation_return()}</a>
            <p>{m.auth_account_operation_leave_notice()}</p>
          </nav>
        ) : null}
        {children}
      </Card>
    </main>
  );
}
