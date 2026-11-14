import { useId } from 'react';
import { Link } from '@tanstack/react-router';
import { MediaImage } from '@rezics/ui/media-image';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { initials } from '../../threads/initials';
import type {
  MyRealmsCurrentActionName,
  MyRealmsCurrentAdvice,
  MyRealmsCurrentController,
  MyRealmsCurrentRow,
} from './contract';

function AdviceStatus({ action, advice }: { action: MyRealmsCurrentActionName; advice: MyRealmsCurrentAdvice }) {
  if (advice.state === 'available') return null;
  const label = action === 'enter' ? m.my_realms_open() : action === 'manage' ? m.my_realms_manage() : m.realm_leave();
  return (
    <p className="text-sm text-muted-foreground" data-action-state={advice.state}>
      {advice.state === 'prohibited'
        ? m.my_realms_action_prohibited({ action: label })
        : advice.reason === 'last_explicit_holder'
          ? m.realm_leave_owner_required()
          : m.my_realms_action_unavailable({ action: label })}
    </p>
  );
}

function ImageState({ slot, state }: { slot: 'avatar' | 'banner'; state: string }) {
  if (state === 'available') return null;
  return (
    <div className="min-w-0" data-media-state={state}>
      <dt className="inline font-medium">
        {slot === 'avatar' ? m.realm_appearance_icon() : m.realm_appearance_banner()}:{' '}
      </dt>
      <dd className="inline">
        {state === 'none' ? m.realm_appearance_no_image() : m.realm_appearance_image_unavailable()}
      </dd>
    </div>
  );
}

function Avatar({ row }: { row: MyRealmsCurrentRow }) {
  const avatar = row.current.avatar;
  return avatar.state === 'available' ? (
    <MediaImage
      media={avatar.value.id}
      width={avatar.value.width}
      height={avatar.value.height}
      placeholder={avatar.value.placeholder}
      variants={avatar.value.variants}
      src={({ media, format, width }) => coverSrc(media, format, width)}
      alt=""
      sizes="4rem"
      frame={1}
      className="size-14 shrink-0 overflow-hidden rounded-full sm:size-16"
    />
  ) : (
    <span
      aria-hidden="true"
      className="grid size-14 shrink-0 place-items-center rounded-full bg-muted text-lg font-semibold text-muted-foreground sm:size-16"
    >
      {initials(row.name)}
    </span>
  );
}

const entryClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-lg px-4 py-2 text-sm font-medium whitespace-normal underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Current identity and each independent action come from the admitted inventory page. */
export function MyRealmsCurrentRowView({
  row,
  controller,
  onLeaveSelect,
}: {
  row: MyRealmsCurrentRow;
  controller?: MyRealmsCurrentController | undefined;
  onLeaveSelect?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  const headingId = useId();
  const actions = row.current.actions;
  const banner = row.current.banner;
  const selected = controller?.review?.row.realmId === row.realmId;
  return (
    <article
      aria-labelledby={headingId}
      className="min-w-0 py-6 [overflow-wrap:anywhere] sm:py-8"
      data-slot="my-realms-item"
      data-selected-leave={selected || undefined}
    >
      {banner.state === 'available' ? (
        <MediaImage
          media={banner.value.id}
          width={banner.value.width}
          height={banner.value.height}
          placeholder={banner.value.placeholder}
          variants={banner.value.variants}
          src={({ media, format, width }) => coverSrc(media, format, width)}
          alt=""
          sizes="(min-width: 768px) 48rem, 100vw"
          frame={6}
          className="mb-5 max-h-28 overflow-hidden rounded-xl"
        />
      ) : null}
      <div className="flex min-w-0 items-start gap-4">
        <Avatar row={row} />
        <div className="min-w-0 flex-1 space-y-4">
          <header className="min-w-0 space-y-2">
            <h2 id={headingId} className="text-xl leading-snug font-semibold sm:text-2xl">
              {row.name}
            </h2>
            <p className="max-w-prose text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {row.current.description}
            </p>
          </header>
          <div className="space-y-3">
            <nav
              aria-label={row.name}
              className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center"
            >
              {actions.enter.state === 'available' ? (
                <Link
                  to="/realms/$id"
                  params={{ id: row.realmId }}
                  className={`${entryClass} bg-primary text-primary-foreground hover:bg-primary/90`}
                >
                  {m.my_realms_open()}
                </Link>
              ) : null}
              {actions.manage.state === 'available' ? (
                <Link
                  to="/realms/$id/members"
                  params={{ id: row.realmId }}
                  className={`${entryClass} border border-border text-primary hover:bg-muted`}
                >
                  {m.my_realms_manage()}
                </Link>
              ) : null}
            </nav>
            <div className="space-y-1">
              <AdviceStatus action="enter" advice={actions.enter} />
              <AdviceStatus action="manage" advice={actions.manage} />
            </div>
          </div>
          <dl className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <ImageState slot="avatar" state={row.current.avatar.state} />
            <ImageState slot="banner" state={banner.state} />
          </dl>
        </div>
      </div>
      <footer className="mt-5 flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm sm:ms-20">
        {actions.leave.state === 'available' && controller?.ready ? (
          <Button
            type="button"
            variant="ghost"
            aria-pressed={selected}
            className="h-auto min-h-11 max-w-full whitespace-normal text-muted-foreground"
            onClick={(event) => {
              onLeaveSelect?.(event.currentTarget);
              controller.select(row);
            }}
          >
            {m.realm_leave()}
          </Button>
        ) : actions.leave.state === 'available' ? (
          <p className="text-sm text-muted-foreground">{m.my_realms_read_only()}</p>
        ) : (
          <AdviceStatus action="leave" advice={actions.leave} />
        )}
      </footer>
    </article>
  );
}
