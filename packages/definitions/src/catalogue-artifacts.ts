/** Server-side admission over complete immutable Release1 artifacts. */
export * from './catalogue.ts';
import {
  validateRelease,
  releaseDigest,
  type Release,
  type LibraryProfilePin,
  type LibraryProfile,
  type TypeDefinition,
} from './index.ts';
import { RELEASE_LIMITS } from './portable.ts';
import {
  CATALOGUE_FORMAT,
  CATALOGUE_NODE_FORMAT,
  CATALOGUE_LIMITS,
  KIND_FORMAT,
  KIND_REDUCTION,
  catalogueBytes,
  catalogueDigest,
  catalogueFail,
  assertCatalogueDigest,
  assertKindId,
  parseCatalogueJson,
  parseCatalogueNode,
  parseCatalogueRoot,
  parseCataloguePin,
  parseKindDeclaration,
  requireConstructibleKind,
  declarationKey,
  releaseKey,
  catalogueNodeRange,
  compareCatalogueKeys,
  type KindCataloguePin,
  type KindDeclarationV1,
  type PinnedKindDeclaration,
  type DefinitionTypePin,
  type CatalogueArtifactReader,
  type CatalogueArtifactStore,
  type CatalogueRootV2,
  type CatalogueNodeV1,
  type CatalogueEntry,
  type CatalogueRange,
} from './catalogue.ts';

function genuineRelease(value: unknown): Release {
  // Preserve historical validity. New-digest publication caps are deliberately not applied to archived releases.
  const errors = validateRelease(value);
  if (errors.length) catalogueFail('invalid', `Invalid Release1: ${JSON.stringify(errors)}`);
  return value as Release; // Narrowed by the genuine existing release validator, never a caller assertion.
}
export async function readCatalogueArtifact(
  reader: CatalogueArtifactReader,
  digest: string,
  maximum: number,
): Promise<unknown> {
  assertCatalogueDigest(digest);
  const bytes = await reader.read(digest);
  if (bytes === undefined) catalogueFail('missing', `Missing artifact ${digest}`);
  if (bytes.length > maximum || catalogueDigest(bytes) !== digest)
    catalogueFail('corrupt', `Corrupt artifact ${digest}`);
  const value = parseCatalogueJson(bytes, maximum);
  const canonical = catalogueBytes(value);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    catalogueFail('corrupt', `Noncanonical stored artifact ${digest}`);
  return value;
}
async function put(store: CatalogueArtifactStore, value: unknown): Promise<string> {
  const bytes = catalogueBytes(value);
  const digest = catalogueDigest(bytes);
  const existing = await store.read(digest);
  if (existing !== undefined && (existing.length !== bytes.length || existing.some((b, i) => b !== bytes[i])))
    catalogueFail('conflict', `Conflicting stored bytes ${digest}`);
  if (existing === undefined) await store.put(digest, bytes);
  return digest;
}
function makePin(rootDigest: string): KindCataloguePin {
  return { format: CATALOGUE_FORMAT, rootDigest, kindSpec: KIND_FORMAT, reduction: KIND_REDUCTION };
}
export function compatibilityKind(release: Release, digest: string, typeId: string): KindDeclarationV1 {
  assertCatalogueDigest(digest);
  assertKindId(typeId);
  const type = Object.hasOwn(release.types, typeId) ? release.types[typeId] : undefined;
  if (!type) catalogueFail('missing', `Missing compatibility Type ${typeId} in ${digest}`);
  return parseKindDeclaration({
    format: KIND_FORMAT,
    id: typeId,
    labels: type.labels,
    ...(type.descriptions === undefined ? {} : { descriptions: type.descriptions }),
    auto: { eligible: true, precedence: 0 },
    condition: { op: 'exact-type', type: { releaseDigest: digest, typeId } },
    presentation: { type: { releaseDigest: digest, typeId } },
  });
}
export type CatalogueBuildInput = Readonly<{
  releases: Iterable<unknown>;
  declarations?: Iterable<unknown>;
  compatibility?: 'all' | Iterable<DefinitionTypePin>;
}>;
/** Finite authoring work: O(N log N + B), bounded pack work per member; no total member/node ceiling.
 * Stores complete Releases, declarations and O(N/256) balanced nodes. Sorting and the entry map are build-only.
 */
export async function buildCatalogue(
  input: CatalogueBuildInput,
  store: CatalogueArtifactStore,
): Promise<KindCataloguePin> {
  const entries = new Map<string, CatalogueEntry>();
  const releases = new Map<string, Release>();
  function add(entry: CatalogueEntry) {
    if (entries.has(entry.key)) catalogueFail('conflict', `Duplicate typed key ${entry.key}`);
    entries.set(entry.key, entry);
  }
  for (const value of input.releases) {
    const bytes = catalogueBytes(value); // Reject accessors before native validation and retain owned immutable meaning.
    const release = genuineRelease(parseCatalogueJson(bytes, RELEASE_LIMITS.bytes));
    const digest = await put(store, release);
    add({ key: releaseKey(digest), kind: 'release', digest });
    releases.set(digest, release);
  }
  for (const value of input.declarations ?? []) {
    const declaration = parseKindDeclaration(value);
    requireConstructibleKind(declaration);
    const digest = await put(store, declaration);
    add({ key: declarationKey(declaration.id), kind: 'declaration', digest });
  }
  const pins =
    input.compatibility === 'all'
      ? (function* () {
          for (const [releaseDigest, release] of releases)
            for (const typeId of Object.keys(release.types)) yield { releaseDigest, typeId };
        })()
      : (input.compatibility ?? []);
  for (const pin of pins) {
    // The closed declaration parser below also validates both exact pin fields.
    const release = releases.get(pin.releaseDigest);
    if (!release) catalogueFail('missing', `Missing compatibility release ${pin.releaseDigest}`);
    const declaration = compatibilityKind(release, pin.releaseDigest, pin.typeId);
    const digest = await put(store, declaration);
    add({ key: declarationKey(declaration.id), kind: 'declaration', digest });
  }
  if (!entries.size) catalogueFail('invalid', 'A catalogue needs at least one release');
  let level: CatalogueRange[] = [];
  const ordered = [...entries.values()].sort((a, b) => compareCatalogueKeys(a.key, b.key));
  // Both count AND canonical-byte bounds determine packing; long stable IDs never overflow a node.
  async function pack<T>(
    items: readonly T[],
    make: (group: readonly T[]) => CatalogueNodeV1,
  ): Promise<CatalogueRange[]> {
    const ranges: CatalogueRange[] = [];
    let group: T[] = [];
    async function flush() {
      if (!group.length) return;
      const node = parseCatalogueNode(make(group));
      ranges.push({ ...catalogueNodeRange(node), digest: await put(store, node) });
      group = [];
    }
    for (const item of items) {
      if (
        group.length &&
        (group.length === CATALOGUE_LIMITS.entries ||
          catalogueBytes(make([...group, item])).length > CATALOGUE_LIMITS.nodeBytes)
      )
        await flush();
      group.push(item);
    }
    await flush();
    return ranges;
  }
  level = await pack(ordered, (entries) => ({ format: CATALOGUE_NODE_FORMAT, node: 'leaf', entries }));
  while (level.length > 1) {
    const next = await pack(level, (children) => ({ format: CATALOGUE_NODE_FORMAT, node: 'branch', children }));
    if (next.length >= level.length) catalogueFail('invalid', 'Directory range keys cannot fit a branching node');
    level = next;
  }
  const root: CatalogueRootV2 = {
    format: CATALOGUE_FORMAT,
    kindSpec: KIND_FORMAT,
    reduction: KIND_REDUCTION,
    directoryDigest: level[0]!.digest,
  };
  const pin = makePin(await put(store, root));
  await verifyCatalogue(pin, store); // No root publication until every reachable artifact and exact closure is complete.
  return pin;
}

async function rootFor(pin: KindCataloguePin, reader: CatalogueArtifactReader): Promise<CatalogueRootV2> {
  const admitted = parseCataloguePin(pin);
  return parseCatalogueRoot(await readCatalogueArtifact(reader, admitted.rootDigest, CATALOGUE_LIMITS.nodeBytes));
}
async function nodeFor(
  digest: string,
  reader: CatalogueArtifactReader,
  expected?: { first: string; last: string },
): Promise<CatalogueNodeV1> {
  const node = parseCatalogueNode(await readCatalogueArtifact(reader, digest, CATALOGUE_LIMITS.nodeBytes));
  const actual = catalogueNodeRange(node);
  if (expected && (expected.first !== actual.first || expected.last !== actual.last))
    catalogueFail('corrupt', `Incomplete or inaccurate directory range ${digest}`);
  return node;
}
/** Descend only the addressed path. Each step parses <=256 entries/256KiB; no global map, sort or scan. */
async function findEntry(
  root: CatalogueRootV2,
  key: string,
  reader: CatalogueArtifactReader,
): Promise<CatalogueEntry | undefined> {
  let digest = root.directoryDigest;
  let expected: CatalogueRange | undefined;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(digest)) catalogueFail('conflict', `Directory cycle ${digest}`);
    visited.add(digest);
    const node = await nodeFor(digest, reader, expected);
    if (node.node === 'leaf') {
      let low = 0,
        high = node.entries.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (node.entries[mid]!.key < key) low = mid + 1;
        else high = mid;
      }
      return node.entries[low]?.key === key ? node.entries[low] : undefined;
    }
    let low = 0,
      high = node.children.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (node.children[mid]!.last < key) low = mid + 1;
      else high = mid;
    }
    const child = node.children[low];
    if (!child || child.first > key) return undefined;
    expected = child;
    digest = child.digest;
  }
}
export type ResolvedCatalogueType = Readonly<{
  pin: DefinitionTypePin;
  /** Complete original Release1, never a descriptor subset masquerading as a Release. */
  release: Release;
  type: TypeDefinition;
  listPresentation: TypeDefinition['listPresentation'] | null;
  library: Readonly<{ pin: LibraryProfilePin; profile: LibraryProfile }> | null;
}>;
export type CatalogueKindLookup =
  | Readonly<{ status: 'not-found'; catalogue: KindCataloguePin }>
  | (PinnedKindDeclaration &
      Readonly<{ status: 'found'; condition: ResolvedCatalogueType; presentation: ResolvedCatalogueType }>);
function typeFromRelease(pin: DefinitionTypePin, release: Release): ResolvedCatalogueType {
  const type = Object.hasOwn(release.types, pin.typeId) ? release.types[pin.typeId] : undefined;
  if (!type) catalogueFail('missing', `Missing exact Type ${pin.typeId} in ${pin.releaseDigest}`);
  let library: ResolvedCatalogueType['library'] = null;
  if (type.library !== undefined) {
    const profile =
      release.libraryProfiles && Object.hasOwn(release.libraryProfiles, type.library.profileId)
        ? release.libraryProfiles[type.library.profileId]
        : undefined;
    if (!profile) catalogueFail('missing', `Missing exact profile ${type.library.profileId} in ${pin.releaseDigest}`);
    library = {
      pin: {
        provenance: 'profile',
        releaseDigest: pin.releaseDigest,
        acceptingType: pin.typeId,
        profileId: profile.id,
      },
      profile,
    };
  }
  return { pin, release, type, listPresentation: type.listPresentation ?? null, library };
}
/** Absence is a result; missing/corrupt selected bytes or pins are errors. No unrelated artifact is loaded. */
export async function lookupCatalogueKind(
  pin: KindCataloguePin,
  id: string,
  reader: CatalogueArtifactReader,
): Promise<CatalogueKindLookup> {
  assertKindId(id);
  const catalogue = parseCataloguePin(pin);
  const root = await rootFor(catalogue, reader);
  const entry = await findEntry(root, declarationKey(id), reader);
  if (!entry) return { status: 'not-found', catalogue };
  const declaration = parseKindDeclaration(
    await readCatalogueArtifact(reader, entry.digest, CATALOGUE_LIMITS.declarationBytes),
  );
  if (declaration.id !== id) catalogueFail('corrupt', `Declaration identity mismatch ${id}`);
  requireConstructibleKind(declaration);
  if (declaration.condition.op !== 'exact-type') return catalogueFail('unsupported', 'Unsupported Kind condition');
  const releases = new Map<string, Release>(); // Selected closure only, at most two Release artifacts.
  async function resolve(pin: DefinitionTypePin) {
    let release = releases.get(pin.releaseDigest);
    if (!release) {
      const member = await findEntry(root, releaseKey(pin.releaseDigest), reader);
      if (!member) catalogueFail('missing', `Release is outside catalogue closure ${pin.releaseDigest}`);
      release = genuineRelease(await readCatalogueArtifact(reader, member.digest, RELEASE_LIMITS.bytes));
      releases.set(pin.releaseDigest, release);
    }
    return typeFromRelease(pin, release);
  }
  return {
    status: 'found',
    catalogue,
    declarationDigest: entry.digest,
    declaration,
    condition: await resolve(declaration.condition.type),
    presentation: await resolve(declaration.presentation.type),
  };
}
export type CatalogueVerification = Readonly<{
  catalogue: KindCataloguePin;
  nodes: number;
  releases: number;
  declarations: number;
}>;
/** Exhaustive authoring verification, O(total bytes + entries); bounded DFS steps, no total population cap. */
export async function verifyCatalogue(
  pin: KindCataloguePin,
  reader: CatalogueArtifactReader,
): Promise<CatalogueVerification> {
  const catalogue = parseCataloguePin(pin);
  const root = await rootFor(catalogue, reader);
  const entries = new Map<string, CatalogueEntry>();
  const nodes = new Set<string>();
  const pending: { digest: string; range?: CatalogueRange }[] = [{ digest: root.directoryDigest }];
  while (pending.length) {
    const next = pending.pop()!;
    if (nodes.has(next.digest)) catalogueFail('conflict', `Repeated directory node or cycle ${next.digest}`);
    nodes.add(next.digest);
    const node = await nodeFor(next.digest, reader, next.range);
    if (node.node === 'branch') {
      for (const range of node.children) pending.push({ digest: range.digest, range });
    } else
      for (const entry of node.entries) {
        if (entries.has(entry.key)) catalogueFail('conflict', `Duplicate typed key ${entry.key}`);
        entries.set(entry.key, entry);
      }
  }
  const releases = new Map<string, Release>();
  const identities = new Map<string, string>();
  function identity(key: string, body: unknown) {
    const digest = catalogueDigest(catalogueBytes(body));
    const old = identities.get(key);
    if (old !== undefined && old !== digest) catalogueFail('conflict', `Conflicting repeated identity ${key}`);
    identities.set(key, digest);
  }
  for (const entry of entries.values())
    if (entry.kind === 'release') {
      const release = genuineRelease(await readCatalogueArtifact(reader, entry.digest, RELEASE_LIMITS.bytes));
      if (releaseDigest(release) !== entry.digest)
        catalogueFail('corrupt', `Release identity mismatch ${entry.digest}`);
      identity(`release:${JSON.stringify([release.catalogue.id, release.catalogue.version])}`, release);
      for (const [id, body] of Object.entries(release.types)) identity(`type:${id}`, body);
      for (const [id, body] of Object.entries(release.properties)) identity(`property:${id}`, body);
      for (const [id, body] of Object.entries(release.libraryProfiles ?? {})) identity(`profile:${id}`, body);
      releases.set(entry.digest, release);
    }
  if (!releases.size) catalogueFail('invalid', 'Catalogue contains no Release1 artifacts');
  let declarations = 0;
  for (const entry of entries.values())
    if (entry.kind === 'declaration') {
      const declaration = parseKindDeclaration(
        await readCatalogueArtifact(reader, entry.digest, CATALOGUE_LIMITS.declarationBytes),
      );
      if (entry.key !== declarationKey(declaration.id))
        catalogueFail('corrupt', `Declaration key mismatch ${entry.key}`);
      requireConstructibleKind(declaration);
      if (declaration.condition.op !== 'exact-type') catalogueFail('unsupported', 'Unsupported Kind condition');
      for (const pin of [declaration.condition.type, declaration.presentation.type]) {
        const release = releases.get(pin.releaseDigest);
        if (!release) catalogueFail('missing', `Missing exact release closure ${pin.releaseDigest}`);
        typeFromRelease(pin, release);
      }
      declarations++;
    }
  return { catalogue, nodes: nodes.size, releases: releases.size, declarations };
}
