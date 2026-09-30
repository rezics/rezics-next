import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { Format } from 'typebox/format';
import {
  creatableWorkTypeOrder,
  typeRegistry,
  typeRegistryDigest,
  workSemanticTypeOrder,
} from '../../../../../packages/model/src/generated/types.ts';
import { TYPES_READ_COST, typeDefinition, typeList, type TypeDefinition } from './contract.ts';

export interface RegisteredType {
  definition: TypeDefinition;
  revision: string;
  lifecycle: 'active' | 'retired';
}

const compiledTypes: TypeDefinition[] = Object.values(typeRegistry);
export const admittedTypes: TypeDefinition[] = [];
/** Retained entries also describe existing Works after retirement. */
export const workTypeEntries: TypeDefinition[] = [];
export const workSemanticTypeOptions: string[] = [];
export const choiceWorkTypeOptions: string[] = [];
export const creatableWorkTypeOptions: string[] = [];
/** Compiled validators call this predicate after each registry refresh. */
Format.Set('rezics-work-type', (value) => workSemanticTypeOptions.includes(value));
const activeWorkTypes = new Set<string>();
const listeners = new Set<() => void>();
let installedSnapshot: string | undefined;
export function onTypeRegistryChange(listener: () => void): void {
  listeners.add(listener);
}

export let typeListBody: string;
export let typeListTag: string;

export function workTypeAdmitted(type: string): boolean {
  return activeWorkTypes.has(type);
}
export function compiledType(type: string): TypeDefinition | undefined {
  return compiledTypes.find((entry) => entry.type === type);
}

function registrySnapshot(rows: readonly RegisteredType[]) {
  // A later compiled definition is authoritative over an older admitted row.
  rows = rows.filter(row => !compiledType(row.definition.type));
  if (rows.length + compiledTypes.length > TYPES_READ_COST.maxTypes)
    throw new Error('Type registry exceeds its inventory bound');
  const seen = new Set(compiledTypes.map((entry) => entry.type));
  for (const row of rows) {
    if (
      !Value.Check(typeDefinition, row.definition) ||
      row.definition.default ||
      !['work', 'resource'].includes(row.definition.base) ||
      (row.lifecycle === 'active' && row.definition.creatable !== (row.definition.base === 'work')) ||
      !['active', 'retired'].includes(row.lifecycle) ||
      !/^[1-9][0-9]*$/.test(row.revision) ||
      seen.has(row.definition.type)
    )
      throw new Error('Invalid admitted Type registry row');
    seen.add(row.definition.type);
  }
  const listed = [
    ...compiledTypes,
    ...rows.map((row) => row.lifecycle === 'retired'
      ? { ...row.definition, creatable: false } : row.definition),
  ].sort((a, b) => a.type.localeCompare(b.type));
  const digest = rows.length
    ? createHash('sha256').update(JSON.stringify(listed)).digest('hex')
    : typeRegistryDigest;
  const list = { profile: 'types-v1' as const, digest, types: listed };
  if (!Value.Check(typeList, list)) throw new Error('Type list breaks its contract');
  const body = JSON.stringify(list);
  if (Buffer.byteLength(body) > TYPES_READ_COST.maxBytes)
    throw new Error('Type list exceeds its byte bound');
  return { listed, digest, body };
}

/** Admission must prove the complete response fits before committing its row. */
export function assertRegisteredTypeSnapshot(rows: readonly RegisteredType[]): void {
  const { body } = registrySnapshot(rows);
  // Each active Work's eventual true -> false retirement costs one extra byte.
  const retirementBytes = rows.filter(row => !compiledType(row.definition.type)
    && row.lifecycle === 'active' && row.definition.base === 'work').length;
  if (Buffer.byteLength(body) + retirementBytes > TYPES_READ_COST.maxBytes)
    throw new Error('Type list exceeds its retirement byte bound');
}

/** Build and validate before publishing; every consumer keeps its array identity. */
export function installRegisteredTypes(rows: readonly RegisteredType[]): void {
  const { listed, digest, body } = registrySnapshot(rows);
  rows = rows.filter(row => !compiledType(row.definition.type));
  const snapshot = JSON.stringify(rows);
  if (snapshot === installedSnapshot) return;
  const order = (type: string, baseline: readonly string[]) => {
    const index = baseline.indexOf(type);
    return index < 0 ? baseline.length : index;
  };
  const works = listed
    .filter((entry) => entry.base === 'work' && !entry.default)
    .sort(
      (a, b) =>
        order(a.type, workSemanticTypeOrder) - order(b.type, workSemanticTypeOrder) ||
        a.type.localeCompare(b.type),
    );
  admittedTypes.splice(0, admittedTypes.length, ...listed);
  workTypeEntries.splice(0, workTypeEntries.length, ...works);
  workSemanticTypeOptions.splice(
    0,
    workSemanticTypeOptions.length,
    ...works.map((entry) => entry.type),
  );
  choiceWorkTypeOptions.splice(
    0,
    choiceWorkTypeOptions.length,
    ...[...works]
      .sort((a, b) => a.priority - b.priority || a.type.localeCompare(b.type))
      .map((entry) => entry.type),
  );
  creatableWorkTypeOptions.splice(
    0,
    creatableWorkTypeOptions.length,
    ...works
      .filter((entry) => entry.creatable)
      .sort(
        (a, b) =>
          order(a.type, creatableWorkTypeOrder) - order(b.type, creatableWorkTypeOrder) ||
          a.type.localeCompare(b.type),
      )
      .map((entry) => entry.type),
  );
  activeWorkTypes.clear();
  const active = [...compiledTypes, ...rows.filter(row => row.lifecycle === 'active').map(row => row.definition)];
  for (const entry of active)
    if (entry.base === 'work' && !entry.default) activeWorkTypes.add(entry.type);
  typeListBody = body;
  typeListTag = `"${digest}"`;
  installedSnapshot = snapshot;
  for (const listener of listeners) listener();
}

installRegisteredTypes([]);
