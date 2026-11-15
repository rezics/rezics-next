import type { MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import type { FollowingKind } from '../following-kind-navigation/address';
import type { FollowingMovement, FollowingWindow } from '../following-kind-navigation/window-history';

type FollowingWorkspaceSelection = {
  title: string;
  titleLang?: string | undefined;
  close: () => void;
  inspection: ReactNode;
};

/** Presentation frame for the admitted directory and its one current selection. */
export function FollowingWorkspace({
  articleRef,
  headingRef,
  kind,
  kindChangeDisabled,
  onMove,
  onRefresh,
  refreshDisabled,
  windowStatus,
  directory,
  windowNavigation,
  selection,
}: {
  articleRef: Ref<HTMLElement>;
  headingRef: Ref<HTMLHeadingElement>;
  kind: FollowingKind;
  kindChangeDisabled: boolean;
  onMove?: (
    event: ReactMouseEvent<HTMLAnchorElement>,
    target: FollowingWindow,
    movement: FollowingMovement,
  ) => void;
  onRefresh?: (() => void) | undefined;
  refreshDisabled: boolean;
  windowStatus: ReactNode;
  directory: ReactNode;
  windowNavigation: ReactNode;
  selection?: FollowingWorkspaceSelection | undefined;
}) {
  return (
    <article ref={articleRef} className="max-w-6xl space-y-6 text-foreground sm:space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <PageHeading ref={headingRef} tabIndex={-1}>
            {m.library_following_heading()}
          </PageHeading>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{m.following_reading_intro()}</p>
        </div>
        {onRefresh ? (
          <Button variant="outline" disabled={refreshDisabled} onClick={onRefresh}>
            {m.following_reading_refresh()}
          </Button>
        ) : null}
      </header>

      <nav aria-label={m.following_kind_label()} className="flex flex-wrap gap-2">
        {(['all', 'subject', 'collection', 'space', 'zone'] as const).map((value) => {
          const label =
            value === 'all'
              ? m.following_kind_all()
              : value === 'subject'
                ? m.following_kind_subject()
                : value === 'collection'
                  ? m.following_kind_collection()
                  : value === 'space'
                    ? m.following_kind_space()
                    : m.following_kind_zone();
          const variant = kind === value ? 'default' : 'outline';
          return kindChangeDisabled ? (
            <Button
              key={value}
              variant={variant}
             
              disabled
              aria-current={kind === value ? 'page' : undefined}
            >
              {label}
            </Button>
          ) : (
            <Link
              key={value}
              to="/library/following"
              search={value === 'all' ? {} : { kind: value }}
              aria-current={kind === value ? 'page' : undefined}
              className={buttonVariants({ variant })}
              onClick={(event) => onMove?.(event, { cursor: null, kind: value }, 'kind')}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {windowStatus}

      {selection ? (
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 xl:hidden">
          <p className="min-w-0 text-sm leading-snug wrap-anywhere">
            <span className="mr-2 font-medium text-muted-foreground">{m.following_reading_inspection()}</span>
            <span className="font-semibold" {...(selection.titleLang ? { lang: selection.titleLang } : {})}>
              {selection.title}
            </span>
          </p>
          <Button className="shrink-0" variant="ghost" onClick={selection.close}>
            {m.following_reading_close()}
          </Button>
        </div>
      ) : null}

      <div
        className={
          selection
            ? 'grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-8'
            : 'max-w-4xl'
        }
      >
        <div className="min-w-0 space-y-6">
          {directory}
          {windowNavigation}
        </div>
        {selection ? (
          <aside className="min-w-0 xl:sticky xl:top-4">{selection.inspection}</aside>
        ) : null}
      </div>
    </article>
  );
}
