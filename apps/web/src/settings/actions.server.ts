import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { changeNotifications, type NotificationChange } from './preferences';

/** Handle the settings form's native POST before progressive enhancement is available. */
export async function submitNotificationForm(request: Request): Promise<Response> {
  const redirect = (failed: boolean) => {
    const url = new URL(request.url);
    url.search = failed ? '?notificationError=1' : '';
    url.hash = '';
    return new Response(null, {
      status: 303,
      headers: { location: url.href, 'cache-control': 'private, no-store' },
    });
  };
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded')
    return new Response(null, { status: 400, headers: { 'cache-control': 'private, no-store' } });

  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return redirect(true);
  }
  const action = form.getAll('action');
  const expectedVersion = form.getAll('expectedVersion');
  const kinds = form.getAll('notificationKind');
  const enabled = form.getAll('enabled');
  if (
    action.length !== 1 ||
    expectedVersion.length !== 1 ||
    typeof expectedVersion[0] !== 'string' ||
    !/^\d+$/.test(expectedVersion[0]) ||
    !Number.isSafeInteger(Number(expectedVersion[0]))
  )
    return redirect(true);

  let notifications: NotificationChange['notifications'];
  if (action[0] === 'restore' && kinds.length === 0 && enabled.length === 0) {
    notifications = null;
  } else if (
    action[0] === 'save' &&
    kinds.length === 1 &&
    typeof kinds[0] === 'string' &&
    /^[a-z][a-z0-9_]*$/.test(kinds[0]) &&
    enabled.length <= 1 &&
    (enabled.length === 0 || enabled[0] === 'true')
  ) {
    notifications = { [kinds[0]]: enabled.length === 1 };
  } else {
    return redirect(true);
  }

  const result = await changeNotifications(kernelClient(), request, env as Partial<SessionEnv>, {
    expectedVersion: Number(expectedVersion[0]),
    notifications,
    idempotencyKey: crypto.randomUUID(),
  });
  if (!result.ok && result.reason === 'forbidden')
    return new Response(null, { status: 403, headers: { 'cache-control': 'private, no-store' } });
  return redirect(!result.ok);
}
