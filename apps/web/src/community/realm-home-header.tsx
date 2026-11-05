import { useId, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import type { RealmHome } from './space';
import {
  CommunityAvatar,
  CommunityBanner,
  CommunityMemberCount,
  CommunityRules,
  ImageCredit,
} from './community-presentation-parts';

/** One community identity, with compact routed-Space context when it differs. */
export function RealmHomeHeader({
  realm,
  participation,
  space,
}: {
  realm: RealmHome;
  participation?: ReactNode;
  space?: { title: string; summary: string };
}) {
  const presentationId = useId();
  const headingId = `${presentationId}-realm-heading`;
  const rulesHeadingId = `${presentationId}-rules-heading`;
  if (realm.presentation?.state === 'hidden') return null;
  const community = realm.presentation?.state === 'available' ? realm.presentation.value : null;
  const avatar = community?.avatar.state === 'available' ? community.avatar.value : null;
  const banner = community?.banner.state === 'available' ? community.banner.value : null;
  const name = community?.name ?? realm.title;
  const description = community ? community.description : realm.summary;
  const distinctSpace = space && space.title !== name;
  return (
    <section
      className="min-w-0 overflow-hidden rounded-3xl bg-card text-start text-card-foreground [overflow-wrap:anywhere]"
      aria-labelledby={headingId}
      data-slot="realm-home-presentation"
    >
      {distinctSpace ? (
        <header className="min-w-0 space-y-1 border-b border-border px-4 py-3 text-sm sm:px-6">
          <h1 className="font-medium">{space.title}</h1>
          <p className="text-muted-foreground">{m.community_space_context({ realm: m.space_realm_heading() })}</p>
          {space.summary && space.summary !== description ? (
            <p className="max-w-3xl whitespace-pre-wrap text-muted-foreground">{space.summary}</p>
          ) : null}
        </header>
      ) : null}
      <CommunityBanner banner={banner} realmId={realm.id} />
      <div className="min-w-0 space-y-4 px-4 pb-5 sm:px-6 sm:pb-6">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <CommunityAvatar avatar={avatar} name={name} realmId={realm.id} />
          <div className="min-w-0 max-w-full pt-3 [&>*]:min-w-0 [&>*]:max-w-full [&_a]:h-auto [&_a]:min-h-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_button]:h-auto [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal">
            {participation}
          </div>
        </div>
        {distinctSpace ? (
          <h2 id={headingId} className="text-3xl leading-tight font-semibold sm:text-4xl">
            <Link
              to="/realms/$id"
              params={{ id: realm.id }}
              className="inline-block min-h-11 min-w-11 max-w-full rounded-md py-1 align-top hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {name}
            </Link>
          </h2>
        ) : (
          <h1 id={headingId} className="text-3xl leading-tight font-semibold sm:text-4xl">
            {name}
          </h1>
        )}
        {description ? (
          <p className="max-w-3xl leading-relaxed whitespace-pre-wrap text-muted-foreground">{description}</p>
        ) : null}
        <CommunityMemberCount members={community?.members} />
        {!community ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.board_community_source_unavailable()}
          </p>
        ) : null}
        {community ? (
          <dl className="flex min-w-0 flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground [&>div]:min-w-0 [&>div]:max-w-full">
            {(['avatar', 'banner'] as const).map((slot) =>
              community[slot].state !== 'available' ? (
                <div key={slot}>
                  <dt className="font-medium">
                    {slot === 'avatar' ? m.realm_appearance_icon() : m.realm_appearance_banner()}
                  </dt>
                  <dd>
                    {community[slot].state === 'none'
                      ? m.realm_appearance_no_image()
                      : m.realm_appearance_image_unavailable()}
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        ) : null}
        <section className="min-w-0 space-y-3 border-t border-border pt-4" aria-labelledby={rulesHeadingId}>
          <h3 id={rulesHeadingId} className="font-semibold">
            {m.board_community_rules()}
          </h3>
          <CommunityRules rules={community?.rules} />
        </section>
        {avatar ? <ImageCredit image={avatar} /> : null}
        {banner ? <ImageCredit image={banner} /> : null}
      </div>
    </section>
  );
}
