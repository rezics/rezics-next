import { useEffect, useRef, useState } from 'react';
import { parseCommand, type Command, type MutationResult } from './model';

/** Visit-local intent. No permission, name or pending request survives an actor/route remount. */
export function useContextIntent(send: (command: Command) => Promise<MutationResult>, reload: () => Promise<unknown>) {
  const [pending, setPending] = useState<Command | null>(null);
  const [result, setResult] = useState<MutationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (result) feedback.current?.focus();
  }, [result]);
  async function submit(input: unknown) {
    if (running.current) return;
    let command: Command;
    try {
      command = pending ?? parseCommand(input);
    } catch {
      setResult({ kind: 'invalid' });
      return;
    }
    running.current = true;
    setPending(command);
    setBusy(true);
    setReviewed(false);
    setResult(null);
    let next: MutationResult;
    try {
      next = await send(command);
    } catch {
      next = { kind: 'unknown' };
    }
    running.current = false;
    if (!mounted.current) return;
    setResult(next);
    if (next.kind === 'confirmed') setPending(null);
    setBusy(false);
  }
  async function refresh(discard = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await reload();
      if (mounted.current) {
        setReviewed(true);
        if (discard && result?.kind !== 'unknown') {
          setPending(null);
          setResult(null);
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { pending, result, busy, reviewed, feedback, submit, refresh };
}
