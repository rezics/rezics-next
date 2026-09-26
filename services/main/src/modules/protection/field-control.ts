import { createHash } from 'node:crypto';

/** Stable field identity; a current literal or list offset is never a field key. */
export interface EditorialFieldTarget {
  component: string;
  definition: string;
  occurrence: string | null;
  context: string;
}

export interface EditorialControlBasis {
  head: string | null;
  epoch: string;
  protection: string | null;
}

const IRI = /^(?:https:\/\/rezics\.com\/(?:id|definition|vocab)\/[A-Za-z0-9:._/-]+|urn:rezics:[A-Za-z0-9:._-]+)$/;
const EPOCH = /^(0|[1-9][0-9]{0,18})$/;

export function validEditorialControlBasis(basis: EditorialControlBasis): boolean {
  return !!basis && Object.hasOwn(basis, 'head') && Object.hasOwn(basis, 'protection')
    && EPOCH.test(basis.epoch)
    && (basis.head === null ? basis.epoch === '0' : basis.epoch !== '0' && IRI.test(basis.head))
    && (basis.protection === null || IRI.test(basis.protection));
}

/** Domain-separated, ordered identity for owner-local field-control slots. */
export function editorialFieldSlot(target: EditorialFieldTarget): string {
  if (!IRI.test(target.component) || !IRI.test(target.definition)
    || (target.occurrence !== null && !IRI.test(target.occurrence)) || !IRI.test(target.context)) {
    throw new Error('admitted field definition, occurrence and context are required');
  }
  return `urn:rezics:editorial-field:${createHash('sha256').update(JSON.stringify([
    'rezics-editorial-field-v1', target.component, target.definition, target.occurrence, target.context,
  ])).digest('hex')}`;
}
