import { POLICY_VERSIONS } from '../../../../services/account/src/policy-versions.ts';
import { type FactSlots, type PolicySlug } from './policies.ts';

/**
 * The facts the published policies state, in one file. The maintainer supplies
 * every value; an empty string means "not supplied", and a release build
 * (`task about:build -- --release`) refuses to publish while any is empty.
 * Never invent a value here: docs/legal/README.md lists what must come from
 * the operator (addresses, mailboxes, a registered DMCA agent, retention
 * periods, processors).
 */
export interface LegalFacts {
  operator: {
    /** Business mailing address and state of incorporation. */
    mailingAddress: string;
    /** Domains and applications the policies cover. */
    services: string;
    /** US state whose law governs the Terms. */
    governingState: string;
    /** County, state and federal judicial district for disputes. */
    venue: string;
  };
  /** Monitored mailboxes and account-free forms; a person need not have an account to use them. */
  contacts: {
    support: string;
    legal: string;
    privacy: string;
    accountSecurity: string;
    security: string;
    safety: string;
    reportForm: string;
    ncii: string;
    appeals: string;
    appealForm: string;
    disputes: string;
  };
  /** The designated agent as registered with the US Copyright Office. */
  dmcaAgent: {
    name: string;
    postalAddress: string;
    telephone: string;
    email: string;
    form: string;
  };
  /** Per policy; Terms and Privacy take their effective date from the version sign-up records. */
  policies: Record<PolicySlug, { effectiveDate: string; version: string }>;
  /** Operating facts in the sources' own words, keyed by the marker's description. */
  statements: Readonly<Record<string, string>>;
}

const accepted = Object.fromEntries(POLICY_VERSIONS.map((p) => [p.policyId, p.effectiveDate]));

export const legalFacts: LegalFacts = {
  operator: { mailingAddress: '', services: '', governingState: '', venue: '' },
  contacts: {
    support: '',
    legal: '',
    privacy: '',
    accountSecurity: '',
    security: '',
    safety: '',
    reportForm: '',
    ncii: '',
    appeals: '',
    appealForm: '',
    disputes: '',
  },
  dmcaAgent: { name: '', postalAddress: '', telephone: '', email: '', form: '' },
  policies: {
    terms: { effectiveDate: accepted.terms ?? '', version: '' },
    privacy: { effectiveDate: accepted.privacy ?? '', version: '' },
    'acceptable-use': { effectiveDate: '', version: '' },
    'content-ratings-and-age': { effectiveDate: '', version: '' },
    ai: { effectiveDate: '', version: '' },
    'copyright-and-dmca': { effectiveDate: '', version: '' },
    ncii: { effectiveDate: '', version: '' },
    'child-safety': { effectiveDate: '', version: '' },
    'api-and-agent': { effectiveDate: '', version: '' },
  },
  statements: {
    'public feature-status page and actual launch configuration.': '',
    'actual licences for catalogue contributions, Realm wikis and other shared datasets, and where contributors accept them.':
      '',
    'purchaser terms, refund policy, delivery terms, merchant identity and support contacts before enabling sales.':
      '',
    'settings route and fallback contact': '',
    'implemented notice channels': '',
    'monitored email and public request form': '',
    'actual role and contact': '',
    'actual appointment and contact; if none has been appointed, state that accurately': '',
    'actual appointments or applicable status': '',
    'verify every collection, provider, retention period and control below against the deployed service. Remove unavailable features from the current-practices description.':
      '',
    'password hashes, passkey public keys, federated-login identifiers and other enabled methods; do not list methods that are absent':
      '',
    'live source inventory, provenance links and migration notices.': '',
    'any processing of special-category data, its precise purpose and applicable legal condition; any recommendations or analytics actually enabled.':
      '',
    'provider names, models or services, processing locations, data sent, retention and training settings; state “none” if no external provider is used':
      '',
    'services actually enabled, contracting entity, locations, retention and privacy link': '',
    'companies, countries, data categories and retention': '',
    'actual sending and receiving providers and their privacy links': '',
    'approval status, actual data transmitted, processing terms and retention': '',
    'Stripe or other actual providers, legal roles, data flows and privacy links': '',
    'active providers or “none”': '',
    'active providers or “none”; distinguish self-hosted software from an external recipient': '',
    'locations, including relevant cross-border access': '',
    'applicable adequacy decisions, executed standard contractual clauses, required assessments and supplementary safeguards for each relevant transfer':
      '',
    period: '',
    'recovery period and subsequent deletion schedule': '',
    'period and any shorter IP retention': '',
    'separate periods': '',
    'periods by case type and review criteria': '',
    'periods and applicable accounting or tax requirements': '',
    'maximum rotation period and deletion handling after restoration': '',
    'REZICS and provider retention': '',
    '@Locale': '',
    '@Theme': '',
    '@Session': '',
    'any local storage, service-worker caches or offline files actually used, their purposes and how users clear them.':
      '',
    'verify Cloudflare, Turnstile, embedded content and all application responses against the three-function cookie limit. Turnstile pre-clearance and other Cloudflare features can set additional cookies; disable incompatible configurations rather than silently omitting them from this notice.':
      '',
    'describe aggregate measurement, marketing subscription controls and any email interaction measurement; do not claim tools are absent without checking':
      '',
    'privacy appeal route': '',
    'applicable US state and market-specific notices, request channels, appeal deadlines and regulator contacts. Do not imply that every state privacy statute applies regardless of its thresholds.':
      '',
    'actual case receipt, status and mandatory safety-inbox routes; ordinary response targets supported by staffing.':
      '',
    'version and public availability page': '',
    'supported countries and minimum ages': '',
    'restrictions; otherwise disabled': '',
    'actual age-assurance methods, birthday-boundary calculation, country-resolution rules, correction process and any market-specific checks. Month-and-year processing must not unlock a feature before the required birthday.':
      '',
    'actual enabled rating categories by market, effective dates and feature restrictions. Eligibility in this policy must not be presented as current feature availability.':
      '',
    'reporting route': '',
    'exact declaration fields, review-status values and help-page examples supported by the product.':
      '',
    'whether any training opt-in programme exists; if none, say no such programme is currently offered.':
      '',
    'live feature inventory, responsible operators, providers and human-approval requirements': '',
    'complete and verify the Copyright Office designation, covered service names, directory link and renewal date. Publishing this contact block alone does not register an agent.':
      '',
    'conspicuous, account-free form URL': '',
    'working alternative': '',
    'account-free appeal route': '',
    'named internal primary and backup responders, working urgent alerts and tested deadline coverage. Keep private operational contact details out of the published policy.':
      '',
    'account-free child-safety form': '',
    'monitored address': '',
    'actual restricted preservation system, retention controls and NIST Cybersecurity Framework alignment required for Section 2258A preservation. Verify internally before making operational claims.':
      '',
    'PhotoDNA application and approval status, the classifier and threshold in use, new-account upload limits, Cloudflare configuration and supported media formats.':
      '',
    'appeal route': '',
    'verify NCMEC electronic-service-provider registration, named internal primary and backup responders, secure reporting access and tested urgent coverage. Do not publish credentials.':
      '',
    'live documentation URL': '',
    'monitored contacts': '',
    'approved import inventory and source-licence documentation.': '',
    'published capability and quota documentation': '',
    'actual versioning, deprecation and developer-notice commitments.': '',
  },
};

/** Marker description (or `@<label>` for a bare marker) to the structured fact that answers it. */
const bindings: Record<string, (facts: LegalFacts) => string> = {
  'business mailing address and state of incorporation': (f) => f.operator.mailingAddress,
  'business address': (f) => f.operator.mailingAddress,
  'domains and applications': (f) => f.operator.services,
  'appropriate US state': (f) => f.operator.governingState,
  'appropriate county, state and federal judicial district': (f) => f.operator.venue,
  'support email and contact page': (f) => f.contacts.support,
  'monitored legal email and mailing address': (f) => f.contacts.legal,
  'privacy email or form': (f) => f.contacts.privacy,
  'account-security contact': (f) => f.contacts.accountSecurity,
  'security contact': (f) => f.contacts.security,
  'monitored safety email': (f) => f.contacts.safety,
  'public reporting form': (f) => f.contacts.reportForm,
  'monitored NCII removal address': (f) => f.contacts.ncii,
  'appeal email': (f) => f.contacts.appeals,
  'account-free appeal form': (f) => f.contacts.appealForm,
  'dispute-resolution email': (f) => f.contacts.disputes,
  'monitored DMCA address': (f) => f.dmcaAgent.email,
  '@Agent name or title': (f) => f.dmcaAgent.name,
  '@Postal address': (f) => f.dmcaAgent.postalAddress,
  '@Telephone': (f) => f.dmcaAgent.telephone,
  '@Optional online form': (f) => f.dmcaAgent.form,
};

/** Marker keys a structured fact answers; the class test checks every source marker has a slot. */
export const boundMarkerKeys: readonly string[] = ['date', 'version', ...Object.keys(bindings)];

export function slotsFor(facts: LegalFacts): FactSlots {
  return {
    fill(key, policy) {
      if (key === 'date') return facts.policies[policy].effectiveDate;
      if (key === 'version') return facts.policies[policy].version;
      const bound = bindings[key];
      return (bound ? bound(facts) : facts.statements[key]) ?? '';
    },
  };
}

/** Dotted paths of every structured fact that is still empty. */
export function emptyFacts(facts: LegalFacts): string[] {
  const empty: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      if (!value.trim()) empty.push(path);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key);
    }
  };
  walk({ ...facts, statements: undefined }, '');
  return empty;
}
