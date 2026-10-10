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
 * Types a revisions-graph subject may already have.
 * `ErasedRevision` is the marker, not a product revision.
 * Identity resolution also names `RevisionAnchor` and `FixedRelease`, which are
 * not `*Revision`: work heads, contribution drafts and fixed releases are stored as those.
 */
export function priorRevisionTypes(identitySource: string, names: readonly string[]): string[] {
  const found = new Set(names.filter(name => name !== 'ErasedRevision'));
  for (const match of identitySource.matchAll(/\ba rv:([A-Z][A-Za-z0-9]+)/g)) {
    if (match[1] !== 'ErasedRevision') found.add(match[1]!);
  }
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
