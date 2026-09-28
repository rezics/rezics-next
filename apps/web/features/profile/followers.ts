import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { ProfileMessages } from './messages.ts';
import type { FollowerCount } from './types.ts';

// Plain module: the follow control (client) and the owner's header (server) both label the count.

/** The strings the control and its count draw; the profile's and the author page's messages both carry them. */
export type FollowMessages = Pick<ProfileMessages, 'follow' | 'following' | 'unfollowName' | 'signInToFollow'
  | 'followFailed' | 'followers' | 'followersAtLeast'>;

/** "794 followers", or "1,000+ followers" when Main stopped counting. */
export function followerLabel(followers: FollowerCount, locale: UiLocale, messages: FollowMessages): string {
  const t = materializeData(messages, { locale });
  return followers.kind === 'lower-bound'
    ? t.followersAtLeast({ count: new Intl.NumberFormat(locale).format(followers.value) })
    : t.followers(followers.value);
}
