import { Value } from 'typebox/value';
import { checkedSemanticValue } from '../semantic/value.ts';
import type { Participant } from '../relation/schema.ts';
import { WorkReadInvalid } from '../work/read-session.ts';
import { associationRequest, type AssociationSelection } from './association-contract.ts';

/** Complete external identity is part of selection and joins, including namespace. */
export const associationParticipantKey = (participant: Participant): string => participant.kind === 'resource'
  ? JSON.stringify(['resource', participant.ref])
  : JSON.stringify(['external', participant.provider, participant.namespace, participant.key]);

/** Object member order never changes an exact tagged value or cursor selection. */
export function associationCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(associationCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, member]) => member !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, member]) => `${JSON.stringify(key)}:${associationCanonical(member)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new WorkReadInvalid('Invalid association selection value');
  return encoded;
}

/** Normalize values through their owner. Cross-reference/frame/Realm admission
 * still belongs to the live readers; shape checking cannot grant authority. */
export function selectAssociations(input: unknown, language = 'en'): AssociationSelection {
  if (!Value.Check(associationRequest, input)) throw new WorkReadInvalid('Invalid subject association selection');
  const { cursor: _cursor, ...request } = input;
  const parameters = request.parameters;
  if (!parameters.roots && (parameters.direction !== 'work-to-subject'
    || !(parameters.match.role || parameters.match.all.length || parameters.match.any.length || parameters.match.none.length))) {
    throw new WorkReadInvalid('Catalogue association reads require a role or predicate filter');
  }
  if (parameters.roots?.some(root => root.kind === 'external'
    && (parameters.direction !== 'subject-to-work' || parameters.kind !== 'credit'))) {
    throw new WorkReadInvalid('External roots require an inverse credit selection');
  }
  let roots: Participant[] | undefined;
  try { roots = parameters.roots?.map(root => checkedSemanticValue(root) as Participant); }
  catch { throw new WorkReadInvalid('Invalid exact association root'); }
  if (roots && new Set(roots.map(associationParticipantKey)).size !== roots.length) throw new WorkReadInvalid('Association roots must be distinct');
  const match = { ...parameters.match };
  for (const mode of ['all', 'any', 'none'] as const) {
    try { match[mode] = match[mode].map(item => ({ predicate: item.predicate, value: checkedSemanticValue(item.value) })); }
    catch { throw new WorkReadInvalid('Invalid exact association predicate value'); }
    const keys = match[mode].map(associationCanonical);
    if (new Set(keys).size !== keys.length) throw new WorkReadInvalid('Association predicates must be distinct');
  }
  return { ...request, parameters: { ...parameters, ...(roots ? { roots } : {}), match },
    presentation: { ...request.presentation, language: request.presentation?.language ?? language }, limit: request.limit ?? 20 };
}

/** A restart preserves selection while dropping only obsolete continuation/pins. */
export function restartAssociations(selection: AssociationSelection): AssociationSelection {
  const { snapshot: _snapshot, ...parameters } = selection.parameters;
  return { ...selection, parameters };
}
