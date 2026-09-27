import { createHash } from 'node:crypto';
import type { ModCapture, ModRequest } from '../../../services/main/src/modules/package/mod-profile.ts';

// Response envelopes and relation enums follow the official CurseForge REST FileDependency
// and Steamworks published-file/Collection API documentation. These records are authored.
function observed(identity: string, surface: string, document: unknown): ModCapture {
  const bytes = Buffer.from(JSON.stringify(document));
  return { identity, surface, status: 'observed', bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

export const curseForgeRelations = [
  { modId: 20, relationType: 1 }, // EmbeddedLibrary
  { modId: 25, relationType: 2 }, // OptionalDependency
  { modId: 30, relationType: 3 }, // RequiredDependency
  { modId: 40, relationType: 4 }, // Tool
  { modId: 50, relationType: 5 }, // Incompatible
  { modId: 60, relationType: 6 }, // Include (bundled content)
] as const;

export const curseForgeAuthored: ModRequest = {
  profile: 'mod-native-capture-v2', ecosystem: 'curseforge', side: 'CLIENT', root: '101',
  captures: [
    observed('101', 'file', { data: { id: 101, modId: 10,
      dependencies: curseForgeRelations } }),
    observed('201', 'file', { data: { id: 201, modId: 20, dependencies: [] } }),
    observed('301', 'file', { data: { id: 301, modId: 30, dependencies: [] } }),
    observed('601', 'file', { data: { id: 601, modId: 60, dependencies: [] } }),
  ],
};

export const steamRequiredItemsAuthored: ModRequest = {
  profile: 'mod-native-capture-v1', ecosystem: 'steam', side: 'CLIENT', root: '987654321',
  captures: [observed('987654321', 'ugc-children', { response: {
    publishedfiledetails: [{ publishedfileid: '987654321', file_type: 0,
      num_children: 2, children: [
        { publishedfileid: '111111111', sortorder: 0 },
        { publishedfileid: '222222222', sortorder: 1 },
      ] }],
  } })],
};

export const steamCollectionAuthored: ModRequest = {
  profile: 'mod-native-capture-v1', ecosystem: 'steam', side: 'CLIENT', root: '888888888',
  captures: [observed('888888888', 'collection-details', { response: {
    result: 1, resultcount: 1, collectiondetails: [{ publishedfileid: '888888888',
      result: 1, children: [
        { publishedfileid: '333333333', sortorder: 0, filetype: 0 },
        { publishedfileid: '444444444', sortorder: 1, filetype: 0 },
      ] }],
  } })],
};
