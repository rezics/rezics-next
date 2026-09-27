import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { ProfileMessages } from './messages.ts';
import { isNativeHandle } from './route.ts';
import type { AgentProfile } from './types.ts';

/**
 * A profile's title and description for search results and link previews.
 * The locale layout adds the canonical address and `hreflang` alternates from
 * the request path, which is always the current handle: other handles redirect
 * before the page renders.
 */
export function profileMetadata(profile: AgentProfile, credited: boolean, locale: UiLocale,
  messages: ProfileMessages): Metadata {
  const t = materializeData(messages, { locale });
  const name = profile.displayName;
  const title = isNativeHandle(profile.handle) ? name : t.profileTitle({ name, handle: profile.handle });
  const description = profile.bio?.text
    ?? (profile.kind === 'organization' ? t.organizationDescription({ name })
      : credited ? t.authorDescription({ name })
        : profile.library.statusShelvesVisible ? t.readerDescription({ name }) : t.profileDescription({ name }));
  return { title, description, openGraph: { type: 'profile', title, description,
    ...(isNativeHandle(profile.handle) ? {} : { username: profile.handle }) } };
}

/**
 * schema.org's ProfilePage for the profile, as JSON safe to place inside a
 * `<script>`: `<` is escaped so a name or bio can never close the element.
 */
export function profileJsonLd(profile: AgentProfile, followers: number | null): string {
  const entity = { '@type': profile.kind === 'person' ? 'Person' : 'Organization', name: profile.displayName,
    ...(isNativeHandle(profile.handle) ? {} : { alternateName: `@${profile.handle}` }), identifier: profile.id,
    ...(profile.bio ? { description: profile.bio.text } : {}),
    ...(followers === null ? {} : { interactionStatistic: { '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/FollowAction', userInteractionCount: followers } }) };
  return JSON.stringify({ '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: entity })
    .replaceAll('<', '\\u003c');
}
