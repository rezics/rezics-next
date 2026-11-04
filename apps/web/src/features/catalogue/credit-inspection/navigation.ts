import { catalogueDigest } from '@rezics/definitions/catalogue';
import { subjectViewHref } from '../../../subject/subject-href';
import type { CreditAssertion, CreditVisit } from './model';

/** A single address and exact assertion locator. Never a retained authorized body or an editor request. */
export type CreditReturn = {
  context: string;
  definition: string;
  holder?: string;
  property?: string;
  statement?: string;
  revision?: string;
  release?: string;
  slot?: string;
};
const prefix = '#person-credit?';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = ['context', 'definition', 'holder', 'property', 'statement', 'revision', 'release', 'slot'];

export function creditReturn(hash: string): CreditReturn | undefined {
  if (!hash.startsWith(prefix) || hash.length > 4096) return;
  const query = new URLSearchParams(hash.slice(prefix.length));
  const names = [...query.keys()];
  if (new Set(names).size !== names.length || names.some((key) => !keys.includes(key))) return;
  const values = Object.fromEntries(query);
  if (!values.context || !uuid.test(values.context) || !values.definition) return;
  if (Object.values(values).some((value) => !value || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)))
    return;
  const selected = keys.slice(2).filter((key) => query.has(key));
  if (
    selected.length &&
    (selected.length !== 6 ||
      !uuid.test(values.holder!) ||
      !uuid.test(values.statement!) ||
      !/^[1-9]\d{0,9}$/.test(values.revision!) ||
      Number(values.revision) > 2147483647)
  )
    return;
  if (values.slot && values.slot !== 'none' && !/^sha256:[0-9a-f]{64}$/.test(values.slot)) return;
  return values as CreditReturn;
}

function slotIdentity(credit: CreditAssertion): string {
  const slot = credit.slot;
  return slot
    ? catalogueDigest(
        new TextEncoder().encode(JSON.stringify([slot.property, slot.target, slot.sameAs, slot.key, slot.context])),
      )
    : 'none';
}

export function creditLocator(visit: CreditVisit, credit?: CreditAssertion): CreditReturn {
  return {
    context: visit.context,
    definition: visit.definition ?? visit.release,
    ...(credit
      ? {
          holder: credit.holder,
          property: credit.statement.property.id,
          statement: credit.statement.id,
          revision: String(credit.statement.rezics.revision),
          release: credit.statement.rezics.release,
          slot: slotIdentity(credit),
        }
      : {}),
  };
}

export function creditReturnMatches(locator: CreditReturn, visit: CreditVisit, credit: CreditAssertion): boolean {
  const current = creditLocator(visit, credit);
  return keys.every((key) => locator[key as keyof CreditReturn] === current[key as keyof CreditReturn]);
}

/** Reload the original native window. Context is an expectation, never a Context override. */
export function creditWindowHref(visit: CreditVisit, locale: string, credit?: CreditAssertion): string {
  const cursor = visit.stream.kind === 'links' ? visit.stream.cursor : undefined;
  const query = new URLSearchParams({
    node: visit.node,
    ...(cursor ? { cursor } : {}),
    ...(visit.realm ? { realm: visit.realm } : {}),
  });
  const fragment = `${prefix}${new URLSearchParams(creditLocator(visit, credit) as Record<string, string>)}`;
  return `${subjectViewHref({ id: visit.person, label: '' }, locale, 'works')}?${query}${fragment}`;
}
