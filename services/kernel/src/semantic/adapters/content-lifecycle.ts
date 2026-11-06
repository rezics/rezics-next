import type { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { memoizedValue } from '../../memoized.ts';
import { checkMediaObject, checkMediaObjects, type CoverReference } from '../../content/cover-reference.ts';
import { tupleRoute } from '../../content/imported-contract.ts';
import type {
  ContentCoverRef,
  ContentImportedFieldGroup,
  ContentLifecyclePort,
  ContentQueryClient,
} from '../contract/domain-ports.ts';
import { resolvedSemanticDomain } from './registry.ts';

function fieldGroup(value: string): ContentImportedFieldGroup {
  return value === 'summary' || value === 'cover' ? value : 'facts';
}

function coverRef(cover: CoverReference): ContentCoverRef {
  return {
    id: cover.id,
    digest: cover.digest,
    containerId: cover.containerId,
    source: {
      source: cover.source.source,
      external_id: cover.source.external_id,
      field_group: fieldGroup(String(cover.source.field_group)),
    },
    ...(cover.width === undefined ? {} : { width: cover.width }),
    ...(cover.height === undefined ? {} : { height: cover.height }),
    ...(cover.placeholder === undefined ? {} : { placeholder: cover.placeholder }),
    ...(cover.variants === undefined ? {} : { variants: cover.variants }),
    ...(cover.focalPoint === undefined ? {} : { focalPoint: cover.focalPoint }),
    ...(cover.credit === undefined
      ? {}
      : {
          credit: {
            rightsHolder: cover.credit.rightsHolder,
            license: cover.credit.license,
            via: cover.credit.via ? { name: cover.credit.via.name, url: cover.credit.via.url } : undefined,
          },
        }),
  };
}

function queryClient(client: ContentQueryClient): Pick<PoolClient, 'query'> {
  return client as Pick<PoolClient, 'query'>;
}

/** Native cover availability and imported-tuple home selection. Composition binds this port. */
export function nativeContentLifecycle(): ContentLifecyclePort {
  return memoizedValue(nativeContentLifecycle, () =>
    Object.freeze({
      async checkCover(client: ContentQueryClient, id: string) {
        const cover = await checkMediaObject(queryClient(client), id, 'cover');
        return cover ? coverRef(cover) : null;
      },
      async checkCovers(client: ContentQueryClient, ids: readonly string[]) {
        if (!ids.length) return new Map<string, ContentCoverRef | null>();
        const found = await checkMediaObjects(queryClient(client), ids, 'cover');
        const mapped = new Map<string, ContentCoverRef | null>();
        for (const [id, cover] of found) mapped.set(id, cover ? coverRef(cover) : null);
        return mapped;
      },
      importedTupleRoute: tupleRoute,
    }),
  );
}

export function contentLifecycleOf(pool?: Pool): ContentLifecyclePort {
  return resolvedSemanticDomain(pool)?.ports.contentLifecycle ?? nativeContentLifecycle();
}
