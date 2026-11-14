import type { ReactNode } from 'react';

export function EntitlementDirectoryFrame({ children }: { children: ReactNode }) {
  return (
    <section
      className="w-full max-w-6xl min-w-0 space-y-8"
      aria-labelledby="entitlements-heading"
    >
      {children}
    </section>
  );
}

export function EntitlementRecordFrame({ children }: { children: ReactNode }) {
  return (
    <article
      className="w-full max-w-6xl min-w-0 space-y-8"
      aria-labelledby="entitlement-heading"
    >
      {children}
    </article>
  );
}
