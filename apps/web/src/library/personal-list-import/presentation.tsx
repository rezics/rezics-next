import type { ComponentProps, ReactNode } from 'react';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { importLibraryReturnHref } from '../showcase-import-return/navigation';
import { buttonVariants } from '@rezics/ui/shadcn/button';

/** Presentation only: providers retain their own admission, review and command custody. */
export function ImportJourney({ stage }: { stage: string }) {
  const index = stage === 'upload' || stage === 'cleanup' ? 0 : stage === 'review' ? 1 : stage === 'confirm' ? 2 : 3;
  const steps = [
    m.library_import_upload(),
    m.library_import_review(),
    m.library_import_confirm(),
    m.library_import_results(),
  ];
  return (
    <div className="min-w-0 space-y-3">
      <ol className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm sm:grid-cols-4" aria-label={m.library_import_steps()}>
        {steps.map((label, step) => (
          <li
            key={step}
            aria-current={index === step ? 'step' : undefined}
            className={`flex min-w-0 items-start gap-2 border-t-2 pt-2 ${index === step ? 'border-primary font-semibold text-foreground' : 'border-border text-muted-foreground'}`}
          >
            <span
              aria-hidden="true"
              className={`grid size-5 shrink-0 place-items-center rounded-full text-xs tabular-nums ${index === step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {step + 1}
            </span>
            <span className="min-w-0 leading-5 [overflow-wrap:anywhere]">{label}</span>
          </li>
        ))}
      </ol>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_import_private_help()}</p>
    </div>
  );
}

export function ImportFileInput(props: Omit<ComponentProps<'input'>, 'type' | 'className'>) {
  return (
    <Input
      {...props}
      type="file"
      className="h-auto min-h-12 w-full max-w-full cursor-pointer rounded-lg border-dashed bg-muted/20 p-1.5 text-sm file:me-3 file:h-8 file:cursor-pointer file:items-center file:rounded-md file:bg-muted file:px-3 file:text-sm"
    />
  );
}

export function ImportDetails({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <details className="h-auto min-w-0 border-t pt-2 text-sm [overflow-wrap:anywhere]">
      <summary className="cursor-pointer py-3 font-medium underline decoration-muted-foreground/50 underline-offset-4">
        {title ?? m.library_import_evidence()}
      </summary>
      <div className="space-y-3 pb-3 pt-2">{children}</div>
    </details>
  );
}

export function ImportChoice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="h-auto min-w-0 space-y-3 border-t pt-4 [overflow-wrap:anywhere]">
      <h4 className="font-semibold">{title}</h4>
      {children}
    </section>
  );
}

export function ImportTarget({ target }: { target: string | null | undefined }) {
  return (
    <p className="h-auto text-sm [overflow-wrap:anywhere]" data-import-chosen-target>
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
    <a className={buttonVariants({ variant: 'link' })} href={importLibraryReturnHref(getLocale())}>
      {m.library_anilist_return_library()}
    </a>
  );
}
