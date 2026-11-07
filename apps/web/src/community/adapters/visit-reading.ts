import type { CommunityRealmReading } from '../contract/visit';
import type { PublicationPrepare } from '../realm-publication-preparation';
import type { PublicationSend } from '../publication-subject-picker';
import {
  changeRealmPublication,
  readRealmBoards,
  readRealmPublications,
  readRealmPublicationPreparation,
} from '../space-actions';
import { nativeRealmHomeShelves, type NativeRealmHomeOperations } from '../realm-home-native';

/** Bind installed BFF/native producers without changing operations, credentials, windows or acknowledgements. */
export function createCommunityReading(
  csrfToken: string | null,
  operations: NativeRealmHomeOperations | undefined,
  languages: string[],
) {
  const change: PublicationSend = (input) =>
    csrfToken
      ? changeRealmPublication({ data: input, headers: { 'X-CSRF-Token': csrfToken } })
      : Promise.resolve({ kind: 'denied' });
  const prepare: PublicationPrepare = (input) => readRealmPublicationPreparation({ data: input });
  return (realmId: string): CommunityRealmReading => {
    const shelves = operations ? nativeRealmHomeShelves(operations, { realmId, languages }) : null;
    return {
      requireReaderOrigin: !shelves,
      transport: {
        boards: shelves?.boards ?? ((input) => readRealmBoards({ data: { realmId, ...input } })),
        publications: shelves?.publications ?? ((input) => readRealmPublications({ data: { realmId, ...input } })),
        change,
        prepare,
      },
    };
  };
}
