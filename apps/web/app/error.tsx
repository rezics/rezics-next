'use client';

import { RouteError } from '../features/shell/route-states.tsx';

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError digest={error.digest} onRetry={reset} />;
}
