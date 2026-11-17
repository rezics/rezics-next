import type { ShowcaseReviewPort } from './showcase-contract.ts';

type Phase =
  | 'initial-build'
  | 'validation-setup'
  | 'bindings'
  | 'validated-build'
  | 'validated-seal'
  | 'membership-build'
  | 'membership-seal'
  | 'final-build'
  | 'final-seal';
type Read = 'subjects' | 'candidateListings' | 'candidatePages' | 'factsFences' | 'coverFences';

/** Bounded stderr diagnostics for the final pass. Serialize only fixed labels and counts or durations. */
export class ShowcaseManifestTrace {
  readonly #started = performance.now();
  readonly #reads = {
    subjects: { count: 0, ms: 0 },
    candidateListings: { count: 0, ms: 0 },
    candidatePages: { count: 0, ms: 0 },
    factsFences: { count: 0, ms: 0 },
    coverFences: { count: 0, ms: 0 },
  };
  #assertionsStarted = 0;
  #assertionReadMsAtStart = 0;

  constructor(readonly write: (line: string) => void = (line) => process.stderr.write(line + '\n')) {}

  start(phase: Phase): number {
    const now = performance.now();
    this.#emit({ phase, state: 'started', elapsedMs: Math.round(now - this.#started) });
    return now;
  }

  complete(phase: Phase, started: number): void {
    const now = performance.now();
    this.#emit({
      phase,
      state: 'completed',
      elapsedMs: Math.round(now - this.#started),
      phaseMs: Math.round(now - started),
      ...(phase === 'bindings' ? this.#counts() : {}),
    });
  }

  candidateListingMiss<T>(run: () => Promise<T>): Promise<T> {
    return this.#measure('candidateListings', run);
  }

  assertions(state: 'started' | 25 | 50 | 75 | 'completed', completed: number, total: number): void {
    const now = performance.now();
    const { subjects, candidateListings, factsFences, coverFences } = this.#reads;
    const readMs = subjects.ms + candidateListings.ms + factsFences.ms + coverFences.ms;
    if (state === 'started') {
      this.#assertionsStarted = now;
      this.#assertionReadMsAtStart = readMs;
    }
    const phaseMs = now - this.#assertionsStarted;
    this.#emit({
      phase: 'assertions',
      state,
      elapsedMs: Math.round(now - this.#started),
      phaseMs: Math.round(phaseMs),
      completed,
      total,
      // Validation reads are serial. Candidate listing time already includes its native pages and journal work.
      localMs: Math.max(0, Math.round(phaseMs - (readMs - this.#assertionReadMsAtStart))),
      ...this.#counts(),
    });
  }

  review(port: ShowcaseReviewPort): Pick<ShowcaseReviewPort, 'readReviewedSubject' | 'reviewedCandidates' | 'fence'> {
    return {
      readReviewedSubject: (id) => this.#measure('subjects', () => port.readReviewedSubject(id)),
      reviewedCandidates: (id, query) => this.#measure('candidatePages', () => port.reviewedCandidates(id, query)),
      ...(port.fence && {
        fence: (query) =>
          this.#measure(query.fieldGroup === 'cover' ? 'coverFences' : 'factsFences', () => port.fence!(query)),
      }),
    };
  }

  async #measure<T>(category: Read, run: () => Promise<T>): Promise<T> {
    const read = this.#reads[category];
    const started = performance.now();
    read.count += 1;
    try {
      return await run();
    } finally {
      read.ms += performance.now() - started;
    }
  }

  #counts() {
    const { subjects, candidateListings, candidatePages, factsFences, coverFences } = this.#reads;
    return {
      subjects: subjects.count,
      subjectMs: Math.round(subjects.ms),
      candidateListingMisses: candidateListings.count,
      candidateListingMs: Math.round(candidateListings.ms),
      candidatePages: candidatePages.count,
      candidatePageMs: Math.round(candidatePages.ms),
      factsFences: factsFences.count,
      factsFenceMs: Math.round(factsFences.ms),
      coverFences: coverFences.count,
      coverFenceMs: Math.round(coverFences.ms),
    };
  }

  #emit(observation: Record<string, string | number>): void {
    this.write(`Cross-media final showcase manifest ${JSON.stringify(observation)}`);
  }
}
