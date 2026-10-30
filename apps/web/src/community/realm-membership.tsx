import { useSession } from '../session/query';
import { Button } from '@rezics/ui/shadcn/button';
import { Badge } from '@rezics/ui/shadcn/badge';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import type { MemberState, MembershipResult, RealmHome } from './space';
import { changeRealmMembership } from './space-actions';
import { realmMembershipQuery, refreshRealmMembership } from './realm-membership-queries';

type Problem = Exclude<MembershipResult, { outcome: 'accepted' }> | null;
type Refresh = 'checking' | 'pending' | 'unavailable' | null;

/** Realm standing has no shadcn equivalent; compose its Badge and Button controls. */
export function RealmParticipationView({
  state,
  visibility,
  busy = false,
  ready = true,
  refresh = null,
  problem = null,
  onChange,
  onRetry,
}: {
  state: MemberState | 'loading' | 'unavailable';
  visibility: RealmHome['visibility'];
  busy?: boolean;
  ready?: boolean;
  refresh?: Refresh;
  problem?: Problem;
  onChange: (action: 'join' | 'leave') => void;
  onRetry: () => void;
}) {
  const pending = state === 'pending';
  return (
    <section
      aria-label={m.realm_membership_label()}
      data-member-state={state}
      aria-busy={busy || refresh === 'checking'}
    >
      <div className="flex flex-wrap items-center gap-3">
        {state === 'member' ? (
          <>
            <Badge>{m.realm_state_member()}</Badge>
            <Button
              size="lg"
              type="button"
              variant="outline"
              className="h-11 px-6 text-base text-foreground"
              disabled={!ready || busy}
              onClick={() => onChange('leave')}
            >
              {m.realm_leave()}
            </Button>
          </>
        ) : null}
        {state === 'none' && visibility === 'public' ? (
          <Button
            size="lg"
            type="button"
            className="h-11 px-6 text-base"
            disabled={!ready || busy}
            onClick={() => onChange('join')}
          >
            {m.realm_join()}
          </Button>
        ) : null}
        {pending ? <Badge variant="secondary">{m.realm_state_pending()}</Badge> : null}
        {state === 'unavailable' || (pending && refresh !== 'checking') ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onRetry}>
            {m.realm_membership_retry()}
          </Button>
        ) : null}
      </div>
      {state === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.realm_membership_loading()}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="max-w-prose text-sm text-muted-foreground">
          {refresh === 'checking'
            ? m.realm_membership_checking()
            : refresh === 'unavailable'
              ? m.realm_membership_pending_unavailable()
              : m.realm_membership_still_pending()}
        </p>
      ) : null}
      {state === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.realm_membership_unavailable()}
        </p>
      ) : null}
      {state === 'banned' ? (
        <p role="status" className="max-w-prose">
          {m.realm_banned()}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="max-w-prose text-sm text-destructive">
          {problem.outcome === 'closed' ? m.realm_change_closed() : (problem.detail ?? m.realm_change_failed())}
        </p>
      ) : null}
      {visibility === 'protected' ? (
        <p data-visibility="protected" className="max-w-prose text-sm text-muted-foreground">
          {state === 'member' ? m.realm_protected_note() : m.realm_protected_admission()}
        </p>
      ) : null}
    </section>
  );
}

/** Membership changes affect participation; following always addresses the carrying Space separately. */
export function RealmMembership({
  realm,
  returnTo,
  spaceId,
}: {
  realm: RealmHome;
  returnTo: string;
  spaceId?: string;
}) {
  const { state: session, csrfToken } = useSession();
  if (session !== 'signed-in') {
    if (realm.visibility === 'protected')
      return (
        <section aria-label={m.realm_membership_label()}>
          <p className="text-sm">{m.realm_protected_admission()}</p>
        </section>
      );
    return (
      <section aria-label={m.realm_membership_label()} data-member-state="none">
        <div className="flex flex-wrap items-center gap-3">
          {realm.viewer?.state === 'none' ? (
            <Button type="button" size="lg" className="h-11 px-6 text-base">
              {m.realm_join()}
            </Button>
          ) : (
            <Button
              size="lg"
              className="h-11 px-6 text-base"
              render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}
            >
              {m.realm_join()}
            </Button>
          )}
        </div>
      </section>
    );
  }
  return <PersonalMembership key={realm.id} realm={realm} csrfToken={csrfToken} spaceId={spaceId} />;
}

function PersonalMembership({
  realm,
  csrfToken,
  spaceId,
}: {
  realm: RealmHome;
  csrfToken: string | null;
  spaceId?: string;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const query = useQuery({ ...realmMembershipQuery(realm.id), enabled: personalRead.enabled });
  const [pending, setPending] = useState<{ target?: 'member' | 'none'; cycle: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [refresh, setRefresh] = useState<Refresh>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ action: 'join' | 'leave'; idempotencyKey: string } | null>(null);
  const viewer = query.data;

  useEffect(() => {
    if (viewer?.state === 'pending') setPending((previous) => previous ?? { cycle: 0 });
  }, [viewer?.state]);

  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    setRefresh('checking');
    void refreshRealmMembership(
      async () => {
        const result = await client.fetchQuery(realmMembershipQuery(realm.id));
        return result;
      },
      pending.target,
      { signal: controller.signal },
    ).then(async (result) => {
      if (controller.signal.aborted || result.kind === 'cancelled') return;
      if (result.kind === 'settled' || result.kind === 'denied') {
        setPending(null);
        setRefresh(null);
        attempt.current = null;
        await Promise.all([
          client.invalidateQueries({ queryKey: ['my-realms'] }),
          ...(spaceId ? [client.invalidateQueries({ queryKey: ['follow-state', spaceId] })] : []),
          router.invalidate(),
        ]);
      } else setRefresh(result.kind);
    });
    return () => controller.abort();
  }, [pending, client, realm.id, router, spaceId]);

  async function change(action: 'join' | 'leave') {
    if (!viewer || !csrfToken || inFlight.current || pending || (action === 'join' && realm.visibility === 'protected'))
      return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const input =
      attempt.current?.action === action ? attempt.current : { action, idempotencyKey: viewer.idempotencyKey };
    attempt.current = input;
    try {
      const result = await changeRealmMembership({
        data: { realmId: realm.id, ...input },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (result.outcome === 'accepted') {
        setRefresh('checking');
        setPending({ target: action === 'join' ? 'member' : 'none', cycle: 0 });
      } else setProblem(result);
    } catch {
      setProblem({ outcome: 'refused' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <RealmParticipationView
      state={
        pending ? 'pending' : query.isPending ? 'loading' : query.isError || !viewer ? 'unavailable' : viewer.state
      }
      visibility={realm.visibility}
      busy={busy}
      ready={!!csrfToken}
      refresh={refresh}
      problem={problem}
      onChange={(action) => void change(action)}
      onRetry={() => (pending ? setPending({ ...pending, cycle: pending.cycle + 1 }) : void query.refetch())}
    />
  );
}
