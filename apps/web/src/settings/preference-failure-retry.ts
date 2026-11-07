import { useEffect, useMemo, useState } from 'react';
import { useSettingsAmbient } from './adapters/ambient-view.tsx';
import type { NativePreferenceFailure } from './preferences';
import { preferenceRetryDeadline } from './ports/ambient';

export { preferenceRetryDeadline } from './ports/ambient';

/** Never requests IO; only re-enables deliberate controls. A supplied deadline avoids restarting a delay on remount. */
export function usePreferenceRetry(failure: NativePreferenceFailure | undefined, retryAt?: number): boolean {
  const ambient = useSettingsAmbient();
  const deadline = useMemo(
    () => retryAt ?? preferenceRetryDeadline(failure?.retryAfter, ambient.now()),
    [ambient, failure, retryAt],
  );
  const [now, setNow] = useState(ambient.now);
  useEffect(() => {
    if (deadline <= now) return;
    const handle = ambient.timer.schedule(
      () => setNow(ambient.now()),
      Math.min(Math.max(0, deadline - ambient.now()), 2_147_483_647),
    );
    return () => handle.cancel();
  }, [ambient, deadline, now]);
  return deadline > now;
}
