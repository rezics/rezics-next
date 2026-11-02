import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { personalRead } from "../kernel/query";
import { useCreatorCurrentOrigin } from "./creator-current-origin";
import {
  acceptsStatementsCurrent,
  readCreatorStatementCurrent,
  readCreatorStatementsCurrent,
  type CreatorStatementCurrentRead,
  type CreatorStatementData,
  type CreatorStatementsAddress,
  type CreatorStatementsCurrentRead,
  type CreatorStatementsData,
} from "./creator-statements";
import { CreatorStatementPage } from "./creator-statement-page";
import { CreatorStatementsPage } from "./creator-statements-page";
import { CreatorPaymentAttestation } from "./creator-payment-attestation-form";

type Page =
  CreatorStatementsData | CreatorStatementData | { kind: "preparing" };
type CurrentRead = CreatorStatementsCurrentRead<
  CreatorStatementsData | CreatorStatementData
>;
type Origin = ReturnType<typeof useCreatorCurrentOrigin>["origin"];
type Outcome = { kind: "accepted"; value: CurrentRead } | { kind: "failed" };

export function CreatorStatementsCurrent({
  initial,
  locale,
  cursor,
}: {
  initial: CreatorStatementsCurrentRead;
  locale: string;
  cursor?: string;
}) {
  return (
    <StatementsBoundary
      initial={initial}
      address={{ kind: "list", locale, cursor: cursor || null }}
    />
  );
}

export function CreatorStatementCurrent({
  initial,
  locale,
  id,
  cursor,
  from,
}: {
  initial: CreatorStatementCurrentRead;
  locale: string;
  id: string;
  cursor?: string;
  from?: string;
}) {
  return (
    <StatementsBoundary
      initial={initial}
      address={{
        kind: "detail",
        locale,
        id,
        cursor: cursor || null,
        from: from || null,
      }}
    />
  );
}

function StatementPresentation({
  address,
  page,
  payment,
}: {
  address: CreatorStatementsAddress;
  page: Page;
  payment?: ReactNode;
}) {
  const search = address.cursor ? { cursor: address.cursor } : {};
  return address.kind === "list" ? (
    <CreatorStatementsPage
      page={page as CreatorStatementsData | { kind: "preparing" }}
      locale={address.locale}
      {...search}
    />
  ) : (
    <CreatorStatementPage
      page={page as CreatorStatementData | { kind: "preparing" }}
      locale={address.locale}
      id={address.id}
      payment={payment}
      {...search}
      {...(address.from ? { from: address.from } : {})}
    />
  );
}

/** A retired origin cannot be revived by a later layout effect, including viewer ABA. */
function StatementsBoundary({
  initial,
  address,
}: {
  initial: CurrentRead;
  address: CreatorStatementsAddress;
}) {
  const current = useCreatorCurrentOrigin(
    "payout_statement.list",
    JSON.stringify(address),
  );
  const { hydrated, origin, seed } = current;
  const subject = hydrated ? current.subject : initial.sessionSubject;
  const admitted = hydrated ? origin.isCurrent() : !!initial.sessionSubject;
  if (!subject || !admitted) {
    const kind =
      current.state === "unavailable" || current.admission === "unavailable"
        ? "unavailable"
        : current.state === "signed-out" || current.admission === "closed"
          ? "denied"
          : "preparing";
    return <StatementPresentation address={address} page={{ kind }} />;
  }
  return (
    <StatementsRead
      key={origin.id}
      initial={initial}
      address={address}
      subject={subject}
      hydrated={hydrated}
      seed={seed}
      origin={origin}
    />
  );
}

async function readCurrent(
  address: CreatorStatementsAddress,
): Promise<CurrentRead> {
  const data = {
    locale: address.locale,
    ...(address.cursor ? { cursor: address.cursor } : {}),
  };
  return address.kind === "list"
    ? readCreatorStatementsCurrent({ data })
    : readCreatorStatementCurrent({
        data: {
          ...data,
          id: address.id,
          ...(address.from ? { from: address.from } : {}),
        },
      });
}

function StatementsRead({
  initial,
  address,
  subject,
  hydrated,
  seed,
  origin,
}: {
  initial: CurrentRead;
  address: CreatorStatementsAddress;
  subject: string;
  hydrated: boolean;
  seed: boolean;
  origin: Origin;
}) {
  const [initialData] = useState<Outcome | undefined>(() => {
    const value =
      (origin.workspace.read as CurrentRead | undefined) ??
      (seed ? initial : undefined);
    return value && acceptsStatementsCurrent(value, subject, address)
      ? { kind: "accepted", value }
      : undefined;
  });
  const query = useQuery<Outcome | null>({
    ...personalRead,
    queryKey: ["creator-statements-current", subject, address, origin.id],
    enabled: hydrated && origin.isCurrent() && personalRead.enabled,
    queryFn: async () => {
      if (!origin.isCurrent()) return null;
      try {
        const value = await readCurrent(address);
        return origin.isCurrent() &&
          acceptsStatementsCurrent(value, subject, address)
          ? { kind: "accepted", value }
          : null;
      } catch {
        return origin.isCurrent() ? { kind: "failed" } : null;
      }
    },
    ...(initialData ? { initialData } : {}),
    // The actual loader already performed this lifetime's bounded read.
    refetchOnMount: !initialData,
    gcTime: 0,
    retry: false,
    throwOnError: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [display, setDisplay] = useState(() => ({
    observed: initialData,
    page:
      initialData?.kind === "accepted"
        ? initialData.value.page
        : ({ kind: "preparing" } as Page),
  }));
  // Foreign/obsolete responses, including their completion, never replace accepted current data.
  if (origin.isCurrent() && query.data && query.data !== display.observed) {
    setDisplay({
      observed: query.data,
      page:
        query.data.kind === "accepted"
          ? query.data.value.page
          : { kind: "unavailable" },
    });
  }
  if (hydrated && !origin.isCurrent())
    return (
      <StatementPresentation address={address} page={{ kind: "preparing" }} />
    );
  if (display.observed?.kind === "accepted" && origin.isCurrent())
    origin.workspace.read = display.observed.value;
  const payment =
    address.kind === "detail" &&
    display.page.kind === "ready" &&
    "statement" in display.page ? (
      <CreatorPaymentAttestation
        statement={display.page.statement}
        subject={subject}
        locale={address.locale}
        guard={origin}
        refresh={async () => {
          const refreshed = await query.refetch();
          return (
            origin.isCurrent() &&
            refreshed.data?.kind === "accepted" &&
            refreshed.data.value.page.kind === "ready" &&
            "statement" in refreshed.data.value.page &&
            refreshed.data.value.page.lines.kind === "ready"
          );
        }}
      />
    ) : undefined;
  return (
    <StatementPresentation
      address={address}
      page={display.page}
      payment={payment}
    />
  );
}
