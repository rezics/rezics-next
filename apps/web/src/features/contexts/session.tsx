import { useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import {
  changeContextWorkspace,
  readContextCreation,
  readContextDirectory,
  readContextSettings,
  readContextTargets,
  readContextWorkspace,
} from './actions';
import type { SettingsRead } from './settings';
import { ContextAdmissions, ContextWork, useContextVisit, type ContextAdmission } from './lifetime';
import {
  contextQueryKey,
  unavailable,
  type Actions,
  type Command,
  type DirectoryInput,
  type DirectoryWorkspace,
  type MutationResult,
  type Result,
  type Workspace,
} from './model';
import { ContextCreateView, ContextDetailView, ContextDirectoryView, ContextFeedback } from './view';

type Mode = { mode: 'directory'; input: DirectoryInput } | { mode: 'create' } | { mode: 'detail'; id: string };
type AdmissionProps = { admissions: ContextAdmissions; admission: ContextAdmission; locale: string };

function VisitSession({ admissions, admission, locale, ...props }: Mode & AdmissionProps) {
  const client = useQueryClient();
  const address = props.mode === 'detail' ? props.id : props.mode === 'directory' ? props.input : null;
  const visit = useContextVisit(
    client,
    admissions,
    admission,
    contextQueryKey(admission.reader, locale, props.mode, address),
  );
  const query = useQuery({
    ...personalRead,
    queryKey: visit.key,
    queryFn: ({ signal }) =>
      visit.read<DirectoryWorkspace | Result<Actions> | Result<Workspace>>(
        signal,
        (signal) => {
          visit.assertCurrent();
          const options = { headers: visit.headers, signal };
          if (props.mode === 'directory') return readContextDirectory({ data: props.input, ...options });
          if (props.mode === 'create') return readContextCreation(options);
          return readContextWorkspace({
            data: { id: props.id, ...(visit.session ? { session: visit.session } : {}) },
            ...options,
          });
        },
        (result) => {
          if (props.mode === 'detail' && 'session' in result) visit.session = result.session ?? visit.session;
        },
      ),
    gcTime: 0,
    retry: false,
  });
  async function reload() {
    if (!visit.live()) return;
    const result = await query.refetch();
    if (!visit.live()) return;
    return result;
  }
  async function submit(command: Command): Promise<MutationResult> {
    visit.assertCurrent();
    await client.cancelQueries({ queryKey: visit.key, exact: true });
    visit.assertCurrent();
    try {
      const result = await changeContextWorkspace({ data: command, headers: visit.headers, signal: visit.signal });
      visit.assertCurrent();
      if (props.mode === 'detail') {
        visit.session = result.session ?? visit.session;
        if (result.kind === 'confirmed') {
          visit.session = result.current.session ?? visit.session;
          client.setQueryData(visit.key, result.current);
        } else {
          // Current denial/conflict and unknown outcomes drop the previous private payload.
          client.setQueryData(visit.key, unavailable);
          await reload();
        }
      } else await reload();
      visit.assertCurrent();
      return result;
    } catch (error) {
      visit.assertCurrent();
      throw error;
    }
  }
  const loadSettings = useMemo(
    () => async (digest?: string) => {
      visit.assertCurrent();
      const result = await readContextSettings({
        data: {
          ...(digest ? { digest } : {}),
          ...(visit.session ? { session: visit.session } : {}),
        },
        headers: visit.headers,
        signal: visit.signal,
      });
      visit.assertCurrent();
      if ('session' in result) visit.session = result.session ?? visit.session;
      return result as SettingsRead;
    },
    [visit],
  );
  const search = useMemo(
    () => async (text: string, signal: AbortSignal) => {
      visit.assertCurrent();
      const combined = AbortSignal.any([signal, visit.signal]);
      combined.throwIfAborted();
      try {
        const result = await readContextTargets({ data: { text, locale }, headers: visit.headers, signal: combined });
        visit.assertCurrent();
        combined.throwIfAborted();
        if (result.kind !== 'ready') throw new Error('Context targets unavailable');
        return result.value;
      } catch (error) {
        visit.assertCurrent();
        throw error;
      }
    },
    [visit, locale],
  );
  return (
    <ContextWork.Provider key={JSON.stringify(visit.key)} value={visit.live}>
      {props.mode === 'directory' ? (
        <ContextDirectoryView
          locale={locale}
          input={props.input}
          data={
            query.isFetching
              ? null
              : query.isError
                ? { page: unavailable, creation: unavailable }
                : ((query.data as DirectoryWorkspace | undefined) ?? null)
          }
          reload={reload}
        />
      ) : props.mode === 'create' ? (
        <ContextCreateView
          locale={locale}
          actions={
            query.isFetching
              ? null
              : query.isError
                ? unavailable
                : ((query.data as Result<Actions> | undefined) ?? null)
          }
          submit={submit}
          reload={reload}
          loadSettings={loadSettings}
        />
      ) : (
        <ContextDetailView
          id={props.id}
          locale={locale}
          data={
            query.isFetching
              ? null
              : query.isError
                ? unavailable
                : ((query.data as Result<Workspace> | undefined) ?? null)
          }
          submit={submit}
          reload={reload}
          search={search}
          loadSettings={loadSettings}
        />
      )}
    </ContextWork.Provider>
  );
}

const serverAdmission = () => null;
/** Personal work belongs to one successful session admission, never just subject equality. */
export function ContextSession(props: Mode) {
  const { state, subject } = useSession();
  const client = useQueryClient();
  const admissions = useMemo(() => new ContextAdmissions(client), [client]);
  const admission = useSyncExternalStore(admissions.subscribe, admissions.snapshot, serverAdmission);
  const locale = getLocale();
  if (state === 'unknown') return <p role="status">{m.ctxw_loading()}</p>;
  if (state !== 'signed-in' || !admission || admission.reader !== subject)
    return (
      <ContextFeedback locale={locale} failure={{ kind: state === 'signed-out' ? 'signed-out' : 'unavailable' }} />
    );
  const identity = JSON.stringify([admission.id, locale, props]);
  return <VisitSession key={identity} {...props} admissions={admissions} admission={admission} locale={locale} />;
}
export function ContextPending() {
  return <p role="status">{m.ctxw_loading()}</p>;
}
export function ContextRouteError() {
  const router = useRouter();
  return <ContextFeedback locale={getLocale()} failure={unavailable} retry={() => void router.invalidate()} />;
}
