import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { EllipsisIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import * as exposure from '../kernel/exposure';
import * as sessionCache from '../session/query';
import type { AcceptedPinsOrigin } from './pins-current';
import { csrfHeaders } from '../threads/composer';
import { pinCollection, unpinCollection } from './pins-actions';
import type { LibraryPinsRead } from './pins-read';

const cachedSession = (client: QueryClient) =>
  sessionCache.sessionQuery ? client.getQueryData(sessionCache.sessionQuery.queryKey) : undefined;
const cachedExposure = (client: QueryClient) =>
  sessionCache.exposureQuery ? client.getQueryData(sessionCache.exposureQuery.queryKey) : undefined;

export type PinControlMode = 'collection' | 'list' | 'navigation';

/** One responsive menu for a Collection's pin action and list ordering controls. */
type PinControlInput = {
  collectionId: string;
  pins: LibraryPinsRead;
  mode: PinControlMode;
  origin?: AcceptedPinsOrigin;
};

type PinAction = 'pin' | 'unpin' | 'up' | 'down';
type WriteAdmission = { allowed: boolean; active: boolean };
type PinAttempt = {
  admission: WriteAdmission;
  lifetime: symbol;
  action: PinAction;
  data: { collectionId: string; revision: number; after?: string | null; idempotencyKey: string };
  pending: boolean;
};

function pinLifetime(key: string, origin: object | undefined, put: boolean, remove: boolean) {
  return {
    key, origin, lifetime: Symbol(), guard: { active: true }, pending: false, notice: '', action: null as PinAction | null,
    put: { allowed: put, active: true }, remove: { allowed: remove, active: true },
  };
}

export function usePinControlActions({ collectionId, pins, mode, origin }: PinControlInput): {
  canUpdate: boolean;
  entries: MenuEntry[];
  notice: string;
  pending: boolean;
} {
  const putAdmitted = exposure.useOperation('library_pin.put');
  const removeAdmitted = exposure.useOperation('library_pin.delete');

  const loadedPins = pins.state === 'loaded' ? pins : null;
  const observedSession = sessionCache.useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const actualSession = cachedSession(queryClient);
  const { state: session, subject, csrfToken } = actualSession ?? observedSession;
  const groups = cachedExposure(queryClient);
  const canPut = (actualSession ? exposure.operationIsAdmitted('library_pin.put', groups) : putAdmitted) &&
    pins.state === 'loaded' && pins.canUpdate === true;
  const canRemove = (actualSession ? exposure.operationIsAdmitted('library_pin.delete', groups) : removeAdmitted) &&
    pins.state === 'loaded' && pins.canRemove === true;
  const viewer = session === 'signed-in' && subject ? subject : null;
  const hasCsrf = Boolean(csrfToken);
  const agreed = !pins.origin || (pins.origin.credentialAgrees && pins.origin.sessionSubject === viewer);
  const key = JSON.stringify([viewer, collectionId, hasCsrf, !!loadedPins && agreed]);
  const [control, setControl] = useState(() => pinLifetime(key, origin?.lifetime, canPut, canRemove));
  const committed = useRef<symbol | null>(null);
  const attempt = useRef<PinAttempt | null>(null);
  const live = useRef({ viewer, collectionId, pins, origin, queryClient, router, csrfToken });
  live.current = { viewer, collectionId, pins, origin, queryClient, router, csrfToken };
  const { lifetime, pending, notice, action: retainedAction } = control;
  if (control.key !== key || control.origin !== origin?.lifetime || !control.guard.active) {
    control.guard.active = false;
    setControl(pinLifetime(key, origin?.lifetime, canPut, canRemove));
  }
  // PUT and DELETE retire independently. Losing target/PUT access must not cancel an admitted removal.
  for (const [name, allowed] of [['put', canPut], ['remove', canRemove]] as const) {
    if (!control[name].active || control[name].allowed !== allowed) {
      const previous = control[name];
      previous.active = false;
      control[name] = { allowed, active: true };
      if (attempt.current?.admission === previous) {
        attempt.current = null;
        setControl((value) => value.lifetime === lifetime ? { ...value, pending: false, notice: '', action: null } : value);
      }
    }
  }
  useLayoutEffect(() => {
    committed.current = lifetime;
    return () => {
      if (committed.current === lifetime) committed.current = null;
      if (attempt.current?.lifetime === lifetime) attempt.current = null;
    };
  }, [lifetime]);
  const actualViewer = () => {
    const now = live.current;
    const actual = cachedSession(now.queryClient);
    // Pure supplied fixtures keep their existing observed-session operand. Production always supplies an origin.
    if (!actual && !now.origin && !now.pins.origin) return now.viewer === viewer && !!now.csrfToken;
    return actual?.state === 'signed-in' && actual.subject === viewer && !!actual.csrfToken;
  };
  const isCurrent = () => committed.current === lifetime && control.guard.active &&
    live.current.viewer === viewer && live.current.collectionId === collectionId &&
    live.current.origin?.lifetime === control.origin && actualViewer() &&
    (live.current.origin?.isCurrent() ?? true);
  const admissionCurrent = (value: WriteAdmission, action: PinAction) => {
    if (!isCurrent() || !value.active || !value.allowed) return false;
    const client = live.current.queryClient;
    if (!cachedSession(client) && !live.current.origin && !live.current.pins.origin) return true;
    return exposure.operationIsAdmitted(action === 'unpin' ? 'library_pin.delete' : 'library_pin.put', cachedExposure(client));
  };
  const update = (change: Partial<typeof control>) =>
    setControl((current) => current.lifetime === lifetime && control.guard.active ? { ...current, ...change } : current);
  useLayoutEffect(() => {
    const observe = () => {
      if (!viewer || !hasCsrf || !loadedPins || !agreed || !control.guard.active || committed.current !== lifetime) return;
      let retired = false;
      if (!actualViewer()) { control.guard.active = false; retired = true; }
      else if (cachedSession(queryClient)) {
        const groups = cachedExposure(queryClient);
        for (const [value, operation] of [[control.put, 'library_pin.put'], [control.remove, 'library_pin.delete']] as const) {
          // Capabilities from the accepted pins response remain an additional restriction.
          if (value.active && value.allowed && !exposure.operationIsAdmitted(operation, groups)) {
            value.active = false;
            retired = true;
          }
        }
      }
      if (retired) setControl((value) => ({ ...value }));
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(observe);
    observe();
    return unsubscribe;
  }, [queryClient, lifetime, control.put, control.remove]);

  const putOrigin = control.put;
  const removeOrigin = control.remove;
  const index = pins.state === 'loaded' ? pins.pins.findIndex((pin) => pin.collectionId === collectionId) : -1;
  const pinned = index >= 0;
  const orderedIds = loadedPins?.pins.map((pin) => pin.collectionId) ?? [];
  const pinCount = loadedPins?.pins.length ?? 0;
  const perform = async (action: PinAction) => {
    const admission = action === 'unpin' ? removeOrigin : putOrigin;
    if (!admissionCurrent(admission, action) || !viewer || !hasCsrf || !loadedPins || !agreed) return;
    let current = attempt.current;
    if (current) {
      if (current.lifetime !== lifetime || current.pending || current.action !== action) return;
    } else {
      if (live.current.pins !== loadedPins) return;
      if ((action === 'up' && index <= 0) || (action === 'down' && (index < 0 || index >= pinCount - 1))) return;
      const after = action === 'up' ? (index <= 1 ? null : orderedIds[index - 2]!) : orderedIds[index + 1]!;
      current = {
        admission,
        lifetime,
        action,
        data: {
          collectionId,
          revision: loadedPins.revision,
          ...(action === 'up' || action === 'down' ? { after } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
        pending: false,
      };
      attempt.current = current;
    }
    const captured = current;
    const isCurrentAttempt = () => admissionCurrent(captured.admission, captured.action) && attempt.current === captured;
    // This synchronous lock also covers two selections before React commits the pending render.
    captured.pending = true;
    update({ pending: true, notice: '', action: captured.action });
    let retain = true;
    const refresh = () => {
      if (!isCurrentAttempt()) return [];
      const now = live.current;
      const navigation = now.router.invalidate();
      const cache = isCurrentAttempt()
        ? now.queryClient.invalidateQueries(now.origin?.queryKey
          ? { queryKey: now.origin.queryKey, exact: true }
          : { queryKey: ['library-navigation'] })
        : undefined;
      return [navigation, cache];
    };
    try {
      if (!isCurrentAttempt()) return;
      const actual = cachedSession(live.current.queryClient);
      const headers = actual?.csrfToken ? { 'X-CSRF-Token': actual.csrfToken } : csrfHeaders();
      if (!isCurrentAttempt()) return;
      const result =
        captured.action === 'unpin'
          ? await unpinCollection({ data: captured.data, headers })
          : await pinCollection({ data: captured.data, headers });
      if (!isCurrentAttempt()) return;
      retain = !result.ok && result.reason === 'unavailable';
      if (result.ok) {
        await Promise.all(refresh());
      } else if (result.reason === 'conflict') {
        update({ notice: m.library_pin_conflict() });
        await Promise.allSettled(refresh());
      } else if (result.reason === 'full') update({ notice: m.library_pin_limit() });
      else update({ notice: m.error_message() });
    } catch {
      if (isCurrentAttempt()) update({ notice: m.error_message() });
    } finally {
      if (isCurrentAttempt()) {
        captured.pending = false;
        if (!retain) attempt.current = null;
        update({ pending: false, action: retain ? captured.action : null });
      }
    }
  };

  const actions: PinAction[] = [];
  if (viewer && loadedPins && agreed && (origin?.isCurrent() ?? true)) {
    if (pinned) {
      if (canPut && mode === 'list' && index > 0) actions.push('up');
      if (canPut && mode === 'list' && index < pinCount - 1) actions.push('down');
      if (canRemove) actions.push('unpin');
    } else if (canPut) actions.push('pin');
    // Keep an uncertain command explicitly retryable even if a refresh changes its menu placement.
    if (retainedAction && !actions.includes(retainedAction)) actions.push(retainedAction);
  }
  const labels = {
    pin: m.library_pin_pin(),
    unpin: m.library_pin_unpin(),
    up: m.library_pin_move_up(),
    down: m.library_pin_move_down(),
  };
  const entries: MenuEntry[] = actions.flatMap((action, index) => [
    ...(action === 'unpin' && index > 0 ? [{ type: 'separator' as const }] : []),
    {
      type: action === 'unpin' ? ('destructive' as const) : ('item' as const),
      label: labels[action],
      onSelect: () => void perform(action),
      disabled: pending || !hasCsrf || (retainedAction !== null && retainedAction !== action),
    },
  ]);

  return {
    canUpdate: entries.length > 0,
    entries,
    notice,
    pending,
  };
}

export function PinControlNotice({ notice }: { notice: string }) {
  return notice ? (
    <span className="max-w-48 text-right text-xs text-muted-foreground" role="status">
      {notice}
    </span>
  ) : null;
}

export function PinControl({ collectionId, pins, mode, origin }: PinControlInput) {
  const control = usePinControlActions({ collectionId, pins, mode, ...(origin ? { origin } : {}) });
  if (!control.canUpdate) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Menu
        title={m.library_pin_actions()}
        trigger={
          <Button aria-label={m.library_pin_actions()} disabled={control.pending} size="icon-sm" variant="ghost">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        }
        entries={control.entries}
      />
      <PinControlNotice notice={control.notice} />
    </span>
  );
}
