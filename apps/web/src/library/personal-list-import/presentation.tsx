import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { importLibraryReturnHref } from '../showcase-import-return/navigation';

/** Presentation only: providers retain their own admission, review and command custody. */
export function ImportJourney({ stage }: { stage: string }) {
  const index = stage === 'upload' ? 0 : stage === 'review' ? 1 : stage === 'confirm' ? 2 : 3;
  const steps = [
    m.library_import_upload(),
    m.library_import_review(),
    m.library_import_confirm(),
    m.library_import_results(),
  ];
  return (
    <div className="space-y-4">
      <ol
        className="grid grid-cols-2 gap-x-4 gap-y-2 border-b pb-4 text-sm sm:grid-cols-4"
        aria-label={m.library_import_steps()}
      >
        {steps.map((label, step) => (
          <li
            key={step}
            aria-current={index === step ? 'step' : undefined}
            className={index === step ? 'font-semibold text-foreground' : 'text-muted-foreground'}
          >
            <span aria-hidden="true" className="me-2 tabular-nums">
              {step + 1}.
            </span>
            {label}
          </li>
        ))}
      </ol>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_import_private_help()}</p>
    </div>
  );
}

export function ImportDetails({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <details className="min-w-0 border-t pt-2 text-sm [overflow-wrap:anywhere]">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium underline decoration-muted-foreground/50 underline-offset-4">
        {title ?? m.library_import_evidence()}
      </summary>
      <div className="space-y-3 pb-3 pt-2">{children}</div>
    </details>
  );
}

export function ImportChoice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-3 border-t pt-4 [overflow-wrap:anywhere]">
      <h4 className="font-semibold">{title}</h4>
      {children}
    </section>
  );
}

export function ImportTarget({ target }: { target: string | null | undefined }) {
  return (
    <p className="text-sm [overflow-wrap:anywhere]" data-import-chosen-target>
      <span className="font-medium">{m.library_import_target()}: </span>
      {target ?? m.library_import_unmatched()}
    </p>
  );
}

export function ImportEmpty({ results = false }: { results?: boolean }) {
  return (
    <p role="status" className="rounded-md border border-dashed p-5 text-muted-foreground">
      {results ? m.library_import_no_results() : m.library_import_empty()}
    </p>
  );
}

export function ImportReturn() {
  return (
    <a
      className="inline-flex min-h-11 items-center underline underline-offset-4"
      href={importLibraryReturnHref(getLocale())}
    >
      {m.library_anilist_return_library()}
    </a>
  );
}
