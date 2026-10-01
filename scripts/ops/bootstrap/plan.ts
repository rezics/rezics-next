import { Value } from 'typebox/value';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { YAML } from 'bun';

const closed = { additionalProperties: false } as const;
// Composite command keys stay within Main's 128-byte idempotency envelope.
const id = t.String({ pattern: '^[a-z][a-z0-9-]{0,29}$' });
const https = t.String({ pattern: '^https://[^\\s]{1,500}$' });
const sha = t.String({ pattern: '^[0-9a-f]{64}$' });
const date = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const recorded = t.Object(
  {
    value: t.String({ minLength: 1, maxLength: 200 }),
    language: t.String({ minLength: 2, maxLength: 35 }),
  },
  closed,
);
export const planSchema = t.Object(
  {
    profile: t.Literal('launch-bootstrap-v1'),
    namespace: id,
    operators: t.Array(
      t.Object(
        {
          accountSubject: t.String({ minLength: 1, maxLength: 128 }),
          actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        },
        closed,
      ),
      { minItems: 1, maxItems: 1 },
    ),
    zones: t.Array(t.String({ pattern: '^config/zones/[a-z0-9-]+\\.json$' }), {
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    }),
    vocabulary: t.Literal('relation-lexicon-v3'),
    sources: t.Array(
      t.Object(
        {
          id,
          enabled: t.Boolean(),
          dumpUrl: https,
          version: t.String({ minLength: 1, maxLength: 80 }),
          dumpSha256: t.Union([sha, t.Null()]),
          slice: t.Union([t.String({ pattern: '^tests/fixtures/[a-z0-9/.-]+\\.json$' }), t.Null()]),
          sliceSha256: t.Union([sha, t.Null()]),
          licence: https,
          rightsEvidence: https,
          rightsEvidenceDate: date,
          attribution: t.String({ minLength: 1, maxLength: 1000 }),
          zones: t.Array(id, { maxItems: 8, uniqueItems: true }),
          steward: t.String({ minLength: 1, maxLength: 128 }),
          backup: t.String({ minLength: 1, maxLength: 128 }),
          bounds: t.Object(
            {
              bytes: t.Integer({ minimum: 1, maximum: 1_000_000 }),
              works: t.Integer({ minimum: 1, maximum: 3 }),
            },
            closed,
          ),
          records: t.Array(
            t.Object(
              {
                id,
                grain: t.Literal('new-creative-scope'),
                title: recorded,
                sourceTitlePointer: t.String({ pattern: '^/[^\\s]{1,500}$' }),
                sourceLanguagePointer: t.String({ pattern: '^/[^\\s]{1,500}$' }),
                sourceIdPointer: t.String({ pattern: '^/[^\\s]{1,500}$' }),
                semanticTypes: t.Array(https, { minItems: 1, maxItems: 3, uniqueItems: true }),
                aliases: t.Array(recorded, { maxItems: 8 }),
                romanizations: t.Array(recorded, { maxItems: 8 }),
                creators: t.Array(t.String({ minLength: 1, maxLength: 500 }), { maxItems: 4 }),
                dates: t.Array(t.Integer({ minimum: 1, maximum: 9999 }), { maxItems: 4 }),
                identifiers: t.Array(
                  t.Object(
                    { provider: https, identifier: t.String({ minLength: 1, maxLength: 200 }) },
                    closed,
                  ),
                  { maxItems: 4 },
                ),
              },
              closed,
            ),
            { maxItems: 3 },
          ),
        },
        closed,
      ),
      { maxItems: 8 },
    ),
  },
  closed,
);
export type BootstrapPlan = Static<typeof planSchema>;
export interface ZoneManifest {
  id: string;
  name: string;
  language: string;
  routeSegment: string;
  preset: 'editorial';
  navigation: { label: string; href: string }[];
  mountSegment?: string;
  announcement?: string;
  mounts?: { id: string; name: string; routeSegment: string }[];
}
const mount = t.Object(
  { id, name: t.String({ minLength: 1, maxLength: 120 }), routeSegment: id },
  closed,
);
const zoneSchema = t.Object(
  {
    id,
    name: t.String({ minLength: 1, maxLength: 120 }),
    language: t.String({ minLength: 2, maxLength: 35 }),
    routeSegment: id,
    preset: t.Literal('editorial'),
    navigation: t.Array(
      t.Object(
        {
          label: t.String({ minLength: 1, maxLength: 80 }),
          href: t.String({ pattern: '^/(?:[a-z0-9-]+)?$' }),
        },
        closed,
      ),
      { maxItems: 16 },
    ),
    mountSegment: t.Optional(id),
    mounts: t.Optional(t.Array(mount, { maxItems: 8 })),
    announcement: t.Optional(t.String({ maxLength: 120 })),
    browse: t.Optional(t.Array(t.String())),
    sharedMember: t.Optional(t.String()),
    releaseBrowse: t.Optional(t.String()),
  },
  closed,
);

export function checkedPlan(value: unknown, production: boolean): BootstrapPlan {
  if (!Value.Check(planSchema, value)) throw new Error('Invalid launch bootstrap plan');
  const plan = structuredClone(value);
  if (new Set(plan.sources.map((source) => source.id)).size !== plan.sources.length)
    throw new Error('Duplicate source identity');
  for (const source of plan.sources) {
    if (
      source.records.length > source.bounds.works ||
      new Set(source.records.map((record) => record.id)).size !== source.records.length
    ) {
      throw new Error(`Source ${source.id} exceeds its distinct Work bound`);
    }
    if (!source.enabled) continue;
    if (!source.dumpSha256 || !source.sliceSha256 || !source.slice || !source.records.length) {
      throw new Error(`Source ${source.id} needs pinned dump and slice evidence`);
    }
    if (
      `${source.licence}; ${source.rightsEvidence} (${source.rightsEvidenceDate}); ${source.attribution}`
        .length > 1024
    ) {
      throw new Error(`Source ${source.id} exceeds the intake rights-evidence bound`);
    }
    if (
      production &&
      [source.steward, source.backup].some((name) => name.trim().toUpperCase() === 'TBD')
    ) {
      throw new Error(`Source ${source.id} needs a named steward and backup`);
    }
    const when = Date.parse(source.rightsEvidenceDate);
    if (
      !Number.isFinite(when) ||
      new Date(when).toISOString().slice(0, 10) !== source.rightsEvidenceDate ||
      when > Date.now()
    )
      throw new Error(`Source ${source.id} needs dated rights evidence`);
  }
  return plan;
}

export function inside(root: string, path: string): string {
  const full = resolve(root, path),
    local = relative(root, full);
  if (!local || local.startsWith('..') || local.startsWith('/'))
    throw new Error('Bootstrap path is outside the checkout');
  return full;
}
export async function loadPlan(root: string, path: string, production: boolean) {
  const plan = checkedPlan(YAML.parse(await readFile(inside(root, path), 'utf8')), production);
  const zones: ZoneManifest[] = [];
  for (const file of plan.zones) {
    const value: unknown = JSON.parse(await readFile(inside(root, file), 'utf8'));
    if (!Value.Check(zoneSchema, value)) throw new Error(`Invalid Zone manifest ${file}`);
    if (value.routeSegment.length < 3)
      throw new Error(`Zone ${value.id} needs a valid community handle`);
    if (!value.mountSegment && !value.mounts?.length)
      throw new Error(`Zone ${value.id} needs mounted Collections`);
    zones.push(value);
  }
  if (
    new Set(zones.map((zone) => zone.id)).size !== zones.length ||
    new Set(zones.map((zone) => zone.routeSegment)).size !== zones.length
  )
    throw new Error('Duplicate Zone identity or route');
  return { plan, zones };
}
