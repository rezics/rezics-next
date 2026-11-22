import type { ReactNode } from 'react';
import { PageHeading } from '../shell/page-heading';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

export function StudioMessage({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8">
      <PageHeading>{m.studio_title({}, { locale: getLocale() })}</PageHeading>
      <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
        <p role="alert">{message}</p>
        {children}
      </div>
    </div>
  );
}

export function StudioPreparing() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8">
      <PageHeading>{m.studio_title({}, { locale: getLocale() })}</PageHeading>
      <p role="status">{m.studio_account_preparing({}, { locale: getLocale() })}</p>
    </div>
  );
}
