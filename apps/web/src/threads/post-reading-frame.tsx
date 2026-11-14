import type { ReactNode, Ref } from 'react';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { ConversationInspection } from './conversation-presentation';
import { m } from '../paraglide/messages.js';
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
        <header
          data-slot="post-reading-identity"
          className="post-reading-header mb-5 min-w-0 [overflow-wrap:anywhere]"
        >
          {byline}
        </header>
        {context ? (
          <div data-slot="post-reading-context" className="mb-4 min-w-0 [overflow-wrap:anywhere]">
            {context}
          </div>
        ) : null}
        <div data-slot="post-reading-body" className="min-w-0 max-w-full">{children}</div>
        <div
          data-slot="post-conversation-actions"
          className="mt-5 min-w-0 max-w-full border-t border-border/60 pt-3 [overflow-wrap:anywhere] [&_[data-slot=feed-action-bar]]:flex-wrap [&_[data-slot=feed-action-bar]]:justify-start [&_[data-slot=feed-action-bar]_button]:whitespace-normal [&_[data-slot=feed-action-bar]_button]:[overflow-wrap:anywhere] [&_[data-slot=feed-action-bar]_a]:whitespace-normal [&_[data-slot=feed-action-bar]_a]:[overflow-wrap:anywhere]"
        >
          {actions}
        </div>
        {details ? (
          <div data-slot="post-reading-inspection" className="mt-1 min-w-0">
            <ConversationInspection label={m.conversation_post_details()}>
              {details}
            </ConversationInspection>
          </div>
        ) : null}
      </ContentItemFrame>
    </li>
  );
}
