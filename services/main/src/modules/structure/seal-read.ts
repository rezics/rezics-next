import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { checkStructureSealManifest, InvalidStructureObject, type PinEntry } from './format.ts';
import { pinTree, structureObjects } from './change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID } from './graph.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, newCost, type TreeCost } from './tree.ts';

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
  unavailableCount: number;
  pins: VisiblePin[];
  next: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  cost: TreeCost;
}

/** Retained fixed dependency reads never follow today's publication head. */
export async function readCompositionSeal(env: WorkActivationEnvironment, input: {
  structure: string; seal: string; after?: string; limit: number;
  canReadTarget: (target: string) => Promise<boolean>;
}): Promise<CompositionSealPage> {
  if (!NATIVE_ID.test(input.structure) || !NATIVE_ID.test(input.seal)
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || input.after && (input.after.length > 512 || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}\u0001/.test(input.after))) {
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
  const ordered = await pinTree(objects).range(manifest.pins,
    input.after ? `${input.after}\u0000` : '', '\uffff', input.limit + 1, cost);
  const page = ordered.slice(0, input.limit);
  const pins: VisiblePin[] = [];
  for (const pin of page) {
    pins.push(await input.canReadTarget(pin.target)
      ? pin : { occurrence: pin.occurrence, unavailable: 'undisclosed' });
  }
  return { structure: input.structure, seal: input.seal,
    structureRevision: manifest.structureRevision, coverage, unavailableCount: manifest.unavailableCount,
    pins, next: ordered.length > input.limit ? key(page.at(-1)!) : null,
    sourcePosition: { datasetId: 'product', dataEpoch: value('epoch')!, sequence: value('sequence')! },
    cost };
}
