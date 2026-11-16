import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import { libraryIdentityNativeOperationFootprint } from '../library/identity-native-bounds.ts';
import { memoizedValue } from '../memoized.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/contract.ts';
import { identityChangeFirstInputsSQL, identityChangeTransformSQL } from './identity-epoch-store-change-transform.ts';
import inputs from './identity-epoch-store-select-input.sql';
import originals from './identity-epoch-store-select-original.sql';
import accepted from '../search/identity-receiving-native-accepted.sql';
import {
  sizedSearchIdentityPlanSql,
  searchIdentityPlanBodyWorkBytes,
  searchNativeAcceptedBytes,
  searchNativeReceivingSqlCost,
} from '../search/identity-receiving-native-work.ts';
import projectionHeads from './public-filter-projection-head-page.sql';
import projectionHeadUpsert from './public-filter-projection-head-upsert.sql';
import mappingOwners from './identity-epoch-read-owners.sql';
import mappingSources from './identity-epoch-read-sources.sql';
import mappingPending from './identity-epoch-read-pending.sql';
import mappingCurrent from './identity-terminal-closure-current.sql';
import projectionSubjects from './search-source-subjects.sql';
import relatedVisibility from './read-subject-related-states.sql';
import provenance from './scope-leaf-selection-provenance.sql';
import sourceFencesRead from '../content/read-source-fences.sql';
import {
  readCanonicalStatementsSql,
  SEARCH_INDEX_PROVENANCE_BYTES,
  SEARCH_INDEX_STATEMENT_BYTES,
  SEARCH_INDEX_STATEMENT_KEYS,
} from './identity-search-index-statements.ts';
import {
  readIdentitySearchIndexTermSlotSql,
  readIdentitySearchIndexTermsSql,
  SEARCH_INDEX_TERM_REPLAY_POINTS,
} from './identity-search-index-terms.ts';
import { prepareSearchIdentityOriginalSql } from '../search/identity-search-writer-plan-sql.ts';
import { bindSemanticProducerRolesSql } from './erasure-producer.ts';
import {
  anonymousSubjectFormulaBound,
  permissionCheckStatements,
  usesPermissionFormulaBatch,
} from '../access/permission.ts';

import {
  readBoundedSearchIdentityActionSql,
  readBoundedSearchIdentityReceiptSql,
  retainSearchIdentityWriterReceiptSql,
  SEARCH_IDENTITY_WRITER_BODY_MAX,
  searchIdentityWriterBodyBytes,
} from '../search/identity-search-writer-dispatch-sql.ts';

const uuid = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const partition = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < PARTITIONS;
const jobHome = (home: unknown, job: unknown) => {
  const route = typeof job === 'string' ? routeOf(job) : null;
  return route !== null && home === partitionOf(route);
};

const maxId = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
const maxEpoch = '9223372036854775807';
const maxHome = PARTITIONS - 1;
const projectionHeadWriteLimit = 8;
// Only the fixed kind and UUID columns cross the wire. The full persisted intent has no byte ceiling here.
const transformBytes = Buffer.byteLength(
  JSON.stringify({
    kind: 'unmerge',
    survivor: maxId,
    original: maxId,
    terminal: maxId,
    remainder_terminal: maxId,
  }),
);

function textArray(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.startsWith('{') || !value.endsWith('}')) return undefined;
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => (item.startsWith('"') && item.endsWith('"') ? item.slice(1, -1) : item));
}

type PageCost = Readonly<{
  sql: string;
  work: WorkDimensions;
  footprint(values: readonly unknown[]): WorkDimensions | undefined;
}>;

// Search's metadata axis funds full Identity basis sweeps. These reads each use one keyed
// index seek, so reuse the Identity caller's query costs as native work in this ledger.
function indexedRead(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const cost = libraryIdentityNativeOperationFootprint(sql, values);
  return cost && Object.freeze({ ...cost, identityMetadataRows: 0 });
}

export function identitySearchSourcePageCosts(): readonly PageCost[] {
  return memoizedValue(identitySearchSourcePageCosts, () => {
    const declare = (sql: string, values: readonly unknown[], footprint: PageCost['footprint']) => {
      const work = footprint(values);
      if (!work) throw new TypeError('Missing Search Source page work declaration');
      return Object.freeze({ sql, work, footprint });
    };
    const permissionWork = Object.freeze({
      candidateKeys: 0,
      identityMetadataRows: 0,
      nativeRows: 16,
      nativePoints: 16,
      witnessKeys: 0,
      statements: 1,
      bytes: 32768,
      emptySeeks: 1,
    });
    return Object.freeze([
      Object.freeze({
        sql: permissionCheckStatements.formula,
        work: Object.freeze({ ...permissionWork, nativeRows: 24 }),
        footprint(values: readonly unknown[]) {
          const bound = anonymousSubjectFormulaBound(values);
          return bound && bound.bytes <= permissionWork.bytes
            ? Object.freeze({
                ...permissionWork,
                nativeRows: bound.rows,
                nativePoints: bound.points,
                bytes: bound.bytes,
              })
            : usesPermissionFormulaBatch(values)
              ? undefined
              : permissionWork;
        },
      }),
      declare(relatedVisibility.sql, [String(maxHome), '{65535,65535}', `{${maxId},${maxId}}`], (values) => {
        const [home, rawRoutes, rawSubjects] = values;
        const routes = textArray(rawRoutes);
        const subjects = textArray(rawSubjects);
        if (
          values.length !== 3 ||
          typeof home !== 'string' ||
          !/^(0|[1-9][0-9]{0,3})$/.test(home) ||
          !partition(Number(home)) ||
          !routes ||
          !subjects ||
          subjects.length < 1 ||
          subjects.length > 2 ||
          routes.length !== subjects.length ||
          subjects.some(
            (id, index) =>
              !uuid(id) ||
              String(routeOf(id)) !== routes[index] ||
              Math.floor(Number(routes[index]) / 16) !== Number(home),
          )
        )
          return undefined;
        return Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: subjects.length,
          nativePoints: subjects.length,
          witnessKeys: 0,
          statements: 1,
          bytes: 2048,
          emptySeeks: subjects.length,
        });
      }),
      declare(
        bindSemanticProducerRolesSql,
        [maxHome, maxId, Array(8).fill(maxId), Array(8).fill('acting-human')],
        (values) => {
          const [home, transaction, accounts, roles] = values;
          if (
            values.length !== 4 ||
            !partition(home) ||
            !uuid(transaction) ||
            !Array.isArray(accounts) ||
            !Array.isArray(roles) ||
            accounts.length > 8 ||
            accounts.length !== roles.length ||
            !accounts.every(uuid) ||
            !roles.every((role) => typeof role === 'string' && Buffer.byteLength(role) <= 12)
          )
            return undefined;
          return Object.freeze({
            candidateKeys: 0,
            identityMetadataRows: 0,
            nativeRows: accounts.length,
            nativePoints: accounts.length,
            witnessKeys: 0,
            statements: 1,
            bytes: 2048,
            emptySeeks: 0,
          });
        },
      ),
      declare(
        readCanonicalStatementsSql,
        [65535, maxId, SEARCH_INDEX_STATEMENT_KEYS, ['a'.repeat(16380)]],
        (values) => {
          const [route, id, keys, facets] = values;
          if (
            values.length !== 4 ||
            typeof id !== 'string' ||
            routeOf(id) !== route ||
            typeof keys !== 'number' ||
            !Number.isInteger(keys) ||
            keys < 1 ||
            keys > SEARCH_INDEX_STATEMENT_KEYS ||
            !Array.isArray(facets) ||
            !facets.every((facet) => typeof facet === 'string') ||
            Buffer.byteLength(JSON.stringify(facets)) > 16384
          )
            return undefined;
          const points = (facets.length ? 7 : 5) * keys + 1;
          return Object.freeze({
            candidateKeys: 0,
            identityMetadataRows: 0,
            nativeRows: points,
            nativePoints: points,
            witnessKeys: 0,
            statements: 1,
            bytes: 4096 + Buffer.byteLength(JSON.stringify(facets)) + keys * (SEARCH_INDEX_STATEMENT_BYTES + 8192),
            emptySeeks: points,
          });
        },
      ),
      declare(
        provenance.sql,
        provenance.params.map((key) =>
          key === 'max_bytes'
            ? SEARCH_INDEX_PROVENANCE_BYTES
            : Array(SEARCH_INDEX_STATEMENT_KEYS).fill(key === 'routes' ? 65535 : maxId),
        ),
        (values) => {
          const bound = values[provenance.params.indexOf('max_bytes')];
          const routes = values[provenance.params.indexOf('routes')];
          if (
            values.length !== 5 ||
            bound !== SEARCH_INDEX_PROVENANCE_BYTES ||
            !Array.isArray(routes) ||
            routes.length < 1 ||
            routes.length > SEARCH_INDEX_STATEMENT_KEYS
          )
            return undefined;
          for (const name of ['subjects', 'candidates', 'slots'] as const) {
            const ids = values[provenance.params.indexOf(name)];
            if (!Array.isArray(ids) || ids.length !== routes.length || !ids.every(uuid)) return undefined;
          }
          const points = 4 * routes.length;
          return Object.freeze({
            candidateKeys: 0,
            identityMetadataRows: 0,
            nativeRows: points,
            nativePoints: points,
            witnessKeys: 0,
            statements: 1,
            bytes: 4096 + routes.length * (SEARCH_INDEX_PROVENANCE_BYTES + 1024),
            emptySeeks: points,
          });
        },
      ),
      Object.freeze({
        sql: sourceFencesRead.sql,
        work: Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: 100,
          nativePoints: 100,
          witnessKeys: 0,
          statements: 1,
          bytes: 4096 + 131072 + 1536 * 100,
          emptySeeks: 100,
        }),
        footprint(values: readonly unknown[]) {
          const home = values[sourceFencesRead.params.indexOf('partition')];
          const data = values[sourceFencesRead.params.indexOf('tuples')];
          if (values.length !== 2 || !partition(home) || typeof data !== 'string' || Buffer.byteLength(data) > 131072)
            return undefined;
          let tuples: unknown;
          try {
            tuples = JSON.parse(data);
          } catch {
            return undefined;
          }
          if (!Array.isArray(tuples) || tuples.length < 1 || tuples.length > 100) return undefined;
          return Object.freeze({
            candidateKeys: 0,
            identityMetadataRows: 0,
            nativeRows: tuples.length,
            nativePoints: tuples.length,
            witnessKeys: 0,
            statements: 1,
            bytes: 4096 + Buffer.byteLength(data) + 1536 * tuples.length,
            emptySeeks: tuples.length,
          });
        },
      }),
      declare(readIdentitySearchIndexTermSlotSql, [65535, maxId, maxId, 32], (values) => {
        const [route, subject, after, limit] = values;
        if (
          values.length !== 4 ||
          typeof route !== 'number' ||
          typeof subject !== 'string' || routeOf(subject) !== route ||
          (after !== null && !uuid(after)) ||
          typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 32
        ) return undefined;
        return Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: 5 + limit,
          nativePoints: 5 + limit,
          witnessKeys: 0,
          statements: 1,
          bytes: 4096 + 2304 * (limit + 1),
          emptySeeks: 3,
        });
      }),
      declare(readIdentitySearchIndexTermsSql, [65535, maxId, SEARCH_INDEX_TERM_REPLAY_POINTS], (values) => {
        const [route, subject, points] = values;
        if (
          values.length !== 3 ||
          typeof route !== 'number' ||
          !Number.isInteger(route) ||
          route < 0 ||
          route > 65535 ||
          typeof subject !== 'string' ||
          routeOf(subject) !== route ||
          typeof points !== 'number' ||
          !Number.isInteger(points) ||
          points < 1 ||
          points > SEARCH_INDEX_TERM_REPLAY_POINTS
        )
          return undefined;
        return Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: points,
          nativePoints: points,
          witnessKeys: 0,
          statements: 1,
          bytes: 4096 + 8192 * points,
          emptySeeks: points,
        });
      }),
      declare(
        prepareSearchIdentityOriginalSql,
        [
          maxHome,
          'target',
          maxId,
          'physical',
          1,
          maxId,
          '1',
          maxId,
          '1',
          maxId,
          'a'.repeat(SEARCH_IDENTITY_WRITER_BODY_MAX),
          null,
        ],
        (values) => {
          const body = values[10];
          const bytes = typeof body === 'string' ? searchIdentityWriterBodyBytes(Buffer.byteLength(body)) : undefined;
          if (
            values.length !== 12 ||
            !partition(values[0]) ||
            !uuid(values[2]) ||
            !uuid(values[9]) ||
            bytes === undefined
          )
            return undefined;
          return Object.freeze({
            candidateKeys: 0,
            identityMetadataRows: 0,
            nativeRows: 1,
            nativePoints: 2,
            witnessKeys: 0,
            statements: 1,
            bytes: bytes + 3072,
            emptySeeks: 1,
          });
        },
      ),
      ...(
        [
          [mappingOwners.sql, [partition], 4096, 1, 512, [maxHome]],
          [
            mappingSources.sql,
            [
              uuid,
              (value: unknown) => typeof value === 'number' && value >= 0 && value <= 65535 && Number.isInteger(value),
            ],
            100,
            4,
            4096,
            [maxId, 65535],
          ],
          [mappingPending.sql, [partition, uuid], 100, 1, 1024, [maxHome, maxId]],
          [mappingCurrent.sql, [partition, uuid, uuid], 100, 4, 4096, [maxHome, maxId, maxId]],
        ] as const
      ).map(([sql, validators, maximum, points, bytes, example]) =>
        declare(
          sql,
          example.map((value) => Array(maximum).fill(value)),
          (values) => {
            const count = Array.isArray(values[0]) ? values[0].length : 0;
            if (
              values.length !== validators.length ||
              count < 1 ||
              count > maximum ||
              !values.every(
                (value, index) => Array.isArray(value) && value.length === count && value.every(validators[index]!),
              )
            )
              return undefined;
            return Object.freeze({
              candidateKeys: 0,
              identityMetadataRows: 0,
              nativeRows: points * count,
              nativePoints: points * count,
              witnessKeys: 0,
              statements: 1,
              bytes: bytes * count,
              emptySeeks: 1,
            });
          },
        ),
      ),
      declare(sizedSearchIdentityPlanSql(), [maxHome, maxId, 16384], (values) => {
        const [home, plan, size] = values;
        const bytes = searchIdentityPlanBodyWorkBytes(size);
        return values.length === 3 && partition(home) && uuid(plan) && bytes !== undefined
          ? Object.freeze({
              candidateKeys: 0,
              identityMetadataRows: 0,
              nativeRows: 3,
              nativePoints: 3,
              witnessKeys: 0,
              statements: 1,
              bytes,
              emptySeeks: 1,
            })
          : undefined;
      }),
      Object.freeze({
        sql: accepted.sql,
        work: Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: 4,
          nativePoints: 4,
          witnessKeys: 0,
          statements: 1,
          bytes: searchNativeReceivingSqlCost.accepted[2],
          emptySeeks: 0,
        }),
        footprint(values: readonly unknown[]) {
          const bytes = searchNativeAcceptedBytes(values[8]);
          return values.length === 11 && bytes !== undefined
            ? Object.freeze({
                candidateKeys: 0,
                identityMetadataRows: 0,
                nativeRows: 4,
                nativePoints: 4,
                witnessKeys: 0,
                statements: 1,
                bytes,
                emptySeeks: 0,
              })
            : undefined;
        },
      }),
      declare(
        retainSearchIdentityWriterReceiptSql,
        [maxHome, 'target', maxId, maxId, 'a'.repeat(SEARCH_IDENTITY_WRITER_BODY_MAX)],
        (values) => {
          const [home, target, document, locator, body] = values;
          const bytes = typeof body === 'string' ? searchIdentityWriterBodyBytes(Buffer.byteLength(body)) : undefined;
          return values.length === 5 &&
            partition(home) &&
            typeof target === 'string' &&
            target.length > 0 &&
            target.length <= 255 &&
            uuid(document) &&
            uuid(locator) &&
            bytes !== undefined
            ? Object.freeze({
                candidateKeys: 0,
                identityMetadataRows: 0,
                nativeRows: 1,
                nativePoints: 1,
                witnessKeys: 0,
                statements: 1,
                bytes,
                emptySeeks: 1,
              })
            : undefined;
        },
      ),
      ...[readBoundedSearchIdentityActionSql, readBoundedSearchIdentityReceiptSql].map((sql) =>
        declare(sql, [maxHome, 'target', maxId, SEARCH_IDENTITY_WRITER_BODY_MAX], (values) => {
          const [home, target, document, bound] = values;
          const bytes = searchIdentityWriterBodyBytes(bound);
          return values.length === 4 &&
            partition(home) &&
            typeof target === 'string' &&
            target.length > 0 &&
            target.length <= 255 &&
            uuid(document) &&
            bytes !== undefined
            ? Object.freeze({
                candidateKeys: 0,
                identityMetadataRows: 0,
                nativeRows: 1,
                nativePoints: 1,
                witnessKeys: 0,
                statements: 1,
                bytes,
                emptySeeks: 1,
              })
            : undefined;
        }),
      ),
      declare(identityChangeTransformSQL, [maxHome, maxId, maxEpoch], (values) => {
        const [home, job, epoch] = values;
        if (
          values.length !== 3 ||
          !jobHome(home, job) ||
          typeof epoch !== 'string' ||
          !/^[1-9][0-9]{0,18}$/.test(epoch) ||
          (epoch.length === maxEpoch.length && epoch > maxEpoch)
        )
          return undefined;
        return Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: 1,
          nativePoints: 1,
          witnessKeys: 0,
          statements: 1,
          bytes:
            Buffer.byteLength(identityChangeTransformSQL) + Buffer.byteLength(JSON.stringify(values)) + transformBytes,
          emptySeeks: 1,
        });
      }),
      declare(identityChangeFirstInputsSQL, [maxHome, maxId], (values) =>
        values.length === 2 && jobHome(values[0], values[1])
          ? Object.freeze({
              candidateKeys: 0,
              identityMetadataRows: 0,
              nativeRows: 4,
              nativePoints: 4,
              witnessKeys: 0,
              statements: 1,
              bytes: 1024,
              emptySeeks: 1,
            })
          : undefined,
      ),
      declare(inputs.sql, [maxHome, maxId], (values) =>
        values.length === 2 && jobHome(values[0], values[1]) ? indexedRead(inputs.sql, values) : undefined,
      ),
      declare(
        projectionSubjects.sql,
        [
          String(maxHome),
          `{${Array<string>(256)
            .fill(String(maxHome * 16 + 15))
            .join(',')}}`,
          `{${Array<string>(256).fill(maxId).join(',')}}`,
        ],
        (values) => {
          const [home, rawRoutes, rawSubjects] = values;
          const routes = textArray(rawRoutes);
          const subjects = textArray(rawSubjects);
          if (
            values.length !== 3 ||
            typeof home !== 'string' ||
            !/^(0|[1-9][0-9]{0,3})$/.test(home) ||
            Number(home) > maxHome ||
            !routes ||
            !subjects ||
            routes.length < 1 ||
            routes.length > 256 ||
            routes.length !== subjects.length ||
            subjects.some(
              (id, index) =>
                !uuid(id) ||
                String(routeOf(id)) !== routes[index] ||
                Math.floor(Number(routes[index]) / 16) !== Number(home),
            )
          )
            return undefined;
          // Each requested key reads Subject, selection state, its latest redirect and its latest revision.
          return Object.freeze({
            candidateKeys: 0,
            identityMetadataRows: 0,
            nativeRows: 4 * subjects.length,
            nativePoints: 4 * subjects.length,
            witnessKeys: 0,
            statements: 1,
            bytes: 16384 * subjects.length,
            emptySeeks: 1,
          });
        },
      ),
      declare(projectionHeads.sql, [maxId, String(maxHome), '1000'], (values) => {
        const [build, after, limit] = values;
        if (
          values.length !== 3 ||
          !uuid(build) ||
          typeof after !== 'string' ||
          !/^(?:-1|0|[1-9][0-9]{0,3})$/.test(after) ||
          Number(after) > maxHome ||
          typeof limit !== 'string' ||
          !/^[1-9][0-9]{0,3}$/.test(limit) ||
          Number(limit) > 1000
        )
          return undefined;
        const rows = Number(limit);
        return Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: rows + 1,
          nativePoints: rows + 1,
          witnessKeys: 0,
          statements: 1,
          bytes: Buffer.byteLength(projectionHeads.sql) + Buffer.byteLength(JSON.stringify(values)) + rows * 256,
          emptySeeks: 1,
        });
      }),
      declare(
        projectionHeadUpsert.sql,
        projectionHeadUpsert.params.map((key) =>
          key === 'build_id'
            ? maxId
            : JSON.stringify(
                Array.from({ length: projectionHeadWriteLimit }, (_, index) => ({
                  partition_no: maxHome - index,
                  owner_epoch: 2147483647,
                  position: maxEpoch,
                })),
              ),
        ),
        (values) => {
          const build = values[projectionHeadUpsert.params.indexOf('build_id')];
          const encoded = values[projectionHeadUpsert.params.indexOf('heads')];
          if (
            values.length !== projectionHeadUpsert.params.length ||
            !uuid(build) ||
            typeof encoded !== 'string' ||
            Buffer.byteLength(encoded) > 1024
          )
            return undefined;
          let heads: unknown;
          try {
            heads = JSON.parse(encoded);
          } catch {
            return undefined;
          }
          if (!Array.isArray(heads) || heads.length < 1 || heads.length > projectionHeadWriteLimit) return undefined;
          // A recordset entry can attempt at most one primary-key upsert, even if the SQL refuses it.
          return Object.freeze({
            candidateKeys: 0,
            identityMetadataRows: 0,
            nativeRows: heads.length,
            nativePoints: heads.length,
            witnessKeys: 0,
            statements: 1,
            bytes: 2048,
            emptySeeks: 0,
          });
        },
      ),
      declare(originals.sql, [maxId, maxId, 100, maxId, maxHome], (values) => {
        const [generation, after, limit, terminal, home] = values;
        return values.length === 5 &&
          uuid(generation) &&
          (after === null || uuid(after)) &&
          (limit === 1 || limit === 50 || limit === 100) &&
          uuid(terminal) &&
          partition(home)
          ? indexedRead(originals.sql, values)
          : undefined;
      }),
    ]);
  });
}
