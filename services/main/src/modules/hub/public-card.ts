import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

export interface PublicHubCard {
  profile: 'hub-work-card-v1';
  kind: 'prompt' | 'skill-package';
  declaredModels: string[];
  testedModels: string[];
  preview: string;
  copyText: string;
}

const prefix = 'urn:rezics:content:revision:';
const uuid = /^[0-9a-f-]{36}$/;

/** One bounded graph batch and Content batch, O(W + B) for W ≤ 20 and B ≤ 1.3 MiB.
 * The current public eligibility and publication must pin the exact Content bytes. */
export async function readPublicHubCards(session: WorkReadSession, works: readonly string[]):
  Promise<Map<string, PublicHubCard>> {
  if (!works.length) return new Map();
  if (works.length > 20 || !session.deps.content || !session.deps.hub) {
    throw new WorkReadUnavailable('Hub card owner is unavailable');
  }
  const rows = await session.query(`SELECT ?work ?variant ?publication ?eligibility ?revision ?digest WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?kind .
      VALUES ?kind { rv:PromptTemplate rv:SkillPackage }
      ?variant a rv:ContentVariant ; rv:resource ?work ;
        rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} { ?publication a rv:ContentPublicationDecision ;
      rv:component ?variant ; rv:resource ?work ; rv:contentRevision ?revision ; rv:byteDigest ?digest .
      ?eligibility a rv:ContentSearchEligibilityDecision ; rv:variant ?variant ;
        rv:resource ?work ; rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
  } LIMIT 21`, 21);
  if (rows.length > 20 || new Set(rows.map(row => row.work?.value)).size !== rows.length
    || rows.some(row => !row.work || !row.variant || !row.publication || !row.eligibility
      || !row.revision?.value.startsWith(prefix) || !uuid.test(row.revision.value.slice(prefix.length))
      || !/^[0-9a-f]{64}$/.test(row.digest?.value ?? ''))) {
    throw new WorkReadUnavailable('Public Hub card relation is ambiguous');
  }
  const revisions = rows.map(row => row.revision!.value.slice(prefix.length));
  const exact = await session.deps.content.readExactBatch(revisions, async ids => new Set(ids));
  const cards = new Map<string, PublicHubCard>();
  let bytes = 0;
  for (const [index, row] of rows.entries()) {
    const body = exact[index];
    if (body?.status === 'erased' || body?.status === 'missing' || body?.status === 'denied') continue;
    if (body?.status !== 'available' || body.reference.resourceId !== row.work!.value
      || body.reference.variantId !== row.variant!.value
      || body.reference.byteDigest !== row.digest!.value) {
      throw new WorkReadUnavailable('Published Hub bytes differ from the public graph');
    }
    const kind = body.reference.model === 'rezics-prompt-v1' ? 'prompt'
      : body.reference.model === 'rezics-skill-package-v1' ? 'skill-package' : null;
    if (!kind || (kind === 'prompt'
      ? await session.deps.hub.promptResource(revisions[index]!)
      : await session.deps.hub.skillResource(revisions[index]!)) !== row.work!.value) {
      throw new WorkReadUnavailable('Published Hub subtype is unavailable');
    }
    const copyText = kind === 'prompt' ? body.body.content : body.body.instructions;
    const previewText = kind === 'prompt' ? copyText : body.body.description;
    const declaredModels = kind === 'prompt' ? (body.body.applicability as { models?: unknown })?.models : [];
    if (typeof copyText !== 'string' || Buffer.byteLength(copyText) > 65_536
      || typeof previewText !== 'string' || Buffer.byteLength(previewText) > 2_048
      || !Array.isArray(declaredModels) || declaredModels.length > 64
      || declaredModels.some(model => typeof model !== 'string' || model.length > 200)) {
      throw new WorkReadUnavailable('Published Hub card exceeds its contract');
    }
    bytes += Buffer.byteLength(copyText);
    if (bytes > 20 * 65_536) throw new WorkReadUnavailable('Hub card page exceeds its byte budget');
    cards.set(row.work!.value, { profile: 'hub-work-card-v1', kind,
      declaredModels: declaredModels as string[], testedModels: [],
      preview: Array.from(previewText).slice(0, 240).join(''), copyText });
  }
  return cards;
}
