import { Button } from '@rezics/ui/shadcn/button';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { threadLocation } from './thread-href';
import {
  conversationDepth,
  conversationRowHidden,
  type ConversationPageModel,
  type ConversationRow,
} from './conversation-page-model';

const controlClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink rounded-md px-3 py-2 text-left text-sm leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type ParentNavigation = { exactHref: (parentId: string) => string };
const ParentNavigationContext = createContext<ParentNavigation | undefined>(undefined);
/** A parent that is absent from the supplied page still has an exact native locator destination. */
export function useReplyParentNavigation() {
  return useContext(ParentNavigationContext);
}

type ReturnPoint = { index: number; element: HTMLElement | null };
type BranchVisit = {
  scope: object;
  collapsed: ReadonlySet<number>;
  returns: readonly ReturnPoint[];
  focus: { index: number; element: HTMLElement | null } | null;
};
const initialVisit = (scope: object): BranchVisit => ({ scope, collapsed: new Set(), returns: [], focus: null });

/** Return the actual post item, rather than its presentation wrapper. IDs are compared as data. */
export function conversationPostElement(list: HTMLOListElement | null, anchorId: string): HTMLElement | null {
  if (!list) return null;
  const constructor = list.ownerDocument.defaultView?.HTMLElement;
  if (!constructor) return null;
  for (const item of list.querySelectorAll('[id]'))
    if (item.id === anchorId && item instanceof constructor) return item as HTMLElement;
  return null;
}

/**
 * Keeps every passed Post mounted and in producer order. The nested, presentational list admits
 * the Post's existing li root without cloning or changing its actions, document or editor.
 * Only the outer reading wrapper is hidden; collapse never owns a draft or a command.
 */
export function ConversationBranches({
  model,
  thread,
  scope,
  current,
  isCurrent,
  hash,
  listRef,
  renderPost,
}: {
  model: ConversationPageModel;
  thread: { id: string; title: string | null };
  scope: object;
  current: boolean;
  isCurrent: () => boolean;
  hash: string;
  listRef: RefObject<HTMLOListElement | null>;
  renderPost: (row: ConversationRow) => ReactNode;
}) {
  const [stored, setVisit] = useState(() => initialVisit(scope));
  // Reset presentation in place: keying the region would discard mounted post editors.
  const visit = stored.scope === scope ? stored : initialVisit(scope);
  if (stored.scope !== scope) setVisit(visit);
  const live = useRef({ scope, current, isCurrent });
  live.current = { scope, current, isCurrent };
  const ownsVisit = () => live.current.scope === scope && live.current.current && live.current.isCurrent();
  const navigation: ParentNavigation = {
    exactHref: (parentId) => threadLocation(getLocale(), thread, undefined, parentId),
  };
  const reveal = (collapsed: ReadonlySet<number>, row: ConversationRow) => {
    const next = new Set(collapsed);
    for (const ancestor of row.ancestors) next.delete(ancestor);
    return next;
  };
  const setFragment = (row: ConversationRow) => {
    const view = listRef.current?.ownerDocument.defaultView;
    // replaceState preserves the current opaque cursor and route. Following a page relation
    // does not start a router page read or create an authoring-departure transition.
    view?.history.replaceState(view.history.state, '', `#${row.anchorId}`);
  };
  useLayoutEffect(() => {
    if (!ownsVisit() || !visit.focus) return;
    const row = model.rows[visit.focus.index];
    if (!row) return;
    const target = conversationPostElement(listRef.current, row.anchorId);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start' });
    const origin = visit.focus.element;
    if (origin?.isConnected && target.contains(origin)) origin.focus({ preventScroll: true });
    else target.focus({ preventScroll: true });
  }, [visit.focus, scope]);
  // External fragment navigation also opens a collapsed destination, without creating a
  // fabricated return point. The list's regular deep-link focus runs after this disclosure.
  useLayoutEffect(() => {
    if (!ownsVisit()) return;
    const fragment = hash.replace(/^#/, '');
    const row = model.rows.find((item) => item.anchorId === fragment);
    if (!row || !conversationRowHidden(row, visit.collapsed)) return;
    setVisit((previous) =>
      previous.scope === scope
        ? { ...previous, collapsed: reveal(previous.collapsed, row), focus: { index: row.index, element: null } }
        : previous,
    );
  }, [hash, scope, model]);

  function follow(event: MouseEvent, origin: ConversationRow) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (!ownsVisit()) return;
    const constructor = event.currentTarget.ownerDocument.defaultView?.Element;
    if (!constructor || !(event.target instanceof constructor)) return;
    const link = (event.target as Element).closest('a');
    const href = link?.getAttribute('href');
    if (!href?.startsWith('#post-')) return;
    let id: string;
    try {
      id = decodeURIComponent(href.slice('#post-'.length));
    } catch {
      return;
    }
    const destination = model.byId.get(id);
    if (!destination || destination.index === origin.index) return;
    event.preventDefault();
    const source = link as HTMLElement;
    setVisit((previous) => {
      if (previous.scope !== scope || !ownsVisit()) return previous;
      return {
        ...previous,
        collapsed: reveal(previous.collapsed, destination),
        returns: [...previous.returns.slice(-(conversationDepth - 1)), { index: origin.index, element: source }],
        focus: { index: destination.index, element: null },
      };
    });
    setFragment(destination);
  }

  function returnToOrigin() {
    if (!ownsVisit()) return;
    const point = visit.returns.at(-1);
    const row = point && model.rows[point.index];
    if (!point || !row) return;
    setVisit((previous) => ({
      ...previous,
      collapsed: reveal(previous.collapsed, row),
      returns: previous.returns.slice(0, -1),
      focus: point,
    }));
    setFragment(row);
  }

  function toggle(row: ConversationRow, button: HTMLButtonElement, expanded?: boolean) {
    if (!ownsVisit()) return;
    button.focus({ preventScroll: true });
    setVisit((previous) => {
      if (previous.scope !== scope) return previous;
      const collapsed = new Set(previous.collapsed);
      const open = expanded ?? collapsed.has(row.index);
      if (open) collapsed.delete(row.index);
      else collapsed.add(row.index);
      return { ...previous, collapsed, focus: null };
    });
  }

  const returnPoint = visit.returns.at(-1);
  return (
    <ParentNavigationContext.Provider value={navigation}>
      <div data-slot="conversation-branches" className="min-w-0 space-y-3">
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">{m.thread_branch_scope()}</p>
        {current && returnPoint ? (
          <nav
            aria-label={m.thread_branch_return_navigation()}
            className="sticky top-20 z-10 flex min-w-0 rounded-lg border bg-background/95 p-1 shadow-sm"
          >
            <Button type="button" variant="outline" className={controlClass} onClick={returnToOrigin}>
              {m.thread_branch_return({ position: returnPoint.index + 1 })}
            </Button>
          </nav>
        ) : null}
        <ol
          id={`thread-${thread.id}`}
          ref={listRef}
          aria-hidden={!current}
          inert={!current}
          className={current ? 'space-y-3 scroll-mt-24' : 'invisible space-y-3 scroll-mt-24'}
        >
          {model.rows.map((row) => {
            const collapsed = visit.collapsed.has(row.index);
            const regionId = `branch-content-${thread.id}-${row.index}`;
            return (
              <li
                key={row.key}
                id={`branch-row-${thread.id}-${row.index}`}
                data-conversation-row={row.index}
                data-relationship-stop={row.stop}
                hidden={conversationRowHidden(row, visit.collapsed)}
                onClickCapture={(event) => follow(event, row)}
                className="min-w-0 space-y-1 border-s border-border ps-1 sm:ps-2"
                style={{ marginInlineStart: `min(${row.ancestors.length * 0.25}rem, 4vw)` }}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground">
                  <span>{m.thread_branch_position({ position: row.index + 1 })}</span>
                  {row.relatedCount > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={controlClass}
                      aria-expanded={!collapsed}
                      aria-controls={row.related.map((index) => `branch-row-${thread.id}-${index}`).join(' ')}
                      onClick={(event) => toggle(row, event.currentTarget)}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                        event.preventDefault();
                        toggle(row, event.currentTarget, event.key === 'ArrowRight');
                      }}
                    >
                      {collapsed
                        ? m.thread_branch_expand({ count: row.relatedCount })
                        : m.thread_branch_collapse({ count: row.relatedCount })}
                    </Button>
                  ) : null}
                </div>
                {row.ancestors.length ? (
                  <nav aria-label={m.thread_branch_path()} className="min-w-0 px-1">
                    <ol className="flex min-w-0 flex-wrap items-center gap-1">
                      {row.ancestors.map((index) => (
                        <li key={index} className="min-w-0">
                          <a href={`#${model.rows[index]!.anchorId}`} className={`${controlClass} inline-flex items-center underline underline-offset-4`}>
                            {m.thread_branch_position({ position: index + 1 })}
                          </a>
                        </li>
                      ))}
                    </ol>
                  </nav>
                ) : null}
                {row.continuation ? (
                  <a
                    href={model.byId.has(row.continuation) ? `#post-${row.continuation}` : navigation.exactHref(row.continuation)}
                    className={`${controlClass} inline-flex items-center underline underline-offset-4`}
                  >
                    {m.thread_branch_continue()}
                  </a>
                ) : null}
                {row.parentId !== null && ['missing', 'duplicate', 'cycle', 'unrelated'].includes(row.stop) ? (
                  <p className="px-2 text-xs leading-relaxed text-muted-foreground">{m.thread_branch_incomplete()}</p>
                ) : null}
                <p role="status" className={collapsed ? 'px-2 text-sm text-muted-foreground' : 'sr-only'}>
                  {collapsed ? m.thread_branch_collapsed({ count: row.relatedCount }) : null}
                </p>
                <ol id={regionId} role="presentation" className="min-w-0 list-none">
                  {renderPost(row)}
                </ol>
              </li>
            );
          })}
        </ol>
      </div>
    </ParentNavigationContext.Provider>
  );
}
