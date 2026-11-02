import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { EllipsisIcon } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { m } from '../paraglide/messages.js';

/** A changed admitted destination retires the previous row's copy interaction. */
export function CopyDiscussionLink({ href }: { href: string }) {
  return <CopyLink key={href} href={href} />;
}

function CopyLink({ href }: { href: string }) {
  const fieldId = useId();
  const statusId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const attempt = useRef(0);
  const [result, setResult] = useState<{ kind: 'copied' } | { kind: 'manual'; url: string } | null>(null);

  useLayoutEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  useEffect(() => {
    if (result?.kind !== 'manual') return;
    // Menu dismissal restores its trigger first; manual recovery then receives the selection.
    const frame = requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [result]);

  async function copyLink() {
    const current = ++attempt.current;
    const url = new URL(href, window.location.origin).href;
    setResult(null);
    try {
      await navigator.clipboard.writeText(url);
      if (attempt.current === current) setResult({ kind: 'copied' });
    } catch {
      if (attempt.current === current) setResult({ kind: 'manual', url });
    }
  }

  function close() {
    attempt.current++;
    setResult(null);
    trigger.current?.focus();
  }

  return (
    <>
      <Menu
        title={m.thread_content_more_actions()}
        trigger={
          <Button
            ref={trigger}
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            aria-label={m.thread_content_more_actions()}
          >
            <EllipsisIcon />
          </Button>
        }
        entries={[
          { type: 'link', label: m.board_feed_open_thread(), href },
          { type: 'item', label: m.thread_content_copy_link(), onSelect: () => void copyLink() },
        ]}
      />
      {result ? (
        <div className="min-w-0 max-w-full space-y-2 text-sm">
          <p id={statusId} role="status">
            {result.kind === 'copied' ? m.board_feed_link_copied() : m.board_feed_copy_failed()}
          </p>
          {result.kind === 'manual' ? (
            <>
              <label htmlFor={fieldId} className="block">
                {m.board_feed_copy_url()}
              </label>
              <input
                ref={field}
                id={fieldId}
                aria-describedby={statusId}
                type="text"
                dir="ltr"
                readOnly
                spellCheck={false}
                value={result.url}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  close();
                }}
                className="min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              <Button type="button" variant="outline" className="min-h-11" onClick={close}>
                {m.board_feed_copy_close()}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
