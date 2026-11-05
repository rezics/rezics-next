import type { QueryClient } from '@tanstack/react-query';
import type { BrowserObservationSnapshot } from '../../session/observation';
import type { QuestionManagementVisit } from './types';

type Cursor = string | null;
type Address = { selectedQuestionId: string | null; cursor: Cursor };

/** Coordinates only. A failed target never changes the accepted path. */
export class QuestionWindow {
  predecessors: Cursor[] = [];
  current: Cursor;
  accepted = false;
  target: { cursor: Cursor } | null = null;

  constructor(cursor: Cursor) {
    this.current = cursor;
  }

  stage(cursor: Cursor) {
    if (this.target) return false;
    this.target = { cursor };
    return true;
  }

  accept(cursor: Cursor) {
    if (this.target && this.target.cursor !== cursor) return false;
    if (this.accepted && this.current !== cursor) {
      const previous = this.predecessors.lastIndexOf(cursor);
      this.predecessors =
        cursor === null
          ? []
          : previous >= 0
            ? this.predecessors.slice(0, previous)
            : [...this.predecessors, this.current].slice(-8);
    }
    this.current = cursor;
    this.accepted = true;
    this.target = null;
    return true;
  }

  get requested() {
    return this.target ? this.target.cursor : this.current;
  }
  get previous() {
    return this.predecessors.at(-1);
  }
}

export class QuestionManagementWindows {
  active = true;
  directory: QuestionWindow;
  history = new QuestionWindow(null);
  expected: Address | null = null;
  focus: { region: 'directory' | 'history'; eligible: () => boolean } | null = null;

  constructor(
    public source: QuestionManagementVisit,
    readonly observation: BrowserObservationSnapshot,
    readonly locale: string,
  ) {
    this.directory = new QuestionWindow(source.cursor);
  }

  retire() {
    this.active = false;
    this.directory = new QuestionWindow(null);
    this.history = new QuestionWindow(null);
    this.expected = null;
    this.focus = null;
  }

  /** Called by the route's existing navigation observer, after the blocker decision. */
  moving(address: Address | null) {
    if (!address || address.selectedQuestionId !== this.source.selectedQuestionId) {
      this.retire();
      return;
    }
    this.directory.target = { cursor: address.cursor };
    this.expected = address;
  }
}

const visits = new WeakMap<QueryClient, QuestionManagementWindows>();

/** One eligible named-route visit per QueryClient; no retained page bodies. */
export function questionManagementWindows(
  client: QueryClient,
  source: QuestionManagementVisit,
  observation: BrowserObservationSnapshot,
  locale: string,
) {
  let visit = visits.get(client);
  if (visit?.active) {
    const previous = visit.source;
    const sameAuthority =
      visit.observation === observation &&
      visit.locale === locale &&
      previous.realmId === source.realmId &&
      previous.viewer === source.viewer &&
      previous.credentialEpisode === source.credentialEpisode &&
      previous.csrfEpisode === source.csrfEpisode;
    const movement =
      visit.expected &&
      previous.cursor !== source.cursor &&
      visit.expected.cursor === source.cursor &&
      visit.expected.selectedQuestionId === source.selectedQuestionId &&
      previous.selectedQuestionId === source.selectedQuestionId;
    if (sameAuthority && (previous === source || movement)) {
      if (previous !== source) {
        // A Router Back/Forward target can replace a failed, still-staged target.
        visit.directory.target = { cursor: source.cursor };
        visit.source = source;
        visit.expected = null;
      }
      return visit;
    }
    visit.retire();
  }
  visit = new QuestionManagementWindows(source, observation, locale);
  visits.set(client, visit);
  return visit;
}
