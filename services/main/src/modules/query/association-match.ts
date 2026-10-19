import type { AssociationSelection, AssociationWitness } from './association-contract.ts';
import { associationCanonical, associationParticipantKey } from './association-selection.ts';

/** Match only a witness already scoped by the existing readers to current
 * disclosure, adoption, exact coverage and compatible Context/frame. A query
 * never constructs that proof from a role name, label or a V1 Statement.
 * In particular, inspecting a qualified assertion does not make it positive. */
export function matchesAssociation(selection: AssociationSelection, witness: AssociationWitness): boolean {
  const { kind, direction, roots, match } = selection.parameters;
  if (witness.kind !== kind) return false;
  const subject = associationParticipantKey(witness.subject);
  if (roots && !roots.some(root => direction === 'work-to-subject'
    ? root.kind === 'resource' && root.ref === witness.work : associationParticipantKey(root) === subject)) return false;
  if (match.role && match.role !== witness.role) return false;
  if ((match.role || match.all.length || match.any.length) && witness.qualification !== 'asserted') return false;
  const asserted = new Set(witness.statements.filter(statement => statement.qualification === 'asserted'
    && statement.value.kind !== 'unknown' && associationParticipantKey(statement.subject) === subject
    && (statement.occurrence === witness.occurrence || statement.occurrence === null))
    .map(statement => associationCanonical({ predicate: statement.predicate, value: statement.value })));
  const has = (predicate: AssociationSelection['parameters']['match']['all'][number]) => asserted.has(associationCanonical(predicate));
  return match.all.every(has) && (!match.any.length || match.any.some(has)) && !match.none.some(has);
}
