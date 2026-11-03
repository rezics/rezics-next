import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

/** The selection key unmounts this feedback along with the private identity it describes. */
export function FollowingReference({ label, value, current }: { label: string; value: string; current: () => boolean }) {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);
  const pending = useRef(false);
  return <div className="min-w-0 space-y-1">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="select-text break-all text-sm">{value}</code>
      <Button className="min-h-11" variant="outline" aria-label={m.following_reading_copy_reference({ label })} onClick={async () => {
        if (!current() || pending.current) return;
        pending.current = true;
        setFeedback(null);
        try {
          await navigator.clipboard.writeText(value);
          if (current()) setFeedback('copied');
        } catch { if (current()) setFeedback('failed'); }
        finally { pending.current = false; }
      }}>{m.following_reading_copy()}</Button>
      {feedback ? <span role="status">{feedback === 'copied' ? m.following_reading_copied() : m.following_reading_copy_failed()}</span> : null}
    </dd>
  </div>;
}
