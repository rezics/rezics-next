import { createFileRoute, notFound } from '@tanstack/react-router';
import { SourceConceptSession } from '../../features/catalogue/source-concept-explorer/session';
import { getLocale } from '../../paraglide/runtime.js';
import { originatingConceptReturn } from '../../features/pages/source-concept-reading/origin';
import { m } from '../../paraglide/messages.js';
import type { ConceptWorksRoutePatch } from '../../features/catalogue/concept-works/view';

export const Route = createFileRoute('/subjects/$id_/$slug/concepts')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const role = search.role;
    const returnTo = search.returnTo;
    const pin = search.pin;
    const property = search.property;
    const scheme = search.scheme;
    const type = search.type;
    const children = search.children;
    const spoiler = search.spoiler;
    const condition = search.condition;
    const tagQualifiers = search.tagQualifiers;
    const cursor = search.cursor;
    let invalid = false;
    if (role !== undefined && (typeof role !== 'string' || role.length > 128)) invalid = true;
    if (returnTo !== undefined && !originatingConceptReturn(returnTo, getLocale())) invalid = true;
    if (pin !== undefined && (typeof pin !== 'string' || pin.length > 128)) throw notFound();
    if (property !== undefined && (typeof property !== 'string' || property.length < 1 || property.length > 128))
      invalid = true;
    if (scheme !== undefined && (typeof scheme !== 'string' || !/^[0-9a-f-]{36}$/i.test(scheme))) invalid = true;
    if (type !== undefined && (typeof type !== 'string' || type.length < 1 || type.length > 128)) invalid = true;
    if (children !== undefined && children !== 'true' && children !== true) invalid = true;
    if (spoiler !== undefined && spoiler !== '0' && spoiler !== '1' && spoiler !== '2') invalid = true;
    if (condition !== undefined && (typeof condition !== 'string' || condition.length > 16_384)) invalid = true;
    if (tagQualifiers !== undefined && (typeof tagQualifiers !== 'string' || tagQualifiers.length > 2048))
      invalid = true;
    if (cursor !== undefined && (typeof cursor !== 'string' || new TextEncoder().encode(cursor).byteLength > 4096))
      invalid = true;
    return {
      role: typeof role === 'string' && role.length <= 128 ? role : undefined,
      returnTo: originatingConceptReturn(returnTo, getLocale()),
      pinUnsupported: pin !== undefined,
      property: typeof property === 'string' && property.length <= 128 ? property : undefined,
      scheme: typeof scheme === 'string' && /^[0-9a-f-]{36}$/i.test(scheme) ? scheme : undefined,
      type: typeof type === 'string' && type.length <= 128 ? type : undefined,
      includeChildren: children === 'true' || children === true,
      ...(spoiler === '1' || spoiler === '2'
        ? { spoilerThreshold: spoiler === '1' ? (1 as const) : (2 as const) }
        : {}),
      conditionText: typeof condition === 'string' && condition.length <= 16_384 ? condition : undefined,
      tagQualifiersText: typeof tagQualifiers === 'string' && tagQualifiers.length <= 2048 ? tagQualifiers : undefined,
      cursor: typeof cursor === 'string' && new TextEncoder().encode(cursor).byteLength <= 4096 ? cursor : undefined,
      invalid,
    };
  },
  head: () => ({ meta: [{ title: m.concept_explore_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: ConceptsRoute,
});

function ConceptsRoute() {
  const { id } = Route.useParams();
  const {
    role,
    returnTo,
    pinUnsupported,
    property,
    scheme,
    type,
    includeChildren,
    spoilerThreshold,
    conditionText,
    tagQualifiersText,
    cursor,
    invalid,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onWorksChange = (patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => {
    void navigate({
      replace: options?.replace === true,
      search: (previous) => {
        const next = { ...previous } as Record<string, unknown>;
        const retainedCondition = typeof next.conditionText === 'string' ? next.conditionText : undefined;
        const retainedTagQualifiers = typeof next.tagQualifiersText === 'string' ? next.tagQualifiersText : undefined;
        const retainedChildren = next.includeChildren === true;
        const retainedSpoiler = typeof next.spoilerThreshold === 'number' ? next.spoilerThreshold : 0;
        for (const key of [
          'conditionText',
          'tagQualifiersText',
          'includeChildren',
          'spoilerThreshold',
          'invalid',
          'pinUnsupported',
        ])
          delete next[key];
        const set = (key: string, value: string | undefined) => {
          if (value === undefined || value === '') delete next[key];
          else next[key] = value;
        };
        if ('property' in patch) set('property', patch.property);
        if ('scheme' in patch) set('scheme', patch.scheme);
        if ('type' in patch) set('type', patch.type);
        if ('includeChildren' in patch) set('children', patch.includeChildren ? 'true' : undefined);
        if ('spoilerThreshold' in patch)
          set('spoiler', patch.spoilerThreshold ? String(patch.spoilerThreshold) : undefined);
        else if (retainedSpoiler) set('spoiler', String(retainedSpoiler));
        if (!('includeChildren' in patch) && retainedChildren) set('children', 'true');
        if ('condition' in patch) set('condition', patch.condition ? JSON.stringify(patch.condition) : undefined);
        else set('condition', retainedCondition);
        if ('cursor' in patch) set('cursor', patch.cursor);
        if ('tagQualifiersText' in patch) set('tagQualifiers', patch.tagQualifiersText);
        else set('tagQualifiers', retainedTagQualifiers);
        return next as typeof previous;
      },
    });
  };
  return (
    <SourceConceptSession
      key={JSON.stringify([id, getLocale(), role])}
      id={id}
      locale={getLocale()}
      role={role}
      returnTo={returnTo}
      pinUnsupported={pinUnsupported}
      worksRoute={{
        property,
        scheme,
        type,
        includeChildren,
        spoilerThreshold,
        conditionText,
        tagQualifiersText,
        cursor,
        invalid,
      }}
      onWorksChange={onWorksChange}
    />
  );
}
