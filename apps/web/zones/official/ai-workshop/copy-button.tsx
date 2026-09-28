'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Copies what a reader takes from a pick: a prompt's published text, a
 * Skill's instructions or, for any other pick, its address. A status line
 * announces the result. Slots render on the server, so every prop is plain
 * data a server may send to this client component.
 */
export function CopyButton({ text, href, title, label, copied, failed, compact }: {
  /** The published text to copy; without it, the pick's address. */
  text: string | null;
  /** The pick's path, kept without a locale so whoever opens it reads it in their own language. */
  href: string;
  title: string; label: string; copied: string; failed: string;
  /** Icon only, for rows and the rail; the label stays for assistive technology. */
  compact?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2400);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text ?? new URL(href, location.href).href);
      setState('copied');
    } catch {
      setState('failed');
    }
  }
  const Icon = state === 'copied' ? CheckIcon : CopyIcon;
  return <>
    <button type="button" className="aw-copy" data-state={state} data-compact={compact ? '' : undefined}
      title={compact ? label : undefined} onClick={() => void copy()}>
      <Icon aria-hidden="true" />
      <span className={compact ? 'sr-only' : undefined}>{label}</span>
      <span className="sr-only"> {title}</span>
    </button>
    <span role="status" className="sr-only">{state === 'copied' ? copied : state === 'failed' ? failed : ''}</span>
  </>;
}
