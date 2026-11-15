import {
  platformRegistry,
  walkStructuralContent,
  type CompositionDocument,
  type CompositionNode,
} from '@rezics/composition';

const components = new Map(platformRegistry.components.map((component) => [component.type, component]));

/** Locate an authored intro and its registered owning slot without flattening the starter layout. */
export function copyStarterIntro(source: CompositionDocument, name: string) {
  const document = structuredClone(source);
  const nodes = [...walkStructuralContent(platformRegistry, document.content)];
  const intro = nodes.find((node) => node.type === 'Text' && node.props.id === 'intro');
  if (!intro || typeof intro.props['text'] !== 'string') throw new Error(`The ${name} starter intro is missing.`);
  const contents: CompositionNode[][] = [document.content];
  for (const node of nodes) {
    for (const slot of components.get(node.type)?.slots ?? []) {
      const children = node.props[slot];
      if (Array.isArray(children)) contents.push(children as CompositionNode[]);
    }
  }
  const siblings = contents.find((content) => content.includes(intro));
  if (!siblings) throw new Error(`The ${name} starter intro has no structural owner.`);
  return { document, intro, siblings };
}
