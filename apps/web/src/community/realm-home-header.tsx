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

/** Supplied Realm identity and participation, separate from the carrying Space. */
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
  const RulesHeading = distinctSpace ? 'h3' : 'h2';
  const hasPresentationDetails = Boolean(
    community &&
      (community.avatar.state !== 'available' ||
        community.banner.state !== 'available' ||
        avatar?.credit ||
        banner?.credit),
  );
  const title = distinctSpace ? (
    <h2 id={headingId} className="min-w-0 max-w-full text-3xl leading-tight font-semibold sm:text-4xl">
      <Link
        to="/realms/$id"
        params={{ id: realm.id }}
        className="inline-block min-h-11 min-w-11 max-w-full rounded-md py-1 align-top underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {name}
      </Link>
    </h2>
  ) : (
    <h1 id={headingId} className="min-w-0 max-w-full text-3xl leading-tight font-semibold sm:text-4xl">
      {name}
    </h1>
  );

  return (
    <section
      className="min-w-0 space-y-5 text-start text-card-foreground [overflow-wrap:anywhere]"
      aria-labelledby={headingId}
      data-slot="realm-home-presentation"
    >
      {distinctSpace ? (
        <aside className="min-w-0 space-y-1 rounded-xl border border-border bg-muted/30 px-4 py-3 sm:px-5">
          <h1 className="min-w-0 max-w-full text-base leading-snug font-semibold">{space.title}</h1>
          <p className="text-xs text-muted-foreground">
            {m.community_space_context({ realm: m.space_realm_heading() })}
          </p>
          {space.summary && space.summary !== description ? (
            <p className="max-w-prose pt-1 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {space.summary}
            </p>
          ) : null}
        </aside>
      ) : null}
      <div className="min-w-0 overflow-hidden rounded-2xl bg-card">
        <CommunityBanner banner={banner} realmId={realm.id} />
        <div className="grid min-w-0 items-start gap-5 px-4 pb-5 sm:px-6 sm:pb-6 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.7fr)] lg:gap-8">
          <div className="flex min-w-0 items-start gap-4">
            <CommunityAvatar avatar={avatar} name={name} realmId={realm.id} />
            <div className="min-w-0 space-y-3 pt-1">
              {title}
              {description ? (
                <p className="max-w-prose leading-relaxed whitespace-pre-wrap text-muted-foreground">{description}</p>
              ) : null}
              <CommunityMemberCount members={community?.members} />
              {!community ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {m.board_community_source_unavailable()}
                </p>
              ) : null}
            </div>
          </div>
          {participation ? (
            <aside
              data-slot="realm-home-participation"
              className="min-w-0 max-w-full rounded-xl border border-border bg-background/70 p-3 sm:p-4 [&>*]:min-w-0 [&>*]:max-w-full [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal"
            >
              {participation}
            </aside>
          ) : null}
        </div>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(15rem,0.75fr)]">
        <section
          className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5 [&_a]:h-auto [&_a]:min-h-11 [&_a]:max-w-full [&_a]:whitespace-normal"
          aria-labelledby={rulesHeadingId}
        >
          <RulesHeading id={rulesHeadingId} className="text-base font-semibold">
            {m.board_community_rules()}
          </RulesHeading>
          <CommunityRules rules={community?.rules} />
        </section>
        {community && hasPresentationDetails ? (
          <aside className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5 [&_a]:max-w-full [&_a]:whitespace-normal">
            <dl className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground [&>div]:min-w-0 [&>div]:max-w-full">
              {(['avatar', 'banner'] as const).map((slot) =>
                community[slot].state !== 'available' ? (
                  <div key={slot}>
                    <dt className="inline font-medium">
                      {slot === 'avatar' ? m.realm_appearance_icon() : m.realm_appearance_banner()}:{' '}
                    </dt>
                    <dd className="inline">
                      {community[slot].state === 'none'
                        ? m.realm_appearance_no_image()
                        : m.realm_appearance_image_unavailable()}
                    </dd>
                  </div>
                ) : null,
              )}
            </dl>
            {avatar ? <ImageCredit image={avatar} /> : null}
            {banner ? <ImageCredit image={banner} /> : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
