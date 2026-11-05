import type { ReactNode, Ref } from 'react';
import { ContentItemFrame } from '@rezics/ui/content-item';
import './post-reading.css';

/** Reading anatomy only. Actions, reply context and editors retain their own authority and lifetime. */
export function PostReadingFrame({
  anchorId,
  itemRef,
  byline,
  actions,
  context,
  children,
}: {
  anchorId: string;
  itemRef?: Ref<HTMLLIElement>;
  byline: ReactNode;
  actions: ReactNode;
  context?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      id={anchorId}
      ref={itemRef}
      tabIndex={-1}
      data-slot="post-reading-frame"
      className="post-reading-frame min-w-0 scroll-mt-24 rounded-xl target:ring-2 target:ring-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <ContentItemFrame
        as="article"
        data-slot="content-item-frame"
        className="min-w-0 rounded-xl px-4 py-5 sm:px-6 sm:py-6"
      >
        <header className="post-reading-header mb-5 flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
          {byline}
          <div className="min-w-0 max-w-full">{actions}</div>
        </header>
        {context}
        {children}
      </ContentItemFrame>
    </li>
  );
}
