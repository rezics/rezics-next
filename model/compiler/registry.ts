import type { BindingRequirement, ProfileDefinition, Term } from './ir.ts';
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
  rv('MainVersion'), rv('ContentVariant'), rv('ContentPublicationDecision'), rv('ContentWithdrawalDecision'),
  rv('ContentSearchEligibilityDecision'), rv('ContentProjection'), rv('Space'), rv('Realm'),
  rv('ExperienceRatingContext'), rv('ExperienceRatingObservation'),
  rv('ExperienceRatingObservationRevision'), rv('RatingPolicyRevision'), rv('DailyRatingContext'),
  rv('DailyRatingObservation'), rv('DailyRatingObservationRevision'),
  rv('ScaledRatingContext'), rv('ScaledRatingObservation'), rv('ScaledRatingObservationRevision'), rv('ScaledGlobalRatingContext'), rv('ScaledGlobalRatingObservation'), rv('ScaledGlobalRatingObservationRevision'), rv('RatingContext'),
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
  rv('ScaledRatingContext'), rv('ScaledRatingObservation'), rv('ScaledRatingObservationRevision'), rv('ScaledGlobalRatingContext'), rv('ScaledGlobalRatingObservation'), rv('ScaledGlobalRatingObservationRevision'),
  rv('RatingObservation'), rv('RatingObservationRevision'), rv('RatingContext'), rv('TranslationLink'),
  rv('WorkDerivation'), rv('FixedRelease'), rv('ClassificationContext'),
  rv('VocabularyDefinition'), rv('ClassificationSense'),
  rv('ConceptPath'), rv('ClassificationExpression'), skos('Concept'), skos('ConceptScheme'),
];

export interface RegistryCondition { path: string; value: string }
export interface RegistryRoute { profile: string; shape: string; when: RegistryCondition[] }
export interface RegistryBinding { required: string[]; optional: string[]; roles: string[] }
export interface CommandRegistry {
  canonical: { type: string; routes: RegistryRoute[] }[];
  bindingDemands: { type: string; profile: string }[];
  bindings: ReadonlyMap<string, RegistryBinding>;
}
/** The same ordered, single-value selector consumed by native CanonicalPolicy.select.
 * Classification belongs to callers; profile and shape selection belongs here.
 * Values are lexical forms of distinct RDF terms: equal lexical forms can still
 * be two terms (an IRI and a literal), which never satisfy a single-value route. */
export function selectCommandProfile(registry: Pick<CommandRegistry, 'canonical'>,
  types: Iterable<string>, values: (path: string) => readonly string[]) {
  const present = new Set(types);
  const canonical = registry.canonical.find(entry => present.has(entry.type));
  if (!canonical) return null;
  const selectors = [...new Set(canonical.routes.flatMap(route => route.when.map(condition => condition.path)))];
  const route = canonical.routes.find(candidate => candidate.when.every(condition => {
    const selected = values(condition.path);
    return selected.length === 1 && selected[0] === condition.value;
  }));
  return route ? { ...route, kind: canonical.type, selectors } : null;
}

export interface RegistryOptions {
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
  // Stale JavaScript callers must not silently lose alternate command metadata.
  if ('established' in options) throw new Error('RegistryOptions.established is retired; use Turtle companion declarations');
  const noPrefixes = new Map<string, string>();
  const canonicalOrder = (options.canonicalOrder ?? canonicalTypeOrder).map(term => expand(term, noPrefixes));
  const demandOrder = (options.demandOrder ?? bindingDemandOrder).map(term => expand(term, noPrefixes));
  const ids = new Set(profiles.map(profile => profile.id));
  if (ids.size !== profiles.length) throw new Error('Duplicate profile ID in command registry');
  const routes = new Map<string, RegistryRoute[]>();
  const demands = new Map<string, string>();
  const bindings = new Map<string, RegistryBinding>();
  for (const profile of profiles) {
    const prefixes = new Map(profile.prefixes);
    const roles = profile.shapes.map(shape => shapeRole(profile.id, shape.iri));
    for (const shape of profile.shapes) {
      const focus = shape.canonical;
      if (!focus) continue;
      const when = (focus.when ?? []).map(condition => ({
        path: absolute(expand(condition.path, prefixes), `${shape.iri} discriminator`),
        value: expand(condition.value, prefixes),
      }));
      if (!focus.types.length || when.some(condition => !condition.value)
        || new Set(when.map(condition => condition.path)).size !== when.length) {
        throw new Error(`${shape.iri} declares invalid canonical routing`);
      }
      for (const type of focus.types) {
        const iri = absolute(expand(type, prefixes), `${shape.iri} canonical type`);
        routes.set(iri, [...routes.get(iri) ?? [], { profile: profile.id, shape: shape.iri, when }]);
      }
    }
    const requirement = profile.binding;
    if (!requirement) continue;
    bindings.set(profile.id, bindingOf(profile, requirement, roles));
    for (const type of requirement.demandedBy) {
      const iri = absolute(expand(type, prefixes), `${profile.id} binding demand`);
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

/** Structural reads for registry bindings. These recover the author's retained
 * arguments; native BindingPolicy remains the validator of their relationships.
 * Roles and keys always come from the registry, never a consumer's profile table. */
export function commandBindingRead(profile: string, binding: RegistryBinding, shape: string,
  graphs: readonly string[], _registry: Pick<CommandRegistry, 'canonical'>) {
  const keys = [...new Set([...binding.roles, ...binding.required, ...binding.optional])];
  const variables = Object.fromEntries(keys.map((key, index) => [key, `b${index}`]));
  const variable = (key: string) => {
    if (!variables[key]) throw new Error(`${profile} has no binding key or role ${key}`);
    return `?${variables[key]}`;
  };
  const role = shapeRole(profile, shape);
  if (!binding.roles.includes(role)) throw new Error(`${profile} has no bound role ${role}`);
  const patterns: string[] = [];
  const facts: { subject: string; predicate: string; object?: string; types?: string[] }[] = [];
  let graphIndex = 0;
  const triple = (subject: string, predicate: string, object: string, optional: boolean | string = false) => {
    const path = predicate.includes('://') ? predicate : `https://rezics.com/vocab/${predicate}`;
    facts.push({ subject, predicate: path, object });
    const graph = `?bindingGraph${graphIndex++}`;
    const clause = `VALUES ${graph} { ${graphs.map(value => `<${value}>`).join(' ')} }
      GRAPH ${graph} { ${variable(subject)} <${path}> ${variable(object)} }`;
    patterns.push(optional ? `OPTIONAL { ${typeof optional === 'string' ? `FILTER(${optional})` : ''} ${clause} }` : clause);
  };
  const fields = (subject: string, entries: Record<string, string>) => {
    for (const [key, predicate] of Object.entries(entries)) if (keys.includes(key))
      triple(subject, predicate, key, binding.optional.includes(key));
  };
  const receipt = (subject: string, predicate: string) => {
    triple('receipt', predicate, subject);
    fields('receipt', { scope: 'admittedScope', epoch: 'authorityEpoch' });
  };
  if (/^classification-proposition-v[12]$/.test(profile)) {
    triple('concept', 'http://www.w3.org/2004/02/skos/core#inScheme', 'scheme');
    triple('path', 'terminalConcept', 'concept');
    triple('expression', 'path', 'path');
    triple('expression', 'assertedConcept', 'concept');
    triple('sense', 'path', 'path');
    triple('sense', 'expression', 'expression');
  } else if (/^classification-context-v[12]$/.test(profile)) {
    patterns.push(`VALUES ${variable('global')} { <urn:rezics:classification-context:global> }`);
    triple('realm', 'classificationContext', 'context');
    triple('context', 'realm', 'realm');
  } else if (profile === 'classification-direct-decision-v1') {
    triple('work', 'mainVersion', 'main');
    triple('main', 'work', 'work');
    fields('sense', { 'sense-revision': 'head' });
    fields('application', { main: 'targetMainVersion', sense: 'sense', context: 'classificationContext',
      slot: 'applicationKey', proposer: 'proposer', decision: 'decisionHead' });
    fields('decision', { application: 'application', outcome: 'outcome', decider: 'decidedBy', predecessor: 'predecessor' });
    fields('context', { 'context-kind': 'contextRole', realm: 'realm' });
    triple('context', 'head', 'context-revision', `BOUND(${variable('realm')})`);
    // Global Context has a head too, but its binding admits no context revision.
    patterns.push(`FILTER(${variable('context-kind')} != <https://rezics.com/vocab/GlobalClassification>
      || !BOUND(${variable('realm')}))`);
  } else if (/rating.*-context-/.test(profile)) {
    if (binding.roles.includes('realm')) {
      triple('realm', 'ratingContext', 'context');
      triple('context', 'realm', 'realm');
    }
    fields('context', { question: 'question', grain: 'targetGrain',
      timeZone: 'ratingTimeZone', displayThreshold: 'displayThreshold' });
    if (keys.includes('language')) {
      patterns.push(`BIND(LANG(${variable('question')}) AS ${variable('language')})`);
    }
  } else if (/rating.*-observation-/.test(profile)) {
    if (binding.roles.includes('realm')) {
      triple('realm', 'ratingContext', 'context');
      triple('context', 'realm', 'realm');
    }
    if (binding.roles.includes('work')) {
      triple('work', 'mainVersion', 'main');
      triple('main', 'work', 'work');
      if (binding.roles.includes('release')) {
        triple('release', 'work', 'work');
        triple('release', 'mainVersion', 'main');
      } else triple('observation', 'targetMainVersion', 'main');
    }
    fields('observation', { context: 'ratingContext', slot: 'ratingSlot', revision: 'observationHead',
      target: 'target', release: 'targetRelease', occasion: 'ratingOccasion',
      day: 'ratingDay', timeZone: 'ratingTimeZone', periodStart: 'periodStart', periodEnd: 'periodEnd' });
    fields('revision', { observation: 'observation', availability: 'ratingAvailability',
      value: 'ratingValue', predecessor: 'predecessor' });
  } else if (profile === 'rating-aggregate-default-policy-v1') {
    fields('context', { revision: 'ratingPolicyHead', contextRevision: 'head' });
    fields('revision', { context: 'component', predecessor: 'predecessor', aggregationPolicy: 'ratingAggregationPolicy' });
  } else if (profile === 'definition-presentation-v1' || /^rating-question-presentation-v[12]$/.test(profile)) {
    triple('presentation', profile === 'definition-presentation-v1' ? 'presentationHead' : 'questionPresentationHead', 'revision');
    triple('revision', 'component', 'presentation');
    fields('presentation', { definition: 'presentationDefinition', meaningRevision: 'meaningRevision',
      fromRole: 'fromRole', toRole: 'toRole', context: 'presentationContext', language: 'presentationLanguage' });
  } else if (profile === 'post-v1') {
    fields('post', { publisher: 'publisher', revision: 'head' });
  } else if (profile === 'projection-v1' || profile === 'realization-v1') {
    const component = binding.roles[0]!;
    triple(component, profile === 'projection-v1' ? 'projectionHead' : 'head', 'revision');
    triple('revision', 'component', component);
  } else if (profile === 'realm-reply-placement-v1') {
    triple('slot', 'replyPlacementHead', 'placement');
    fields('placement', { realm: 'realm', reply: 'reply', root: 'rootTarget', revision: 'contentRevision',
      review: 'reviewDecision', author: 'author', actor: 'decidedBy' });
    receipt('placement', 'placement');
  } else if (profile === 'work-author-credit-v1' || profile === 'work-author-credit-v2') {
    triple('credit', 'creditRevision', 'revision');
    triple('revision', 'component', 'credit');
    fields('revision', { work: 'work', 'work-head': 'workRevision', key: 'externalKey',
      ordinal: 'https://schema.org/position', actor: 'confirmedBy', 'source-role': 'sourceRoleKey',
      provider: 'externalProvider', namespace: 'externalNamespace', role: 'https://schema.org/roleName' });
    receipt('revision', 'creditRevision');
    fields('receipt', { intent: 'sourceIntent' });
  } else if (profile === 'translation-link-v1' || /^work-derivation(?:-unresolved)?-v[12]$/.test(profile)) {
    const component = binding.roles[0]!;
    fields(component, { 'target-work': 'targetWork', 'target-main': 'targetMainVersion',
      'target-revision': 'targetMainRevision', 'source-work': 'sourceWork', 'source-main': 'sourceMainVersion',
      'source-revision': 'sourceMainRevision', kind: 'derivationKind', status: 'translationStatus',
      language: 'contentLanguage', translator: 'translator', publisher: 'publisher', evidence: 'evidence', actor: 'linkedBy' });
    receipt(component, profile === 'translation-link-v1' ? 'translationLink' : 'workDerivation');
  } else if (profile === 'fixed-native-text-release-v1') {
    fields('release', { work: 'work', main: 'mainVersion', revision: 'mainRevision', selection: 'selection',
      contribution: 'contribution', decision: 'publicationDecision', draft: 'selectedDraft', language: 'language',
      digest: 'bodyDigest', manifest: 'manifest', actor: 'sealedBy' });
    receipt('release', 'fixedRelease');
  } else throw new Error(`${profile} has no structural binding read`);
  // Routing selects a validation shape; it does not enumerate every type that
  // shape admits. Native SHACL validates the structurally bound role subjects.
  // Catch newly declared roles or required arguments at the owning registry.
  const pattern = patterns.join('\n');
  for (const key of [...binding.roles, ...binding.required]) {
    if (!new RegExp(`\\?${variables[key]}\\b`).test(pattern)) throw new Error(`${profile} has no structural read for ${key}`);
  }
  return { keys, variables, anchor: variable(role), pattern, facts };
}

/** Native binding arguments use lexical values, with the historical enum names. */
export function commandBindingValue(key: string, value: string): string {
  const enums: Record<string, Record<string, string>> = {
    availability: { 'https://rezics.com/vocab/Available': 'available', 'https://rezics.com/vocab/Withdrawn': 'withdrawn' },
    outcome: { 'https://rezics.com/vocab/Accepted': 'accepted', 'https://rezics.com/vocab/Rejected': 'rejected' },
    'context-kind': { 'https://rezics.com/vocab/GlobalClassification': 'global', 'https://rezics.com/vocab/RealmClassification': 'realm' },
    status: { 'https://rezics.com/vocab/Official': 'official', 'https://rezics.com/vocab/ThirdParty': 'third-party' },
    kind: { 'https://rezics.com/vocab/Adaptation': 'adaptation', 'https://rezics.com/vocab/NewRecording': 'new-recording',
      'https://rezics.com/vocab/SoftwareFork': 'software-fork' },
    aggregationPolicy: { 'https://rezics.com/definition/rating-latest-per-rater-mean-v1': 'latest-per-rater-mean',
      'https://rezics.com/definition/rating-mean-per-rater-v1': 'mean-per-rater',
      'https://rezics.com/definition/rating-pooled-observation-mean-v1': 'pooled-observation-mean' },
  };
  return enums[key]?.[value] ?? value;
}

/** These historical bindings validate their retained admission receipts as well
 * as the owner graph; all other bound shapes admit only current and revisions. */
export function commandBindingGraphs(profile: string, graphs: {
  current: string; revisions: string; receipts: string; control: string;
}): string[] {
  const receiptBound = ['translation-link-v1', 'work-derivation-v1',
    'fixed-native-text-release-v1', 'work-author-credit-v1', 'work-author-credit-v2'].includes(profile);
  return [graphs.current, graphs.revisions, ...receiptBound ? [graphs.receipts, graphs.control] : []];
}
