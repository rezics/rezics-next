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
      className="mx-auto grid w-full min-w-0 max-w-[76rem] gap-6 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6 sm:gap-8 sm:px-8 sm:pt-10"
      lang={locale}
      data-slot="hosted-book-reader"
      data-reading-mode={readingMode}
    >
      <header className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
        {identity}
        {contents}
        <div className="grid min-w-0 gap-2">
          {titleLabel}
          <h1
            ref={headingRef}
            id={headingId}
            tabIndex={-1}
            className="rounded-sm text-pretty text-3xl font-semibold leading-tight tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:text-4xl"
          >
            {title}
          </h1>
        </div>
      </header>
      {controls}
      {readingPosition ? <div data-slot="reading-position">{readingPosition}</div> : null}
      <div className="grid min-w-0 gap-6 sm:gap-8" data-slot="reading-content">
        {children}
      </div>
    </section>
  );
}
