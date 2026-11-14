import { useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { KnowledgePrivateOperations } from './private-page';
import type { KnowledgePrivateAddress } from './private-knowledge';
import { KnowledgeNavigationEntry, type KnowledgeNavigationOperations } from './navigation-page';
import { knowledgeControl, knowledgeLink } from './workspace';

/** The editor reuses the replacing native outline reader, opened deliberately and never prefetched. */
export function KnowledgeWorkspaceNavigation({
  address,
  title,
  locale,
  binding,
  operations,
  admission,
  current,
  onRetire,
}: {
  address: KnowledgePrivateAddress;
  title: string;
  locale: string;
  binding: { viewer: string; csrfToken: string };
  operations: KnowledgePrivateOperations;
  admission: 'unknown' | 'available' | 'denied' | 'unavailable';
  current: () => boolean;
  onRetire: (state: 'retired' | 'signed-out' | 'denied') => void;
}) {
  const [open, setOpen] = useState(false);
  const options = { locale: locale as never };
  const callbacks = useRef({ current, onRetire });
  callbacks.current = { current, onRetire };
  const navigation = useMemo<KnowledgeNavigationOperations>(
    () => ({
      current: () => callbacks.current.current(),
      async read(request) {
        if (request.kind !== 'outline') return { state: 'unavailable' };
        const result = await operations.readOutline(
          {
            notebookId: request.notebookId,
            parentPlacementId: request.parentPlacementId,
            cursor: request.cursor ?? null,
          },
          binding,
        );
        if (result.state === 'ready') return { state: 'ready', page: { kind: 'outline', ...result.page } };
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied') {
          callbacks.current.onRetire(result.state);
          return { state: result.state };
        }
        return { state: result.state === 'stale' || result.state === 'not-found' ? 'changed' : 'unavailable' };
      },
    }),
    [operations, binding],
  );
  return (
    <aside
      className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start"
      aria-label={m.knowledge_workspace_documents({}, options)}
    >
      <div className="space-y-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">
          {m.knowledge_workspace_only_you({}, options)}
        </p>
        <h2 className="text-base font-semibold">{m.knowledge_workspace_documents({}, options)}</h2>
      </div>
      <p aria-current="page" className="border-l-2 border-primary py-2 pl-3 text-sm font-medium">
        {title}
      </p>
      <div className="flex flex-wrap gap-x-4 lg:flex-col lg:items-start">
        <Link
          to="/knowledge/notebooks/$notebookId"
          params={{ notebookId: address.notebookId }}
          preload={false}
          className={knowledgeLink}
        >
          {m.knowledge_navigation_return({}, options)}
        </Link>
        <Link to="/knowledge" preload={false} className={knowledgeLink}>
          {m.knowledge_navigation_heading({}, options)}
        </Link>
      </div>
      {!open ? (
        <Button type="button" variant="outline" className={knowledgeControl} onClick={() => setOpen(true)}>
          {m.knowledge_workspace_navigation_open({}, options)}
        </Button>
      ) : (
        <KnowledgeNavigationEntry
          address={{ kind: 'outline', notebookId: address.notebookId, parentPlacementId: null }}
          locale={locale}
          binding={JSON.stringify(binding)}
          access={admission === 'unknown' ? 'preparing' : admission}
          operations={navigation}
          selectedDocumentId={address.documentId}
          embedded
        />
      )}
    </aside>
  );
}
