'use client';

import { Button, type ButtonProps } from '@rezics/ui/button';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Copies a Work's published text, such as a prompt, and says so in a status
 * line. Every prop is plain data, so a server component can render it.
 */
export function CopyTextButton({ text, label, copied, failed, size = 'sm', variant, className }: {
  text: string; label: string; copied: string; failed: string;
  size?: ButtonProps['size']; variant?: ButtonProps['variant']; className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2400);
    return () => clearTimeout(timer);
  }, [state]);
  const Icon = state === 'copied' ? CheckIcon : CopyIcon;
  return <>
    <Button type="button" size={size} variant={variant} pill className={className}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed'))}>
      <Icon aria-hidden="true" />{label}</Button>
    <span role="status" className="sr-only">{state === 'copied' ? copied : state === 'failed' ? failed : ''}</span>
  </>;
}
