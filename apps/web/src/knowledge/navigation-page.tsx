import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { KnowledgeNavigationReturn } from './navigation-return';
import { knowledgeNavigationControl, knowledgeNavigationLink } from './navigation-return-link';

export type KnowledgeNavigationAccess = 'available' | 'preparing' | 'denied' | 'unavailable' | 'signed-out';
export type KnowledgeNavigationOperations = Readonly<{
  read: KnowledgeNavigationReader;
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
}: {
  locale: string;
  children: React.ReactNode;
  outline: boolean;
}) {
  const options = { locale: locale as never };
  return (
    <main
      className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-4 py-6 text-foreground selection:bg-primary/20 [overflow-wrap:anywhere] sm:px-6 sm:py-8"
      data-private-knowledge-navigation
    >
      <header className="min-w-0 space-y-3">
        <PageHeading>
          {outline ? m.knowledge_navigation_outline({}, options) : m.knowledge_navigation_heading({}, options)}
        </PageHeading>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.knowledge_navigation_intro({}, options)}
        </p>
      </header>
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
}: {
  address: KnowledgeNavigationAddress;
  locale: string;
  binding: string;
  access: KnowledgeNavigationAccess;
  operations: KnowledgeNavigationOperations;
  returning?: KnowledgeNavigationReturn;
  retryAccess?: () => void;
}) {
  const options = { locale: locale as never };
  const owner = JSON.stringify([address, locale, binding, access, sourceId(operations)]);
  return (
    <NavigationFrame locale={locale} outline={address.kind === 'outline'}>
      {access === 'available' ? (
        <KnowledgeNavigationOwner
          key={owner}
          address={address}
          locale={locale}
          binding={binding}
          operations={operations}
          returning={returning}
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
                address.kind === 'owned' ? '/knowledge' : `/knowledge/notebooks/${address.notebookId}`,
                locale,
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
      )}
    </NavigationFrame>
  );
}

function KnowledgeNavigationOwner({
  address,
  locale,
  binding,
  operations,
  returning,
}: {
  address: KnowledgeNavigationAddress;
  locale: string;
  binding: string;
  operations: KnowledgeNavigationOperations;
  returning?: KnowledgeNavigationReturn;
}) {
  const initial = useRef<{ frontier: KnowledgeNavigationFrontier; expired: boolean }>(null);
  const [reading, setReading] = useState<KnowledgeNavigationReading>();
  useLayoutEffect(() => {
    if (!initial.current) {
      const restored = address.kind === 'outline' ? returning?.take(binding, address.notebookId) : undefined;
      if (address.kind === 'owned') returning?.clear();
      initial.current = {
        frontier: restored?.frontier ?? knowledgeNavigationRoot(address),
        expired: restored?.expired ?? false,
      };
    }
    const { frontier, expired } = initial.current;
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
  if (!reading) return <p role="status">{m.knowledge_navigation_preparing({}, { locale: locale as never })}</p>;
  return <KnowledgeNavigationRows reading={reading} locale={locale} binding={binding} returning={returning} />;
}

function KnowledgeNavigationRows({
  reading,
  locale,
  binding,
  returning,
}: {
  reading: KnowledgeNavigationReading;
  locale: string;
  binding: string;
  returning?: KnowledgeNavigationReturn;
}) {
  const snapshot = useSyncExternalStore(reading.subscribe, reading.getSnapshot, reading.getSnapshot);
  const options = { locale: locale as never };
  const focus = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (snapshot.state !== 'preparing' && snapshot.state !== 'retired') focus.current?.focus({ preventScroll: true });
  }, [snapshot]);
  const actions = reading.actions(snapshot);
  const { page, frontier } = snapshot;
  const outline = frontier.request.kind === 'outline';
  const remember = (documentId: string) => {
    if (snapshot !== reading.getSnapshot() || page?.kind !== 'outline') return;
    returning?.save(binding, { notebookId: page.notebookId, documentId }, frontier);
  };
  return (
    <section
      ref={focus}
      tabIndex={-1}
      className="min-w-0 space-y-6"
      aria-label={m.knowledge_navigation_reading({}, options)}
      aria-busy={snapshot.state === 'preparing'}
    >
      {outline && (
        <nav
          aria-label={m.knowledge_navigation_breadcrumbs({}, options)}
          className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1"
        >
          <Link to="/knowledge" preload={false} className={knowledgeNavigationLink}>
            {m.knowledge_navigation_heading({}, options)}
          </Link>
          <Button
            variant="ghost"
            className={knowledgeNavigationControl}
            disabled={snapshot.state === 'preparing'}
            onClick={actions.root}
          >
            {m.knowledge_navigation_root({}, options)}
          </Button>
          {frontier.breadcrumbs.map((crumb, index) => (
            <Button
              key={crumb.placementId}
              variant="ghost"
              className={knowledgeNavigationControl}
              aria-current={index === frontier.breadcrumbs.length - 1 ? 'location' : undefined}
              disabled={snapshot.state !== 'ready'}
              onClick={() => actions.ancestor(index)}
            >
              {crumb.title}
            </Button>
          ))}
        </nav>
      )}
      {snapshot.state === 'preparing' || snapshot.state === 'retired' ? (
        <p role="status">{m.knowledge_navigation_preparing({}, options)}</p>
      ) : snapshot.state === 'ready' && page ? (
        <>
          {(page.kind === 'owned' ? page.notebooks.length : page.placements.length) === 0 && (
            <p role="status">
              {page.next
                ? m.knowledge_navigation_sparse({}, options)
                : page.kind === 'owned'
                  ? m.knowledge_navigation_empty({}, options)
                  : m.knowledge_navigation_empty_outline({}, options)}
            </p>
          )}
          <ul className="min-w-0 divide-y divide-border">
            {page.kind === 'owned'
              ? page.notebooks.map((row) => (
                  <li
                    key={row.notebookId}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4"
                  >
                    <h2 className="min-w-0 basis-full text-base font-medium sm:basis-auto sm:flex-1">{row.title}</h2>
                    <Link
                      to="/knowledge/notebooks/$notebookId"
                      params={{ notebookId: row.notebookId }}
                      preload={false}
                      className={knowledgeNavigationLink}
                    >
                      {m.knowledge_navigation_open_notebook({}, options)}
                      <span className="sr-only">{`: ${row.title}`}</span>
                    </Link>
                  </li>
                ))
              : page.placements.map((row) => (
                  <li key={row.placementId} className="min-w-0 space-y-2 py-4">
                    <h2 className="text-base font-medium">{row.title}</h2>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
                      <Link
                        to="/knowledge/notebooks/$notebookId/documents/$documentId"
                        params={{ notebookId: page.notebookId, documentId: row.documentId }}
                        preload={false}
                        className={knowledgeNavigationLink}
                        onClick={(event) => {
                          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
                            remember(row.documentId);
                        }}
                      >
                        {m.knowledge_navigation_open_document({}, options)}
                        <span className="sr-only">{`: ${row.title}`}</span>
                      </Link>
                      <Button
                        variant="outline"
                        className={knowledgeNavigationControl}
                        disabled={frontier.breadcrumbs.length >= 32}
                        onClick={() => actions.children(row)}
                      >
                        {m.knowledge_navigation_children({}, options)}
                        <span className="sr-only">{`: ${row.title}`}</span>
                      </Button>
                    </div>
                  </li>
                ))}
          </ul>
          {frontier.breadcrumbs.length >= 32 && <p role="status">{m.knowledge_navigation_depth({}, options)}</p>}
          {page.next && (
            <Button className={knowledgeNavigationControl} onClick={actions.more}>
              {m.knowledge_navigation_more({}, options)}
            </Button>
          )}
        </>
      ) : (
        <div role="alert" className="space-y-4">
          <p>
            {snapshot.state === 'changed'
              ? m.knowledge_navigation_changed({}, options)
              : snapshot.state === 'denied'
                ? m.knowledge_navigation_denied({}, options)
                : snapshot.state === 'signed-out'
                  ? m.knowledge_navigation_signed_out({}, options)
                  : m.knowledge_navigation_unavailable({}, options)}
          </p>
          {snapshot.state === 'changed' && (
            <Button className={knowledgeNavigationControl} onClick={actions.restart}>
              {m.knowledge_navigation_restart({}, options)}
            </Button>
          )}
          {snapshot.state === 'unavailable' && (
            <Button className={knowledgeNavigationControl} onClick={actions.retry}>
              {m.knowledge_navigation_retry({}, options)}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
