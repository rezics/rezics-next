import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Same scan the revision-class enumeration uses: every `rv:*Revision` local name. */
export function revisionClassNames(definitions: string): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(definitions).sort()) {
    if (!file.endsWith('.ttl')) continue;
    for (const match of readFileSync(join(definitions, file), 'utf8')
      .matchAll(/\brv:([A-Z][A-Za-z0-9]*Revision)\b/g)) found.add(match[1]!);
  }
  return [...found].sort();
}

/**
 * Types, other than `rv:*Revision`, that identity resolution stores a revisions-graph
 * subject as: work heads and contribution drafts are `RevisionAnchor`, a fixed release
 * is `FixedRelease`, and a text contribution owner is `TextContribution`.
 * `services/main/tests/erasure-revision-kinds.test.ts` checks that every type
 * `modules/erasure/revision-kind.ts` resolves is a `*Revision` name or one of these,
 * so the compiler does not read a service source file.
 */
export const IDENTITY_RESOLUTION_TYPES = ['FixedRelease', 'RevisionAnchor', 'TextContribution'] as const;

/**
 * Types a revisions-graph subject may already have.
 * `ErasedRevision` is the marker, not a product revision.
 */
export function priorRevisionTypes(names: readonly string[]): string[] {
  const found = new Set(names.filter(name => name !== 'ErasedRevision'));
  for (const name of IDENTITY_RESOLUTION_TYPES) found.add(name);
  return [...found].sort();
}

export function renderRevisionClasses(names: readonly string[], prior: readonly string[]): string {
  const list = (values: readonly string[]) => values.map(name => `        "${name}"`).join(',\n');
  return `package com.rezics.jena;

import java.util.Set;

/** Generated from model definitions. Do not edit. */
public final class RevisionClasses {
    /** Every {@code rv:*Revision} local name in the model definitions. */
    public static final Set<String> NAMES = Set.of(
${list(names)}
    );

    /**
     * Prior {@code rdf:type} local names that make an id IRI a revision subject.
     * {@code ErasedRevision} is excluded: it is the marker. {@code RevisionAnchor} and
     * {@code FixedRelease} are included because identity resolution stores work heads,
     * contribution drafts and fixed releases as those types.
     */
    public static final Set<String> PRIOR = Set.of(
${list(prior)}
    );

    private RevisionClasses() {}
}
`;
}
