import { Value } from 'typebox/value';
import {
  creatableWorkTypeOrder,
  typeRegistry,
  typeRegistryDigest,
  workSemanticTypeOrder,
} from '../../../../../packages/model/src/generated/types.ts';
import { TYPES_READ_COST, typeDefinition, typeList } from './contract.ts';

/** Keep generated literal types for consumers after validating the served contract at startup. */
export const admittedTypes = Object.values(typeRegistry).map((entry) => {
  const type = entry.type;
  if (!Value.Check(typeDefinition, entry))
    throw new Error(`Generated Type ${type} breaks its contract`);
  return entry;
});

/** Creation's semantic types; source-adopted catalogue kinds remain admitted here. */
export const workTypeEntries = admittedTypes
  .filter((entry) => entry.base === 'work' && !entry.default)
  .sort((a, b) => workSemanticTypeOrder.indexOf(a.type) - workSemanticTypeOrder.indexOf(b.type));
export const workSemanticTypeOptions = workTypeEntries.map((entry) => entry.type);
/** Native type edits use the narrower set compiled from work-type-v2. */
export const creatableWorkTypeOptions = admittedTypes
  .filter((entry) => entry.creatable)
  .map((entry) => entry.type)
  .sort((a, b) => creatableWorkTypeOrder.indexOf(a) - creatableWorkTypeOrder.indexOf(b));

const list = { profile: 'types-v1' as const, digest: typeRegistryDigest, types: admittedTypes };
if (!Value.Check(typeList, list)) throw new Error('Generated Type list breaks its contract');
export const typeListBody = JSON.stringify(list);
export const typeListTag = `"${typeRegistryDigest}"`;
if (Buffer.byteLength(typeListBody) > TYPES_READ_COST.maxBytes)
  throw new Error('Type list exceeds its byte bound');
