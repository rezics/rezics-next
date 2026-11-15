import { expect, test } from 'bun:test';
import type { AccessClient } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { HOSTED_APPEND_DESCRIPTOR_SELECT, hostedAppendDescriptor } from '../../src/content/hosted-chapters-append.ts';

const catalogueId = newId(7),
  revisionId = newId(7);

test('an existing prefix decodes exact counters and follows its sealed base without another probe', async () => {
  const baseRevisionId = newId(7);
  let queries = 0;
  const client: AccessClient = {
    query: (async (sql: string, values: unknown[]) => {
      queries++;
      expect(sql).toBe(HOSTED_APPEND_DESCRIPTOR_SELECT);
      expect(values).toEqual([7, catalogueId, revisionId]);
      return {
        rows: [
          {
            revision_id: revisionId,
            base_revision_id: baseRevisionId,
            base_placement_count: '512',
            base_root_count: '497',
            high_water: '9007199254740478',
          },
        ],
      };
    }) as AccessClient['query'],
  };
  expect(await hostedAppendDescriptor(client, catalogueId, revisionId)).toEqual({
    revisionId,
    baseRevisionId,
    basePlacementCount: 512n,
    baseRootCount: 497n,
    highWater: 9007199254740478n,
  });
  expect(queries).toBe(1);
});
