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
  details,
  children,
}: {
  anchorId: string;
  itemRef?: Ref<HTMLLIElement>;
  byline: ReactNode;
  actions: ReactNode;
  context?: ReactNode;
  details?: ReactNode;
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
        className="min-w-0 rounded-xl border border-border/60 bg-card px-4 py-5 sm:px-6 sm:py-6"
      >
        <header className="post-reading-header mb-5 min-w-0">{byline}</header>
        {context}
        {children}
        <div
          data-slot="post-conversation-actions"
          className="mt-5 min-w-0 max-w-full border-t border-border/60 pt-3 [&_[data-slot=feed-action-bar]]:justify-start"
        >
          {actions}
        </div>
        {details}
      </ContentItemFrame>
    </li>
  );
}
