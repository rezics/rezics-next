import { useEffect, useRef, type MutableRefObject } from 'react';
import { useBlocker, useRouter } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { NavigationSession } from '../../../shell/navigation';
import type { OwnerCapture, OwnerLifetime } from '../editor/owner-lifetime';

type CreateNavigationProps = {
  locale: string;
  session: NavigationSession;
  owner?: OwnerLifetime;
  capture: OwnerCapture | null | undefined;
  needsDecision: () => boolean;
  requestMayComplete: boolean;
  onLeave: () => void;
  clearBlockedDeparture: MutableRefObject<(() => void) | null>;
};

function current(props: CreateNavigationProps) {
  return props.session === 'signed-in' && (!props.owner || props.owner.isCurrent(props.capture));
}

function shouldBlock(props: CreateNavigationProps) {
  return current(props) && props.needsDecision();
}

export function CreateNavigationGuard(props: CreateNavigationProps) {
  const latest = useRef(props);
  latest.current = props;
  const router = useRouter({ warn: false });

  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (!shouldBlock(latest.current)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, []);

  return router ? <RouterCreateNavigationGuard latest={latest} /> : null;
}

function RouterCreateNavigationGuard({ latest }: { latest: MutableRefObject<CreateNavigationProps> }) {
  const resolved = useRef(false);
  const needsDecision = shouldBlock(latest.current);
  const blocker = useBlocker({
    shouldBlockFn: () => {
      if (!shouldBlock(latest.current)) return false;
      resolved.current = false;
      return true;
    },
    disabled: !needsDecision,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (!shouldBlock(latest.current) && blocker.status === 'blocked' && !resolved.current) {
      resolved.current = true;
      blocker.reset();
    }
  }, [blocker, needsDecision]);
  useEffect(() => {
    latest.current.clearBlockedDeparture.current = () => {
      const pending = blockerRef.current;
      if (pending.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        pending.reset();
      }
    };
    return () => {
      latest.current.clearBlockedDeparture.current = null;
      const pending = blockerRef.current;
      if (pending.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        pending.reset();
      }
    };
  }, []);

  function resolve(leave: boolean) {
    if (blocker.status !== 'blocked' || resolved.current) return;
    resolved.current = true;
    if (leave && shouldBlock(latest.current)) {
      latest.current.onLeave();
      blocker.proceed();
    } else blocker.reset();
  }

  if (blocker.status !== 'blocked') return null;
  const options = { locale: latest.current.locale as never };
  return (
    <section role="alert" className="mb-6 space-y-3 border-t border-border pt-4">
      <p>{m.zone_editor_leave({}, options)}</p>
      {latest.current.requestMayComplete ? <p>{m.zones_create_uncertain({}, options)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => resolve(false)}>{m.zone_editor_stay({}, options)}</Button>
        <Button variant="outline" onClick={() => resolve(true)}>
          {m.zone_editor_discard({}, options)}
        </Button>
      </div>
    </section>
  );
}
