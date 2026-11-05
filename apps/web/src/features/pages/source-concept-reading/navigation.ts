import { catalogueEntries } from '../../catalogue/catalogue-entry';
import type { ConceptPage } from './visit';
import type { ConceptWorksRouteState } from '../../catalogue/concept-works/view';

export const conceptVisitDescriptorLimit = 8192;
export const conceptVisitHistoryLimit = 8;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sections = ['hierarchy', 'scheme', 'code', 'broader', 'works'] as const;

export type ConceptFocus = { section: (typeof sections)[number]; row?: string };
export type ConceptHierarchyAddress = {
  subject: string;
  role?: string;
  current: { release: string; revision: number; context: string; type: string };
  addresses: (string | null)[];
  index: number;
  truncated: boolean;
  focus?: ConceptFocus;
};
export type ConceptWorkIntent = {
  property?: string;
  scheme?: string;
  type?: string;
  includeChildren?: boolean;
  spoilerThreshold?: 0 | 1 | 2;
  conditionText?: string;
  tagQualifiersText?: string;
};
export type ConceptVisitDescriptor = {
  version: 1;
  subject: string;
  role?: string;
  current: ConceptHierarchyAddress['current'];
  addresses: (string | null)[];
  index: number;
  truncated: boolean;
  focus: ConceptFocus;
  works: ConceptWorkIntent;
};

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > conceptVisitDescriptorLimit) return;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validCurrent(value: unknown): value is ConceptHierarchyAddress['current'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const current = value as Record<string, unknown>;
  return (
    exactKeys(current, ['release', 'revision', 'context', 'type']) &&
    typeof current.release === 'string' &&
    current.release.length > 0 &&
    current.release.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(current.release) &&
    Number.isSafeInteger(current.revision) &&
    Number(current.revision) > 0 &&
    typeof current.context === 'string' &&
    uuid.test(current.context) &&
    typeof current.type === 'string' &&
    current.type.length > 0 &&
    current.type.length <= 128 &&
    !/[\s\u0000-\u001f\u007f]/u.test(current.type)
  );
}

function validFocus(value: unknown): value is ConceptFocus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const focus = value as Record<string, unknown>;
  return (
    exactKeys(focus, ['section', 'row']) &&
    sections.includes(focus.section as ConceptFocus['section']) &&
    (focus.row === undefined || (typeof focus.row === 'string' && uuid.test(focus.row)))
  );
}

function validAddresses(value: unknown, index: unknown): value is (string | null)[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= conceptVisitHistoryLimit &&
    Number.isSafeInteger(index) &&
    Number(index) >= 0 &&
    Number(index) < value.length &&
    value.every(
      (cursor, addressIndex) =>
        (cursor === null && addressIndex === 0) ||
        (typeof cursor === 'string' && cursor.length > 0 && byteLength(cursor) <= 4096 && !/[\u0000-\u001f\u007f]/u.test(cursor)),
    )
  );
}

function validPosition(value: unknown): value is ConceptHierarchyAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  return (
    exactKeys(position, ['subject', 'role', 'current', 'addresses', 'index', 'truncated', 'focus']) &&
    typeof position.subject === 'string' &&
    uuid.test(position.subject) &&
    (position.role === undefined ||
      (typeof position.role === 'string' &&
        position.role.length > 0 &&
        position.role.length <= 128 &&
        !/[\u0000-\u001f\u007f]/u.test(position.role))) &&
    validCurrent(position.current) &&
    validAddresses(position.addresses, position.index) &&
    typeof position.truncated === 'boolean' &&
    (position.focus === undefined || validFocus(position.focus))
  );
}

function validWorks(value: unknown): value is ConceptWorkIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const works = value as Record<string, unknown>;
  return (
    exactKeys(works, [
      'property',
      'scheme',
      'type',
      'includeChildren',
      'spoilerThreshold',
      'conditionText',
      'tagQualifiersText',
    ]) &&
    ['property', 'scheme', 'type'].every(
      (key) =>
        works[key] === undefined ||
        (typeof works[key] === 'string' &&
          works[key].length > 0 &&
          works[key].length <= 128 &&
          !/[\s\u0000-\u001f\u007f]/u.test(works[key])),
    ) &&
    (works.scheme === undefined || (typeof works.scheme === 'string' && uuid.test(works.scheme))) &&
    (works.includeChildren === undefined || typeof works.includeChildren === 'boolean') &&
    (works.spoilerThreshold === undefined || [0, 1, 2].includes(works.spoilerThreshold as number)) &&
    (works.conditionText === undefined || (typeof works.conditionText === 'string' && works.conditionText.length <= 16_384)) &&
    (works.tagQualifiersText === undefined ||
      (typeof works.tagQualifiersText === 'string' && works.tagQualifiersText.length <= 2048))
  );
}

export function parseConceptHierarchyAddress(value: unknown): ConceptHierarchyAddress | undefined {
  if (typeof value !== 'string' || value.length > conceptVisitDescriptorLimit) return;
  const json = fromBase64Url(value);
  if (!json) return;
  try {
    const parsed: unknown = JSON.parse(json);
    if (validPosition(parsed)) return parsed;
  } catch {
    return;
  }
}

export function parseConceptVisitDescriptor(value: unknown): ConceptVisitDescriptor | undefined {
  if (typeof value !== 'string' || value.length > conceptVisitDescriptorLimit) return;
  const json = fromBase64Url(value);
  if (!json) return;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const descriptor = parsed as Record<string, unknown>;
    if (
      !exactKeys(descriptor, [
        'version',
        'subject',
        'role',
        'current',
        'addresses',
        'index',
        'truncated',
        'focus',
        'works',
      ]) ||
      descriptor.version !== 1 ||
      typeof descriptor.subject !== 'string' ||
      !uuid.test(descriptor.subject) ||
      (descriptor.role !== undefined &&
        (typeof descriptor.role !== 'string' ||
          descriptor.role.length < 1 ||
          descriptor.role.length > 128 ||
          /[\u0000-\u001f\u007f]/u.test(descriptor.role))) ||
      !validCurrent(descriptor.current) ||
      !validAddresses(descriptor.addresses, descriptor.index) ||
      typeof descriptor.truncated !== 'boolean' ||
      !validFocus(descriptor.focus) ||
      !validWorks(descriptor.works)
    )
      return;
    return descriptor as ConceptVisitDescriptor;
  } catch {
    return;
  }
}

export function encodeConceptVisitDescriptor(descriptor: ConceptVisitDescriptor): string | undefined {
  const encoded = base64Url(JSON.stringify(descriptor));
  return encoded.length <= conceptVisitDescriptorLimit && parseConceptVisitDescriptor(encoded) ? encoded : undefined;
}

function encodePosition(position: ConceptHierarchyAddress): string | undefined {
  const encoded = base64Url(JSON.stringify(position));
  return encoded.length <= conceptVisitDescriptorLimit ? encoded : undefined;
}

function currentPosition(
  page: ConceptPage,
  history: (string | undefined)[],
  index: number,
  truncated: boolean,
  focus?: ConceptFocus,
): ConceptHierarchyAddress {
  const start = Math.max(0, index - conceptVisitHistoryLimit + 1);
  const addresses = history.slice(start, index + 1).map((cursor) => cursor ?? null);
  return {
    subject: page.public.subject.id,
    ...(page.requestedRole ? { role: page.requestedRole } : {}),
    current: {
      release: page.public.subject.release,
      revision: page.public.subject.revision,
      context: page.public.subject.context,
      type: page.public.subject.type,
    },
    addresses,
    index: addresses.length - 1,
    truncated: truncated || start > 0,
    ...(focus ? { focus } : {}),
  };
}

export function conceptWorkIntentFor(route: ConceptWorksRouteState | undefined, page: ConceptPage): ConceptWorkIntent {
  const readableSchemes = page.schemes.filter((scheme) => scheme.readable && scheme.conceptPage);
  const onlyScheme = page.schemes.length === 1 && readableSchemes.length === 1 ? readableSchemes[0] : undefined;
  return {
    ...(route?.property ? { property: route.property } : {}),
    ...(route?.scheme || onlyScheme ? { scheme: route?.scheme ?? onlyScheme?.id } : {}),
    ...(route?.type ? { type: route.type } : {}),
    ...(route?.includeChildren ? { includeChildren: true } : {}),
    ...(route?.spoilerThreshold !== undefined ? { spoilerThreshold: route.spoilerThreshold } : {}),
    ...(route?.conditionText ? { conditionText: route.conditionText } : {}),
    ...(route?.tagQualifiersText ? { tagQualifiersText: route.tagQualifiersText } : {}),
  };
}

function encodeDescriptor(
  page: ConceptPage,
  history: (string | undefined)[],
  index: number,
  truncated: boolean,
  route: ConceptWorksRouteState | undefined,
  focus: ConceptFocus,
): string | undefined {
  let position = currentPosition(page, history, index, truncated, focus);
  const works = conceptWorkIntentFor(route, page);
  let encoded = '';
  while (position.addresses.length) {
    const descriptor: ConceptVisitDescriptor = {
      version: 1,
      subject: position.subject,
      ...(position.role ? { role: position.role } : {}),
      current: position.current,
      addresses: position.addresses,
      index: position.index,
      truncated: position.truncated,
      focus,
      works,
    };
    encoded = base64Url(JSON.stringify(descriptor));
    if (encoded.length <= conceptVisitDescriptorLimit) return encoded;
    if (position.addresses.length === 1) return;
    position = {
      ...position,
      addresses: position.addresses.slice(1),
      index: Math.max(0, position.index - 1),
      truncated: true,
    };
  }
}

export function conceptVisitDescriptorFor(
  page: ConceptPage,
  history: { addresses: (string | undefined)[]; truncated: boolean },
  index: number,
  route: ConceptWorksRouteState | undefined,
  focus: ConceptFocus,
): string | undefined {
  if (!page.admitted || !validFocus(focus)) return;
  return encodeDescriptor(page, history.addresses, index, history.truncated, route, focus);
}

export function conceptHierarchyAddressFor(
  page: ConceptPage,
  history: { addresses: (string | undefined)[]; truncated: boolean },
  index: number,
  focus?: ConceptFocus,
): ConceptHierarchyAddress | undefined {
  if (!page.admitted) return;
  let position = currentPosition(page, history.addresses, index, history.truncated, focus);
  while (position.addresses.length) {
    const encoded = encodePosition(position);
    if (encoded) return position;
    if (position.addresses.length === 1) return;
    position = {
      ...position,
      addresses: position.addresses.slice(1),
      index: Math.max(0, position.index - 1),
      truncated: true,
    };
  }
}

export function encodeConceptHierarchyAddress(position: ConceptHierarchyAddress | undefined): string | undefined {
  if (!position || !validPosition(position)) return;
  return encodePosition(position);
}

export function conceptVisitHref(descriptor: ConceptVisitDescriptor, locale: string, returnTo?: string): string | undefined {
  const encoded = encodeConceptVisitDescriptor(descriptor);
  if (!encoded) return;
  const base = catalogueEntries.concepts({ id: descriptor.subject, label: '', locale }).href;
  const params = new URLSearchParams({ conceptVisit: encoded });
  if (returnTo) params.set('returnTo', returnTo);
  return `${base}?${params}`;
}

export function conceptVisitAddressFor(
  page: ConceptPage,
  history: { addresses: (string | undefined)[]; truncated: boolean },
  index: number,
  route: ConceptWorksRouteState | undefined,
  focus: ConceptFocus,
  locale: string,
  returnTo?: string,
): string | undefined {
  const encoded = conceptVisitDescriptorFor(page, history, index, route, focus);
  const descriptor = parseConceptVisitDescriptor(encoded);
  return descriptor ? conceptVisitHref(descriptor, locale, returnTo) : undefined;
}

export function conceptTargetHref(
  base: string,
  descriptor: string | undefined,
  returnTo?: string,
): string {
  const url = new URL(base, 'https://rezics.invalid');
  if (descriptor) url.searchParams.set('conceptVisit', descriptor);
  if (returnTo) url.searchParams.set('returnTo', returnTo);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function subjectVisitHref(base: string, returnTo: string | undefined): string {
  if (!returnTo) return base;
  const url = new URL(base, 'https://rezics.invalid');
  url.searchParams.set('via', returnTo);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function conceptVisitPosition(descriptor: ConceptVisitDescriptor): ConceptHierarchyAddress {
  return {
    subject: descriptor.subject,
    ...(descriptor.role ? { role: descriptor.role } : {}),
    current: descriptor.current,
    addresses: descriptor.addresses,
    index: descriptor.index,
    truncated: descriptor.truncated,
    focus: descriptor.focus,
  };
}

export function conceptVisitWorkIntent(descriptor: ConceptVisitDescriptor): ConceptWorkIntent {
  return descriptor.works;
}

export function currentnessMatches(page: ConceptPage, address: ConceptHierarchyAddress): boolean {
  const current = page.public.subject;
  return (
    page.admitted &&
    current.id === address.subject &&
    current.release === address.current.release &&
    current.revision === address.current.revision &&
    current.context === address.current.context &&
    current.type === address.current.type &&
    page.requestedRole === address.role
  );
}
