import { KnowledgeDetails, KnowledgeValue } from './workspace';
import { BookOpen, FileText } from 'lucide-react';
import { KnowledgeOrganizationOwner } from './organization-page';
import type { OrganizationOperations } from './organization-read';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { sessionRecoverySignInHref } from '../session/unavailable';
import { PageHeading } from '../shell/page-heading';
import {
  KnowledgeNavigationReading,
  knowledgeNavigationRoot,
  type KnowledgeNavigationFrontier,
  type KnowledgeNavigationReader,
} from './navigation-model';
import type { KnowledgeNavigationAddress } from './navigation-read';
import {
  KnowledgeOutlineReading,
  type KnowledgeOutlineBranch,
  type KnowledgeOutlineSnapshot,
} from './navigation-reading';
import { KnowledgeNavigationReturn } from './navigation-return';
import { useKnowledgeNavigationOrientation } from './navigation-focus';
import type { KnowledgeNavigationRestoration } from './navigation-return';
import { knowledgeNavigationControl, knowledgeNavigationLink } from './navigation-return-link';

export type KnowledgeNavigationAccess = 'available' | 'preparing' | 'denied' | 'unavailable' | 'signed-out';
export type KnowledgeNavigationOperations = Readonly<{
  read: KnowledgeNavigationReader;
  organization?: OrganizationOperations;
  current?: () => boolean;
  subscribeRetirement?: (retire: () => void) => () => void;
}>;
const sourceIds = new WeakMap<object, number>();
let sourceSequence = 0;
function sourceId(source: object) {
  let id = sourceIds.get(source);
  if (!id) {
    id = ++sourceSequence;
    sourceIds.set(source, id);
  }
  return id;
}

function NavigationFrame({
  locale,
  children,
  outline,
  notebookId,
}: {
  locale: string;
  children: React.ReactNode;
  outline: boolean;
  notebookId?: string | undefined;
}) {
  const options = { locale: locale as never };
  return (
    <main
      className="mx-auto w-full min-w-0 max-w-6xl space-y-8 px-4 py-6 text-foreground selection:bg-primary/20 [overflow-wrap:anywhere] sm:px-6 sm:py-8"
      data-private-knowledge-navigation
    >
      <header className="min-w-0 space-y-3">
        <PageHeading>
          {outline ? m.knowledge_navigation_outline({}, options) : m.knowledge_navigation_heading({}, options)}
        </PageHeading>
        <p className="text-sm text-muted-foreground">{m.knowledge_workspace_only_you({}, options)}</p>
      </header>
      {notebookId && (
        <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
          <dl>
            <KnowledgeValue label={m.knowledge_private_notebook_id({}, options)} value={notebookId} exact />
          </dl>
        </KnowledgeDetails>
      )}
      {children}
    </main>
  );
}

/** Stories and mounted regressions enter at the same access/source/address replacement boundary. */
export function KnowledgeNavigationEntry({
  address,
  locale,
  binding,
  access,
  operations,
  returning,
  retryAccess,
  embedded = false,
  selectedDocumentId,
}: {
  address: KnowledgeNavigationAddress;
  locale: string;
  binding: string;
  access: KnowledgeNavigationAccess;
  operations: KnowledgeNavigationOperations;
  returning?: KnowledgeNavigationReturn | undefined;
  retryAccess?: () => void;
  embedded?: boolean;
  selectedDocumentId?: string | undefined;
}) {
  const options = { locale: locale as never };
  const owner = JSON.stringify([address, locale, binding, access, sourceId(operations)]);
  const content =
    access === 'available' ? (
      <KnowledgeNavigationOwner
        key={owner}
        address={address}
        locale={locale}
        binding={binding}
        operations={operations}
        returning={returning}
        selectedDocumentId={selectedDocumentId}
        embedded={embedded}
      />
    ) : (
      <div className="space-y-4" role={access === 'denied' || access === 'unavailable' ? 'alert' : 'status'}>
        <p>
          {access === 'signed-out'
            ? m.knowledge_navigation_signed_out({}, options)
            : access === 'denied'
              ? m.knowledge_navigation_denied({}, options)
              : access === 'unavailable'
                ? m.knowledge_navigation_unavailable({}, options)
                : m.knowledge_navigation_preparing({}, options)}
        </p>
        {access === 'signed-out' && (
          <a
            className={knowledgeNavigationLink}
            href={sessionRecoverySignInHref(
              address.kind === 'owned'
                ? `/${locale}/knowledge`
                : `/${locale}/knowledge/notebooks/${address.notebookId}`,
            )}
          >
            {m.knowledge_private_sign_in({}, options)}
          </a>
        )}
        {access === 'unavailable' && retryAccess && (
          <Button className={knowledgeNavigationControl} onClick={retryAccess}>
            {m.knowledge_navigation_retry({}, options)}
          </Button>
        )}
      </div>
    );
  return embedded ? (
    content
  ) : (
    <NavigationFrame
      locale={locale}
      outline={address.kind === 'outline'}
      notebookId={address.kind === 'outline' ? address.notebookId : undefined}
    >
      {content}
    </NavigationFrame>
  );
}

function KnowledgeNavigationOwner({
  address,
  locale,
  binding,
  operations,
  returning,
  selectedDocumentId,
  embedded,
}: {
  selectedDocumentId?: string | undefined;
  embedded?: boolean | undefined;
  address: KnowledgeNavigationAddress;
  locale: string;
  binding: string;
  operations: KnowledgeNavigationOperations;
  returning?: KnowledgeNavigationReturn | undefined;
}) {
  const [initialized, setInitialized] = useState(false);
  const initial = useRef<KnowledgeNavigationRestoration & { frontier: KnowledgeNavigationFrontier }>(null);
  const [reading, setReading] = useState<KnowledgeNavigationReading>();
  useLayoutEffect(() => {
    if (!initial.current) {
      const restored = address.kind === 'outline' ? returning?.take(binding, address.notebookId) : undefined;
      if (address.kind === 'owned') returning?.clear();
      initial.current = {
        ...restored,
        frontier: restored?.frontier ?? knowledgeNavigationRoot(address),
        expired: restored?.expired ?? false,
      };
    }
    const { frontier, expired } = initial.current;
    if (address.kind === 'outline') {
      setReading(undefined);
      setInitialized(true);
      return;
    }
    const current = new KnowledgeNavigationReading(operations.read, frontier, expired, operations.current);
    const stop = operations.subscribeRetirement?.(() => current.retire());
    setReading(current);
    if (!expired)
      queueMicrotask(() => {
        void current.open();
      });
    return () => {
      stop?.();
      current.retire();
    };
  }, [JSON.stringify(address), binding, operations, returning]);
  if (address.kind === 'outline' && initialized && initial.current)
    return (
      <KnowledgeOutlineOwner
        address={address}
        frontier={initial.current.frontier}
        expired={initial.current.expired}
        locale={locale}
        binding={binding}
        operations={operations}
        returning={returning}
        restored={initial.current}
        embedded={embedded}
        selectedDocumentId={selectedDocumentId ?? initial.current.documentId}
      />
    );
  if (!reading) return <p role="status">{m.knowledge_navigation_preparing({}, { locale: locale as never })}</p>;
  return <KnowledgeNavigationRows reading={reading} locale={locale} />;
}

/** The flat owned-notebook directory deliberately keeps replacing native pages. */
function KnowledgeNavigationRows({ reading, locale }: { reading: KnowledgeNavigationReading; locale: string }) {
  const snapshot = useSyncExternalStore(reading.subscribe, reading.getSnapshot, reading.getSnapshot);
  const options = { locale: locale as never };
  const { boundary, activate } = useKnowledgeNavigationOrientation(snapshot, reading.getSnapshot);
  const actions = reading.actions(snapshot);
  const page = snapshot.page?.kind === 'owned' ? snapshot.page : undefined;
  return (
    <section
      ref={boundary}
      tabIndex={-1}
      className="min-w-0 space-y-6"
      aria-label={m.knowledge_navigation_reading({}, options)}
      aria-busy={snapshot.state === 'preparing'}
    >
      {snapshot.state === 'preparing' || snapshot.state === 'retired' ? (
        <p role="status">{m.knowledge_navigation_preparing({}, options)}</p>
      ) : snapshot.state === 'ready' && page ? (
        <>
          {page.notebooks.length === 0 && (
            <p role="status">
              {page.next ? m.knowledge_navigation_sparse({}, options) : m.knowledge_navigation_empty({}, options)}
            </p>
          )}
          <ul className="min-w-0 divide-y divide-border">
            {page.notebooks.map((row) => (
              <li key={row.notebookId} className="flex min-w-0 items-start gap-4 py-5 sm:gap-6">
                <BookOpen aria-hidden="true" className="mt-3 size-5 shrink-0 text-muted-foreground" />
                <h2 aria-label={row.title} className="min-w-0 flex-1 text-lg font-semibold leading-snug">
                  <Link
                    to="/knowledge/notebooks/$notebookId"
                    params={{ notebookId: row.notebookId }}
                    preload={false}
                    className={knowledgeNavigationLink}
                  >
                    <span className="sr-only">{m.knowledge_navigation_open_notebook({}, options)}: </span>
                    {row.title}
                  </Link>
                </h2>
              </li>
            ))}
          </ul>
          {page.next && (
            <Button className={knowledgeNavigationControl} onClick={(event) => activate(event, actions.more)}>
              {m.knowledge_navigation_more({}, options)}
            </Button>
          )}
        </>
      ) : (
        <NavigationFailure
          state={snapshot.state}
          locale={locale}
          retry={(event) => activate(event, actions.retry)}
          restart={(event) => activate(event, actions.restart)}
        />
      )}
    </section>
  );
}

function NavigationFailure({
  state,
  locale,
  retry,
  restart,
}: {
  state: string;
  locale: string;
  retry: React.MouseEventHandler<HTMLButtonElement>;
  restart: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const options = { locale: locale as never };
  return (
    <div role="alert" className="space-y-3">
      <p>
        {state === 'changed'
          ? m.knowledge_navigation_changed({}, options)
          : state === 'denied'
            ? m.knowledge_navigation_denied({}, options)
            : state === 'signed-out'
              ? m.knowledge_navigation_signed_out({}, options)
              : m.knowledge_navigation_unavailable({}, options)}
      </p>
      {state === 'changed' && (
        <Button className={knowledgeNavigationControl} onClick={restart}>
          {m.knowledge_navigation_restart({}, options)}
        </Button>
      )}
      {state === 'unavailable' && (
        <Button className={knowledgeNavigationControl} onClick={retry}>
          {m.knowledge_navigation_retry({}, options)}
        </Button>
      )}
    </div>
  );
}

function KnowledgeOutlineOwner({
  address,
  frontier,
  expired,
  operations,
  locale,
  binding,
  returning,
  restored,
  embedded,
  selectedDocumentId,
}: {
  address: Extract<KnowledgeNavigationAddress, { kind: 'outline' }>;
  frontier: KnowledgeNavigationFrontier;
  expired: boolean;
  operations: KnowledgeNavigationOperations;
  locale: string;
  binding: string;
  returning?: KnowledgeNavigationReturn | undefined;
  restored?: KnowledgeNavigationRestoration | undefined;
  embedded?: boolean | undefined;
  selectedDocumentId?: string | undefined;
}) {
  const [reading, setReading] = useState<KnowledgeOutlineReading>();
  const [organizationOpened, setOrganizationOpened] = useState(false);
  const [organizationFrontier] = useState(() => knowledgeNavigationRoot(address));
  const organization = useMemo<OrganizationOperations | undefined>(() => {
    const source = operations.organization;
    return source
      ? {
          ...source,
          move: async (intent) => {
            const result = await source.move(intent);
            if (result.state === 'acknowledged' || result.state === 'conflict') reading?.invalidate();
            return result;
          },
        }
      : undefined;
  }, [operations.organization, reading]);
  useLayoutEffect(() => {
    const current = new KnowledgeOutlineReading(operations.read, frontier, expired, operations.current);
    const stop = operations.subscribeRetirement?.(() => current.retire());
    setReading(current);
    if (!expired)
      queueMicrotask(() => {
        void current.open();
      });
    return () => {
      stop?.();
      current.retire();
    };
  }, [operations, frontier, expired]);
  const options = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-6">
      {reading ? (
        <KnowledgeOutlineRows
          reading={reading}
          locale={locale}
          binding={binding}
          returning={returning}
          restored={restored}
          embedded={embedded}
          selectedDocumentId={selectedDocumentId}
        />
      ) : (
        <p role="status">{m.knowledge_navigation_preparing({}, options)}</p>
      )}
      {organization && (
        <details
          data-knowledge-organization
          className="min-w-0 border-t border-border pt-4"
          onToggle={(event) => {
            if (event.currentTarget.open) setOrganizationOpened(true);
          }}
        >
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            {m.knowledge_navigation_organization({}, options)}
          </summary>
          {organizationOpened && (
            <KnowledgeOrganizationOwner
              frontier={organizationFrontier}
              expired={false}
              locale={locale}
              binding={binding}
              operations={organization}
              current={operations.current}
              subscribeRetirement={operations.subscribeRetirement}
              returning={returning}
              embedded={embedded}
              selectedDocumentId={selectedDocumentId}
            />
          )}
        </details>
      )}
    </div>
  );
}

function KnowledgeOutlineRows({
  reading,
  ...props
}: {
  reading: KnowledgeOutlineReading;
  locale: string;
  binding: string;
  returning?: KnowledgeNavigationReturn | undefined;
  restored?: KnowledgeNavigationRestoration | undefined;
  embedded?: boolean | undefined;
  selectedDocumentId?: string | undefined;
}) {
  const snapshot = useSyncExternalStore(reading.subscribe, reading.getSnapshot, reading.getSnapshot);
  const regionPrefix = useId();
  return (
    <KnowledgeOutlineBranchRows
      {...props}
      reading={reading}
      snapshot={snapshot}
      parent={snapshot.root}
      regionPrefix={regionPrefix}
    />
  );
}

function KnowledgeOutlineBranchRows({
  reading,
  snapshot,
  parent,
  regionPrefix,
  locale,
  binding,
  returning,
  restored,
  embedded,
  selectedDocumentId,
}: {
  reading: KnowledgeOutlineReading;
  snapshot: KnowledgeOutlineSnapshot;
  parent: string | null;
  regionPrefix: string;
  locale: string;
  binding: string;
  returning?: KnowledgeNavigationReturn | undefined;
  restored?: KnowledgeNavigationRestoration | undefined;
  embedded?: boolean | undefined;
  selectedDocumentId?: string | undefined;
}) {
  const branch = snapshot.branches.get(parent)!;
  const root = parent === snapshot.root;
  const options = { locale: locale as never };
  const getBranch = useCallback(() => reading.getSnapshot().branches.get(parent) ?? branch, [reading, parent]);
  const { boundary, selected, activate } = useKnowledgeNavigationOrientation<KnowledgeOutlineBranch>(
    branch,
    getBranch,
    {
      embedded,
      restored: root ? restored : undefined,
      selectedDocumentId,
    },
  );
  const actions = reading.actions(parent, branch);
  const RowHeading = embedded ? 'h3' : 'h2';
  return (
    <section
      ref={boundary}
      tabIndex={-1}
      className="min-w-0 space-y-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={root ? m.knowledge_navigation_reading({}, options) : branch.frontier.breadcrumbs.at(-1)?.title}
      aria-busy={branch.state === 'preparing'}
    >
      {root && !embedded && (
        <Link to="/knowledge" preload={false} className={knowledgeNavigationLink}>
          {m.knowledge_navigation_heading({}, options)}
        </Link>
      )}
      {root && branch.frontier.breadcrumbs.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {[m.knowledge_navigation_root({}, options), ...branch.frontier.breadcrumbs.map((crumb) => crumb.title)].join(
            ' / ',
          )}
        </p>
      )}
      {branch.rows.length > 0 && (
        <ul className="min-w-0 divide-y divide-border">
          {branch.rows.map((supplied) => {
            const row = supplied.placement;
            const child = snapshot.branches.get(row.placementId);
            const expanded = child?.expanded ?? false;
            const regionId = `${regionPrefix}-${row.placementId}`;
            return (
              <li
                key={row.placementId}
                data-knowledge-placement={row.placementId}
                className={`min-w-0 py-3 ${row.documentId === selectedDocumentId ? 'border-l-2 border-l-primary pl-2' : ''}`}
              >
                <div className="flex min-w-0 items-start gap-2">
                  {!embedded && <FileText aria-hidden="true" className="mt-3 size-4 shrink-0 text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <RowHeading className="text-base font-medium leading-snug">
                      <Link
                        to="/knowledge/notebooks/$notebookId/documents/$documentId"
                        params={{ notebookId: branch.frontier.request.notebookId, documentId: row.documentId }}
                        preload={false}
                        className={knowledgeNavigationLink}
                        ref={
                          (
                            restored?.placementId
                              ? row.placementId === restored.placementId
                              : row.documentId === selectedDocumentId
                          )
                            ? selected
                            : undefined
                        }
                        aria-current={row.documentId === selectedDocumentId ? 'page' : undefined}
                        onClick={(event) => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                            return;
                          const frontier = reading.remember(parent, branch, supplied);
                          if (frontier)
                            returning?.save(
                              binding,
                              { notebookId: branch.frontier.request.notebookId, documentId: row.documentId },
                              frontier,
                              row.placementId,
                            );
                        }}
                      >
                        <span className="sr-only">{m.knowledge_navigation_open_document({}, options)}: </span>
                        {row.title}
                      </Link>
                    </RowHeading>
                    <Button
                      variant="ghost"
                      className={knowledgeNavigationControl}
                      aria-expanded={expanded}
                      aria-controls={regionId}
                      disabled={branch.frontier.breadcrumbs.length >= 32}
                      onClick={() => actions.toggle(row)}
                    >
                      {expanded
                        ? m.knowledge_navigation_collapse({}, options)
                        : m.knowledge_navigation_children({}, options)}
                      <span className="sr-only">: {row.title}</span>
                    </Button>
                  </div>
                </div>
                <div id={regionId} hidden={!expanded} className="min-w-0 border-l border-border pl-3 sm:pl-4">
                  {expanded && (
                    <KnowledgeOutlineBranchRows
                      reading={reading}
                      snapshot={snapshot}
                      parent={row.placementId}
                      regionPrefix={regionPrefix}
                      locale={locale}
                      binding={binding}
                      returning={returning}
                      embedded={embedded}
                      selectedDocumentId={selectedDocumentId}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {branch.state === 'preparing' || branch.state === 'retired' ? (
        <p role="status">{m.knowledge_navigation_preparing({}, options)}</p>
      ) : branch.state !== 'ready' ? (
        <NavigationFailure
          state={branch.state}
          locale={locale}
          retry={(event) => activate(event, actions.retry)}
          restart={(event) => activate(event, actions.restart)}
        />
      ) : (
        <>
          {branch.rows.length === 0 && (
            <p role="status">
              {branch.next
                ? m.knowledge_navigation_sparse({}, options)
                : m.knowledge_navigation_empty_outline({}, options)}
            </p>
          )}
          {branch.frontier.breadcrumbs.length >= 32 && <p role="status">{m.knowledge_navigation_depth({}, options)}</p>}
          {branch.next && (
            <Button className={knowledgeNavigationControl} onClick={(event) => activate(event, actions.more)}>
              {m.knowledge_navigation_more({}, options)}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
