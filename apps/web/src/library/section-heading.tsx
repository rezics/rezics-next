import type { ReactNode } from 'react';

/** Shared heading style for home sections. */
export function SectionHeading({
  children,
  id,
  lang,
}: {
  children: ReactNode;
  id?: string | undefined;
  lang?: string | undefined;
}) {
  return (
    <h2 id={id} lang={lang} className="text-2xl leading-snug font-semibold tracking-tight text-balance">
      {children}
    </h2>
  );
}
