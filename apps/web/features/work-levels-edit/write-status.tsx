import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CircleCheckIcon, HourglassIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import type { Copy } from './messages.ts';
import type { Problem, WriteState } from './write.ts';

/** Field codes the server actions report, each with the catalog key that says what to fix. */
const fieldHints = { work: 'badWork', intent: 'badIntent', structure: 'badStructure', target: 'badTarget', label: 'badLabel',
  after: 'badAfter', kind: 'badKind', counterpart: 'badCounterpart', evidence: 'badEvidence', language: 'badLanguage',
  translators: 'badTranslators', publishers: 'badPublishers', title: 'badTitle', status: 'badStatus', isbn13: 'badIsbn13',
  year: 'badYear', territory: 'badTerritory', identifiers: 'badIdentifiers', coverage: 'badCoverage' } as const;

const headlines: Record<Problem, 'problemSignIn' | 'problemDenied' | 'problemStale' | 'problemInvalid' | 'problemUnavailable'> = {
  'sign-in': 'problemSignIn', denied: 'problemDenied', stale: 'problemStale', invalid: 'problemInvalid',
  unavailable: 'problemUnavailable' };

/** The field a refusal names, for the form to mark invalid. */
export const invalidField = (state: WriteState) => state.status === 'error' ? state.field : null;

/**
 * What the last submit came to: Main's receipt, a write still being applied, or Main's refusal with
 * its own reason. A head that moved offers "Reload latest"; the form keeps what was typed.
 */
export function WriteStatus({ state, t, onReload }: { state: WriteState; t: Copy; onReload: () => void }) {
  if (state.status === 'idle') return null;
  if (state.status === 'done') {
    return <Alert variant="success" role="status"><CircleCheckIcon aria-hidden="true" />
      <AlertTitle>{t.saved}</AlertTitle>
      <AlertDescription className="break-all">{t.receipt({ receipt: state.receipt })}
        {state.replayed ? <> · {t.replayed}</> : null}</AlertDescription></Alert>;
  }
  if (state.status === 'pending') {
    return <Alert variant="info" role="status"><HourglassIcon aria-hidden="true" />
      <AlertTitle>{t.pendingTitle}</AlertTitle><AlertDescription>{t.pendingBody}</AlertDescription></Alert>;
  }
  const hint = state.field ? t[fieldHints[state.field as keyof typeof fieldHints] ?? 'problemInvalid'] : null;
  return <Alert variant="destructive" role="alert"><TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{t[headlines[state.problem]]}</AlertTitle>
    <AlertDescription className="grid gap-2">
      {hint ? <span>{hint}</span> : null}
      {state.problem === 'stale' ? <span>{t.staleBody}</span> : null}
      {state.problem === 'unavailable' ? <span>{t.unavailableBody}</span> : null}
      {state.detail ? <span><span className="font-medium">{t.mainSays}:</span> {state.detail}</span> : null}
      {state.problem === 'stale' ? <Button type="button" variant="outline" size="sm" className="w-fit"
        onClick={onReload}><RefreshCwIcon aria-hidden="true" />{t.reload}</Button> : null}
    </AlertDescription></Alert>;
}
