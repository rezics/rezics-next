import type { AgentOption } from '../auth/acting-identity.ts';
import { recipeEditHref } from '../recipe-editor/route.ts';
import { idOf } from './types.ts';
import { identityKeyUuid, uuidToSid } from '@rezics/model/address';

// Studio carries its Agent in the route, `/studio/@{agent}/…`: a workspace
// layer (docs/contracts/identity-and-access.md#acting-identity-layers) that
// starts from the session Agent and may differ from it, per tab. The segment
// is the chosen handle or the opaque sid. Historical forms still resolve.

/** The route segment for an Agent, without the `@`. */
function agentSlug(agent: Pick<AgentOption, 'iri' | 'handle'>): string {
  return agent.handle ?? uuidToSid(agent.iri.slice(-36));
}

/** `/studio/@{agent}` plus a Studio path such as `/new` or `/works/<id>`. */
export function studioHref(agent: Pick<AgentOption, 'iri' | 'handle'>, path = ''): string {
  return `/studio/@${agentSlug(agent)}${path}`;
}

export type StudioAgent =
  | { kind: 'agent'; agent: AgentOption }
  /** A well-formed address for an Agent this person does not act for. It is reported, never replaced. */
  | { kind: 'foreign'; slug: string }
  /** Not an Agent address at all. */
  | { kind: 'invalid' };

/**
 * The Agent a Studio route segment names, among the Agents this person may act as.
 * Accepts a sid or chosen handle, and legacy UUID forms, raw or percent-encoded.
 */
export function resolveStudioAgent(segment: string, options: readonly AgentOption[]): StudioAgent {
  let value: string;
  try { value = decodeURIComponent(segment); } catch { return { kind: 'invalid' }; }
  if (!value.startsWith('@') || value.length < 2 || value.length > 80) return { kind: 'invalid' };
  const key = value.slice(1);
  const slug = key.toLowerCase();
  const id = identityKeyUuid(/^agent-/i.test(key) ? key.slice(6) : key);
  const agent = options.find(option => option.handle?.toLowerCase() === slug
    || (id !== null && option.iri.slice(-36) === id));
  if (agent) return { kind: 'agent', agent };
  return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? { kind: 'foreign', slug: id ? key : slug } : { kind: 'invalid' };
}

export type WorkTab = 'chapters' | 'text' | 'details' | 'realms';

/** A text Studio can reopen, or none when that language has not been written yet. */
export interface EditingTarget {
  language: string;
  text?: { id: string; revision?: string | null } | null;
  /** This opens a book's own text, its introduction, rather than its chapters. */
  introduction?: boolean;
}

/**
 * Where Studio opens a Work for editing. A recipe always opens in the recipe
 * editor. A book opens on its chapters, unless this is its introduction. Any
 * other Work opens the named text, or a new one in `language`.
 */
export function editingHref(agent: Pick<AgentOption, 'iri' | 'handle'>, work: string, kind: string,
  target: EditingTarget): string {
  if (kind === 'recipe') return recipeEditHref(work);
  if (kind === 'book' && !target.introduction) return workHref(agent, work, 'chapters');
  if (target.text) return textHref(agent, work, target.text.id, target.text.revision);
  return `${studioHref(agent, `/works/${idOf(work)}/write`)}?language=${encodeURIComponent(target.language)}`;
}

/** Where Studio opens a Work it has just created. */
export function createdWorkPath(agent: Pick<AgentOption, 'iri' | 'handle'>, work: string, presentation: string,
  language: string): string {
  return editingHref(agent, work, presentation, { language });
}

/** A Work's Studio page, on one of its tabs. */
export function workHref(agent: Pick<AgentOption, 'iri' | 'handle'>, work: string, tab?: WorkTab): string {
  return studioHref(agent, `/works/${idOf(work)}${tab ? `?tab=${tab}` : ''}`);
}

/** The editor address for one text, pinned to the revision Studio last saw so a reload opens it exactly. */
export function textHref(agent: Pick<AgentOption, 'iri' | 'handle'>, work: string, text: string, revision?: string | null):
  string {
  return studioHref(agent, `/works/${idOf(work)}/write/${idOf(text)}${revision ? `?revision=${idOf(revision)}` : ''}`);
}

/** The editor address for one chapter of a Book, pinned like a text's, in the language the Book is written in. */
export function chapterHref(agent: Pick<AgentOption, 'iri' | 'handle'>, book: string, chapter: string,
  revision?: string | null, language?: string): string {
  const query = new URLSearchParams([...revision ? [['revision', idOf(revision)]] : [],
    ...language ? [['language', language]] : []]).toString();
  return studioHref(agent, `/works/${idOf(book)}/chapters/${idOf(chapter)}${query ? `?${query}` : ''}`);
}
