import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { checkStructureSealManifest, InvalidStructureObject, type PinEntry } from './format.ts';
import { pinTree, structureObjects } from './change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID } from './graph.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, newCost } from './tree.ts';
import { decodeReadCursor, encodeReadCursor } from '../work/read-session.ts';

export interface VisiblePin {
  occurrence: string;
  target?: string;
  variant?: string;
  revision?: string;
  unavailable?: 'erased' | 'withdrawn' | 'undisclosed' | 'missing';
}

export interface CompositionSealPage {
  structure: string;
  seal: string;
  structureRevision: string;
  coverage: 'complete' | 'partial';
  pins: VisiblePin[];
  next: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** Retained fixed dependency reads never follow today's publication head. */
export async function readCompositionSeal(env: WorkActivationEnvironment, input: {
  structure: string; seal: string; after?: string; limit: number;
  canReadTarget: (target: string) => Promise<boolean>;
}): Promise<CompositionSealPage> {
  if (!NATIVE_ID.test(input.structure) || !NATIVE_ID.test(input.seal)
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || input.after && input.after.length > 2048) {
    throw new CompositionUnavailable('invalid composition seal page');
  }
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?manifest ?coverage
    ?unavailable ?epoch ?sequence WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(input.seal)} a rv:StructureSeal ; rv:structure ${iri(input.structure)} ;
        rv:structureRevision ?revision ; rv:manifest ?manifest ; rv:sealCoverage ?coverage ;
        rv:unavailableCount ?unavailable ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
    } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) throw new CompositionUnavailable('composition seal is unavailable');
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const coverage = value('coverage') === `${RV}Complete` ? 'complete'
    : value('coverage') === `${RV}Partial` ? 'partial' : null;
  if (rows.length !== 1 || !NATIVE_ID.test(value('revision') ?? '')
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(value('manifest') ?? '')
    || !coverage || !/^[0-9]+$/.test(value('unavailable') ?? '')
    || !/^[0-9]+$/.test(value('sequence') ?? '') || !value('epoch')) {
    throw new CompositionCorrupt('composition seal anchor is incomplete');
  }
  const objects = structureObjects(env);
  let bytes: Uint8Array;
  try { bytes = await objects.get(value('manifest')!.slice(-64)); }
  catch (error) {
    if (error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    throw error;
  }
  let manifest;
  try { manifest = checkStructureSealManifest(bytes); }
  catch (error) {
    if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
    throw error;
  }
  if (manifest.structure !== input.structure || manifest.structureRevision !== value('revision')
    || manifest.coverage !== coverage || manifest.unavailableCount !== Number(value('unavailable'))) {
    throw new StructureObjectCorrupt('composition seal manifest differs from its anchor');
  }
  const cost = newCost();
  cost.pagesRead++;
  const key = (pin: PinEntry) => `${pin.occurrence}\u0001${pin.variant ?? ''}`;
  const position = { dataEpoch: value('epoch')!, sequence: value('sequence')! };
  const binding = { structure: input.structure, seal: input.seal };
  let after: string | undefined;
  try { after = decodeReadCursor(input.after, binding, position)?.after; }
  catch { throw new CompositionUnavailable('composition seal cursor is invalid'); }
  const pins: PinEntry[] = [];
  const access = new Map<string, boolean>();
  while (true) {
    const ordered = await pinTree(objects).range(manifest.pins,
      after ? `${after}\u0000` : '', '\uffff', 101, cost);
    for (const pin of ordered) {
      if (!access.has(pin.target)) access.set(pin.target, await input.canReadTarget(pin.target));
      if (access.get(pin.target)) pins.push(pin);
      if (pins.length > input.limit) break;
    }
    if (pins.length > input.limit || ordered.length < 101) break;
    after = key(ordered.at(-1)!);
  }
  const hasNext = pins.length > input.limit;
  pins.splice(input.limit);
  return { structure: input.structure, seal: input.seal,
    structureRevision: manifest.structureRevision, coverage,
    pins, next: hasNext ? encodeReadCursor(binding, position, key(pins.at(-1)!)) : null,
    sourcePosition: { datasetId: 'product', dataEpoch: value('epoch')!, sequence: value('sequence')! },
  };
}
