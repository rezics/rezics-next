import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import { MediaImage } from '@rezics/ui/media-image';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { coverSrc } from '../media/cover-src';
import { initials } from '../threads/initials';
import type { CommunityPresentation, RealmPresentationImage } from '../threads/board-community-source';

/** Shared native presentation parts; no feed, personal session or source reader is mounted here. */
export function CommunityBanner({ banner }: { banner: RealmPresentationImage | null }) {
  return banner ? (
    <MediaImage
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
    />
  ) : (
    <div aria-hidden="true" data-slot="board-banner-fallback" className="aura-surface h-24 sm:h-36" />
  );
}

export function CommunityAvatar({ avatar, name }: { avatar: RealmPresentationImage | null; name: string }) {
  const avatarVariant =
    avatar?.variants.find((variant) => variant.format === 'webp' && variant.width >= 96) ?? avatar?.variants[0];
  return (
    <Avatar className="-mt-9 size-20 border-4 border-card text-2xl sm:size-24">
      {avatar && avatarVariant ? (
        <AvatarImage
          src={coverSrc(avatar.id, avatarVariant.format, avatarVariant.width)}
          alt=""
          style={{ objectPosition: imagePosition(avatar) }}
        />
      ) : null}
      <AvatarFallback className="text-2xl sm:text-3xl">{initials(name)}</AvatarFallback>
    </Avatar>
  );
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

export function ImageCredit({ image }: { image: RealmPresentationImage }) {
  const credit = image.credit;
  if (!credit) return null;
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
