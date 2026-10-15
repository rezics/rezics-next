import { mainApiWithToken } from '../../../apps/web/features/api/main.ts';
import type { OutcomeRecorder } from './outcome-test.ts';
import type { PersonaSession } from './personas.ts';

/** Record the Japanese counterpart of a surface's language-dependent reads at the
 * same fixture state. Commands and language-independent reads retain one answer.
 * The production client owns query construction; no recorded answer is edited. */
export function recordJapaneseReads(recording: OutcomeRecorder): OutcomeRecorder {
  return new Proxy(recording, {
    get(target, property) {
      if (property !== 'session') {
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...identity: Parameters<OutcomeRecorder['session']>) => {
        const sample = target.session(...identity);
        return async (label: string, ...args: Parameters<PersonaSession['main']>) => {
          const response = await sample(label, ...args);
          const [method, path] = args;
          if (method !== 'GET') return response;
          const url = new URL(path, 'https://record.invalid');
          const realm = /^\/v1\/realms\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];
          const realmLanguage = realm && (!url.searchParams.has('language') || url.searchParams.get('language') === 'en');
          const agentsLanguage = url.pathname === '/v1/me/agents' && url.searchParams.get('languages') === 'en';
          if (!realmLanguage && !agentsLanguage) return response;
          const client = mainApiWithToken(undefined, { fetcher: (async (input, init) => {
            const request = new Request(input, init);
            const japanese = new URL(request.url);
            return sample(`${label}@ja`, request.method, japanese.pathname + japanese.search,
              undefined, undefined, { ...args[4], headers: {
                ...args[4]?.headers, 'accept-language': 'ja', 'x-rezics-display-languages': 'ja',
              } });
          }) as typeof fetch });
          if (realmLanguage) await client.v1.realms({ realm }).get({ query: {
            ...(url.searchParams.has('language') ? { language: 'ja' } : {}), ...(url.searchParams.has('actingSubject')
              ? { actingSubject: url.searchParams.get('actingSubject')! } : {}),
          } });
          else await client.v1.me.agents.get({ query: { languages: 'ja' } });
          return response;
        };
      };
    },
  });
}
