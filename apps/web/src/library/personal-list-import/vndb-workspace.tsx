import type { ReactNode, Ref } from 'react';

/** Provider-local layout for the mounted VNDB journey and its retained recovery state. */
export function VndbWorkspace({
  stage,
  mainRef,
  heading,
  journey,
  recovery,
  children,
  footer,
}: {
  stage: string;
  mainRef?: Ref<HTMLElement>;
  heading: ReactNode;
  journey: ReactNode;
  recovery?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main
      ref={mainRef}
      className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-6"
      data-vndb-workspace-stage={stage}
    >
      <header className="min-w-0 space-y-4 border-b pb-5">
        {heading}
        {journey}
      </header>
      {recovery ? (
        <div className="min-w-0 space-y-3 rounded-lg border bg-muted/20 p-4" data-vndb-recovery>
          {recovery}
        </div>
      ) : null}
      <div className="min-w-0 space-y-6" data-vndb-current-task>
        {children}
      </div>
      {footer ? <footer className="min-w-0 space-y-4 border-t pt-4">{footer}</footer> : null}
    </main>
  );
}

/** Keep native row context in reading order and its consequential action beside it on wide screens. */
export function VndbStage({
  stage,
  children,
  actions,
}: {
  stage: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <section
      className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)]"
      data-vndb-stage={stage}
      tabIndex={-1}
    >
      <div className="min-w-0 space-y-5">{children}</div>
      <div className="min-w-0 lg:sticky lg:top-4 lg:self-start" data-vndb-action-area>
        <div className="min-w-0 rounded-lg border bg-muted/20 p-4">{actions}</div>
      </div>
    </section>
  );
}
