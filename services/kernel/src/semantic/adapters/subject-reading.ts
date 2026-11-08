import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import type { ContentCoverRef, ContentQueryClient } from '../contract/domain-ports.ts';
import type { SubjectReadingNativePort, SubjectReadingFence, SubjectReadingFenceTuple } from '../contract/index.ts';
import type { ContextRecord } from '../context.ts';
import { contextSnapshot } from '../context.ts';
import { activeRelease, readRelease } from '../definition-release-read.ts';
import { layeredRelease } from '../definition-release-read.ts';
import type { Access } from '../../request/access.ts';
import type { Actor } from '../../request/access.ts';
import {
  readCurrentContentDocument,
  type CurrentContentDocumentRuntime,
} from '../../content/adapters/subject-document.ts';
import { nativeContentLifecycle } from './content-lifecycle.ts';
import { readCharacterPublicDocuments } from '../character-public-reading-documents.ts';
import type { Item } from '../item.ts';
import {
  createSubjectReadingApplication,
  type SubjectReadingPorts,
  type SubjectReadingRuntime,
} from '../subject-reading-application.ts';
import type { SubjectReadingApplication } from '../subject-reading-application.ts';
import { GLOBAL_SUBJECT_CONTEXT } from '../contract/subject-values.ts';
import { readAnchoredFences, readCurrentSourceFences } from '../fences.ts';

type Connection = Pool | Pick<PoolClient, 'query'>;
type NativeFenceTuple = SubjectReadingFenceTuple & { field_group: 'facts' | 'summary' | 'cover' };
type NativeFence = SubjectReadingFence & { field_group: 'facts' | 'summary' | 'cover' };
type CurrentDocumentRead = Awaited<ReturnType<typeof readCurrentContentDocument>>;
type CharacterDocumentsRead = Awaited<ReturnType<typeof readCharacterPublicDocuments>>;

/** Native Content and Semantic producers used by the ordinary Subject reading composition. */
export function createNativeSubjectReadingPort(): SubjectReadingNativePort<
  SubjectReadingRuntime,
  Connection,
  Release,
  ContextRecord,
  CurrentDocumentRead,
  CharacterDocumentsRead,
  ContentCoverRef,
  NativeFenceTuple,
  NativeFence
> {
  const content = nativeContentLifecycle();
  return Object.freeze({
    readContextSnapshot(connection, context) {
      if (context === GLOBAL_SUBJECT_CONTEXT) return Promise.resolve(null);
      return contextSnapshot(connection as Pool, context);
    },
    async readActiveRelease(connection) {
      const active = await activeRelease(connection as Parameters<typeof activeRelease>[0]);
      return active ? { digest: active.digest, release: active.release } : null;
    },
    readRelease(connection, digest) {
      return readRelease(connection as Parameters<typeof readRelease>[0], digest);
    },
    layerRelease(connection, release, context) {
      return layeredRelease(connection as Parameters<typeof layeredRelease>[0], release, context);
    },
    readCurrentDocument(runtime, document) {
      const contentRuntime: CurrentContentDocumentRuntime = {
        pool: runtime.pool,
        access: runtime.access,
        routeKey: runtime.routeKey,
        now: () => runtime.clock().getTime(),
      };
      return readCurrentContentDocument(contentRuntime, {
        id: document,
        actor: runtime.actor,
        deadline: runtime.deadline,
      });
    },
    readCharacterDocuments(runtime, subject, release, locale) {
      return readCharacterPublicDocuments(
        {
          pool: runtime.pool,
          access: runtime.access,
          routeKey: runtime.routeKey,
          now: () => runtime.clock().getTime(),
        },
        subject as Item,
        release,
        { actor: runtime.actor, deadline: runtime.deadline },
        locale,
      );
    },
    checkCover(connection, media) {
      return content.checkCover(connection as ContentQueryClient, media);
    },
    checkCovers(connection, media) {
      return content.checkCovers(connection as ContentQueryClient, media);
    },
    readCoverFences(connection, tuples) {
      return readCurrentSourceFences(connection as ContentQueryClient, tuples);
    },
    readAnchoredCoverFences(connection, partition, tuples) {
      return readAnchoredFences(connection as Pool, partition, tuples);
    },
    importedTupleRoute(routeKey, source, externalId) {
      return content.importedTupleRoute(routeKey, source, externalId);
    },
  });
}

let installedApplication: SubjectReadingApplication | undefined;

/** Install the process's native reading application once for compatibility clients and composed hosts. */
export function installNativeSubjectReadingApplication(
  create: () => SubjectReadingApplication,
): SubjectReadingApplication {
  installedApplication ??= create();
  return installedApplication;
}

/** Compatibility clients share the application installed by composition, creating it lazily for old hosts. */
export function nativeSubjectReadingApplication(): SubjectReadingApplication {
  return installNativeSubjectReadingApplication(() =>
    createSubjectReadingApplication(createNativeSubjectReadingPort() as SubjectReadingPorts),
  );
}
