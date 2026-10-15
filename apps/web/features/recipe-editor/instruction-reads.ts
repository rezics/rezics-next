import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import type { MainClient } from '../studio/types.ts';
import { instructionDocument, procedureDefinition, referenceDefinition, type Instruction, type ProcedureItem } from './instructions.ts';

type Reference = Parameters<MainClient['v1']['resource-reference-resolutions']['post']>[0]['references'][number];
type Derivations = NonNullable<Awaited<ReturnType<ReturnType<MainClient['v1']['content-revisions']>['derivations']['get']>>['data']>;
type Resolutions = NonNullable<Awaited<ReturnType<MainClient['v1']['resource-reference-resolutions']['post']>>['data']>;
type Recording = NonNullable<Awaited<ReturnType<ReturnType<MainClient['v1']['media']['representations']>['get']>>['data']>;
export interface InstructionDetails {
  author?: string;
  derivations?: Derivations;
  references?: Resolutions['items'];
  recording?: Recording;
  refusals: { status: number; problem: unknown }[];
}
export type ReadInstruction = Instruction & { details?: InstructionDetails };

/** References are inspected once; resolving an intermediate Recipe never expands its dependencies. */
function referencesIn(document: DocumentSnapshot): Reference[] {
  const references: Reference[] = [];
  const visit = (node: DocumentNode) => {
    if (node.attrs?.definition === referenceDefinition) references.push(node.attrs.payload as unknown as Reference);
    if (node.attrs?.definition === procedureDefinition) {
      const items = (node.attrs.payload as { items: ProcedureItem[] }).items;
      const procedure = (item: ProcedureItem) => item.type === 'HowToStep' ? visit(item.document.doc) : item.items.forEach(procedure);
      items.forEach(procedure);
    }
    node.content?.forEach(visit);
  };
  visit(document.doc);
  return references;
}

/** Production page and editor reads use the caller's cached persona client, including every refusal. */
export async function readInstructionDetails(main: MainClient, instructions: readonly Instruction[], actingSubject?: string | null): Promise<ReadInstruction[]> {
  const query = { ...(actingSubject ? { actingSubject } : {}) };
  const content = new Map<string, Promise<InstructionDetails>>();
  return Promise.all(instructions.map(async instruction => {
    if (instruction.status !== 'available') return instruction;
    const selector = instruction.reference.selector;
    const key = JSON.stringify(instruction.reference);
    let pending = content.get(key);
    if (!pending) {
      pending = (async () => {
        const details: InstructionDetails = { refusals: [] };
        const keep = <T>(answer: { data: T | null; error: { status: number; value?: unknown } | null; status: number }) => {
          if (answer.error || answer.status !== 200) {
            details.refusals.push({ status: answer.status, problem: answer.error?.value ?? answer.data });
            return null;
          }
          return answer.data;
        };
        if (selector.grain === 'content') {
          const exact = keep(await main.v1['content-revisions']({ revision: selector.revision }).get({ query }));
          if (exact) details.author = exact.reference.provenance.author;
          const derivations = await main.v1['content-revisions']({ revision: selector.revision }).derivations.get({
            query: { ...query, limit: 20 },
          });
          const document = instructionDocument(instruction);
          const references = document ? referencesIn(document) : [];
          const resolved: Resolutions['items'] = [];
          for (let offset = 0; offset < references.length; offset += 16) {
            const page = keep(await main.v1['resource-reference-resolutions'].post({
              ...query, references: references.slice(offset, offset + 16),
            }));
            if (page) resolved.push(...page.items);
          }
          details.references = resolved;
          return { ...details, derivations: keep(derivations) ?? undefined };
        } else {
          details.recording = keep(await main.v1.media.representations({ representation: selector.representation }).get({
            query: { ...query, ...(instruction.mediaUse ? { use: instruction.mediaUse } : {}) },
          })) ?? undefined;
        }
        return details;
      })();
      content.set(key, pending);
    }
    return { ...instruction, details: await pending };
  }));
}
