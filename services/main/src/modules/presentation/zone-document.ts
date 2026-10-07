import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { documentSnapshotSchema } from '../../api-document.ts';
import { ZonePresentation } from '../zone/presentation-format.ts';
import type { readZoneModuleData } from '../zone/publication.ts';
import type { readZoneCampaignArt } from '../zone/campaign-art.ts';
import { WorkReadLimit } from '../work/read-session.ts';

const closed = { additionalProperties: false };
export const ZONE_SHOWCASE_BLOCK_DEFINITION = 'https://rezics.com/definition/showcase-block-v1';
export const ZONE_SHOWCASE_BLOCK_VERSION = '1';

/** The Blocks payload pattern: named predicates, preserving cardinality. */
export const ZoneShowcasePayload = Type.Object({
  'rv:module': Type.Optional(Type.Array(Type.String({
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64,
  }), { minItems: 1, maxItems: 1, uniqueItems: true })),
}, closed);
export type ZoneShowcasePayload = Static<typeof ZoneShowcasePayload>;
export const ZONE_SHOWCASE_BLOCK = {
  definition: ZONE_SHOWCASE_BLOCK_DEFINITION,
  version: ZONE_SHOWCASE_BLOCK_VERSION,
  payloadSchema: ZoneShowcasePayload,
} as const;

/** Content retains at most 1 MB per document; even its smallest nodes fit this
 * traversal bound. Slides and media are shared once per document; module source
 * results are shared once per selected module, with a final response byte bound. */
export const ZONE_DOCUMENT_COST = { maxNodes: 100_000, maxShowcases: 25,
  maxModuleSources: 9, maxSlides: 6, maxResponseBytes: 4 * 1024 * 1024,
  graphReads: 0, definitionExecutions: 0 } as const;

type ModuleData = Awaited<ReturnType<typeof readZoneModuleData>>;
type SlideMedia = Awaited<ReturnType<typeof readZoneCampaignArt>>;
export interface ZonePageShowcase {
  id: string;
  module: ZonePresentation['modules'][number] | null;
  sources: ModuleData[number]['sources'];
}

const blockIdentity = {
  id: Type.String(), definition: Type.String(), version: Type.String(), fallback: Type.String(),
};
export const ZonePageBlock = Type.Union([
  Type.Object({ ...blockIdentity, status: Type.Literal('resolved'),
    kind: Type.Literal('showcase'), showcase: Type.String() }, closed),
  Type.Object({ ...blockIdentity, status: Type.Literal('placeholder'), reason: Type.Union([
    Type.Literal('unknown_definition'), Type.Literal('unsupported_version'),
    Type.Literal('invalid_payload'), Type.Literal('missing_module'),
  ]) }, closed),
]);
export type ZonePageBlock = Static<typeof ZonePageBlock>;

export const ZonePageDocument = Type.Object({
  document: documentSnapshotSchema,
  definitions: Type.Array(Type.Object({ definition: Type.Literal(ZONE_SHOWCASE_BLOCK_DEFINITION),
    version: Type.Literal(ZONE_SHOWCASE_BLOCK_VERSION), payloadSchema: Type.Unknown() }, closed),
  { maxItems: 1 }),
  blocks: Type.Array(ZonePageBlock, { maxItems: ZONE_DOCUMENT_COST.maxNodes }),
  showcases: Type.Array(Type.Unsafe<ZonePageShowcase>(Type.Object({ id: Type.String(),
    module: Type.Union([Type.Null(), ZonePresentation.properties.modules.items]),
    sources: Type.Array(Type.Unknown(), { maxItems: ZONE_DOCUMENT_COST.maxModuleSources }),
  }, closed)), { maxItems: ZONE_DOCUMENT_COST.maxShowcases }),
  showcaseData: Type.Object({
    slides: ZonePresentation.properties.slides,
    slideMedia: Type.Unsafe<SlideMedia>(Type.Array(Type.Unknown(), { maxItems: ZONE_DOCUMENT_COST.maxSlides })),
  }, closed),
  cost: Type.Object({ nodesVisited: Type.Integer({ minimum: 0, maximum: ZONE_DOCUMENT_COST.maxNodes }),
    extensions: Type.Integer({ minimum: 0, maximum: ZONE_DOCUMENT_COST.maxNodes }),
    showcases: Type.Integer({ minimum: 0, maximum: ZONE_DOCUMENT_COST.maxShowcases }),
    responseBytes: Type.Integer({ minimum: 0, maximum: ZONE_DOCUMENT_COST.maxResponseBytes }),
    graphReads: Type.Literal(0), definitionExecutions: Type.Literal(0) }, closed),
}, closed);
export type ZonePageDocument = Static<typeof ZonePageDocument>;

/** Resolve a retained exact document against its published, disclosure-filtered
 * presentation. The caller supplies the existing bounded public module/media
 * reads. Unknown definitions and versions stay opaque; no definition is loaded
 * or executed, and the original body survives unchanged for export. */
export function resolveZonePageDocument(document: DocumentSnapshot,
  presentation: ZonePresentation, moduleData: ModuleData, slideMedia: SlideMedia): ZonePageDocument {
  if (presentation.modules.length > ZONE_DOCUMENT_COST.maxShowcases - 1
    || presentation.slides.length > ZONE_DOCUMENT_COST.maxSlides
    || slideMedia.length > ZONE_DOCUMENT_COST.maxSlides
    || moduleData.length > ZONE_DOCUMENT_COST.maxShowcases - 1
    || moduleData.some(module => module.sources.length > ZONE_DOCUMENT_COST.maxModuleSources)) {
    throw new WorkReadLimit('Zone document presentation exceeds its bound');
  }
  const modules = new Map(presentation.modules.map(module => [module.id, module]));
  const sources = new Map(moduleData.map(module => [module.id, module.sources]));
  const showcases = new Map<string, ZonePageShowcase>();
  const blocks: ZonePageBlock[] = [];
  const pending: DocumentNode[] = [document.doc];
  let nodesVisited = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++nodesVisited > ZONE_DOCUMENT_COST.maxNodes) {
      throw new WorkReadLimit('Zone document traversal exceeds its bound');
    }
    for (let index = (node.content?.length ?? 0) - 1; index >= 0; index--) {
      pending.push(node.content![index]!);
    }
    if (node.type !== 'extensionBlock' && node.type !== 'extensionInline') continue;
    const attrs = node.attrs!;
    const identity = { id: String(attrs.id), definition: String(attrs.definition),
      version: String(attrs.version), fallback: String(attrs.fallback) };
    let reason: Extract<ZonePageBlock, { status: 'placeholder' }>['reason'] | undefined;
    if (identity.definition !== ZONE_SHOWCASE_BLOCK_DEFINITION || node.type !== 'extensionBlock') {
      reason = 'unknown_definition';
    } else if (identity.version !== ZONE_SHOWCASE_BLOCK_VERSION) {
      reason = 'unsupported_version';
    } else if (!Value.Check(ZoneShowcasePayload, attrs.payload)) {
      reason = 'invalid_payload';
    } else {
      const moduleId = attrs.payload['rv:module']?.[0];
      const module = moduleId ? modules.get(moduleId) : null;
      if (moduleId && (!module || module.type !== 'hero-carousel')) {
        reason = 'missing_module';
      } else {
        const id = moduleId ?? '$default';
        if (!showcases.has(id)) showcases.set(id, { id, module: module ?? null,
          sources: moduleId ? sources.get(moduleId) ?? [] : [] });
        blocks.push({ ...identity, status: 'resolved', kind: 'showcase', showcase: id });
      }
    }
    if (reason) blocks.push({ ...identity, status: 'placeholder', reason });
  }
  const result: ZonePageDocument = { document, definitions: [ZONE_SHOWCASE_BLOCK], blocks,
    showcases: [...showcases.values()], showcaseData: { slides: presentation.slides, slideMedia },
    cost: { nodesVisited, extensions: blocks.length, showcases: showcases.size,
      responseBytes: 0, graphReads: 0, definitionExecutions: 0 } };
  const zeroBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  // Account for the byte count's own digits without serializing the document again.
  let responseBytes = zeroBytes;
  while (responseBytes !== zeroBytes + String(responseBytes).length - 1) {
    responseBytes = zeroBytes + String(responseBytes).length - 1;
  }
  if (responseBytes > ZONE_DOCUMENT_COST.maxResponseBytes) {
    throw new WorkReadLimit('Zone document response exceeds its byte bound');
  }
  result.cost.responseBytes = responseBytes;
  return result;
}
