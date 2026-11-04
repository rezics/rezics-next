/** Closed private-profile GET envelope until generated route declarations include `editing`.
 * Transport remains `accounts({accountId}).profile.get`; this is not a second DTO. */
export const PROFILE_TEXT_MAX_LENGTH = 4096;
export const PROFILE_LINK_MAX_ITEMS = 5;
export const PROFILE_LINK_LABEL_MAX_LENGTH = 64;
export const PROFILE_LINK_URL_MAX_LENGTH = 2048;
export const PROFILE_PUBLIC_VIEW_FLAGS = ['posts', 'reviews', 'collections', 'realms'] as const;

export type AccountProfileTextAdvice = { applicable: true; maxLength: typeof PROFILE_TEXT_MAX_LENGTH };
export type AccountProfileAvatarAdvice = { applicable: true };
export type AccountProfileLinksAdvice = {
  applicable: true;
  maxItems: typeof PROFILE_LINK_MAX_ITEMS;
  labelMaxLength: typeof PROFILE_LINK_LABEL_MAX_LENGTH;
  urlMaxLength: typeof PROFILE_LINK_URL_MAX_LENGTH;
};
export type AccountProfilePublicViewsAdvice = {
  applicable: true;
  flags: typeof PROFILE_PUBLIC_VIEW_FLAGS;
};
export type AccountProfileSpeakersAdvice = { applicable: true };

type IdentityFields = {
  displayName: AccountProfileTextAdvice;
  biography: AccountProfileTextAdvice;
  avatar: AccountProfileAvatarAdvice;
  links: AccountProfileLinksAdvice;
  publicViews: AccountProfilePublicViewsAdvice;
};

export type AccountProfileEditing =
  | {
      viewer: { accountId: string };
      target: { accountId: string; kind: 'actor' };
      fields: IdentityFields;
    }
  | {
      viewer: { accountId: string };
      target: { accountId: string; kind: 'organization' };
      fields: IdentityFields & { speakersListed: AccountProfileSpeakersAdvice };
    };

const textAdvice: AccountProfileTextAdvice = { applicable: true, maxLength: PROFILE_TEXT_MAX_LENGTH };
const avatarAdvice: AccountProfileAvatarAdvice = { applicable: true };
const linksAdvice: AccountProfileLinksAdvice = {
  applicable: true,
  maxItems: PROFILE_LINK_MAX_ITEMS,
  labelMaxLength: PROFILE_LINK_LABEL_MAX_LENGTH,
  urlMaxLength: PROFILE_LINK_URL_MAX_LENGTH,
};
const publicViewsAdvice: AccountProfilePublicViewsAdvice = {
  applicable: true,
  flags: PROFILE_PUBLIC_VIEW_FLAGS,
};

export function accountProfileEditing(
  viewerAccountId: string,
  target: { id: string; kind: 'actor' | 'organization' },
): AccountProfileEditing {
  const fields: IdentityFields = {
    displayName: textAdvice,
    biography: textAdvice,
    avatar: avatarAdvice,
    links: linksAdvice,
    publicViews: publicViewsAdvice,
  };
  return target.kind === 'organization'
    ? {
        viewer: { accountId: viewerAccountId },
        target: { accountId: target.id, kind: 'organization' },
        fields: { ...fields, speakersListed: { applicable: true } },
      }
    : {
        viewer: { accountId: viewerAccountId },
        target: { accountId: target.id, kind: 'actor' },
        fields,
      };
}
