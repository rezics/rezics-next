/** Page-local targets only. Rows and authority stay in the route's current observation. */
export type RosterDirection = 'next' | 'previous' | 'reload' | 'first' | 'retry';
export type RosterRequest = Readonly<{ direction: Exclude<RosterDirection, 'retry'>; cursor: string | undefined }>;
export type RosterNavigationState = Readonly<{
  cursor: string | undefined;
  previous: readonly (string | undefined)[];
  truncated: boolean;
  accepted: boolean;
  requested: RosterRequest | null;
  observation: number;
}>;
const empty = (): RosterNavigationState => ({
  cursor: undefined,
  previous: [],
  truncated: false,
  accepted: false,
  requested: null,
  observation: 0,
});
export class MembershipRosterNavigation {
  state = empty();
  request(direction: RosterDirection, next?: string): RosterRequest {
    const { cursor, previous, requested } = this.state;
    if (direction === 'retry' && requested) return requested;
    const request: RosterRequest = {
      direction: direction === 'retry' ? 'reload' : direction,
      cursor:
        direction === 'first'
          ? undefined
          : direction === 'previous'
            ? previous.at(-1)
            : direction === 'next'
              ? next
              : cursor,
    };
    this.state = { ...this.state, requested: request };
    return request;
  }
  accept(request: RosterRequest) {
    const state = this.state;
    let previous = state.previous;
    let truncated = state.truncated;
    if (request.direction === 'next' && state.accepted) {
      previous = [...previous, state.cursor];
      if (previous.length > 32) {
        previous = previous.slice(-32);
        truncated = true;
      }
    } else if (request.direction === 'previous') previous = previous.slice(0, -1);
    else if (request.direction === 'first') {
      previous = [];
      truncated = false;
    }
    this.state = {
      cursor: request.cursor,
      previous,
      truncated,
      accepted: true,
      requested: null,
      observation: state.observation + 1,
    };
  }
  clear() {
    this.state = empty();
  }
}
