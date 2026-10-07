/** The parsed SHACL subset consumed by the model lowerers. */
export type Term = `${string}:${string}` | `<${string}>` | `"${string}"` | `${number}`;

export interface PropertyDefinition {
  path: Term;
  minCount?: number;
  maxCount?: number;
  nodeKind?: Term;
  class?: Term;
  datatype?: Term;
  pattern?: string;
  in?: readonly Term[];
  languageIn?: readonly string[];
  uniqueLang?: boolean;
  minLength?: number;
  maxLength?: number;
  minInclusive?: number;
  maxInclusive?: number;
  hasValue?: Term;
}

/** Holds when the subject has exactly one `path` value whose IRI or lexical form is `value`. */
export interface Discriminator {
  path: Term;
  value: Term;
}

/**
 * Canonical routing: the command module validates every touched current or revision
 * subject whose selected canonical type is listed here against this shape, whatever
 * the request declares. Among shapes sharing a type, the one whose `when` conditions
 * hold and are most specific wins; the compiler rejects ambiguous sets.
 */
export interface CanonicalFocus {
  types: readonly Term[];
  when?: readonly Discriminator[];
}

/** Generic command binding rules; profile-specific value checks remain module code. */
export interface BindingRequirement {
  /** Keys that must be present and nonempty, in the order the module reports them. */
  required: readonly string[];
  optional?: readonly string[];
  /** Shape roles that each need one focus; a key with the same name must equal it. */
  roles: readonly string[];
  /** rdf:types whose touched subjects must be the focus of a bound validation of this profile. */
  demandedBy: readonly Term[];
}

export interface ShapeDefinition {
  iri: string;
  properties: readonly PropertyDefinition[];
  /** The owner lists every predicate on this component; shared Resource envelopes stay open. */
  closed?: true;
  /** SHACL disjunction of local property groups. */
  or?: readonly (readonly PropertyDefinition[])[];
  /** Command-registry metadata; it does not change the constraints. */
  canonical?: CanonicalFocus;
}

export interface ProfileDefinition {
  id: string;
  prefixes: readonly (readonly [name: string, iri: string])[];
  shapes: readonly ShapeDefinition[];
  /** Command-registry metadata; it does not change the constraints. */
  binding?: BindingRequirement;
}

const profileSnapshots = new WeakMap<ProfileDefinition, ProfileDefinition>();

/**
 * One loaded authored definition supplies one compilation basis. Keep its data
 * separate from consumer inspections of the module's shared objects; a source
 * edit loads a new definition, and a derived definition has a new identity.
 */
export function profileSnapshot(profile: ProfileDefinition): ProfileDefinition {
  let snapshot = profileSnapshots.get(profile);
  if (!snapshot) {
    snapshot = structuredClone(profile);
    profileSnapshots.set(profile, snapshot);
  }
  return snapshot;
}

// Resource IRIs and vocabulary IRIs have different referents. A context may use
// either compact prefix, but it must not turn a resource ID into a predicate (or
// silently switch newly authored Schema.org terms to the HTTP alias).
export const reservedNamespaces = {
  rezics: 'https://rezics.com/id/',
  rv: 'https://rezics.com/vocab/',
  'rezics-vocab': 'https://rezics.com/vocab/',
  schema: 'https://schema.org/',
  sh: 'http://www.w3.org/ns/shacl#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  skosxl: 'http://www.w3.org/2008/05/skos-xl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  prov: 'http://www.w3.org/ns/prov#',
  oa: 'http://www.w3.org/ns/oa#',
  time: 'http://www.w3.org/2006/time#',
} as const;
