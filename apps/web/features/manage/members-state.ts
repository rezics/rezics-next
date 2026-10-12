export interface MemberRead {
  readonly search: string;
  readonly after: string | null;
}

/** Replacement reads own the filter and result; pagination can only extend a settled result. */
export class MemberReads {
  private submittedSearch = '';
  private active: MemberRead | null = null;
  private ready = true;

  get canAppend() { return this.active === null && this.ready; }
  get search() { return this.submittedSearch; }

  replace(search = this.search): MemberRead {
    this.submittedSearch = search;
    this.ready = false;
    const request = { search, after: null };
    this.active = request;
    return request;
  }

  append(after: string): MemberRead | null {
    if (!this.canAppend) return null;
    const request = { search: this.search, after };
    this.active = request;
    return request;
  }

  finish(request: MemberRead, succeeded: boolean): boolean {
    if (request !== this.active) return false;
    this.active = null;
    if (request.after === null) this.ready = succeeded;
    return true;
  }
}
