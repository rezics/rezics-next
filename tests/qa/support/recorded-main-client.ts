import { browserMainApi, BFF_PREFIX } from '../../../apps/web/features/api/browser.ts';
import type { OutcomeRecorder } from './outcome-test.ts';
import type { PersonaName, PersonaSession } from './personas.ts';

/** Run the browser's real request through the persona's HTTP session, recording its answer. */
export function recordedMainClient(recording: OutcomeRecorder, persona: PersonaName,
  person: PersonaSession, label: string) {
  const sample = recording.session(persona, person);
  return browserMainApi('https://record.invalid', {
    anonymous: persona === 'visitor',
    fetcher: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${BFF_PREFIX}/`)) throw new Error('Expected the Main browser boundary');
      const raw = await request.text();
      return sample(label, request.method, url.pathname.slice(BFF_PREFIX.length) + url.search,
        raw ? JSON.parse(raw) as unknown : undefined,
        request.headers.get('idempotency-key') ?? undefined,
        { headers: Object.fromEntries(request.headers.entries()), settle: false });
    }) as typeof fetch,
  });
}
