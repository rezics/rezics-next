import type { ReactNode, Ref } from 'react';

type ReaderWorkspaceProps = {
  rootRef: Ref<HTMLElement>;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  title: ReactNode;
  titleLabel?: ReactNode;
  identity?: ReactNode;
  contents?: ReactNode;
  controls?: ReactNode;
  readingPosition?: ReactNode;
  children: ReactNode;
  busy: boolean;
  locale: string;
  readingMode: 'pinned' | 'flow';
};

/** A shared presentation frame for the Book identity, contents context and reading area. */
export function ReaderWorkspace({
  rootRef,
  headingId,
  headingRef,
  title,
  titleLabel,
  identity,
  contents,
  controls,
  readingPosition,
  children,
  busy,
  locale,
  readingMode,
}: ReaderWorkspaceProps) {
  return (
    <section
      ref={rootRef}
      aria-labelledby={headingId}
      aria-busy={busy}
      className="mx-auto grid w-full min-w-0 max-w-[68rem] grid-cols-1 gap-3 pb-[max(2rem,env(safe-area-inset-bottom))] pt-3 sm:gap-5 sm:px-5 sm:pt-6"
      lang={locale}
      data-slot="hosted-book-reader"
      data-reading-mode={readingMode}
    >
      <header className="grid min-w-0 grid-cols-1 gap-2 [overflow-wrap:anywhere]">
        {identity}
        {contents}
        <div className="grid min-w-0 grid-cols-1 gap-1">
          {titleLabel}
          <h1
            ref={headingRef}
            id={headingId}
            tabIndex={-1}
            className="min-w-0 max-w-[34ch] rounded-sm font-work-title text-2xl font-semibold leading-tight tracking-tight wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:text-4xl"
          >
            {title}
          </h1>
        </div>
      </header>
      {controls}
      {readingPosition ? <div data-slot="reading-position">{readingPosition}</div> : null}
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:gap-6" data-slot="reading-content">
        {children}
      </div>
    </section>
  );
}
