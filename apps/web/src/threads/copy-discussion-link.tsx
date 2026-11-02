import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { EllipsisIcon } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { m } from '../paraglide/messages.js';

type CopyFocusIntent = {
  attempt: number;
  trigger: HTMLButtonElement | null;
  triggerRestoreAvailable: boolean;
  handingOff: boolean;
  active: boolean;
  cancelFrame: () => void;
};
let keyboardActivation = false;
let activeFocusIntent: CopyFocusIntent | null = null;
let mountedCallers = 0;

function cancelFocusIntent(intent: CopyFocusIntent) {
  intent.active = false;
  if (activeFocusIntent === intent) activeFocusIntent = null;
  intent.cancelFrame();
}

function cancelActiveFocusIntent() {
  if (activeFocusIntent) cancelFocusIntent(activeFocusIntent);
}

function trackCopyKeydown(event: KeyboardEvent) {
  cancelActiveFocusIntent();
  const target = event.target;
  keyboardActivation =
    (event.key === 'Enter' || event.key === ' ') &&
    target instanceof Element &&
    target.closest('button, [role="menuitem"]') !== null;
  queueMicrotask(() => {
    keyboardActivation = false;
  });
}

function trackCopyPointerdown() {
  keyboardActivation = false;
  cancelActiveFocusIntent();
}

function trackCopyFocusin(event: FocusEvent) {
  keyboardActivation = false;
  const intent = activeFocusIntent;
  if (!intent || intent.handingOff) return;
  if (intent.triggerRestoreAvailable && event.target === intent.trigger) {
    intent.triggerRestoreAvailable = false;
    return;
  }
  cancelFocusIntent(intent);
}

function trackCopyInteraction() {
  if (mountedCallers++ === 0) {
    document.addEventListener('keydown', trackCopyKeydown, true);
    document.addEventListener('pointerdown', trackCopyPointerdown, true);
    document.addEventListener('focusin', trackCopyFocusin, true);
  }
  return () => {
    if (--mountedCallers !== 0) return;
    cancelActiveFocusIntent();
    keyboardActivation = false;
    document.removeEventListener('keydown', trackCopyKeydown, true);
    document.removeEventListener('pointerdown', trackCopyPointerdown, true);
    document.removeEventListener('focusin', trackCopyFocusin, true);
  };
}

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
  const focusIntent = useRef<CopyFocusIntent | null>(null);
  const focusFrame = useRef<number | null>(null);
  const [result, setResult] = useState<{ kind: 'copied' } | { kind: 'manual'; url: string } | null>(null);

  function cancelCurrentFocusIntent() {
    if (focusIntent.current) cancelFocusIntent(focusIntent.current);
    focusIntent.current = null;
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
  }

  useEffect(() => trackCopyInteraction(), []);
  useLayoutEffect(
    () => () => {
      attempt.current++;
      cancelCurrentFocusIntent();
    },
    [],
  );
  useEffect(() => {
    if (result?.kind !== 'manual') return;
    const intent = focusIntent.current;
    if (!intent?.active || intent.attempt !== attempt.current) return;
    const frame = requestAnimationFrame(() => {
      if (!intent.active || focusIntent.current !== intent || attempt.current !== intent.attempt) return;
      focusFrame.current = null;
      const input = field.current;
      if (!input) {
        cancelCurrentFocusIntent();
        return;
      }
      intent.handingOff = true;
      input.focus();
      input.select();
      intent.active = false;
      if (activeFocusIntent === intent) activeFocusIntent = null;
      focusIntent.current = null;
    });
    focusFrame.current = frame;
    return () => {
      cancelAnimationFrame(frame);
      if (focusFrame.current === frame) focusFrame.current = null;
    };
  }, [result]);

  async function copyLink() {
    cancelCurrentFocusIntent();
    cancelActiveFocusIntent();
    const explicitKeyboard = keyboardActivation;
    keyboardActivation = false;
    const current = ++attempt.current;
    if (explicitKeyboard) {
      const intent: CopyFocusIntent = {
        attempt: current,
        trigger: trigger.current,
        triggerRestoreAvailable: true,
        handingOff: false,
        active: true,
        cancelFrame: () => {
          if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
          focusFrame.current = null;
        },
      };
      focusIntent.current = activeFocusIntent = intent;
    }
    const url = new URL(href, window.location.origin).href;
    setResult(null);
    try {
      await navigator.clipboard.writeText(url);
      if (attempt.current === current) {
        cancelCurrentFocusIntent();
        setResult({ kind: 'copied' });
      }
    } catch {
      if (attempt.current === current) setResult({ kind: 'manual', url });
    }
  }

  function close() {
    attempt.current++;
    cancelCurrentFocusIntent();
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
