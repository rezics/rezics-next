import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { EllipsisIcon } from 'lucide-react';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { QueryClientContext, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import * as exposure from '../kernel/exposure';
import * as sessionCache from '../session';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import type { AcceptedPinsOrigin } from './pins-current';
import { csrfHeaders } from '../threads/composer';
import { pinCollection, unpinCollection } from './pins-actions';
import type { LibraryNavigationRead, LibraryPinsRead } from './pins-read';

const cachedSession = (client: QueryClient) => {
  const state = client.getQueryState(sessionCache.sessionQuery.queryKey);
  return state?.status === 'success' ? state.data : undefined;
};
const pinOperations = ['library_pin.put', 'library_pin.delete'] as const;

export type PinControlMode = 'collection' | 'list' | 'navigation';

/** One responsive menu for a Collection's pin action and list ordering controls. */
type PinControlInput = {
  collectionId: string;
  pins: LibraryPinsRead;
  mode: PinControlMode;
  origin?: AcceptedPinsOrigin | undefined;
};

type PinAction = 'pin' | 'unpin' | 'up' | 'down';
type WriteAdmission = { allowed: boolean; active: boolean; version: number | undefined };
type PinSender = typeof pinCollection | typeof unpinCollection;
type PinReadSource = {
  origin: AcceptedPinsOrigin | undefined;
  pinsOrigin: LibraryPinsRead['origin'];
};
type PinAcknowledgement = { action: PinAction; revision: number; source: PinReadSource };
type PinReadback = 'none' | 'pending' | 'failed' | 'complete';
type PinAttempt = {
  admission: WriteAdmission;
  lifetime: symbol;
  action: PinAction;
  source: PinReadSource;
  data: { collectionId: string; revision: number; after?: string | null; idempotencyKey: string };
  headers: ReturnType<typeof csrfHeaders>;
  sender: PinSender;
  pending: boolean;
  uncertain: boolean;
};

function pinLifetime(
  key: string,
  origin: object | undefined,
  put: boolean,
  remove: boolean,
  versions: readonly number[],
) {
  return {
    key,
    origin,
    lifetime: Symbol(),
    guard: { active: true },
    pending: false,
    notice: '',
    action: null as PinAction | null,
    acknowledgement: null as PinAcknowledgement | null,
    readback: 'none' as PinReadback,
    put: { allowed: put, active: true, version: versions[0] },
    remove: { allowed: remove, active: true, version: versions[1] },
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
  const supplied = useContext(QueryClientContext);
  const { store, value: scoped } = useLibraryWorkspaceAdmission(pinOperations);

  const loadedPins = pins.state === 'loaded' ? pins : null;
  const observedSession = sessionCache.useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const actualSession = cachedSession(queryClient);
  const {
    state: session,
    subject,
    csrfToken,
  } = supplied ? (actualSession ?? { state: 'unknown', subject: null, csrfToken: null }) : observedSession;
  const canPut =
    (supplied ? scoped.granted[0] === true : putAdmitted) && pins.state === 'loaded' && pins.canUpdate === true;
  const canRemove =
    (supplied ? scoped.granted[1] === true : removeAdmitted) && pins.state === 'loaded' && pins.canRemove === true;
  const viewer = session === 'signed-in' && subject ? subject : null;
  const hasCsrf = Boolean(csrfToken);
  const agreed = !pins.origin || (pins.origin.credentialAgrees && pins.origin.sessionSubject === viewer);
  const key = JSON.stringify([viewer, scoped.viewer, collectionId, hasCsrf]);
  const [control, setControl] = useState(() => pinLifetime(key, origin?.lifetime, canPut, canRemove, scoped.dispatch));
  const committed = useRef<symbol | null>(null);
  const attempt = useRef<PinAttempt | null>(null);
  const readAttempt = useRef<{ lifetime: symbol; token: symbol } | null>(null);
  const live = useRef({ viewer, collectionId, pins, origin, queryClient, router, csrfToken });
  live.current = { viewer, collectionId, pins, origin, queryClient, router, csrfToken };
  const { lifetime, pending, notice, action: retainedAction } = control;
  if (control.key !== key || control.origin !== origin?.lifetime || !control.guard.active) {
    control.guard.active = false;
    if (readAttempt.current?.lifetime === lifetime) readAttempt.current = null;
    setControl(pinLifetime(key, origin?.lifetime, canPut, canRemove, scoped.dispatch));
  }
  // PUT and DELETE retire independently. Losing target/PUT access must not cancel an admitted removal.
  for (const [name, allowed] of [
    ['put', canPut],
    ['remove', canRemove],
  ] as const) {
    const version = scoped.dispatch[name === 'put' ? 0 : 1];
    if (!control[name].active || control[name].allowed !== allowed || control[name].version !== version) {
      const previous = control[name];
      previous.active = false;
      control[name] = { allowed, active: true, version };
      if (attempt.current?.admission === previous) {
        attempt.current.pending = false;
        setControl((value) =>
          value.lifetime === lifetime
            ? { ...value, pending: false, notice: '', action: attempt.current?.action ?? null }
            : value,
        );
      }
    }
  }
  useLayoutEffect(() => {
    committed.current = lifetime;
    return () => {
      if (committed.current === lifetime) committed.current = null;
      if (attempt.current?.lifetime === lifetime) attempt.current = null;
      if (readAttempt.current?.lifetime === lifetime) readAttempt.current = null;
    };
  }, [lifetime]);
  const actualViewer = (requireCsrf = true) => {
    const now = live.current;
    const actual = cachedSession(now.queryClient);
    // Pure supplied fixtures keep their existing observed-session operand. Production always supplies an origin.
    if (!supplied && !now.origin && !now.pins.origin)
      return now.viewer === viewer && (!requireCsrf || !!now.csrfToken);
    return (
      actual?.state === 'signed-in' &&
      actual.subject === viewer &&
      (!requireCsrf || !!actual.csrfToken) &&
      store.read().viewer === scoped.viewer
    );
  };
  const isCurrent = () =>
    committed.current === lifetime &&
    control.guard.active &&
    live.current.viewer === viewer &&
    live.current.collectionId === collectionId &&
    live.current.origin?.lifetime === control.origin &&
    actualViewer() &&
    (live.current.origin?.isCurrent() ?? true);
  const admissionCurrent = (value: WriteAdmission, action: PinAction) => {
    if (!isCurrent() || !value.active || !value.allowed) return false;
    if (!supplied && !live.current.origin && !live.current.pins.origin) return true;
    const operation = action === 'unpin' ? 'library_pin.delete' : 'library_pin.put';
    return store.allowed(operation) && value.version === store.dispatchVersion(operation);
  };
  const sourceCurrent = (source: PinReadSource) =>
    committed.current === lifetime &&
    control.guard.active &&
    live.current.viewer === viewer &&
    live.current.collectionId === collectionId &&
    live.current.origin?.lifetime === source.origin?.lifetime &&
    actualViewer(false);
  const update = (change: Partial<typeof control>) =>
    setControl((current) =>
      current.lifetime === lifetime && control.guard.active ? { ...current, ...change } : current,
    );
  useLayoutEffect(() => {
    const observe = () => {
      if (!viewer || !hasCsrf || !loadedPins || !agreed || !control.guard.active || committed.current !== lifetime)
        return;
      let retired = false;
      if (!actualViewer()) {
        control.guard.active = false;
        retired = true;
      } else if (cachedSession(queryClient)) {
        for (const [value, operation] of [
          [control.put, 'library_pin.put'],
          [control.remove, 'library_pin.delete'],
        ] as const) {
          // Capabilities from the accepted pins response remain an additional restriction.
          if (value.active && value.version !== store.dispatchVersion(operation)) {
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
  const labels = {
    pin: m.library_pin_pin(),
    unpin: m.library_pin_unpin(),
    up: m.library_pin_move_up(),
    down: m.library_pin_move_down(),
  };
  const readbackIsCurrent = (acknowledgement: PinAcknowledgement) => {
    const source = acknowledgement.source;
    if (!sourceCurrent(source)) return false;
    const queryKey = source.origin?.queryKey;
    if (!queryKey) {
      const currentPins = live.current.pins;
      return (
        currentPins.state === 'loaded' &&
        currentPins.revision >= acknowledgement.revision &&
        (!source.pinsOrigin ||
          (currentPins.origin?.sessionSubject === source.pinsOrigin.sessionSubject &&
            currentPins.origin.credentialAgrees &&
            currentPins.origin.requestedLimit === source.pinsOrigin.requestedLimit))
      );
    }
    const client = live.current.queryClient;
    const state = client.getQueryState(queryKey);
    const value = client.getQueryData(queryKey) as LibraryNavigationRead | undefined;
    const currentPins = value?.pins;
    if (state?.status !== 'success' || currentPins?.state !== 'loaded' || currentPins.revision < acknowledgement.revision)
      return false;
    return source.pinsOrigin
      ? currentPins.origin?.sessionSubject === source.pinsOrigin.sessionSubject &&
          currentPins.origin.credentialAgrees &&
          currentPins.origin.requestedLimit === source.pinsOrigin.requestedLimit
      : !currentPins.origin ||
          (currentPins.origin.sessionSubject === viewer && currentPins.origin.credentialAgrees);
  };
  const refreshCurrentList = async (source: PinReadSource, acknowledgement?: PinAcknowledgement) => {
    if (!sourceCurrent(source)) return { retired: true, failed: false };
    const now = live.current;
    const invalidations = await Promise.allSettled([
      Promise.resolve().then(() => now.router.invalidate()),
      Promise.resolve().then(() =>
        now.queryClient.invalidateQueries(
          source.origin?.queryKey
            ? { queryKey: source.origin.queryKey, exact: true }
            : { queryKey: ['library-navigation'] },
        ),
      ),
    ]);
    if (!sourceCurrent(source)) return { retired: true, failed: false };
    return {
      retired: false,
      failed: invalidations.some((result) => result.status === 'rejected') ||
        (!!acknowledgement && !readbackIsCurrent(acknowledgement)),
    };
  };
  const continueReadback = async (acknowledgement: PinAcknowledgement) => {
    if (readAttempt.current?.lifetime === lifetime) return;
    const token = Symbol();
    readAttempt.current = { lifetime, token };
    update({ pending: true, readback: 'pending' });
    try {
      const result = await refreshCurrentList(acknowledgement.source, acknowledgement);
      if (readAttempt.current?.token !== token) return;
      readAttempt.current = null;
      if (result.retired) {
        if (sourceCurrent(acknowledgement.source)) update({ pending: false, readback: 'failed' });
        return;
      }
      update({ pending: false, readback: result.failed ? 'failed' : 'complete' });
    } catch {
      if (readAttempt.current?.token !== token) return;
      readAttempt.current = null;
      if (sourceCurrent(acknowledgement.source)) update({ pending: false, readback: 'failed' });
    } finally {
      if (readAttempt.current?.token === token) readAttempt.current = null;
    }
  };
  const perform = async (action: PinAction) => {
    const admission = action === 'unpin' ? removeOrigin : putOrigin;
    if (
      (control.acknowledgement !== null && control.readback !== 'complete') ||
      !admissionCurrent(admission, action) ||
      !viewer ||
      !hasCsrf ||
      !loadedPins ||
      !agreed
    )
      return;
    let current = attempt.current;
    if (current) {
      if (current.lifetime !== lifetime || current.pending || current.action !== action) return;
      // A retry owns a new completion fence while retaining the exact native request.
      // Mutating the previous attempt would let its unresolved completion acquire this admission.
      current = { ...current, admission, pending: false };
      attempt.current = current;
    } else {
      if (live.current.pins !== loadedPins) return;
      if ((action === 'up' && index <= 0) || (action === 'down' && (index < 0 || index >= pinCount - 1))) return;
      const after = action === 'up' ? (index <= 1 ? null : orderedIds[index - 2]!) : orderedIds[index + 1]!;
      const actual = cachedSession(live.current.queryClient);
      current = {
        admission,
        lifetime,
        action,
        source: { origin, pinsOrigin: loadedPins.origin },
        data: {
          collectionId,
          revision: loadedPins.revision,
          ...(action === 'up' || action === 'down' ? { after } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
        headers: actual?.csrfToken ? { 'X-CSRF-Token': actual.csrfToken } : csrfHeaders(),
        sender: action === 'unpin' ? unpinCollection : pinCollection,
        pending: false,
        uncertain: false,
      };
      attempt.current = current;
    }
    const captured = current;
    const isCurrentAttempt = () =>
      admissionCurrent(captured.admission, captured.action) && attempt.current === captured;
    const isCurrentSourceAttempt = () => sourceCurrent(captured.source) && attempt.current === captured;
    // This synchronous lock also covers two selections before React commits the pending render.
    captured.pending = true;
    update({
      pending: true,
      notice: '',
      action: captured.action,
      acknowledgement: null,
      readback: 'none',
    });
    let retain = true;
    const refresh = () => {
      return refreshCurrentList(captured.source);
    };
    try {
      if (!isCurrentAttempt()) return;
      const result = await captured.sender({ data: captured.data, headers: captured.headers });
      if (!isCurrentSourceAttempt()) return;
      if (result.ok) {
        retain = false;
        attempt.current = null;
        captured.pending = false;
        const acknowledgement: PinAcknowledgement = {
          action: captured.action,
          revision: result.revision,
          source: captured.source,
        };
        update({
          pending: true,
          notice: '',
          action: null,
          acknowledgement,
          readback: 'pending',
        });
        await continueReadback(acknowledgement);
      } else if (result.reason === 'conflict') {
        retain = false;
        update({ notice: m.library_pin_conflict() });
        await refresh();
      } else if (result.reason === 'full') {
        retain = false;
        update({ notice: m.library_pin_limit() });
      } else if (result.reason === 'unavailable') {
        captured.uncertain = true;
        retain = true;
        update({ notice: m.error_message() });
      } else {
        retain = captured.uncertain;
        update({
          notice:
            result.reason === 'closed'
              ? m.platform_closed_message()
              : result.reason === 'denied'
                ? m.library_follow_forbidden()
                : m.library_sign_in(),
        });
      }
    } catch {
      if (isCurrentSourceAttempt()) {
        captured.uncertain = true;
        update({ notice: m.error_message() });
      }
    } finally {
      if (isCurrentSourceAttempt()) {
        captured.pending = false;
        if (!retain) attempt.current = null;
        update({ pending: false, action: retain ? captured.action : null });
      }
    }
  };

  const readbackBlocked = control.acknowledgement !== null && control.readback !== 'complete';
  const actions: PinAction[] = [];
  if (!readbackBlocked && viewer && loadedPins && agreed && (origin?.isCurrent() ?? true)) {
    if (pinned) {
      if (canPut && mode === 'list' && index > 0) actions.push('up');
      if (canPut && mode === 'list' && index < pinCount - 1) actions.push('down');
      if (canRemove) actions.push('unpin');
    } else if (canPut) actions.push('pin');
    // Keep an uncertain command explicitly retryable even if a refresh changes its menu placement.
    if (retainedAction && !actions.includes(retainedAction)) actions.push(retainedAction);
  }
  const entries: MenuEntry[] = actions.flatMap((action, index) => [
    ...(action === 'unpin' && index > 0 ? [{ type: 'separator' as const }] : []),
    {
      type: action === 'unpin' ? ('destructive' as const) : ('item' as const),
      label: labels[action],
      onSelect: () => void perform(action),
      disabled:
        pending ||
        !hasCsrf ||
        (supplied && !store.allowed(action === 'unpin' ? 'library_pin.delete' : 'library_pin.put')) ||
        (retainedAction !== null && retainedAction !== action),
    },
  ]);
  const acknowledgement = control.acknowledgement;
  if (acknowledgement && control.readback === 'failed' && sourceCurrent(acknowledgement.source)) {
    entries.push({
      type: 'item',
      label: m.library_collection_boundary_refresh(),
      onSelect: () => void continueReadback(acknowledgement),
      disabled: pending || !sourceCurrent(acknowledgement.source),
    });
  }
  const confirmedNotice = acknowledgement
    ? m.collection_save_confirmed({ action: labels[acknowledgement.action] })
    : notice;
  const visibleNotice = [
    confirmedNotice,
    control.readback === 'failed' ? m.library_pin_read_failed() : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    canUpdate: entries.length > 0,
    entries,
    notice: visibleNotice,
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
  return <PinControlView control={control} />;
}

/** The menu can outlive a public members refresh while its owning action hook retains exact intent. */
export function PinControlView({ control }: { control: ReturnType<typeof usePinControlActions> }) {
  if (!control.canUpdate && !control.notice) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {control.canUpdate ? (
        <Menu
          title={m.library_pin_actions()}
          trigger={
            <Button aria-label={m.library_pin_actions()} disabled={control.pending} size="icon-sm" variant="ghost">
              <EllipsisIcon aria-hidden="true" />
            </Button>
          }
          entries={control.entries}
        />
      ) : null}
      <PinControlNotice notice={control.notice} />
    </span>
  );
}
