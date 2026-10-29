import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledRelease } from '../../src/bundled.ts';
import { RELEASE_LIMITS, validateRelease, valueSchema, type Release } from '../../src/index.ts';
import { analyzePattern } from '../../src/pattern-safety.ts';
import { admitFilter, parseFilter, validateFilter, type FilterDocument } from '../../../filter/src/filter.ts';

export const scales = [64, 512, 4096] as const;
export const candidateAnalysisMax = 16_384;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const read = (path: string) => readFileSync(path, 'utf8');
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const rootType = 'grow:Root';
const code = 'grow:code';

export function constructionFixture(
  bases = 0,
  declarations = 0,
  filters = 1,
  leaves = 1,
  qualifiers = 1,
  returnable = 1,
) {
  const release = structuredClone(bundledRelease);
  release.prefixes.grow = 'https://construction.example/';
  release.prefixes.zzgrow = 'https://construction.example/qualifier/';
  release.properties[code] = {
    iri: `${release.prefixes.grow}code`,
    labels: { en: 'Construction code' },
    mappings: [],
    datatype: 'string',
    multivalued: false,
    qualifiers: [],
    value: valueSchema('string', { pattern: '^[A-Z]+$' }),
  };
  release.types[rootType] = {
    iri: `${release.prefixes.grow}Root`,
    labels: { en: 'Construction root' },
    mappings: [],
    bases: Array.from({ length: bases }, (_, index) => `grow:B${String(index).padStart(4, '0')}`),
    properties: [code],
    facets: [code],
  };
  if (declarations) {
    // At 4096 retain every original property: grow the list to the actual property cap,
    // rather than adding 4096 properties on top of the catalogue or dropping it.
    const existing = Object.keys(release.properties).sort();
    const added = Math.max(4, declarations - existing.length);
    const names = Array.from({ length: added }, (_, index) => `zzgrow:q${String(index).padStart(4, '0')}`);
    for (const name of names)
      release.properties[name] = {
        iri: `${release.prefixes.zzgrow}${name.slice('zzgrow:'.length)}`,
        labels: { en: name },
        mappings: [],
        datatype: 'string',
        multivalued: false,
        qualifiers: [],
        value: valueSchema('string'),
      };
    release.properties[code]!.qualifiers = [...existing.slice(0, declarations - added), ...names].sort();
  }
  const typeNames = [rootType];
  for (let index = 1; index < returnable; index++) {
    const name = `grow:R${index}`;
    typeNames.push(name);
    release.types[name] = { ...structuredClone(release.types[rootType]!), iri: `${release.prefixes.grow}R${index}` };
  }
  const declared = release.properties[code]!.qualifiers;
  const selected = declared.slice(-qualifiers);
  const leaf: FilterDocument = {
    statement: {
      property: code,
      in: ['A'],
      ...(declarations ? { qualifiers: selected.map((property) => ({ property, in: ['x'] })) } : {}),
    },
  };
  const filter: FilterDocument = {
    and: [{ type: { in: typeNames } }, ...Array.from({ length: leaves }, () => structuredClone(leaf))],
  };
  for (let index = 0; index < filters; index++) {
    const key = `construction${Math.floor(index / 64)}/f${String(index % 64).padStart(2, '0')}`;
    (release.filters ??= {})[key] = { labels: { en: key }, filter: structuredClone(filter) };
  }
  return release;
}

type Counts = {
  duplicateVisits: number;
  duplicateCopies: number;
  duplicateAppends: number;
  baseReads: number;
  baseVisits: number;
  qualifierVisits: number;
  snapshotVisits: number;
  hashNodes: number;
  hashBytes: number;
  hashSortComparisons: number;
  facetProbes: number;
};
type ProbeState = Counts & { bases: WeakSet<object>; types: WeakSet<object>; qualifiers: WeakSet<object> };
type Row = {
  name: string;
  mode: 'release' | 'filter';
  axes: Record<string, number>;
  bytes: number;
  shape: { nodes: number; edges: number; filters: number; strings: number; stringUnits: number };
  counts: Counts;
  original: unknown;
  instrumented: unknown;
};
type PatternRow = {
  source: string;
  original: ReturnType<typeof analyzePattern>;
  instrumented: ReturnType<typeof analyzePattern>;
  native: unknown[];
};
export type Evidence = {
  sources: Record<string, { original: string; instrumented: string }>;
  versions: Record<string, string>;
  rows: Row[];
  patterns: PatternRow[];
};

function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error(`Instrumentation anchor must occur exactly once: ${before}`);
  return source.replace(before, after);
}

// Only import specifiers move. All executable changes below are observation at the
// original loop, or observation of the original spread's iterator, never replacement algorithms.
function imports(source: string, directory: string) {
  return source.replace(/from (['"])([^'"]+)\1/g, (match, quote: string, specifier: string) => {
    if (specifier.startsWith('node:')) return match;
    const target = specifier.startsWith('.') ? resolve(directory, specifier) : Bun.resolveSync(specifier, directory);
    return `from ${quote}${target}${quote}`;
  });
}

function shape(value: unknown) {
  let nodes = 0,
    edges = 0,
    strings = 0,
    stringUnits = 0;
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    nodes++;
    if (typeof item === 'string') {
      strings++;
      stringUnits += item.length;
    }
    if (item !== null && typeof item === 'object') {
      const children = Object.values(item);
      edges += children.length;
      pending.push(...children);
      if (!Array.isArray(item))
        for (const key of Object.keys(item)) {
          strings++;
          stringUnits += key.length;
        }
    }
  }
  return { nodes, edges, strings, stringUnits };
}

async function probe(): Promise<Evidence> {
  const temporaryRoot = join(root, '.temp/publication-construction');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'probe-'));
  const global = globalThis as typeof globalThis & { __publicationConstruction?: ProbeState };
  const previous = Object.getOwnPropertyDescriptor(global, '__publicationConstruction');
  const sources: Evidence['sources'] = {};
  function copy(name: string, originalPath: string, source: string, outputPath: string) {
    sources[name] = { original: hash(read(originalPath)), instrumented: hash(source) };
    writeFileSync(outputPath, source);
  }
  try {
    const definitionsPath = join(root, 'packages/definitions/src/index.ts');
    const filterPath = join(root, 'packages/filter/src/filter.ts');
    const typeboxPath = join(root, 'packages/definitions/node_modules/typebox');
    const uniquePath = join(typeboxPath, 'build/schema/engine/uniqueItems.mjs');
    const copiedDirectories: string[] = [];
    cpSync(typeboxPath, join(directory, 'typebox'), {
      recursive: true,
      dereference: true,
      filter(source, destination) {
        if (statSync(source).isDirectory()) copiedDirectories.push(destination);
        return true;
      },
    });
    // The installed cache is read-only. Change modes only on the disposable copy,
    // using the copy's manifest, so instrumentation and finally cleanup can write.
    for (const destination of copiedDirectories) chmodSync(destination, 0o700);
    chmodSync(join(directory, 'typebox/build/schema/engine/uniqueItems.mjs'), 0o600);
    const counter = 'globalThis.__publicationConstruction';
    let unique = read(uniquePath);
    unique = replaceOnce(
      unique,
      'const hash = Hashing.Hash(value);',
      `${counter}.duplicateVisits++;\n        const hash = Hashing.Hash(value);`,
    );
    unique = replaceOnce(unique, 'return [...result, index];', `return [...publicationSpread(result), index];`);
    unique += `\nfunction* publicationSpread(result) {\n  ${counter}.duplicateAppends++;\n  for (const item of result) { ${counter}.duplicateCopies++; yield item; }\n}\n`;
    copy('typebox-uniqueItems', uniquePath, unique, join(directory, 'typebox/build/schema/engine/uniqueItems.mjs'));
    const baseRevision = '2c86ce30ef';
    const originalSource = (path: string) => {
      const result = Bun.spawnSync(['git', 'show', `${baseRevision}:${path}`], { cwd: root });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    };
    const originalFilterPath = join(directory, 'original-filter.ts');
    writeFileSync(originalFilterPath, imports(originalSource('packages/filter/src/filter.ts'), dirname(filterPath)));
    const originalDefinitionsPath = join(directory, 'original-definitions.ts');
    writeFileSync(
      originalDefinitionsPath,
      imports(originalSource('packages/definitions/src/index.ts'), dirname(definitionsPath)).replace(
        Bun.resolveSync('@rezics/filter', dirname(definitionsPath)),
        originalFilterPath,
      ),
    );
    const originalDefinitions = (await import(originalDefinitionsPath)) as typeof import('../../src/index.ts');
    const originalFilter = (await import(originalFilterPath)) as typeof import('../../../filter/src/filter.ts');
    let filter = imports(read(filterPath), dirname(filterPath));
    filter = replaceOnce(
      filter,
      'const item = ownData(value, index);',
      `if (${counter}.bases.has(value)) ${counter}.baseReads++;
       if (${counter}.qualifiers.has(value)) ${counter}.qualifierVisits++;
       const item = ownData(value, index);`,
    );
    filter = replaceOnce(
      filter,
      "for (const base of ownStringList(definition, 'bases')) {",
      `for (const base of ownStringList(definition, 'bases')) {
        if (${counter}.types.has(definition)) ${counter}.baseVisits++;`,
    );
    filter = replaceOnce(
      filter,
      'ancestors.delete(value);',
      `
      if (${counter}.bases.has(value)) ${counter}.bases.add(copy);
      if (${counter}.types.has(value)) ${counter}.types.add(copy);
      if (${counter}.qualifiers.has(value)) ${counter}.qualifiers.add(copy);
      ancestors.delete(value);`,
    );
    filter = replaceOnce(
      filter,
      'const declaredQualifiers = construction.qualifiers.get(statement.property) ?? emptyFacets;',
      'const declaredQualifiers = construction.qualifiers.get(statement.property) ?? emptyFacets;',
    );
    filter = replaceOnce(
      filter,
      'if (!declaredQualifiers.has(qualifier.property) || !qualifierDefinition)',
      `if ((${counter}.qualifierVisits++, !declaredQualifiers.has(qualifier.property)) || !qualifierDefinition)`,
    );
    filter = replaceOnce(
      filter,
      "if (value === null || typeof value !== 'object') return value;",
      `${counter}.snapshotVisits++;
  if (value === null || typeof value !== 'object') return value;`,
    );
    filter = replaceOnce(
      filter,
      'selectedFacets.some((facets) => facets.has(property))',
      `selectedFacets.some((facets) => { ${counter}.facetProbes++; return facets.has(property); })`,
    );
    copy('filter', filterPath, filter, join(directory, 'filter.ts'));
    let definitions = imports(read(definitionsPath), dirname(definitionsPath));
    definitions = definitions.replace(
      Bun.resolveSync('@rezics/filter', dirname(definitionsPath)),
      join(directory, 'filter.ts'),
    );
    definitions = definitions.replace(
      Bun.resolveSync('typebox/schema', dirname(definitionsPath)),
      join(directory, 'typebox/build/schema/index.mjs'),
    );
    const constructionPath = join(root, 'packages/definitions/src/publication-construction.ts');
    let construction = imports(read(constructionPath), dirname(constructionPath));
    construction = construction.replace(
      Bun.resolveSync('typebox/value', dirname(constructionPath)),
      join(directory, 'typebox/build/value/index.mjs'),
    );
    construction = replaceOnce(
      construction,
      'const hash = Hash(member);',
      `${counter}.duplicateVisits++;
          const hash = Hash(member);`,
    );
    construction = replaceOnce(
      construction,
      'seen.add(hash);',
      `${counter}.duplicateAppends++;
          seen.add(hash);`,
    );
    copy('construction', constructionPath, construction, join(directory, 'construction.ts'));
    definitions = definitions.replace(constructionPath, join(directory, 'construction.ts'));
    const hashingPath = join(typeboxPath, 'build/system/hashing/hash.mjs');
    let hashing = read(hashingPath);
    hashing = replaceOnce(
      hashing,
      'function FromValue(value) {',
      `function FromValue(value) { ${counter}.hashNodes++;`,
    );
    hashing = replaceOnce(
      hashing,
      'function FNV1A64_OP(byte) {',
      `function FNV1A64_OP(byte) { ${counter}.hashBytes++;`,
    );
    hashing = replaceOnce(
      hashing,
      'InstanceKeys(value).sort()',
      `InstanceKeys(value).sort((a,b) => { ${counter}.hashSortComparisons++; return a < b ? -1 : a > b ? 1 : 0; })`,
    );
    chmodSync(join(directory, 'typebox/build/system/hashing/hash.mjs'), 0o600);
    copy('hashing', hashingPath, hashing, join(directory, 'typebox/build/system/hashing/hash.mjs'));
    copy('definitions', definitionsPath, definitions, join(directory, 'definitions.ts'));
    const measured = (await import(join(directory, 'definitions.ts'))) as typeof import('../../src/index.ts');
    const measuredFilter = (await import(
      join(directory, 'filter.ts')
    )) as typeof import('../../../filter/src/filter.ts');
    sources.schema = {
      original: hash(read(join(root, 'packages/definitions/schema/release.json'))),
      instrumented: hash(read(join(root, 'packages/definitions/schema/release.json'))),
    };
    const rows: Row[] = [];
    function measure(name: string, mode: Row['mode'], release: Release, axes: Record<string, number>) {
      const state: ProbeState = {
        duplicateVisits: 0,
        duplicateCopies: 0,
        duplicateAppends: 0,
        baseReads: 0,
        baseVisits: 0,
        qualifierVisits: 0,
        snapshotVisits: 0,
        hashNodes: 0,
        hashBytes: 0,
        hashSortComparisons: 0,
        facetProbes: 0,
        bases: new WeakSet(),
        types: new WeakSet(),
        qualifiers: new WeakSet(),
      };
      for (const [key, type] of Object.entries(release.types))
        if (key.startsWith('grow:')) {
          state.bases.add(type.bases);
          state.types.add(type);
        }
      state.qualifiers.add(release.properties[code]!.qualifiers);
      global.__publicationConstruction = state;
      const selected = Object.entries(release.filters ?? {}).filter(([key]) => key.startsWith('construction'));
      function admissions(api: typeof measuredFilter) {
        const owned = api.createFilterConstruction?.(release);
        return selected.map(([key, saved]) => {
          // Observe actual normalized admitted output as well as the complete typed refusal.
          const errors = owned
            ? owned.validateFilter(saved.filter, { saved: false })
            : api.validateFilter(saved.filter, release, { saved: false });
          if (errors.length) return { key, errors };
          return {
            key,
            errors,
            admitted: owned
              ? owned.admitFilter(api.parseFilter(saved.filter), { saved: false })
              : api.admitFilter(api.parseFilter(saved.filter), release, { saved: false }),
          };
        });
      }
      const original = mode === 'release' ? originalDefinitions.validateRelease(release) : admissions(originalFilter);
      const instrumented = mode === 'release' ? measured.validateRelease(release) : admissions(measuredFilter);
      const { bases: _bases, types: _types, qualifiers: _qualifiers, ...counts } = state;
      rows.push({
        name,
        mode,
        axes,
        bytes: Buffer.byteLength(JSON.stringify({ release })),
        shape: { ...shape(release), filters: Object.keys(release.filters ?? {}).length },
        counts,
        original,
        instrumented,
      });
    }
    for (const count of scales)
      for (const member of ['bases', 'mappings', 'qualifiers'] as const) {
        const release = constructionFixture();
        if (member === 'qualifiers') release.properties[code]!.qualifiers = Array(count).fill('schema:name');
        else release.types[rootType]![member] = Array(count).fill('schema:Thing');
        measure(`duplicate-${member}-${count}`, 'release', release, { duplicates: count - 1 });
      }
    // Differential witnesses exercise TypeBox's pinned structural hash on
    // malformed members, including sorted object keys and numeric -0 equality.
    const malformed = constructionFixture();
    const members = [{ a: 1, b: 2 }, { b: 2, a: 1 }, -0, 0, null, null];
    malformed.types[rootType]!.bases = structuredClone(members) as unknown as string[];
    malformed.types[rootType]!.mappings = structuredClone(members) as unknown as string[];
    malformed.types[rootType]!.facets = structuredClone(members) as unknown as string[];
    malformed.properties[code]!.qualifiers = structuredClone(members) as unknown as string[];
    malformed.properties[code]!.mappings = structuredClone(members) as unknown as string[];
    const itemProperty = Object.values(malformed.properties).find((property) => property.datatype === 'wikibase-item');
    if (itemProperty) itemProperty.targets = structuredClone(members) as unknown as string[];
    const quantityProperty = Object.values(malformed.properties).find((property) => property.datatype === 'quantity');
    if (quantityProperty) quantityProperty.units = structuredClone(members) as unknown as string[];
    const relationProperty = Object.values(malformed.properties).find((property) => property.relation);
    if (relationProperty?.relation) relationProperty.relation.filter = structuredClone(members) as unknown as string[];
    for (const profile of Object.values(malformed.libraryProfiles ?? {}))
      for (const source of profile.importSources ?? [])
        source.recordKinds = structuredClone(members) as unknown as string[];
    measure('malformed-unique-members', 'release', malformed, { malformedMembers: members.length });
    const filterRoom = 1024 - Object.keys(bundledRelease.filters ?? {}).length;
    for (const invalid of [false, true]) {
      const mark = (release: Release) => {
        if (invalid)
          for (const [key, saved] of Object.entries(release.filters ?? {}))
            if (key.startsWith('construction')) {
              const children = (saved.filter as Extract<FilterDocument, { and: unknown }>).and;
              const last = children[children.length - 1] as Extract<FilterDocument, { statement: unknown }>;
              const qualifiers = last.statement.qualifiers;
              const statement = qualifiers
                ? {
                    ...last.statement,
                    qualifiers: [...qualifiers.slice(0, -1), { property: 'grow:Missing', in: ['x'] }],
                  }
                : { ...last.statement, in: ['!'] };
              saved.filter = { and: [...children.slice(0, -1), { statement }] };
            }
        return release;
      };
      for (const [index, count] of scales.entries()) {
        const population = Math.min(count, filterRoom);
        const crossed = [1, 8, 64][index]!;
        for (const mode of ['release', 'filter'] as const) {
          measure(`bases-axis-${invalid}-${count}`, mode, mark(constructionFixture(count)), {
            bases: count,
            filters: 1,
          });
          measure(`filters-axis-${invalid}-${count}`, mode, mark(constructionFixture(64, 0, population)), {
            bases: 64,
            filters: population,
          });
          measure(`bases-cross-${invalid}-${count}`, mode, mark(constructionFixture(count, 0, crossed)), {
            bases: count,
            filters: crossed,
          });
          measure(`qualifiers-axis-${invalid}-${count}`, mode, mark(constructionFixture(0, count)), {
            declarations: count,
            filters: 1,
            leaves: 1,
            qualifiers: 1,
          });
          measure(`qualifier-filters-axis-${invalid}-${count}`, mode, mark(constructionFixture(0, 64, population)), {
            declarations: 64,
            filters: population,
            leaves: 1,
            qualifiers: 1,
          });
          measure(`qualifiers-cross-${invalid}-${count}`, mode, mark(constructionFixture(0, count, crossed, 6, 4)), {
            declarations: count,
            filters: crossed,
            leaves: 6,
            qualifiers: 4,
          });
        }
      }
      for (const returnable of [1, 8, 64])
        for (const mode of ['release', 'filter'] as const)
          measure(
            `returnable-axis-${invalid}-${returnable}`,
            mode,
            mark(constructionFixture(64, 0, 8, 1, 1, returnable)),
            { bases: 64 * returnable, filters: 8, returnable },
          );
      // Each grammar axis also grows independently of the declared list.
      for (const leaves of [1, 3, 6])
        for (const mode of ['release', 'filter'] as const)
          measure(`leaves-axis-${invalid}-${leaves}`, mode, mark(constructionFixture(0, 512, 1, leaves, 4)), {
            declarations: 512,
            filters: 1,
            leaves,
            qualifiers: 4,
          });
      for (const qualifiers of [1, 2, 4])
        for (const mode of ['release', 'filter'] as const)
          measure(
            `statement-qualifiers-axis-${invalid}-${qualifiers}`,
            mode,
            mark(constructionFixture(0, 512, 1, 1, qualifiers)),
            { declarations: 512, filters: 1, leaves: 1, qualifiers },
          );
    }
    const patternPath = join(root, 'packages/definitions/src/pattern-safety.ts');
    let pattern = read(patternPath).replace(
      "import.meta.resolve('recheck/lib/browser.js')",
      JSON.stringify(new URL(`file://${Bun.resolveSync('recheck/lib/browser.js', dirname(patternPath))}`).href),
    );
    pattern = replaceOnce(
      pattern,
      'let rezicsPatternSteps = 0;',
      'globalThis.publicationOutcomes = [];\n  let rezicsPatternSteps = 0;',
    );
    pattern = replaceOnce(
      pattern,
      "return { safe: result.status === 'safe'",
      "globalThis.publicationOutcomes.push({status: result.status, checker: result.checker});\n    return { safe: result.status === 'safe'",
    );
    pattern = replaceOnce(
      pattern,
      'return { safe: false, steps: rezicsPatternSteps };',
      "globalThis.publicationOutcomes.push({status: 'exception-or-unknown', steps: rezicsPatternSteps});\n    return { safe: false, steps: rezicsPatternSteps };",
    );
    pattern += `\nexport function publicationOutcomes() { return new Script('publicationOutcomes.splice(0)').runInContext(context); }\n`;
    copy('pattern-safety', patternPath, pattern, join(directory, 'pattern.ts'));
    const diagnostic = (await import(join(directory, 'pattern.ts'))) as {
      analyzePattern: typeof analyzePattern;
      publicationOutcomes(): unknown[];
    };
    const patterns = ['^A$', '^(a+)+$', '^[ab]{32}a[ab]*$', '^[ab]*a[ab]{32}$'].map((source) => {
      const original = analyzePattern(source);
      const instrumented = diagnostic.analyzePattern(source);
      return { source, original, instrumented, native: diagnostic.publicationOutcomes() };
    });
    return {
      sources,
      versions: {
        bun: Bun.version,
        revision: Bun.revision,
        typebox: JSON.parse(read(join(typeboxPath, 'package.json'))).version,
        recheck: JSON.parse(read(join(root, 'packages/definitions/node_modules/recheck/package.json'))).version,
        canonicalize: JSON.parse(read(join(root, 'packages/definitions/node_modules/canonicalize/package.json')))
          .version,
      },
      rows,
      patterns,
    };
  } finally {
    if (previous) Object.defineProperty(global, '__publicationConstruction', previous);
    else delete global.__publicationConstruction;
    rmSync(directory, { recursive: true, force: true });
  }
}

let evidence: Promise<Evidence> | undefined;
export function constructionEvidence(): Promise<Evidence> {
  return (evidence ??= (async () => {
    // All instrumentation and module caches die with this child. No prototype,
    // host clock, installed dependency or product file is ever patched.
    const child = Bun.spawn([process.execPath, import.meta.path, '--probe'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`Construction probe exit ${exit}: ${stderr}\n${stdout}`);
    const report = JSON.parse(stdout) as Evidence;
    console.log('construction native evidence', JSON.stringify(report));
    return report;
  })());
}

export function duplicatePointer(member: string) {
  return member === 'qualifiers' ? `/properties/${pointer(code)}/qualifiers` : `/types/${pointer(rootType)}/${member}`;
}

if (import.meta.main && process.argv.includes('--probe')) console.log(JSON.stringify(await probe()));
