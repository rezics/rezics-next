import { memoizedValue } from '../memoized.ts';
import { tryAccessApplication } from './adapters/bind.ts';
import type { AvatarSummary } from './contract/index.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { prepareReadDecisions, type Access, type AccessContext, type AccountActor } from './check.ts';
import { routeOf } from '../route/route.ts';
import { type AccountLink, type AccountPublicViews } from './account-data.ts';
import { viewerActionReadTime } from './read-bindings.ts';
import { deadlineClient, within } from './deadline.ts';
import { requireAccessDeadline } from './unavailable.ts';
import {
  accessCheckout,
  accessNativeDeclaration,
  accessNativeWork,
  accessOwnerWork,
  accessTransaction,
  addAccessWork,
  EMPTY_ACCESS_WORK,
  type AccessWork,
} from './work.ts';
import profileRead from './account-edit-profile-read.sql';

export const PROFILE_TEXT_MAX_LENGTH = 4096;
export const PROFILE_LINK_MAX_ITEMS = 5;
export const PROFILE_LINK_LABEL_MAX_LENGTH = 64;
export const PROFILE_LINK_URL_MAX_LENGTH = 2048;
export const PROFILE_PUBLIC_VIEW_FLAGS = ['posts', 'reviews', 'collections', 'realms'] as const;

export type EditableAccountProfile = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  links: AccountLink[];
  avatar: AvatarSummary | null;
  publicViews: AccountPublicViews;
  speakersListed?: boolean;
};

type TextAdvice = { applicable: true; maxLength: typeof PROFILE_TEXT_MAX_LENGTH };
type AvatarAdvice = { applicable: true };
type LinksAdvice = {
  applicable: true;
  maxItems: typeof PROFILE_LINK_MAX_ITEMS;
  labelMaxLength: typeof PROFILE_LINK_LABEL_MAX_LENGTH;
  urlMaxLength: typeof PROFILE_LINK_URL_MAX_LENGTH;
};
type PublicViewsAdvice = { applicable: true; flags: typeof PROFILE_PUBLIC_VIEW_FLAGS };
type SpeakersAdvice = { applicable: true };

const textAdvice: TextAdvice = { applicable: true, maxLength: PROFILE_TEXT_MAX_LENGTH };
const avatarAdvice: AvatarAdvice = { applicable: true };
const linksAdvice: LinksAdvice = {
  applicable: true,
  maxItems: PROFILE_LINK_MAX_ITEMS,
  labelMaxLength: PROFILE_LINK_LABEL_MAX_LENGTH,
  urlMaxLength: PROFILE_LINK_URL_MAX_LENGTH,
};
const publicViewsAdvice: PublicViewsAdvice = { applicable: true, flags: PROFILE_PUBLIC_VIEW_FLAGS };
const speakersAdvice: SpeakersAdvice = { applicable: true };

type ActorEditing = {
  viewer: { accountId: string };
  target: { accountId: string; kind: 'actor' };
  fields: {
    displayName: TextAdvice;
    biography: TextAdvice;
    avatar: AvatarAdvice;
    links: LinksAdvice;
    publicViews: PublicViewsAdvice;
  };
};
type OrganizationEditing = {
  viewer: { accountId: string };
  target: { accountId: string; kind: 'organization' };
  fields: {
    displayName: TextAdvice;
    biography: TextAdvice;
    avatar: AvatarAdvice;
    links: LinksAdvice;
    publicViews: PublicViewsAdvice;
    speakersListed: SpeakersAdvice;
  };
};
export type AccountProfileEditing = ActorEditing | OrganizationEditing;
export type EditableAccountProfileRead = { profile: EditableAccountProfile; editing: AccountProfileEditing };

/** Closed field advice from this read's prepared update authority, account kind and command limits.
 * The handle is immutable here. Advice is an observation, never a durable grant.
 */
export function accountProfileEditing(
  viewerAccountId: string,
  target: { id: string; kind: 'actor' | 'organization' },
): AccountProfileEditing {
  const identity = {
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
        fields: { ...identity, speakersListed: speakersAdvice },
      }
    : {
        viewer: { accountId: viewerAccountId },
        target: { accountId: target.id, kind: 'actor' },
        fields: identity,
      };
}

function checkoutBound(): AccessWork {
  return memoizedValue(checkoutBound, () => ({ ...EMPTY_ACCESS_WORK, points: 1 }));
}
function beginBound() {
  return memoizedValue(
    beginBound,
    () =>
      accessNativeDeclaration('transaction', { statement: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' }, {})
        .bound,
  );
}
function commitBound() {
  return memoizedValue(commitBound, () => accessNativeDeclaration('transaction', { statement: 'COMMIT' }, {}).bound);
}
function rollbackBound() {
  return memoizedValue(
    rollbackBound,
    () => accessNativeDeclaration('transaction', { statement: 'ROLLBACK' }, {}).bound,
  );
}
function profileBound() {
  return memoizedValue(profileBound, () => accessNativeDeclaration('account-profile', {}, {}).bound);
}
const avatarBound: AccessWork = {
  keys: 1,
  points: 1,
  witnesses: 0,
  rows: 1,
  bytes: Buffer.byteLength(
    JSON.stringify({
      media: 'x'.repeat(36),
      width: 2147483647,
      height: 2147483647,
      placeholder: { thumbhash: 'x'.repeat(64), color: '#ffffff' },
      variants: Array.from({ length: 12 }, () => ({ format: 'webp', width: 2147483647 })),
      focalPoint: { x: 1, y: 1 },
      credit: null,
    }),
  ),
  emptySeeks: 1,
};
function serializationBound(): AccessWork {
  return memoizedValue(serializationBound, () => ({
    ...EMPTY_ACCESS_WORK,
    bytes:
      profileBound().bytes +
      avatarBound.bytes +
      Buffer.byteLength(
        JSON.stringify(accountProfileEditing('x'.repeat(36), { id: 'x'.repeat(36), kind: 'organization' })),
      ),
  }));
}
function profileReadBound() {
  return memoizedValue(profileReadBound, () =>
    addAccessWork(
      checkoutBound(),
      beginBound(),
      commitBound(),
      rollbackBound(),
      profileBound(),
      avatarBound,
      serializationBound(),
    ),
  );
}

/** Closed owner envelope for this private GET: checkout, controls, statement, avatar, serialization. */
export function accountEditProfileReadWork(): AccessWork {
  return profileReadBound();
}

/** Private source fields, addressed by immutable account ID, under updateAccount's authority.
 * Preparation and a foreign operator check release their connections before the subject snapshot.
 * This is a read: it neither creates a command attempt nor spends a write operation.
 */
export async function readEditableAccountProfile(
  access: Access,
  context: AccessContext & { actor: AccountActor },
  accountId: string,
): Promise<EditableAccountProfileRead> {
  const { pool, actor, deadline, work } = context;
  const route = routeOf(accountId);
  if (route === null || actor.kind !== 'account') throw new ProblemError('forbidden');
  return within(deadline, async () => {
    const actions = new Set(['account:read', 'account:update', 'account:manage']);
    const decisions = await prepareReadDecisions(access, {
      actor,
      actions,
      typeActions: new Map([['access.account', actions]]),
      context,
    });
    if (!decisions.prepareAccountAuthority) throw new ProblemError('dependency_unavailable');
    const authority = await decisions.prepareAccountAuthority([accountId]);
    const time = viewerActionReadTime(access, context);
    return accessOwnerWork(
      work,
      'access.account-edit-profile',
      {
        bound: () => profileReadBound(),
        actual: () => profileReadBound(),
      },
      undefined,
      () =>
        accessCheckout(work, () =>
          withConnection(pool, async (connection) => {
            const client = deadlineClient(connection, deadline);
            await accessTransaction(work, client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            try {
              const answer = await authority.decide(
                client,
                { kind: 'profile', action: 'account:update', ids: [accountId] },
                time,
              );
              if (!answer[accountId]?.allowed) throw new ProblemError('forbidden');
              const row = await accessNativeWork(work, 'account-profile', { route, account_id: accountId }, {}, () =>
                profileRead.run(client, { route, account_id: accountId }),
              );
              if (!row) throw new ProblemError('forbidden');
              const views = row.publicViews as Record<string, unknown> | null;
              // Missing or malformed storage never opts an account into public presentation.
              const publicViews = {
                posts: views?.posts === true,
                reviews: views?.reviews === true,
                collections: views?.collections === true,
                realms: views?.realms === true,
              };
              const avatarId = row.avatar;
              const avatar = avatarId
                ? await accessOwnerWork(
                    work,
                    'content.avatar-summaries',
                    {
                      bound: () => avatarBound,
                      actual: (_input, summary) => (summary ? avatarBound : { ...avatarBound, emptySeeks: 1 }),
                    },
                    { media: avatarId },
                    async () => {
                      const application = tryAccessApplication();
                      if (!application) throw new ProblemError('dependency_unavailable');
                      return (await application.readAvatarSummaries(client, [avatarId])).get(avatarId) ?? null;
                    },
                  )
                : null;
              const kind = row.kind === 'organization' ? 'organization' : 'actor';
              const profile: EditableAccountProfile = {
                id: row.id,
                kind,
                handle: row.handle,
                displayName: row.displayName,
                bio: row.bio,
                links: (row.links as AccountLink[]).map(({ label, url }) => ({ label, url })),
                avatar,
                publicViews,
                ...(kind === 'organization' ? { speakersListed: row.speakersListed } : {}),
              };
              const editing = accountProfileEditing(actor.accountId, { id: profile.id, kind });
              requireAccessDeadline(deadline);
              await accessTransaction(work, client, 'COMMIT');
              return { profile, editing };
            } catch (error) {
              try {
                await accessTransaction(work, client, 'ROLLBACK');
              } catch (rollbackError) {
                discardConnection(connection, rollbackError as Error);
              }
              throw error;
            }
          }),
        ),
    );
  });
}
