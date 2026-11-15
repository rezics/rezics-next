import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useMatch, useRouterState } from '@tanstack/react-router';
import { dismissMenuForNavigation } from '@rezics/ui/menu';

type Owner = {
  identity: object;
  scope: object;
  depth: number;
};
type ContextNavigation = {
  scope: object;
  active: object | null;
  target: HTMLDivElement | null;
  register(owner: Owner): () => void;
  attach(target: HTMLDivElement | null): void | (() => void);
};
const ContextNavigation = createContext<ContextNavigation | null>(null);

/** Shell-owned placement, scoped to the current path without remounting the route's editor. */
export function ShellContextNavigationProvider({ children }: { children: ReactNode }) {
  const routeKey = useLocation({ select: (location) => location.pathname });
  const scope = useMemo(() => ({}), [routeKey]);
  const [owners, setOwners] = useState<readonly Owner[]>([]);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const register = useCallback((owner: Owner) => {
    setOwners((current) => [...current, owner]);
    // Remove this exact registration: effect replay or a replacement may already own the region.
    return () => setOwners((current) => current.filter((candidate) => candidate !== owner));
  }, []);
  const attach = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setTarget(node);
    return () => setTarget((current) => (current === node ? null : current));
  }, []);
  // The deepest mounted route wins; the latest declaration wins within that route.
  // These are live owner identities only. Labels, elements and private data never enter shell state.
  const active = owners.reduce<Owner | null>(
    (selected, owner) => (owner.scope === scope && (!selected || owner.depth >= selected.depth) ? owner : selected),
    null,
  );
  const value = useMemo(
    () => ({ scope, active: active?.identity ?? null, target, register, attach }),
    [scope, active, target, register, attach],
  );
  return <ContextNavigation value={value}>{children}</ContextNavigation>;
}

/** Menu focus work follows route/reader identities even after its physical panel closes. */
export function useShellContextNavigationMenuScope() {
  const context = useContext(ContextNavigation);
  return useMemo(() => ({}), [context?.scope, context?.active]);
}

/** Only the expanded desktop rail or the mounted phone Menu supplies this host. */
export function ShellContextNavigationOutlet() {
  const context = useContext(ContextNavigation);
  const host = useRef<HTMLDivElement | null>(null);
  const previousOwner = useRef(context?.active);
  const attach = context?.attach;
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      host.current = node;
      return attach?.(node);
    },
    [attach],
  );
  useLayoutEffect(() => {
    if (previousOwner.current && previousOwner.current !== context?.active) dismissMenuForNavigation(host.current);
    previousOwner.current = context?.active;
  }, [context?.active]);
  return <div ref={ref} data-shell-context-navigation-host className="min-w-0 empty:hidden" />;
}

export type ShellContextNavigationProps = {
  label: string;
  children: ReactNode;
};

function visibleSelectionTarget(target: HTMLElement | null | undefined): target is HTMLElement {
  if (!target?.isConnected || target.matches(':disabled')) return false;
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    if (
      node.hidden ||
      node.inert ||
      node.getAttribute('aria-hidden') === 'true' ||
      node.getAttribute('aria-disabled') === 'true' ||
      node.matches('fieldset:disabled')
    )
      return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return true;
}

/** Call only after the consumer admits a document choice or its existing switch review. */
export function useShellContextNavigationSelection(lifetime?: object) {
  const context = useContext(ContextNavigation);
  const [selection, setSelection] = useState<{
    scope: object | undefined;
    owner: object | null | undefined;
    lifetime: object | undefined;
    origin: Element | null;
    focus: () => HTMLElement | null | undefined;
  } | null>(null);
  useLayoutEffect(() => {
    if (!selection) return;
    if (selection.scope !== context?.scope || selection.owner !== context?.active || selection.lifetime !== lifetime) {
      setSelection(null);
      return;
    }
    const active = document.activeElement;
    if (active !== selection.origin && active !== document.body) {
      setSelection(null);
      return;
    }
    const target = selection.focus();
    if (visibleSelectionTarget(target)) {
      setSelection(null);
      target.focus({ preventScroll: true });
      return;
    }
    // The Menu host or the consumer may still be retiring/revealing. Retry on their next commit.
    // A later user action owns focus instead of this pending selection.
    const cancel = () => setSelection((pending) => (pending === selection ? null : pending));
    const moved = (event: FocusEvent) => {
      if (event.target !== selection.origin && event.target !== document.body) cancel();
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', moved);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', moved);
      window.removeEventListener('blur', cancel);
    };
  });
  return (accepted: boolean, focus?: () => HTMLElement | null | undefined) => {
    if (!accepted) return;
    const origin = document.activeElement;
    dismissMenuForNavigation(context?.target ?? null);
    setSelection(focus ? { scope: context?.scope, owner: context?.active, lifetime, origin, focus } : null);
  };
}

/**
 * Declare navigation next to the reading/editing canvas, inside its existing reader and data providers.
 * The portal retains that React ancestry and disappears with the consumer's admission or lifetime.
 */
export function ShellContextNavigation({ label, children }: ShellContextNavigationProps) {
  const context = useContext(ContextNavigation);
  if (!context)
    return (
      <ContextNavigationRegion label={label} standalone>
        {children}
      </ContextNavigationRegion>
    );
  return (
    <HostedContextNavigation context={context} label={label}>
      {children}
    </HostedContextNavigation>
  );
}

function HostedContextNavigation({
  context,
  label,
  children,
}: ShellContextNavigationProps & { context: ContextNavigation }) {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  const depth = useRouterState({ select: (state) => state.matches.findIndex((match) => match.routeId === routeId) });
  const [identity] = useState(() => ({}));
  const { register, scope } = context;
  useLayoutEffect(() => {
    return register({ identity, scope, depth });
  }, [register, identity, scope, depth]);

  if (!context.target || context.active !== identity) return null;
  return createPortal(<ContextNavigationRegion label={label}>{children}</ContextNavigationRegion>, context.target);
}

function ContextNavigationRegion({
  label,
  children,
  standalone = false,
}: ShellContextNavigationProps & { standalone?: boolean }) {
  const headingId = useId();
  const Region = standalone ? 'nav' : 'section';
  return (
    <Region
      aria-labelledby={headingId}
      data-shell-context-navigation
      className="mt-3 min-w-0 border-t border-sidebar-border pt-3"
    >
      <h2 id={headingId} className="mb-2 px-2 text-xs font-semibold wrap-anywhere text-muted-foreground">
        {label}
      </h2>
      <div className="min-w-0">{children}</div>
    </Region>
  );
}
