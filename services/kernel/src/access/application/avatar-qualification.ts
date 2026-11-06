import {
  ACCESS_AVATAR_BATCH_LIMIT,
  type AccessApplicationPorts,
  type AvatarSummary,
  type QualifyAvatarInput,
} from '../contract/index.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createAvatarQualification(ports: Pick<AccessApplicationPorts, 'avatar'>) {
  return {
    async qualifyAvatar(input: QualifyAvatarInput): Promise<boolean> {
      if (typeof input.mediaId !== 'string' || !uuid.test(input.mediaId)) return false;
      if (typeof input.accountId !== 'string' || !uuid.test(input.accountId)) return false;
      return ports.avatar.checkAvatarMedia(input.client, input.mediaId, input.accountId);
    },
    async readAvatarSummaries(
      client: QualifyAvatarInput['client'],
      ids: readonly string[],
    ): Promise<ReadonlyMap<string, AvatarSummary | null>> {
      if (ids.length < 1 || ids.length > ACCESS_AVATAR_BATCH_LIMIT) {
        throw new RangeError('Avatar batches must contain 1 to 256 ids');
      }
      return ports.avatar.readAvatarSummaries(client, ids);
    },
  };
}
