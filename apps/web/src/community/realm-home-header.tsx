import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import type { RealmHome } from './space';
import { CommunityAvatar, CommunityBanner, CommunityMemberCount, CommunityRules, ImageCredit } from './community-presentation-parts';

/** The carried community remains visibly separate from its Space's routed identity. */
export function RealmHomeHeader({ realm, participation }: { realm: RealmHome; participation?: ReactNode }) {
  if (realm.presentation?.state === 'hidden') return null;
  const community = realm.presentation?.state === 'available' ? realm.presentation.value : null;
  const avatar = community?.avatar.state === 'available' ? community.avatar.value : null;
  const banner = community?.banner.state === 'available' ? community.banner.value : null;
  const name = community?.name ?? realm.title;
  const description = community ? community.description : realm.summary;
  return (
    <section className="overflow-hidden rounded-3xl bg-card" aria-labelledby="space-realm-heading" data-slot="realm-home-presentation">
      <CommunityBanner banner={banner} />
      <div className="space-y-4 px-4 pb-5 sm:px-6 sm:pb-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <CommunityAvatar avatar={avatar} name={name} />
          <div className="max-w-full pt-3">{participation}</div>
        </div>
        <p className="text-sm font-medium text-muted-foreground">{m.space_realm_heading()}</p>
        <h2 id="space-realm-heading" className="text-xl font-semibold sm:text-2xl">
          <Link to="/realms/$id" params={{ id: realm.id }} className="break-words hover:underline">{name}</Link>
        </h2>
        {description ? <p className="max-w-3xl whitespace-pre-wrap text-muted-foreground">{description}</p> : null}
        <CommunityMemberCount members={community?.members} />
        {!community ? <p role="status" className="text-sm text-muted-foreground">{m.board_community_source_unavailable()}</p> : null}
        {community ? <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          {(['avatar', 'banner'] as const).map((slot) => community[slot].state !== 'available' ? (
            <div key={slot}>
              <dt className="font-medium">{slot === 'avatar' ? m.realm_appearance_icon() : m.realm_appearance_banner()}</dt>
              <dd>{community[slot].state === 'none' ? m.realm_appearance_no_image() : m.realm_appearance_image_unavailable()}</dd>
            </div>
          ) : null)}
        </dl> : null}
        <section className="space-y-3 border-t border-border pt-4" aria-labelledby="realm-home-rules-heading">
          <h3 id="realm-home-rules-heading" className="font-semibold">{m.board_community_rules()}</h3>
          <CommunityRules rules={community?.rules} />
        </section>
        {avatar ? <ImageCredit image={avatar} /> : null}
        {banner ? <ImageCredit image={banner} /> : null}
      </div>
    </section>
  );
}
