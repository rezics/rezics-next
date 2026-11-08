import { Link } from '@tanstack/react-router';
import { MediaImage } from '@rezics/ui/media-image';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import type {
  MyRealmsCurrentActionName,
  MyRealmsCurrentAdvice,
  MyRealmsCurrentController,
  MyRealmsCurrentRow,
} from './contract';
import { MyRealmsLeaveReview } from './review';

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
  const label = slot === 'avatar' ? m.realm_appearance_icon() : m.realm_appearance_banner();
  return (
    <p className="text-xs text-muted-foreground" data-media-state={state}>
      {label}: {state === 'none' ? m.realm_appearance_no_image() : m.realm_appearance_image_unavailable()}
    </p>
  );
}

function Media({ row }: { row: MyRealmsCurrentRow }) {
  const { avatar, banner } = row.current;
  return (
    <div className="space-y-2">
      {banner.state === 'available' ? (
        <MediaImage
          media={banner.value.id}
          width={banner.value.width}
          height={banner.value.height}
          placeholder={banner.value.placeholder}
          variants={banner.value.variants}
          src={({ media, format, width }) => coverSrc(media, format, width)}
          alt=""
          sizes="(min-width: 768px) 42rem, 100vw"
          frame={6}
          className="max-h-36 overflow-hidden rounded-lg"
        />
      ) : (
        <ImageState slot="banner" state={banner.state} />
      )}
      <div className="flex items-center gap-3">
        {avatar.state === 'available' ? (
          <MediaImage
            media={avatar.value.id}
            width={avatar.value.width}
            height={avatar.value.height}
            placeholder={avatar.value.placeholder}
            variants={avatar.value.variants}
            src={({ media, format, width }) => coverSrc(media, format, width)}
            alt=""
            sizes="5rem"
            frame={1}
            className="size-16 overflow-hidden rounded-full"
          />
        ) : (
          <ImageState slot="avatar" state={avatar.state} />
        )}
      </div>
    </div>
  );
}

/** Render only the actions the installed page independently admitted. */
export function MyRealmsCurrentRowView({
  row,
  controller,
}: {
  row: MyRealmsCurrentRow;
  controller?: MyRealmsCurrentController | undefined;
}) {
  const actions = row.current.actions;
  const review = controller?.review?.row.realmId === row.realmId ? controller : undefined;
  return (
    <article
      className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere]"
      data-slot="my-realms-item"
    >
      <Media row={row} />
      <header className="space-y-2">
        <h2 className="text-xl font-semibold leading-snug">{row.name}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{row.current.description}</p>
      </header>
      <div className="space-y-2">
        <nav aria-label={row.name} className="flex flex-wrap gap-2">
          {actions.enter.state === 'available' ? (
            <Link
              to="/realms/$id"
              params={{ id: row.realmId }}
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.my_realms_open()}
            </Link>
          ) : null}
          {actions.manage.state === 'available' ? (
            <Link
              to="/realms/$id/members"
              params={{ id: row.realmId }}
              className="inline-flex min-h-11 items-center rounded-md border border-border px-4 py-2 text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.my_realms_manage()}
            </Link>
          ) : null}
          {actions.leave.state === 'available' && controller?.ready ? (
            <Button type="button" variant="outline" onClick={() => controller.select(row)}>
              {m.realm_leave()}
            </Button>
          ) : null}
        </nav>
        <AdviceStatus action="enter" advice={actions.enter} />
        <AdviceStatus action="manage" advice={actions.manage} />
        {actions.leave.state === 'available' && !controller?.ready ? (
          <p className="text-sm text-muted-foreground">{m.my_realms_read_only()}</p>
        ) : (
          <AdviceStatus action="leave" advice={actions.leave} />
        )}
      </div>
      {review ? <MyRealmsLeaveReview controller={review} /> : null}
    </article>
  );
}
