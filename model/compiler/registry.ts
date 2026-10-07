import type { BindingRequirement, CanonicalFocus, ProfileDefinition, Term } from './ir.ts';
import { expand } from './outputs.ts';

// The command registry travels in the generated manifest that the Fuseki command
// module loads beside the shapes. It replaces the module's hand-written type
// chains: canonical routes select the shape of every touched native subject, and
// binding rules fix each bound profile's keys, roles and demanding types.

const rv = (local: string): Term => `<https://rezics.com/vocab/${local}>`;
const skos = (local: string): Term => `<http://www.w3.org/2004/02/skos/core#${local}>`;
const creativeWork: Term = '<https://schema.org/CreativeWork>';

/**
 * Canonical types in the module's historical match order. A subject carrying several
 * canonical types resolves through the first listed; types first declared later
 * follow in IRI order. Reordering changes which shape validates a multi-typed subject.
 */
export const canonicalTypeOrder: readonly Term[] = [
  rv('EditorialControlRevision'), rv('AuthorCredit'), rv('AuthorCreditRevision'), creativeWork,
  rv('MainVersion'), rv('ContentVariant'), rv('ContentPublicationDecision'),
  rv('ContentSearchEligibilityDecision'), rv('ContentProjection'), rv('Space'), rv('Realm'),
  rv('ExperienceRatingContext'), rv('ExperienceRatingObservation'),
  rv('ExperienceRatingObservationRevision'), rv('RatingPolicyRevision'), rv('DailyRatingContext'),
  rv('DailyRatingObservation'), rv('DailyRatingObservationRevision'), rv('RatingContext'),
  rv('RatingObservation'), rv('RatingObservationRevision'), rv('RouteBinding'), rv('TranslationLink'),
  rv('WorkDerivation'), rv('FixedRelease'), rv('TextContribution'), rv('PublicationDecision'),
  rv('ClassificationApplication'), rv('ClassificationDecision'), rv('ClassificationSense'),
  rv('ClassificationContext'), rv('PublicationSelection'), rv('RealmPublicationRejection'),
  skos('ConceptScheme'), skos('Concept'), rv('ConceptPath'), rv('ClassificationExpression'),
];

/** Binding-demand types in the module's historical match order; later ones follow in IRI order. */
export const bindingDemandOrder: readonly Term[] = [
  rv('AuthorCredit'), rv('AuthorCreditRevision'), rv('RatingPolicyRevision'),
  rv('ClassificationApplication'), rv('ClassificationDecision'), rv('ExperienceRatingObservation'),
  rv('ExperienceRatingObservationRevision'), rv('ExperienceRatingContext'),
  rv('DailyRatingObservation'), rv('DailyRatingObservationRevision'), rv('DailyRatingContext'),
  rv('RatingObservation'), rv('RatingObservationRevision'), rv('RatingContext'), rv('TranslationLink'),
  rv('WorkDerivation'), rv('FixedRelease'), rv('ClassificationContext'),
  rv('VocabularyDefinition'), rv('ClassificationSense'),
  rv('ConceptPath'), rv('ClassificationExpression'), skos('Concept'), skos('ConceptScheme'),
];

export interface EstablishedDeclaration {
  /** Canonical routing keyed by shape role. */
  canonical?: Readonly<Record<string, CanonicalFocus>>;
  binding?: BindingRequirement;
}

const only = (...types: Term[]): CanonicalFocus => ({ types });

/**
 * Registry declarations of the profiles admitted before definitions carried them.
 * Each belongs in its definition's `canonical` and `binding` fields: move it there
 * and delete it here, because declaring both is an error.
 */
export const establishedDeclarations: Readonly<Record<string, EstablishedDeclaration>> = {
  'translation-link-v1': {
    canonical: { link: only(rv('TranslationLink')) },
    binding: {
      required: ['link', 'target-work', 'target-main', 'target-revision', 'source-work', 'source-main',
        'status', 'language', 'translator', 'publisher', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
      optional: ['source-revision'], roles: ['link'], demandedBy: [rv('TranslationLink')],
    },
  },
  'classification-direct-decision-v1': {
    canonical: { application: only(rv('ClassificationApplication')),
      decision: only(rv('ClassificationDecision')) },
    binding: {
      required: ['work', 'main', 'sense', 'sense-revision', 'context', 'context-kind', 'application',
        'decision', 'slot', 'proposer', 'decider', 'outcome'],
      optional: ['realm', 'context-revision', 'predecessor'],
      roles: ['work', 'main', 'sense', 'context', 'application', 'decision'],
      demandedBy: [rv('ClassificationApplication'), rv('ClassificationDecision')],
    },
  },
  'classification-proposition-v1': {
    canonical: { sense: only(rv('ClassificationSense')), scheme: only(skos('ConceptScheme')),
      concept: only(skos('Concept')), path: only(rv('ConceptPath')),
      expression: only(rv('ClassificationExpression')) },
    binding: {
      required: ['scheme', 'concept', 'path', 'expression', 'sense'],
      roles: ['scheme', 'concept', 'path', 'expression', 'sense'],
      demandedBy: [rv('ClassificationSense'), rv('ConceptPath'), rv('ClassificationExpression'),
        skos('Concept'), skos('ConceptScheme')],
    },
  },
  'classification-context-v1': {
    canonical: {
      global: { types: [rv('ClassificationContext')],
        when: [{ path: rv('contextRole'), value: rv('GlobalClassification') }] },
      context: only(rv('ClassificationContext')),
    },
    binding: { required: ['realm', 'context'], roles: ['global', 'realm', 'context'],
      demandedBy: [rv('ClassificationContext')] },
  },
  'main-default-selection-v1': {
    canonical: { selection: { types: [rv('PublicationSelection')],
      when: [{ path: rv('selectionBasis'), value: rv('MainMaintainer') }] } },
  },
  'realm-policy-selection-v1': { canonical: { selection: { types: [rv('PublicationSelection')],
    when: [{ path: rv('selectionBasis'), value: rv('RealmPolicy') }] } } },
  'realm-local-selection-v1': { canonical: { selection: only(rv('PublicationSelection')) } },
  'realm-local-rejection-v1': { canonical: { rejection: only(rv('RealmPublicationRejection')) } },
};

export interface RegistryCondition { path: string; value: string }
export interface RegistryRoute { profile: string; shape: string; when: RegistryCondition[] }
export interface RegistryBinding { required: string[]; optional: string[]; roles: string[] }
export interface CommandRegistry {
  canonical: { type: string; routes: RegistryRoute[] }[];
  bindingDemands: { type: string; profile: string }[];
  bindings: ReadonlyMap<string, RegistryBinding>;
}
export interface RegistryOptions {
  established?: Readonly<Record<string, EstablishedDeclaration>>;
  canonicalOrder?: readonly Term[];
  demandOrder?: readonly Term[];
}

export function shapeRole(profile: string, shape: string): string {
  const prefix = `https://rezics.com/definition/${profile}/`;
  const role = shape.startsWith(prefix) && shape.endsWith('-shape')
    ? shape.slice(prefix.length, -'-shape'.length) : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) throw new Error(`${profile} has an unnamed focus role`);
  return role;
}

function absolute(value: string, context: string): string {
  if (!/^(?:https?:\/\/|urn:)[^\s<>"{}|\\^`]+$/.test(value)) throw new Error(`${context} is not an absolute IRI: ${value}`);
  return value;
}

/** Exclusive routes can never both hold: some path requires different single values. */
function exclusive(a: readonly RegistryCondition[], b: readonly RegistryCondition[]): boolean {
  return a.some(left => b.some(right => left.path === right.path && left.value !== right.value));
}

function strictlyNarrows(a: readonly RegistryCondition[], b: readonly RegistryCondition[]): boolean {
  return a.length > b.length
    && b.every(right => a.some(left => left.path === right.path && left.value === right.value));
}

function ordered<T extends { type: string }>(entries: T[], order: readonly string[]): T[] {
  const rank = (type: string) => { const index = order.indexOf(type); return index < 0 ? order.length : index; };
  return entries.sort((a, b) => rank(a.type) - rank(b.type) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

const keyPattern = /^[A-Za-z][A-Za-z0-9-]*$/;

function bindingOf(profile: ProfileDefinition, requirement: BindingRequirement,
  roles: readonly string[]): RegistryBinding {
  const required = [...requirement.required];
  const optional = [...requirement.optional ?? []];
  const keys = [...required, ...optional];
  if (!required.length || !requirement.roles.length || keys.some(key => !keyPattern.test(key))
    || new Set(keys).size !== keys.length || new Set(requirement.roles).size !== requirement.roles.length) {
    throw new Error(`${profile.id} declares invalid binding keys or roles`);
  }
  for (const role of requirement.roles) {
    if (!roles.includes(role)) throw new Error(`${profile.id} binding names unknown role ${role}`);
  }
  return { required, optional, roles: [...requirement.roles] };
}

/** Resolve the registry for the command module; ambiguous or stale declarations fail generation. */
export function buildCommandRegistry(profiles: readonly ProfileDefinition[],
  options: RegistryOptions = {}): CommandRegistry {
  const established = options.established ?? establishedDeclarations;
  const noPrefixes = new Map<string, string>();
  const canonicalOrder = (options.canonicalOrder ?? canonicalTypeOrder).map(term => expand(term, noPrefixes));
  const demandOrder = (options.demandOrder ?? bindingDemandOrder).map(term => expand(term, noPrefixes));
  const ids = new Set(profiles.map(profile => profile.id));
  if (ids.size !== profiles.length) throw new Error('Duplicate profile ID in command registry');
  for (const id of Object.keys(established)) {
    if (!ids.has(id)) throw new Error(`Established registry declaration names unknown profile ${id}`);
  }
  const routes = new Map<string, RegistryRoute[]>();
  const demands = new Map<string, string>();
  const bindings = new Map<string, RegistryBinding>();
  for (const profile of profiles) {
    const prefixes = new Map(profile.prefixes);
    const table = established[profile.id];
    const roles = profile.shapes.map(shape => shapeRole(profile.id, shape.iri));
    for (const role of Object.keys(table?.canonical ?? {})) {
      if (!roles.includes(role)) throw new Error(`${profile.id} registry declaration names unknown role ${role}`);
    }
    for (const shape of profile.shapes) {
      const role = shapeRole(profile.id, shape.iri);
      const listed = table?.canonical?.[role];
      if (shape.canonical && listed) throw new Error(`${shape.iri} declares canonical routing twice`);
      const focus = shape.canonical ?? listed;
      if (!focus) continue;
      // Established entries use full IRIs; a definition's terms use its own prefixes.
      const terms = shape.canonical ? prefixes : noPrefixes;
      const when = (focus.when ?? []).map(condition => ({
        path: absolute(expand(condition.path, terms), `${shape.iri} discriminator`),
        value: expand(condition.value, terms),
      }));
      if (!focus.types.length || when.some(condition => !condition.value)
        || new Set(when.map(condition => condition.path)).size !== when.length) {
        throw new Error(`${shape.iri} declares invalid canonical routing`);
      }
      for (const type of focus.types) {
        const iri = absolute(expand(type, terms), `${shape.iri} canonical type`);
        routes.set(iri, [...routes.get(iri) ?? [], { profile: profile.id, shape: shape.iri, when }]);
      }
    }
    if (profile.binding && table?.binding) throw new Error(`${profile.id} declares its binding twice`);
    const requirement = profile.binding ?? table?.binding;
    if (!requirement) continue;
    bindings.set(profile.id, bindingOf(profile, requirement, roles));
    const terms = profile.binding ? prefixes : noPrefixes;
    for (const type of requirement.demandedBy) {
      const iri = absolute(expand(type, terms), `${profile.id} binding demand`);
      const other = demands.get(iri);
      if (other) throw new Error(`${iri} demands bindings of both ${other} and ${profile.id}`);
      demands.set(iri, profile.id);
    }
  }
  for (const type of canonicalOrder) {
    if (!routes.has(type)) throw new Error(`Canonical precedence names undeclared type ${type}`);
  }
  for (const type of demandOrder) {
    if (!demands.has(type)) throw new Error(`Binding precedence names undeclared type ${type}`);
  }
  const canonical = ordered([...routes].map(([type, entries]) => {
    // Most specific first; the checks below make the first holding route unique.
    const sorted = [...entries].sort((a, b) => b.when.length - a.when.length);
    for (const [index, a] of sorted.entries()) {
      for (const b of sorted.slice(index + 1)) {
        if (!exclusive(a.when, b.when) && !strictlyNarrows(a.when, b.when)) {
          throw new Error(`Ambiguous canonical routing for ${type}: ${a.shape} and ${b.shape}`);
        }
      }
    }
    return { type, routes: sorted };
  }), canonicalOrder);
  const bindingDemands = ordered([...demands].map(([type, profile]) => ({ type, profile })), demandOrder);
  return { canonical, bindingDemands, bindings };
}
