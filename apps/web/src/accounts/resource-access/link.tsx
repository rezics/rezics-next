import { reviewRequest } from './request';
import { useEffect, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { useSession } from '../../session/query';
import { readResourceAccess } from './actions';

/** Public resource pages make this private authority read only after hydration. */
export function ResourceAccessLink({ resourceId }: { resourceId: string }) {
  const { state } = useSession();
  const [authorized, setAuthorized] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const caller = new AbortController();
    setAuthorized(null);
    if (state === 'signed-in')
      void reviewRequest((signal) => readResourceAccess({ data: { resourceId }, signal }), caller.signal)
        .then((result) => {
          if (active && result.status === 'ready') setAuthorized(resourceId);
        })
        .catch(() => {});
    return () => {
      active = false;
      caller.abort();
    };
  }, [resourceId, state]);
  return state === 'signed-in' && authorized === resourceId ? (
    <a
      className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
      href={`/${getLocale()}/access/${encodeURIComponent(resourceId)}`}
    >
      {m.access_heading()}
    </a>
  ) : null;
}
