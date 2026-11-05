import { Card } from '@rezics/ui/shadcn/card';
import type { ReactNode, Ref } from 'react';
import { m } from './paraglide/messages.js';
import { LocaleChoice } from './locale-choice-view';

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
          <LocaleChoice />
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
  identity,
  headingRef,
  headingTabIndex,
}: {
  heading: string;
  children?: ReactNode;
  returnToSecurity?: boolean;
  identity?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  headingTabIndex?: number;
}) {
  return (
    <main className="auth-main">
      <Card role="region" className="auth-card" aria-labelledby="auth-heading">
        <h1
          id="auth-heading"
          ref={headingRef}
          tabIndex={headingTabIndex}
          aria-describedby={identity ? 'auth-account-identity-description' : undefined}
        >
          {heading}
        </h1>
        {identity}
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
