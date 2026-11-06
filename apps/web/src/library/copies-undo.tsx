import { useEffect, useRef, useState } from 'react';
import { Exposure } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { Button } from '@rezics/ui/shadcn/button';

/** A brief in-memory affordance. Native restore checks the exact episode and original 720-hour deadline. */
export function UndoNotice({
  message,
  deadline,
  available,
  operation,
  failure,
  restore,
}: {
  message: string;
  deadline: number;
  available: boolean;
  operation: 'copy.update' | 'published_log.create';
  failure: string;
  restore: (key: string) => Promise<boolean>;
}) {
  const [expired, setExpired] = useState(() => Date.now() >= deadline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const key = useRef(crypto.randomUUID());
  const busy = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  async function undo() {
    if (busy.current || Date.now() >= deadline) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      if (!(await restore(key.current))) setError(true);
    } catch {
      setError(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p role="status">{message}</p>
      {available && !expired ? (
        <Exposure operation={operation}>
          <Button
            variant="outline"
            disabled={pending}
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => void undo()}
          >
            {m.editor_undo()}
          </Button>
        </Exposure>
      ) : null}
      {error ? <p role="alert">{failure}</p> : null}
    </div>
  );
}
