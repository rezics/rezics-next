import type { Pool, PoolClient } from 'pg';
import { readRealmVotes } from '../../community/content-capabilities.ts';
import type {
  ContentAmbient,
  ContentApplicationPorts,
  ContentAuthoredFieldPort,
  ContentDocumentPort,
  ContentPool,
  ContentQueryClient,
  ContentRankingPort,
} from '../contract/index.ts';
import { readAuthoredField, readAuthoredFieldBounded } from '../authored-fields.ts';
import { readImportedField, readImportedFieldBounded } from '../imported-fields.ts';
import { refreshBoardRankBatch } from '../board-rank.ts';
import { createNativeContentAmbient } from './ambient.ts';

function asPool(pool: ContentPool): Pool {
  return pool as Pool;
}

function asClient(client: ContentQueryClient): PoolClient {
  return client as PoolClient;
}

function nativeDocuments(): ContentDocumentPort {
  return {
    async read(client, route, id, maxSourceBytes) {
      const imported =
        maxSourceBytes === undefined
          ? await readImportedField(asClient(client), route, id)
          : await readImportedFieldBounded(asClient(client), route, id, maxSourceBytes);
      if (imported) {
        return {
          availability: imported.availability,
          origin: 'import',
          subject: imported.subject,
          candidate: imported.candidate,
        };
      }
      const authored =
        maxSourceBytes === undefined
          ? await readAuthoredField(asClient(client), route, id)
          : await readAuthoredFieldBounded(asClient(client), route, id, maxSourceBytes);
      return authored
        ? {
            availability: authored.availability,
            origin: 'account',
            subject: authored.subject,
            candidate: authored.candidate,
          }
        : null;
    },
  };
}

function nativeAuthoredFields(ambient: ContentAmbient): ContentAuthoredFieldPort {
  return {
    async erase(_id, deadline) {
      if (!Number.isFinite(deadline) || ambient.now() >= deadline) return null;
      return null;
    },
  };
}

function nativeRanking(): ContentRankingPort {
  return {
    async refreshBatch(pool, at, partitions) {
      return refreshBoardRankBatch(asPool(pool), at, partitions);
    },
    async readRealmVotes(client, realmIds) {
      return readRealmVotes(asClient(client), realmIds);
    },
  };
}

/** Native Content ports. Composition roots bind these; applications never import this module. */
export function createNativeContentPorts(
  ambient: ContentAmbient = createNativeContentAmbient(),
): ContentApplicationPorts {
  return {
    documents: nativeDocuments(),
    authoredFields: nativeAuthoredFields(ambient),
    ranking: nativeRanking(),
    ambient,
  };
}

export { createNativeContentAmbient };
