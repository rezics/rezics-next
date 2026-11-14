import { useMemo, useState } from 'react';
import { ChevronRight, FileText, MoreHorizontal, Plus } from 'lucide-react';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { SidebarMenu, SidebarMenuItem } from '@rezics/ui/shadcn/sidebar';
import { bookTocIndex, moveBookOccurrence, type BookTocIndex, type BookTocRow } from './book-toc';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sameExact } from './contract';
import type { BookOrganizationRequest } from './book-organization-canvas';
import { HostedHistoryDisclosure } from './hosted-history-view';
import type { HostedHistoryBinding } from './hosted-history';
import type { StudioController, StudioState } from './controller';
import './studio-navigation.css';

export function BookOrganizer({
  controller,
  state,
  onOpen,
  onOrganize,
  history,
}: {
  history?: HostedHistoryBinding;
  controller: StudioController;
  state: StudioState;
  onOpen: (postId: string) => void;
  onOrganize: (request: BookOrganizationRequest) => void;
}) {
  const structure = state.structure;
  const adapter = useMemo(() => {
    if (!structure) return { outline: null, error: null };
    try {
      return { outline: bookTocIndex(structure), error: null };
    } catch {
      return { outline: null, error: true };
    }
  }, [structure]);
  const locale = getLocale();
  if (!structure) return null;
  if (adapter.error) return <p role="alert">{m.studio_book_outline_unavailable({}, { locale })}</p>;
  const outline = adapter.outline!;
  const editable = controller.canOrganize() && !state.busy && !controller.hasUnresolvedCommand();
  return (
    <section aria-label={m.studio_book_outline_label({}, { locale })} className="studio-toc studio-navigation">
      <div className="studio-section-heading">
        <h2>{m.studio_book_outline_heading({}, { locale })}</h2>
      </div>
      {!controller.canOrganize() ? (
        <p className="studio-help">{m.studio_book_organization_unavailable({}, { locale })}</p>
      ) : null}
      {outline.rows.length ? (
        <TocBranch
          parent={null}
          outline={outline}
          state={state}
          controller={controller}
          editable={editable}
          onOpen={onOpen}
          onOrganize={onOrganize}
        />
      ) : (
        <p>{m.studio_book_outline_empty({}, { locale })}</p>
      )}
      {controller.canOrganize() ? (
        <Button
          type="button"
          variant="ghost"
          className="studio-navigation-row studio-navigation-add"
          disabled={!editable}
          onClick={() => onOrganize({ kind: 'add' })}
        >
          <Plus aria-hidden="true" />
          {m.studio_book_add_heading({}, { locale })}
        </Button>
      ) : null}
      {history ? <HostedHistoryDisclosure key={structure.catalogueId} binding={history} /> : null}
      <details className="studio-technical">
        <summary>{m.studio_book_structure_version({}, { locale })}</summary>
        <p className="studio-help">
          {m.studio_book_outline_capacity(
            { count: outline.rows.length, limit: structure.limits.maxPlacements },
            { locale },
          )}
        </p>
        <dl>
          <dt>{m.studio_book_catalogue({}, { locale })}</dt>
          <dd>{structure.catalogueId}</dd>
          <dt>{m.exact_revision_id({}, { locale })}</dt>
          <dd>{structure.revision}</dd>
        </dl>
      </details>
    </section>
  );
}

function TocBranch({
  parent,
  outline,
  ...props
}: {
  parent: string | null;
  outline: BookTocIndex;
  state: StudioState;
  controller: StudioController;
  editable: boolean;
  onOpen: (postId: string) => void;
  onOrganize: (request: BookOrganizationRequest) => void;
}) {
  const siblings = outline.children.get(parent) ?? [];
  return (
    <SidebarMenu className="studio-navigation-branch">
      {siblings.map((row) => (
        <TocEntry key={row.placement.occurrenceId} row={row} outline={outline} {...props} />
      ))}
    </SidebarMenu>
  );
}
function TocEntry({
  row,
  outline,
  state,
  controller,
  editable,
  onOpen,
  onOrganize,
}: {
  row: BookTocRow;
  outline: BookTocIndex;
  state: StudioState;
  controller: StudioController;
  editable: boolean;
  onOpen: (postId: string) => void;
  onOrganize: (request: BookOrganizationRequest) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { placement } = row;
  const locale = getLocale();
  const target = placement.target;
  const current = state.selected;
  const active = target.kind === 'chapter' && current?.source.revision.exact.postId === target.document.postId;
  const pin =
    target.kind === 'chapter' &&
    current?.source.revision.exact.postId === target.document.postId &&
    !current.dirty &&
    !current.snapshotPending &&
    !current.uploading &&
    !current.invalid &&
    !sameExact(current.source.revision.exact, target.document)
      ? current.source.revision.exact
      : null;
  const actions: MenuEntry[] = [
    {
      type: 'item',
      label: m.studio_book_move_to({}, { locale }),
      disabled: !editable,
      onSelect: () => onOrganize({ kind: 'move', occurrenceId: placement.occurrenceId }),
    },
    ...(
      [
        {
          direction: 'up',
          label: m.studio_book_move_up_title({ title: placement.title }, { locale }),
        },
        {
          direction: 'down',
          label: m.studio_book_move_down_title({ title: placement.title }, { locale }),
        },
        {
          direction: 'in',
          label: m.studio_book_nest_title({ title: placement.title }, { locale }),
        },
        {
          direction: 'out',
          label: m.studio_book_unnest_title({ title: placement.title }, { locale }),
        },
      ] as const
    ).map(({ direction, label }): MenuEntry => ({
      type: 'item',
      label,
      disabled: !editable || !moveBookOccurrence(row, direction, outline),
      onSelect: () => {
        const structure = controller.snapshot().structure;
        if (!structure) return;
        const latest = bookTocIndex(structure);
        const source = latest.byId.get(placement.occurrenceId);
        const current = source ? moveBookOccurrence(source, direction, latest) : null;
        if (current) void controller.organize(current);
      },
    })),
  ];
  if (pin)
    actions.push({
      type: 'item',
      label: m.studio_book_use_saved_version({}, { locale }),
      disabled: !editable,
      onSelect: () => void controller.organize({ kind: 'pin', occurrenceId: placement.occurrenceId, document: pin }),
    });
  actions.push(
    { type: 'separator' },
    {
      type: 'item',
      label: m.studio_book_rename({}, { locale }),
      disabled: !editable,
      onSelect: () => onOrganize({ kind: 'rename', occurrenceId: placement.occurrenceId }),
    },
    {
      type: 'destructive',
      label: m.studio_book_remove({}, { locale }),
      disabled: !editable,
      onSelect: () => onOrganize({ kind: 'remove', occurrenceId: placement.occurrenceId }),
    },
  );
  const entry = (
    <>
      <div
        className="studio-navigation-entry"
        data-current={active || undefined}
        style={{ marginInlineStart: `${Math.min(row.depth, 8) * 0.75}rem` }}
      >
        {target.kind === 'chapter' ? (
          <Button
            type="button"
            variant="ghost"
            className="studio-navigation-row"
            aria-current={active ? 'true' : undefined}
            disabled={Boolean(state.busy) || controller.hasUnresolvedCommand()}
            onClick={() => onOpen(target.document.postId)}
          >
            <FileText aria-hidden="true" />
            <span>{placement.title}</span>
          </Button>
        ) : (
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" className="studio-navigation-row studio-navigation-part" />}
          >
            <ChevronRight className="studio-navigation-chevron" aria-hidden="true" />
            <span>{placement.title}</span>
          </CollapsibleTrigger>
        )}
        <Menu
          title={m.studio_book_organize_title({ title: placement.title }, { locale })}
          entries={actions}
          navigationScope={controller}
          trigger={
            <Button
              type="button"
              variant="ghost"
              className="studio-navigation-actions"
              aria-label={m.studio_book_organize_title({ title: placement.title }, { locale })}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          }
        />
      </div>
      {target.kind === 'part' ? (
        <CollapsibleContent keepMounted>
          <TocBranch
            parent={placement.occurrenceId}
            outline={outline}
            state={state}
            controller={controller}
            editable={editable}
            onOpen={onOpen}
            onOrganize={onOrganize}
          />
        </CollapsibleContent>
      ) : null}
    </>
  );
  return target.kind === 'part' ? (
    <Collapsible open={expanded} onOpenChange={setExpanded} render={<SidebarMenuItem />}>
      {entry}
    </Collapsible>
  ) : (
    <SidebarMenuItem>{entry}</SidebarMenuItem>
  );
}
