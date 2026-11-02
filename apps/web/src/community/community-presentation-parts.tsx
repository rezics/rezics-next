import { useCallback, useRef, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import { MediaImage } from '@rezics/ui/media-image';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { coverSrc } from '../media/cover-src';
import { initials } from '../threads/initials';
import type { CommunityPresentation, RealmPresentationImage } from '../threads/board-community-source';

/** Shared native presentation parts; no feed, personal session or source reader is mounted here. */
export function CommunityBanner({
  banner,
  realmId,
}: {
  banner: RealmPresentationImage | null;
  realmId: string | null;
}) {
  return banner ? (
    <CommunityBannerImage key={imageAttemptIdentity('banner', realmId, banner)} banner={banner} />
  ) : (
    <div
      aria-hidden="true"
      data-slot="board-banner-fallback"
      data-image-load-state="absent"
      className="aura-surface h-24 sm:h-36"
    />
  );
}

function CommunityBannerImage({ banner }: { banner: RealmPresentationImage }) {
  const recovery = useCommunityImageRetry();
  const hasDerivative = banner.variants.length > 0;
  const retrying = recovery.attempt > 0 && recovery.state === 'loading';
  return (
    <div
      data-slot="community-banner-image"
      data-image-load-state={hasDerivative ? recovery.state : 'unavailable'}
      className="relative"
    >
      <MediaImage
        key={recovery.attempt}
        media={banner.id}
        width={banner.width}
        height={banner.height}
        variants={banner.variants}
        placeholder={banner.placeholder}
        src={({ media, format, width }) => coverSrc(media, format, width)}
        alt=""
        sizes="(min-width: 1280px) 1152px, 100vw"
        frame={6}
        priority
        className="h-24 rounded-none sm:h-36 [&_img]:[object-position:inherit]"
        style={{ objectPosition: imagePosition(banner) }}
        onImageLoad={recovery.loaded}
        onImageError={recovery.failed}
      />
      {hasDerivative && (recovery.state === 'failed' || retrying) ? (
        <RetryImageButton
          className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-md bg-background/90 px-3 py-2 text-xs font-medium text-foreground shadow-sm ring-1 ring-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          waiting={retrying}
          onRetry={recovery.retry}
        />
      ) : null}
    </div>
  );
}

export function CommunityAvatar({
  avatar,
  name,
  realmId,
}: {
  avatar: RealmPresentationImage | null;
  name: string;
  realmId: string | null;
}) {
  const avatarVariant =
    avatar?.variants.find((variant) => variant.format === 'webp' && variant.width >= 96) ?? avatar?.variants[0];
  return (
    <CommunityAvatarImage
      key={imageAttemptIdentity('avatar', realmId, avatar)}
      avatar={avatar}
      avatarVariant={avatarVariant}
      name={name}
    />
  );
}

function CommunityAvatarImage({
  avatar,
  avatarVariant,
  name,
}: {
  avatar: RealmPresentationImage | null;
  avatarVariant: RealmPresentationImage['variants'][number] | undefined;
  name: string;
}) {
  const recovery = useCommunityImageRetry();
  const retrying = recovery.attempt > 0 && recovery.state === 'loading';
  const imageState = !avatar ? 'absent' : !avatarVariant ? 'unavailable' : recovery.state;
  return (
    <Avatar className="-mt-9 size-20 border-4 border-card text-2xl sm:size-24" data-image-load-state={imageState}>
      {avatar && avatarVariant ? (
        <AvatarImage
          key={recovery.attempt}
          src={coverSrc(avatar.id, avatarVariant.format, avatarVariant.width)}
          alt=""
          style={{ objectPosition: imagePosition(avatar) }}
          onLoad={(event) => (event.currentTarget.naturalWidth > 0 ? recovery.loaded() : recovery.failed())}
          onError={recovery.failed}
        />
      ) : null}
      <AvatarFallback className="text-2xl sm:text-3xl">{initials(name)}</AvatarFallback>
      {avatarVariant && (recovery.state === 'failed' || retrying) ? (
        <RetryImageButton
          className="absolute inset-0 z-10 grid place-items-center rounded-full bg-background/90 px-2 text-center text-xs font-medium text-foreground shadow-sm ring-1 ring-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          waiting={retrying}
          onRetry={recovery.retry}
        />
      ) : null}
    </Avatar>
  );
}

function RetryImageButton({
  className,
  waiting,
  onRetry,
}: {
  className: string;
  waiting: boolean;
  onRetry: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="community-image-retry"
      aria-label={m.realm_appearance_retry_image()}
      aria-disabled={waiting}
      tabIndex={0}
      className={className}
      onClick={onRetry}
    >
      {m.realm_appearance_retry_image()}
    </button>
  );
}

function useCommunityImageRetry() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'failed' | 'loaded'>('loading');
  const currentAttempt = useRef(0);
  const failed = useCallback(() => {
    if (currentAttempt.current === attempt) setState('failed');
  }, [attempt]);
  const loaded = useCallback(() => {
    if (currentAttempt.current === attempt) setState('loaded');
  }, [attempt]);
  const retry = useCallback(() => {
    if (state !== 'failed' || currentAttempt.current !== attempt) return;
    const next = attempt + 1;
    currentAttempt.current = next;
    setState('loading');
    setAttempt(next);
  }, [attempt, state]);
  return { attempt, state, failed, loaded, retry };
}

// A retry remains in the original frame and remounts only the admitted derivative.
function imageAttemptIdentity(slot: 'avatar' | 'banner', realmId: string | null, image: RealmPresentationImage | null) {
  return JSON.stringify([
    realmId,
    slot,
    image?.id ?? null,
    image?.digest ?? null,
    image?.width ?? null,
    image?.height ?? null,
    image?.placeholder ?? null,
    image?.focalPoint ?? null,
    image?.variants.map(({ format, width, height }) => [format, width, height]) ?? null,
  ]);
}

export function CommunityMemberCount({ members }: { members?: CommunityPresentation['members'] | undefined }) {
  return (
    <p className="text-sm text-muted-foreground" data-slot="community-members">
      {members?.state === 'current'
        ? m.board_community_members({ count: members.count })
        : m.board_community_members_unknown()}
    </p>
  );
}

export function CommunityRules({ rules }: { rules?: CommunityPresentation['rules'] | undefined }) {
  return (
    <>
      {rules?.state === 'available' ? (
        <>
          <DocumentBody document={rules.value.body} locale={getLocale()} className="text-sm" />
          <a
            href={`/${getLocale()}/posts/${rules.value.postId}/revisions/${rules.value.revisionId}`}
            className="inline-flex min-h-11 items-center text-sm text-primary hover:underline"
          >
            {m.board_community_rules_revision()}
          </a>
          <p className="text-xs text-muted-foreground">{rules.value.licence}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {rules?.state === 'none' ? m.board_community_rules_none() : m.board_community_rules_unavailable()}
        </p>
      )}
    </>
  );
}

function imagePosition(image: RealmPresentationImage): string | undefined {
  return image.focalPoint ? `${image.focalPoint.x * 100}% ${image.focalPoint.y * 100}%` : undefined;
}

export function ImageCredit({ image, loaded = true }: { image: RealmPresentationImage; loaded?: boolean }) {
  const credit = image.credit;
  if (!loaded || !credit) return null;
  return (
    <p className="text-xs text-muted-foreground">
      © {credit.rightsHolder} ·{' '}
      <a href={credit.via.url} rel="noopener noreferrer nofollow" className="underline">
        {credit.via.name}
      </a>{' '}
      · {credit.license}
    </p>
  );
}
