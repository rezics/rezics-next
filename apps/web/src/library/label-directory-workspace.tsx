import type { ReactNode, Ref } from 'react';

/** Layout for the private Labels route; page and action behavior stay with its caller. */
export function LabelDirectoryWorkspace({
  heading,
  prelude,
  description,
  privacy,
  directoryTools,
  createForm,
  feedback,
  catalogue,
  state,
  articleRef,
  busy,
}: {
  heading: ReactNode;
  prelude?: ReactNode;
  description?: ReactNode;
  privacy?: ReactNode;
  directoryTools?: ReactNode;
  createForm?: ReactNode;
  feedback?: ReactNode;
  catalogue?: ReactNode;
  state?: ReactNode;
  articleRef?: Ref<HTMLElement>;
  busy?: boolean;
}) {
  if (state !== undefined)
    return (
      <article className="min-w-0 max-w-3xl space-y-6">
        {heading}
        {state}
      </article>
    );

  return (
    <article
      ref={articleRef}
      tabIndex={-1}
      className="min-w-0 max-w-6xl space-y-8 text-foreground"
      aria-busy={busy}
    >
      {prelude}
      <header className="space-y-3 border-b pb-6">
        {heading}
        {description}
        {privacy}
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.72fr)] lg:gap-8">
        {directoryTools ? (
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">{directoryTools}</div>
        ) : null}
        {createForm ? (
          <aside className="min-w-0 lg:col-start-2 lg:row-start-1">{createForm}</aside>
        ) : null}
        {feedback ? <div className="min-w-0 space-y-4 lg:col-start-1">{feedback}</div> : null}
        {catalogue ? (
          <section className="min-w-0 space-y-6 lg:col-start-1">
            {catalogue}
          </section>
        ) : null}
      </div>
    </article>
  );
}
