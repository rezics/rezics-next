import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type {
  KnowledgeBreadcrumb,
  KnowledgeOutlinePage,
  KnowledgeOutlinePlacement,
  KnowledgeOwnedNotebook,
  KnowledgeOwnedNotebooksPage,
} from './navigation.ts';

const controlClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function localeOptions(locale: string) {
  return { locale: locale as never };
}

function NavigationNotice({
  state,
  locale,
  retry,
}: {
  state: string;
  locale: string;
  retry?: (() => void) | undefined;
}) {
  const options = localeOptions(locale);
  const message =
    state === 'preparing' || state === 'unknown'
      ? m.knowledge_private_preparing({}, options)
      : state === 'denied'
        ? m.knowledge_private_denied({}, options)
        : state === 'not-found'
          ? m.knowledge_private_not_found({}, options)
          : state === 'stale'
            ? m.knowledge_private_structure_changed({}, options)
            : state === 'signed-out'
              ? m.knowledge_private_signed_out({}, options)
              : state === 'retired'
                ? m.knowledge_private_retired({}, options)
                : m.knowledge_private_unavailable({}, options);
  const isUnavailable = state === 'unavailable' || state === 'preparing';
  return (
    <section
      role={isUnavailable ? 'status' : 'alert'}
      className="min-w-0 space-y-4 border-t border-border pt-4 text-foreground"
      aria-live="polite"
    >
      <p className="min-w-0 break-words">{message}</p>
      {retry ? (
        <Button type="button" variant="outline" className={controlClass} onClick={retry}>
          {m.knowledge_private_retry({}, options)}
        </Button>
      ) : null}
    </section>
  );
}

function Continuation({
  locale,
  next,
  busy,
  onOpen,
  onMore,
  opened,
  openLabel,
}: {
  locale: string;
  next: string | null;
  busy: boolean;
  onOpen: () => void;
  onMore: () => void;
  opened: boolean;
  openLabel: string;
}) {
  const options = localeOptions(locale);
  if (!opened)
    return (
      <Button type="button" className={controlClass} disabled={busy} onClick={onOpen}>
        {busy ? m.knowledge_private_preparing({}, options) : openLabel}
      </Button>
    );
  if (!next) return null;
  return (
    <Button type="button" variant="outline" className={controlClass} disabled={busy} onClick={onMore}>
      {busy ? m.knowledge_private_preparing({}, options) : m.knowledge_private_more({}, options)}
    </Button>
  );
}

export function KnowledgeOwnedNotebookList({
  locale,
  state,
  page,
  busy,
  selectedId,
  onOpen,
  onMore,
  onRetry,
  onSelect,
}: {
  locale: string;
  state: string;
  page: KnowledgeOwnedNotebooksPage | null;
  busy: boolean;
  selectedId: string | null;
  onOpen: () => void;
  onMore: () => void;
  onRetry: () => void;
  onSelect: (row: KnowledgeOwnedNotebook) => void;
}) {
  const options = localeOptions(locale);
  const opened = state === 'ready' && !!page;
  const failed = !['idle', 'preparing', 'ready'].includes(state);
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="knowledge-private-notebooks">
      <h2 id="knowledge-private-notebooks" className="text-lg font-semibold">
        {m.knowledge_private_choose_notebook({}, options)}
      </h2>
      {failed ? (
        <NavigationNotice state={state} locale={locale} retry={state !== 'preparing' ? onRetry : undefined} />
      ) : null}
      {opened && page.notebooks.length === 0 ? (
        <p role="status" className="break-words text-sm text-muted-foreground">
          {m.knowledge_private_notebooks_empty({}, options)}
        </p>
      ) : null}
      {opened ? (
        <ul className="min-w-0 space-y-3">
          {page.notebooks.map((row) => {
            const selected = selectedId === row.notebookId;
            return (
              <li
                key={row.notebookId}
                className="flex min-w-0 flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <p className="min-w-0 break-words font-medium">{row.title}</p>
                  <p className="min-w-0 break-all font-mono text-sm text-muted-foreground">{row.notebookId}</p>
                </div>
                <Button
                  type="button"
                  variant={selected ? 'default' : 'outline'}
                  className={controlClass}
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => onSelect(row)}
                >
                  {selected
                    ? m.knowledge_private_selected_notebook({}, options)
                    : m.knowledge_private_select_notebook({}, options)}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Continuation
        locale={locale}
        next={page?.next ?? null}
        busy={busy}
        onOpen={onOpen}
        onMore={onMore}
        opened={!!page}
        openLabel={m.knowledge_private_open_notebooks({}, options)}
      />
    </section>
  );
}

export function KnowledgeVisitedTrail({ locale, trail }: { locale: string; trail: readonly KnowledgeBreadcrumb[] }) {
  const options = localeOptions(locale);
  return (
    <nav aria-label={m.knowledge_private_breadcrumb({}, options)} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap gap-2 text-sm">
        <li className="min-w-0 break-words text-muted-foreground">
          {m.knowledge_private_destination_root({}, options)}
        </li>
        {trail.map((crumb) => (
          <li key={crumb.placementId} className="min-w-0 break-words">
            <span aria-hidden="true" className="pr-2 text-muted-foreground">
              /
            </span>
            {crumb.title}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function KnowledgeOutlineList({
  locale,
  state,
  page,
  busy,
  trail,
  onOpen,
  onMore,
  onRetry,
  onOpenParent,
  onReturn,
  onPlaceHere,
}: {
  locale: string;
  state: string;
  page: KnowledgeOutlinePage | null;
  busy: boolean;
  trail: readonly KnowledgeBreadcrumb[];
  onOpen: () => void;
  onMore: () => void;
  onRetry: () => void;
  onOpenParent: (placement: KnowledgeOutlinePlacement) => void;
  onReturn: () => void;
  onPlaceHere: () => void;
}) {
  const options = localeOptions(locale);
  const opened = state === 'ready' && !!page;
  const failed = !['idle', 'preparing', 'ready'].includes(state);
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="knowledge-private-outline">
      <h2 id="knowledge-private-outline" className="text-lg font-semibold">
        {m.knowledge_private_destination({}, options)}
      </h2>
      <KnowledgeVisitedTrail locale={locale} trail={trail} />
      {trail.length > 0 ? (
        <Button type="button" variant="outline" className={controlClass} disabled={busy} onClick={onReturn}>
          {m.knowledge_private_return_destination({}, options)}
        </Button>
      ) : null}
      {failed ? (
        <NavigationNotice state={state} locale={locale} retry={state !== 'preparing' ? onRetry : undefined} />
      ) : null}
      {opened && page.placements.length === 0 ? (
        <p role="status" className="break-words text-sm text-muted-foreground">
          {m.knowledge_private_outline_empty({}, options)}
        </p>
      ) : null}
      {opened ? (
        <ul className="min-w-0 space-y-3">
          {page.placements.map((row) => (
            <li
              key={row.placementId}
              className="flex min-w-0 flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <p className="min-w-0 break-words font-medium">{row.title}</p>
              <Button
                type="button"
                variant="outline"
                className={controlClass}
                disabled={busy}
                onClick={() => onOpenParent(row)}
              >
                {m.knowledge_private_open_parent({}, options)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex min-w-0 flex-wrap gap-3">
        <Continuation
          locale={locale}
          next={page?.next ?? null}
          busy={busy}
          onOpen={onOpen}
          onMore={onMore}
          opened={!!page}
          openLabel={m.knowledge_private_open_outline({}, options)}
        />
        {opened ? (
          <Button type="button" className={controlClass} disabled={busy} onClick={onPlaceHere}>
            {m.knowledge_private_place_here({}, options)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
