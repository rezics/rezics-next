import type { NativeRealmMember, NativeRealmMembersRead, RealmMembersReadInput } from './native';
import type { MemberPageRead, MemberSelectionRead, RealmMembersSource } from './source';

type NativeReader = (input: RealmMembersReadInput) => Promise<NativeRealmMembersRead>;

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const productionRead: NativeReader = async (input) =>
  (await import('./transport')).readRealmMembers({ data: input });
const productionAddMember: NonNullable<RealmMembersSource['addMember']> = async (intent) =>
  (await import('./commands')).addSelectedRealmMember(intent);

function pageFailure(read: Exclude<NativeRealmMembersRead, { kind: 'ready' }>): MemberPageRead {
  switch (read.kind) {
    case 'preparing':
      return { kind: 'preparing' };
    case 'denied':
    case 'concealed':
      return { kind: 'denied' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'expired':
    case 'failed':
      return { kind: 'failed' };
  }
}

function selectionFailure(read: Exclude<NativeRealmMembersRead, { kind: 'ready' }>): MemberSelectionRead {
  switch (read.kind) {
    case 'preparing':
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'denied':
      return { kind: 'denied' };
    case 'concealed':
      return { kind: 'concealed' };
    case 'expired':
      return { kind: 'changed' };
    case 'failed':
      return { kind: 'failed' };
  }
}

function selectedIdentity(member: NativeRealmMember) {
  if (!member.identity) return null;
  return {
    accountId: member.accountId,
    reference: member.identity.state === 'active' ? (member.identity.handle ?? member.accountId) : member.accountId,
    label: member.displayName,
  };
}

function availability(action: NativeRealmMember['actions']['addMember']): 'available' | 'unavailable' | 'unknown' {
  if (action.state === 'available') return 'available';
  if (action.state === 'uncertain') return 'unknown';
  return 'unavailable';
}

/** Binds the browser composition to the authenticated viewer and producer-owned page observations. */
export function nativeRealmMembersSource(
  viewerId: string | null | undefined,
  reader: NativeReader = productionRead,
  addMember: NonNullable<RealmMembersSource['addMember']> = productionAddMember,
): RealmMembersSource {
  let pageBound = 0;

  async function request(input: Omit<RealmMembersReadInput, 'viewerId'>): Promise<NativeRealmMembersRead> {
    if (typeof viewerId !== 'string' || !idPattern.test(viewerId)) return { kind: 'unavailable' };
    try {
      return await reader({ ...input, viewerId });
    } catch {
      return { kind: 'failed' };
    }
  }

  return {
    get pageBound() {
      return pageBound;
    },
    readPage: async (address) => {
      const read = await request({
        realmId: address.realmId,
        ...(address.cursor === null ? {} : { cursor: address.cursor }),
      });
      if (read.kind !== 'ready') return pageFailure(read);
      pageBound = read.page.pageBound;
      if (read.page.state === 'preparing') return { kind: 'preparing' };
      if (read.page.realmId !== address.realmId || read.page.viewer.accountId !== viewerId) return { kind: 'failed' };
      return {
        kind: 'ready',
        page: {
          realm: { id: read.page.realmId, label: read.page.realmLabel },
          authority: read.page.viewer.authority,
          rows: read.page.items.map((member) => {
            const identity = selectedIdentity(member);
            return identity
              ? {
                  kind: 'disclosed' as const,
                  identity,
                  membershipInterval: member.episode,
                  membership: 'current' as const,
                }
              : { kind: 'concealed' as const };
          }),
          next: read.page.next,
        },
      };
    },
    readSelected: async (address) => {
      const expectedBound = pageBound;
      const read = await request({ realmId: address.realmId, accountId: address.accountId });
      if (read.kind !== 'ready') return selectionFailure(read);
      if (expectedBound < 1 || read.page.pageBound !== expectedBound) return { kind: 'changed' };
      if (read.page.state === 'preparing') return { kind: 'unavailable' };
      if (read.page.realmId !== address.realmId || read.page.viewer.accountId !== viewerId) return { kind: 'failed' };
      const selected = read.page.selected;
      if (!selected || selected.accountId !== address.accountId) return { kind: 'changed' };
      const identity = selectedIdentity(selected);
      if (!identity) return { kind: 'concealed' };
      return {
        kind: 'ready',
        realmId: address.realmId,
        authority: read.page.viewer.authority,
        identity,
        membershipInterval: selected.membership === 'member' ? selected.episode : null,
        membershipEpisode: selected.episode,
        membership: selected.membership === 'member' ? 'current' : 'none',
        advice: {
          add: availability(selected.actions.addMember),
          ban: availability(selected.actions.ban),
          unban: availability(selected.actions.unban),
        },
      };
    },
    addMember,
  };
}
