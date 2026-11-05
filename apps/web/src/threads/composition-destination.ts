import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { m } from '../paraglide/messages.js';
import { boardCommunitySource, type CommunityPresentation } from './board-community-source';
import type { NewThreadPageResult } from './new-thread-read';

type Board = NewThreadPageResult['board'];
type RulesSlot = CommunityPresentation['rules'];
export type CompositionRulesValue = Extract<RulesSlot, { state: 'available' }>['value'];

export type CompositionRulesIdentity = Readonly<{
  destinationKey: string;
  postId: string;
  revisionId: string;
  sha256: string;
}>;

export type CompositionRulesOutline = Readonly<{
  entries: readonly Readonly<{ index: number; level: number; label: string }>[];
  omitted: number;
  total: number;
}>;

export type CompositionDestinationProjection = Readonly<{
  boardId: string;
  boardTitle: string | null;
  destinationKey: string;
  community:
    | Readonly<{ state: 'global' }>
    | Readonly<{ state: 'unavailable' }>
    | Readonly<{
        state: 'available';
        name: string;
        realmId: string;
        spaceId: string;
        contextId: string;
        rules: RulesSlot;
      }>;
  rulesIdentity?: CompositionRulesIdentity;
  outline?: CompositionRulesOutline;
}>;

const emptyOutline: CompositionRulesOutline = { entries: [], omitted: 0, total: 0 };
const outlineLimit = 100;

function clippedLabel(value: string): string {
  const points = Array.from(value.replace(/\s+/gu, ' ').trim());
  return points.length > 96 ? `${points.slice(0, 95).join('')}…` : points.join('');
}

function visibleHeadingText(heading: DocumentNode): string {
  const text: string[] = [];
  const stack = [heading];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'text') {
      if (!node.marks?.some((mark) => mark.type === 'spoiler')) text.push(node.text ?? '');
      continue;
    }
    if (node.type === 'hardBreak') {
      text.push(' ');
      continue;
    }
    if (node.type === 'mention' || node.type === 'image' || node.type === 'media' || node.type.startsWith('extension'))
      continue;
    const content = node.content ?? [];
    for (let index = content.length - 1; index >= 0; index--) stack.push(content[index]!);
  }
  return text.join('');
}

/** A local, bounded index for the already admitted text-profile snapshot. */
export function projectCompositionRulesOutline(body: DocumentSnapshot): CompositionRulesOutline {
  const entries: { index: number; level: number; label: string }[] = [];
  const stack = [...(body.doc.content ?? [])].reverse();
  let total = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'heading') {
      const index = total++;
      if (entries.length < outlineLimit) {
        const label =
          clippedLabel(visibleHeadingText(node)) || m.composition_rules_reader_section({ number: index + 1 });
        const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
        entries.push({ index, level, label });
      }
    }
    const content = node.content ?? [];
    for (let index = content.length - 1; index >= 0; index--) stack.push(content[index]!);
  }
  return { entries, total, omitted: Math.max(0, total - entries.length) };
}

function identityKey(identity: CompositionRulesIdentity): string {
  return JSON.stringify([identity.destinationKey, identity.postId, identity.revisionId, identity.sha256]);
}

export function sameCompositionRulesIdentity(
  left: CompositionRulesIdentity | null,
  right: CompositionRulesIdentity | null,
): boolean {
  return Boolean(left && right && identityKey(left) === identityKey(right));
}

/** A per-visit, one-snapshot projection cache. The latest outline is reused by revision identity. */
export function createCompositionDestinationReader() {
  let lastBoard: Board | undefined;
  let lastProjection: CompositionDestinationProjection | undefined;
  let outlineKey: string | undefined;
  let outline = emptyOutline;

  return {
    read(board: Board): CompositionDestinationProjection {
      if (board === lastBoard && lastProjection) return lastProjection;

      const source = boardCommunitySource(board);
      const destinationKey =
        source === null
          ? JSON.stringify([board.id, 'global'])
          : source.state === 'unavailable'
            ? JSON.stringify([board.id, board.realmId, 'unavailable'])
            : JSON.stringify([board.id, source.value.realmId, source.value.spaceId, source.value.contextId]);

      let community: CompositionDestinationProjection['community'];
      let rulesIdentity: CompositionRulesIdentity | undefined;
      let currentOutline: CompositionRulesOutline | undefined;
      if (source === null) {
        community = { state: 'global' };
        outlineKey = undefined;
        outline = emptyOutline;
      } else if (source.state === 'unavailable') {
        community = { state: 'unavailable' };
        outlineKey = undefined;
        outline = emptyOutline;
      } else {
        community = {
          state: 'available',
          name: source.value.name,
          realmId: source.value.realmId,
          spaceId: source.value.spaceId,
          contextId: source.value.contextId,
          rules: source.value.rules,
        };
        if (source.value.rules.state === 'available') {
          const value = source.value.rules.value;
          rulesIdentity = {
            destinationKey,
            postId: value.postId,
            revisionId: value.revisionId,
            sha256: value.sha256,
          };
          const nextOutlineKey = identityKey(rulesIdentity);
          if (outlineKey !== nextOutlineKey) {
            outline = projectCompositionRulesOutline(value.body);
            outlineKey = nextOutlineKey;
          }
          currentOutline = outline;
        } else {
          outlineKey = undefined;
          outline = emptyOutline;
        }
      }

      lastBoard = board;
      lastProjection = {
        boardId: board.id,
        boardTitle: board.title,
        destinationKey,
        community,
        ...(rulesIdentity && currentOutline ? { rulesIdentity, outline: currentOutline } : {}),
      };
      return lastProjection;
    },
    clear() {
      lastBoard = undefined;
      lastProjection = undefined;
      outlineKey = undefined;
      outline = emptyOutline;
    },
  };
}

export function compositionDestinationPanelKey(destination: CompositionDestinationProjection): string {
  return destination.community.state === 'available'
    ? JSON.stringify([destination.destinationKey, destination.community.rules.state])
    : JSON.stringify([destination.destinationKey, destination.community.state]);
}
