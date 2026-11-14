import type { ReactNode } from 'react';
import { BookOpenIcon, MessageSquareIcon } from 'lucide-react';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';

/** Presentation of the admitted kind only; neither label grants contribution authority. */
export function ConversationKind({ kind }: { kind: 'discussion' | 'review' }) {
  const Icon = kind === 'review' ? BookOpenIcon : MessageSquareIcon;
  return (
    <span
      data-slot="conversation-kind"
      data-kind={kind}
      className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{kind === 'review' ? m.conversation_review() : m.conversation_discussion()}</span>
    </span>
  );
}

/** Native disclosure leaves local readers, drafts and uncertain operations mounted when closed. */
export function ConversationInspection({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details data-slot="conversation-inspection" className={cn('min-w-0 text-sm', className)}>
      <summary className="min-h-11 cursor-pointer rounded-md py-3 text-muted-foreground underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {label}
      </summary>
      <div className="min-w-0 space-y-3 pb-3 [overflow-wrap:anywhere]">{children}</div>
    </details>
  );
}
