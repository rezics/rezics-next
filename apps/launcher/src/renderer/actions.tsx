import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useRemote<T>(load: () => Promise<T>) {
  const [result, setResult] = useState<{ data?: T; error?: string; pending: boolean }>({ pending: true });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setResult((previous) => ({ pending: true, ...(previous.data !== undefined && { data: previous.data }) }));
    void load().then(
      (data) => {
        if (current) setResult({ data, pending: false });
      },
      (error: unknown) => {
        if (current) setResult((previous) => ({ ...previous, error: message(error), pending: false }));
      },
    );
    return () => {
      current = false;
    };
  }, [load, revision]);
  return { ...result, reload };
}

export function useAction() {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function run(action: () => Promise<unknown>): Promise<void> {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      running.current = false;
      setPending(false);
    }
  }
  return { run, pending, error };
}

export function Failure({ error, retry }: { error?: string | undefined; retry?: (() => void) | undefined }) {
  if (!error) return null;
  return (
    <Alert className="failure" variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="col-start-2 [overflow-wrap:anywhere]">{error}</AlertDescription>
      {retry && (
        <Button className="col-start-2 mt-1 justify-self-start" size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      )}
    </Alert>
  );
}

export function Pending({ children }: { children: ReactNode }) {
  return (
    <p className="actions muted" role="status">
      <Spinner aria-hidden="true" />
      {children}
    </p>
  );
}

export function Pager({
  cursor,
  previous,
  next,
}: {
  cursor: string | undefined;
  previous: () => void;
  next: (() => void) | undefined;
}) {
  if (!cursor && !next) return null;
  return (
    <nav className="actions pager" aria-label="Results pagination">
      <Button variant="outline" disabled={!cursor} onClick={previous}>
        Previous page
      </Button>
      <Button variant="outline" disabled={!next} onClick={next}>
        Next page
      </Button>
    </nav>
  );
}

export function usePaging() {
  const [pages, setPages] = useState<string[]>([]);
  return {
    cursor: pages.at(-1),
    previous: () => setPages((values) => values.slice(0, -1)),
    next: (cursor: string) => setPages((values) => [...values, cursor]),
    reset: () => setPages([]),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The launcher could not complete the action.';
}
