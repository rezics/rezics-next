import { useLocation, createFileRoute, notFound } from '@tanstack/react-router';
import { SourceConceptPublicSession } from '../../features/catalogue/source-concept-explorer/session';
import { parseConceptPublicVisit } from '../../features/catalogue/source-concept-explorer/public-visit';
import { getLocale } from '../../paraglide/runtime.js';
import { originatingConceptReturn } from '../../features/pages/source-concept-reading/origin';
import {
  conceptVisitPosition,
  encodeConceptHierarchyAddress,
  parseConceptHierarchyAddress,
  parseConceptVisitDescriptor,
} from '../../features/pages/source-concept-reading/navigation';
import { m } from '../../paraglide/messages.js';
import type { ConceptWorksRoutePatch } from '../../features/catalogue/concept-works/contract';
import { conceptWorksRouteFor, patchConceptWorksSearch } from '../../features/pages/source-concept-reading/works-route';

export const Route = createFileRoute('/subjects/$id_/$slug/concepts')({
  staticData: { publicCache: false },
  loader: ({ params, location }) => ({
    publicVisit: parseConceptPublicVisit(location.searchStr, params.id, getLocale(), location.pathname, location.hash),
  }),
  validateSearch: (search: Record<string, unknown>) => {
    const role = search.role;
    const returnTo = search.returnTo;
    const pin = search.pin;
    const property = search.property;
    const scheme = search.scheme;
    const type = search.type;
    const sort = search.sort;
    const children = search.children;
    const spoiler = search.spoiler;
    const condition = search.condition;
    const tagQualifiers = search.tagQualifiers;
    const cursor = search.cursor;
    const conceptVisitRaw = search.conceptVisit;
    const hierarchyRaw = search.hierarchy;
    const origin = search.origin;
    const publicReturn = search.publicReturn;
    let invalid = false;
    if (
      role !== undefined &&
      (typeof role !== 'string' || role.length < 1 || role.length > 128 || /[\u0000-\u001f\u007f]/u.test(role))
    )
      invalid = true;
    if (returnTo !== undefined && !originatingConceptReturn(returnTo, getLocale())) invalid = true;
    if (pin !== undefined && (typeof pin !== 'string' || pin.length > 128)) throw notFound();
    if (property !== undefined && (typeof property !== 'string' || property.length < 1 || property.length > 128))
      invalid = true;
    if (scheme !== undefined && (typeof scheme !== 'string' || !/^[0-9a-f-]{36}$/i.test(scheme))) invalid = true;
    if (type !== undefined && (typeof type !== 'string' || type.length < 1 || type.length > 128)) invalid = true;
    if (sort !== undefined && sort !== 'name' && sort !== 'rating') invalid = true;
    if (children !== undefined && children !== 'true' && children !== true) invalid = true;
    if (spoiler !== undefined && spoiler !== '0' && spoiler !== '1' && spoiler !== '2') invalid = true;
    if (condition !== undefined && (typeof condition !== 'string' || condition.length > 16_384)) invalid = true;
    if (tagQualifiers !== undefined && (typeof tagQualifiers !== 'string' || tagQualifiers.length > 2048))
      invalid = true;
    if (cursor !== undefined && (typeof cursor !== 'string' || new TextEncoder().encode(cursor).byteLength > 4096))
      invalid = true;
    const conceptVisit = parseConceptVisitDescriptor(conceptVisitRaw);
    const hierarchyAddress = parseConceptHierarchyAddress(hierarchyRaw);
    return {
      role:
        typeof role === 'string' && role.length > 0 && role.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(role)
          ? role
          : undefined,
      returnTo: originatingConceptReturn(returnTo, getLocale()),
      pinUnsupported: pin !== undefined,
      property: typeof property === 'string' && property.length <= 128 ? property : undefined,
      scheme: typeof scheme === 'string' && /^[0-9a-f-]{36}$/i.test(scheme) ? scheme : undefined,
      type: typeof type === 'string' && type.length <= 128 ? type : undefined,
      ...(sort === 'name' || sort === 'rating' ? { sort: sort as 'name' | 'rating' } : {}),
      includeChildren: children === undefined ? undefined : children === 'true' || children === true,
      ...(spoiler === '1' || spoiler === '2'
        ? { spoilerThreshold: spoiler === '1' ? (1 as const) : (2 as const) }
        : {}),
      conditionText: typeof condition === 'string' && condition.length <= 16_384 ? condition : undefined,
      tagQualifiersText: typeof tagQualifiers === 'string' && tagQualifiers.length <= 2048 ? tagQualifiers : undefined,
      cursor: typeof cursor === 'string' && new TextEncoder().encode(cursor).byteLength <= 4096 ? cursor : undefined,
      conceptVisit: typeof conceptVisitRaw === 'string' && conceptVisitRaw.length <= 8192 ? conceptVisitRaw : undefined,
      conceptVisitDescriptor: conceptVisit,
      invalidConceptVisit: conceptVisitRaw !== undefined && !conceptVisit,
      hierarchy: typeof hierarchyRaw === 'string' && hierarchyRaw.length <= 8192 ? hierarchyRaw : undefined,
      hierarchyAddress,
      invalidHierarchy: hierarchyRaw !== undefined && !hierarchyAddress,
      ...(typeof origin === 'string' ? { origin } : {}),
      ...(typeof publicReturn === 'string' ? { publicReturn } : {}),
      invalid,
    };
  },
  head: () => ({ meta: [{ title: m.concept_explore_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: ConceptsRoute,
});

function ConceptsRoute() {
  const { id } = Route.useParams();
  const location = useLocation();
  const { publicVisit } = Route.useLoaderData();
  const {
    role,
    returnTo,
    pinUnsupported,
    property,
    scheme,
    type,
    sort,
    includeChildren,
    spoilerThreshold,
    conditionText,
    tagQualifiersText,
    cursor,
    conceptVisitDescriptor,
    invalidConceptVisit,
    hierarchyAddress,
    invalidHierarchy,
    invalid,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  const resume = conceptVisitDescriptor?.subject === id ? conceptVisitDescriptor : undefined;
  const roleValue = role ?? resume?.role;
  const {
    property: propertyValue,
    scheme: schemeValue,
    type: typeValue,
    sort: sortValue,
    includeChildren: childrenValue,
    spoilerThreshold: spoilerValue,
    conditionText: conditionValue,
    tagQualifiersText: tagQualifiersValue,
  } = conceptWorksRouteFor(
    { property, scheme, type, sort, includeChildren, spoilerThreshold, conditionText, tagQualifiersText },
    resume,
  );
  const hierarchyMismatch =
    !!hierarchyAddress && (hierarchyAddress.subject !== id || hierarchyAddress.role !== roleValue);
  const effectiveHierarchy =
    !hierarchyMismatch && hierarchyAddress ? hierarchyAddress : resume ? conceptVisitPosition(resume) : undefined;
  const onWorksChange = (patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => {
    void navigate({
      replace: options?.replace === true,
      search: (previous) => patchConceptWorksSearch(previous, patch, resume),
    });
  };
  const onHierarchyChange = (
    address: Parameters<typeof encodeConceptHierarchyAddress>[0],
    options?: { replace?: boolean },
  ) => {
    const encoded = encodeConceptHierarchyAddress(address);
    void navigate({
      replace: options?.replace === true,
      search: (previous) => {
        const next = { ...previous } as Record<string, unknown>;
        for (const key of [
          'hierarchyAddress',
          'conceptVisitDescriptor',
          'invalidConceptVisit',
          'invalidHierarchy',
          'conditionText',
          'tagQualifiersText',
          'includeChildren',
          'spoilerThreshold',
          'invalid',
          'pinUnsupported',
        ])
          delete next[key];
        if (encoded) next.hierarchy = encoded;
        else delete next.hierarchy;
        const set = (key: string, value: string | undefined) => {
          if (value === undefined || value === '') delete next[key];
          else next[key] = value;
        };
        set('role', roleValue);
        set('property', propertyValue);
        set('scheme', schemeValue);
        set('type', typeValue);
        set('children', childrenValue ? 'true' : undefined);
        set('spoiler', spoilerValue ? String(spoilerValue) : undefined);
        set('condition', conditionValue);
        set('tagQualifiers', tagQualifiersValue);
        if (!address) {
          delete next.hierarchy;
          delete next.cursor;
          if (invalidConceptVisit || resume) delete next.conceptVisit;
        }
        return next as typeof previous;
      },
    });
  };
  return (
    <SourceConceptPublicSession
      key={JSON.stringify([id, getLocale(), roleValue, publicVisit])}
      id={id}
      locale={getLocale()}
      publicVisit={publicVisit}
      pathname={location.pathname}
      role={roleValue}
      returnTo={returnTo}
      conceptVisit={conceptVisitDescriptor}
      invalidConceptVisit={invalidConceptVisit}
      hierarchyAddress={effectiveHierarchy}
      invalidHierarchy={invalidHierarchy || hierarchyMismatch}
      pinUnsupported={pinUnsupported}
      worksRoute={{
        property: propertyValue,
        scheme: schemeValue,
        type: typeValue,
        sort: sortValue,
        includeChildren: childrenValue,
        spoilerThreshold: spoilerValue,
        conditionText: conditionValue,
        tagQualifiersText: tagQualifiersValue,
        cursor,
        invalid,
      }}
      onWorksChange={onWorksChange}
      onHierarchyChange={onHierarchyChange}
    />
  );
}
