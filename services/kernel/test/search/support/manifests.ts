// Search expansion fixtures. Vertical sources come from the shared generator:
// verticalManifests(count) produces v0..v{count-1}. A scale step indexes the new
// names in the half-open range [from, to). The query anchors v0, which is present
// at every scale, so matches stay fixed while the release and the other subjects grow.

import { releaseDigest, type PropertyDefinition, type Release } from '@rezics/definitions';
import { bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import type { Pool } from 'pg';
import type { AccountActor } from '../../../src/request/access.ts';
import { derivedId } from '../../../src/route/route.ts';
import { activateRelease, activeRelease, publishRelease } from '../../../src/semantic/definitions.ts';
import type { IndexedStatement, IndexedSubject } from '../../../src/search/source.ts';
import { verticalManifests, verticalProfile } from '../../support/manifests.ts';

const ANCHOR = 0;
const YEAR = 1999;
const AMOUNT = 1;
const SUBJECT_NAMESPACE = '018f0000-0000-7000-8000-0000000000e1';
const SUBJECT_ROUTE = 1;
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-5eac4e000001',
  clientId: 'web',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const receiptDigest = new Uint8Array(32).fill(9);
const compiled = new Map<number, Release>();

function sourcesFor(count: number) {
  const bundled = bundledSources();
  const extra = verticalManifests(count);
  const imports = Array.from({ length: count }, (_, index) => `  - v${index}`).join('\n');
  return {
    root: bundled.root,
    schemas: {
      ...bundled.schemas,
      ...extra.schemas,
      'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n${imports}\n`,
    },
    presentation: { ...bundled.presentation, ...extra.presentation },
    contexts: bundled.contexts,
  };
}

async function compiledRelease(count: number): Promise<Release> {
  const cached = compiled.get(count);
  if (cached) return cached;
  const release = await compileCatalogue(sourcesFor(count));
  compiled.set(count, release);
  return release;
}

function verticalClasses(release: Release, index: number): string[] {
  const profile = verticalProfile(index);
  const ids = new Set([profile.work, profile.edition, profile.agent]);
  const classes = Object.keys(release.types).filter((id) => ids.has(id));
  if (classes.length !== ids.size) throw new Error(`Vertical v${index} is missing a class in the active release`);
  return classes;
}

function subjectId(index: number, type: string, copy: number): string {
  return derivedId(SUBJECT_NAMESPACE, `${index}/${type}/${copy}`, SUBJECT_ROUTE);
}

function patternedString(property: PropertyDefinition): string | undefined {
  if (property.datatype !== 'string' && property.datatype !== 'external-id') return undefined;
  if (typeof property.value !== 'object' || property.value === null || !('pattern' in property.value)) return undefined;
  const pattern = property.value.pattern;
  return typeof pattern === 'string' && pattern.length > 0 ? pattern : undefined;
}

function codeFor(pattern: string): string {
  const expression = new RegExp(pattern, 'u');
  for (const candidate of ['1', 'A', 'code', 'v0', 'abc']) {
    if (expression.exec(candidate)?.[0] === candidate) return candidate;
  }
  throw new Error(`No fixture code matches ${pattern}`);
}

function statementFor(release: Release, propertyId: string, otherId: string): IndexedStatement {
  const property = release.properties[propertyId];
  if (!property) throw new Error(`Missing property ${propertyId}`);
  if (property.datatype === 'wikibase-item') return { property: propertyId, value: otherId, facet: { kind: 'item' } };
  if (property.datatype === 'time') {
    return {
      property: propertyId,
      value: `+${String(YEAR).padStart(4, '0')}-01-01T00:00:00Z`,
      facet: { kind: 'time', year: YEAR },
    };
  }
  if (property.datatype === 'quantity') {
    const unit = property.units?.[0];
    if (unit === undefined) throw new Error(`Quantity ${propertyId} declares no unit`);
    return { property: propertyId, value: String(AMOUNT), facet: { kind: 'quantity', amount: AMOUNT, unit } };
  }
  const pattern = patternedString(property);
  if (pattern) return { property: propertyId, value: codeFor(pattern), facet: { kind: 'code' } };
  throw new Error(`Facet ${propertyId} has no search value`);
}

/** Compile the bundled catalogue plus `count` verticals, publish that release and activate it. */
export async function activateManifests(db: { pool: Pool }, count: number): Promise<Release> {
  const release = await compiledRelease(count);
  const digest = releaseDigest(release);
  const command = {
    actor,
    digest: receiptDigest,
    authorize: async () => true,
    deadline: Date.now() + 60_000,
  };
  await publishRelease(db.pool, { ...command, idempotencyKey: `search-expansion-publish-${count}`, release });
  const active = await activeRelease(db.pool);
  if (active?.digest !== digest) {
    await activateRelease(db.pool, {
      ...command,
      idempotencyKey: `search-expansion-activate-${count}`,
      releaseDigest: digest,
      expectedHead: active?.head ?? null,
    });
  }
  return release;
}

/** Two visible subjects for each class of verticals v`from` through v`to - 1`. */
export function manifestSubjects(release: Release, from: number, to: number): IndexedSubject[] {
  const subjects: IndexedSubject[] = [];
  for (let index = from; index < to; index++) {
    for (const type of verticalClasses(release, index)) {
      const definition = release.types[type]!;
      const pair = [0, 1].map((copy) => subjectId(index, type, copy));
      for (const copy of [0, 1]) {
        const otherId = pair[copy === 0 ? 1 : 0]!;
        subjects.push({
          id: pair[copy]!,
          type,
          visibility: 'visible',
          redirect: null,
          securityRevision: 1,
          labels: [{ language: 'en', value: `${type} ${copy}` }],
          aliases: [],
          descriptions: [],
          statements: definition.facets.map((property) => statementFor(release, property, otherId)),
        });
      }
    }
  }
  return subjects;
}

/** A v0 query: its first class, one item facet naming a v0 subject, and its time facet when present. */
export function manifestQuery(release: Release): {
  filter: {
    and: readonly (
      | { type: { in: readonly string[] } }
      | { statement: { property: string; in: readonly string[] } }
      | { statement: { property: string; range: { gte: number; lte: number } } }
    )[];
  };
  facets: { property: string }[];
} {
  const type = verticalClasses(release, ANCHOR)[0];
  if (type === undefined) throw new Error('Anchor vertical has no class');
  const definition = release.types[type]!;
  const itemFacets = definition.facets
    .filter((property) => release.properties[property]?.datatype === 'wikibase-item')
    .slice(0, 8);
  const item = itemFacets[0];
  if (item === undefined) throw new Error(`Anchor class ${type} has no item facet`);
  const time = definition.facets.find((property) => release.properties[property]?.datatype === 'time');
  return {
    filter: {
      and: [
        { type: { in: [type] } },
        { statement: { property: item, in: [subjectId(ANCHOR, type, 0)] } },
        ...(time === undefined ? [] : [{ statement: { property: time, range: { gte: YEAR, lte: YEAR } } }]),
      ],
    },
    facets: itemFacets.map((property) => ({ property })),
  };
}
