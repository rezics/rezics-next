import { catalogueEditor, useEditorLifetime } from "./editor-lifetime";
import { hasDocumentContent } from "@rezics/document";
import { useQuery } from "@tanstack/react-query";
import { useBlocker, useRouter } from "@tanstack/react-router";
import { pickText } from "@rezics/composition";
import { ContentItemFrame, ContentItemHeading } from "@rezics/ui/content-item";
import { RichTextEditor } from "@rezics/ui/rich-text-editor";
import {
  EntityPicker,
  type EntityPickerSearch,
  type EntityPickerSubject,
} from "@rezics/ui/entity-picker";
import { Button, buttonVariants } from "@rezics/ui/shadcn/button";
import { Checkbox } from "@rezics/ui/shadcn/checkbox";
import { Field, FieldLabel } from "@rezics/ui/shadcn/field";
import { Input } from "@rezics/ui/shadcn/input";
import { Textarea } from "@rezics/ui/shadcn/textarea";
import {
  NativeSelect,
  NativeSelectOption,
} from "@rezics/ui/shadcn/native-select";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rezics/ui/shadcn/alert-dialog";
import { coverSrc } from "../../media/cover-src";
import { m } from "../../paraglide/messages.js";
import { CreateSubjectLanguageRemove } from "./create-subject-language-remove";
import { editorLabels } from "../../threads/composer";
import { PageHeading } from "../../shell/page-heading";
import {
  CandidateReview,
  type CandidateTransport,
} from "../../subject/candidate-review";
import type { CandidateSlot } from "../../subject/candidates";
import { subjectHref } from "../../subject/subject-href";
import { CandidateValue } from "../pages/data";
import {
  newAuthoredField,
  authoredFieldValue,
  type AuthoredField,
} from "./authored-field";
import type { CreateFailure, CreateResult } from "./create-subject";
import {
  recipeDraft,
  recipePropertyCompatible,
  recipeTarget,
  type RecipeCommand,
  type RecipeProperty,
  type RecipeTransport,
  type RecipeRead,
} from "./recipe-editor";
import {
  statementInput,
  type ProposalCommand,
  type ProposalResult,
  type StatementInput,
} from "./statement-editor";
import { statementDraftChanged } from "./statement-editor-navigation";
import { EditorFailure, ScalarControl } from "./statement-editor-view";
import {
  focusRecipeCorrection,
  recipeCorrections,
  recipeInvalid,
  recipeRowId,
  type RecipeCorrection,
} from "./recipe-validation-presentation";

type Ready = Extract<RecipeRead, { ok: true }>;
const recipeActionClassName =
  "relative z-10 h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const recipeInputClassName = "relative z-10 min-h-11 min-w-0 max-w-full";
// Raise native targets individually; supplied reading text keeps the shared frame's normal flow.
const recipePanelClassName =
  "min-w-0 space-y-4 p-4 [overflow-wrap:anywhere] sm:p-6 " +
  "[&_label]:relative [&_label]:z-10 [&_label]:min-w-0 [&_label]:max-w-full [&_label]:flex-wrap " +
  "[&_input]:relative [&_input]:z-10 [&_input]:min-h-11 [&_input]:min-w-0 " +
  "[&_select]:relative [&_select]:z-10 [&_select]:min-h-11 [&_select]:min-w-11 " +
  "[&_textarea]:relative [&_textarea]:z-10 [&_textarea]:min-h-11 [&_textarea]:min-w-0 " +
  "[&_a]:relative [&_a]:z-10 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center " +
  "[&_button]:relative [&_button]:z-10 [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:break-words " +
  "[&_:is(a,button,input,select,textarea):focus-visible]:outline-2 " +
  "[&_:is(a,button,input,select,textarea):focus-visible]:outline-offset-2 " +
  "[&_:is(a,button,input,select,textarea):focus-visible]:outline-ring";
type Row = {
  id: string;
  statement: StatementInput;
  definition: RecipeProperty;
  original?: boolean;
  authored?: AuthoredField;
  picked?: EntityPickerSubject[];
  command?: ProposalCommand | undefined;
  result?: ProposalResult | undefined;
  uncertain?: boolean;
  source?: NonNullable<
    Ready["public"]
  >["subject"]["statements"][string][number];
};
const newRow = (property: string, definition: RecipeProperty): Row => ({
  id: crypto.randomUUID(),
  definition: structuredClone(definition),
  statement: {
    property: { id: property },
    value: { type: "value", content: "" },
    qualifiers: [],
    references: [],
    rank: "normal",
  },
});

function rowMatchesCurrentDefinition(row: Row, read: Ready): boolean {
  const property = row.statement.property.id;
  return (
    read.fields.includes(property) &&
    recipePropertyCompatible(row.definition, read.release.properties[property])
  );
}

function availableAdditionalFields(read: Ready, rows: Row[]) {
  return read.fields.filter((field) => {
    const definition = read.release.properties[field];
    return (
      !!definition &&
      (definition.multivalued ||
        !rows.some((row) => row.statement.property.id === field))
    );
  });
}

export const RecipeEditor = catalogueEditor(RecipeEditorLive);

function RecipeEditorLive({
  id,
  locale,
  session,
  transport,
  search,
  review,
}: {
  id?: string;
  locale: string;
  session: string;
  transport: RecipeTransport;
  search: EntityPickerSearch;
  review?: (
    property: string,
    slot: CandidateSlot | undefined,
    session?: string,
  ) => CandidateTransport;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: ["recipe-editor", id, locale, lifetime.generation],
    queryFn: transport.load,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [readEpoch, setReadEpoch] = useState(0);
  const readEpochRef = useRef(0);
  const admittedReadEpoch = useRef(0);
  const retainedRead = useRef<
    | {
        id: string | undefined;
        locale: string;
        generation: number;
        value: Ready;
      }
    | undefined
  >(undefined);
  if (
    retainedRead.current &&
    (retainedRead.current.id !== id ||
      retainedRead.current.locale !== locale ||
      retainedRead.current.generation !== lifetime.generation)
  )
    retainedRead.current = undefined;
  const matchesIdentity = (candidate?: Ready) =>
    !!candidate && (!id || candidate.public?.subject.id === id);
  if (query.data?.ok && matchesIdentity(query.data))
    retainedRead.current = {
      id,
      locale,
      generation: lifetime.generation,
      value: query.data,
    };
  const draftRead = retainedRead.current?.value;
  const read =
    readEpoch === readEpochRef.current &&
    admittedReadEpoch.current === readEpoch &&
    !query.isFetching &&
    !query.isError &&
    query.data?.ok &&
    matchesIdentity(query.data)
      ? query.data
      : undefined;
  const isReadEpochCurrent = (epoch: number) => epoch === readEpochRef.current;
  const readUnavailable =
    query.isError ||
    (!!query.data && (!query.data.ok || !matchesIdentity(query.data)));
  const termsId = useId();
  const nextTermId = useRef(1);
  const [terms, setTerms] = useState([
    { id: 0, language: locale, label: "", description: "", aliases: "" },
  ]);
  const [rows, setRows] = useState<Row[]>([]);
  const [property, setProperty] = useState("");
  const [failure, setFailure] = useState<CreateFailure>();
  const [corrections, setCorrections] = useState<RecipeCorrection[]>([]);
  const correctionFocus = useRef<string | undefined>(undefined);
  const workspace = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const target = correctionFocus.current;
    correctionFocus.current = undefined;
    if (target && workspace.current && lifetime.active())
      focusRecipeCorrection(workspace.current.ownerDocument, target);
  }, [corrections, lifetime]);
  const clearCorrections = (matches: (error: RecipeCorrection) => boolean) => {
    if (!pending.current && !running.current)
      setCorrections((previous) => previous.filter((error) => !matches(error)));
  };
  const reject = (next: CreateFailure, extra: RecipeCorrection[] = []) => {
    const errors =
      draftRead && next.reason === "invalid"
        ? [
            ...recipeCorrections(
              next.errors ?? [],
              terms,
              rows,
              draftRead.release,
              locale,
              termsId,
            ),
            ...extra,
          ]
        : [];
    if (next.reason === "invalid" && !errors.length)
      errors.push({
        id: `${termsId}-unknown`,
        label: m.catalogue_create_invalid_field({}, o),
        instruction: m.correction_error_uneditable({}, o),
      });
    correctionFocus.current = errors.find((error) => error.target)?.target;
    setCorrections(errors);
    setFailure(next);
  };
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<RecipeCommand | null>(null);
  const pendingUncertain = useRef(false);
  const running = useRef(false);
  const readFocus = useRef<
    { epoch: number; active: () => boolean } | undefined
  >(undefined);
  const readingHeading = useRef<HTMLHeadingElement>(null);
  const emptyReading = useRef<HTMLParagraphElement>(null);
  const unavailableReading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const origin = readFocus.current;
    if (!origin) return;
    if (!origin.active() || origin.epoch !== readEpochRef.current) {
      readFocus.current = undefined;
      return;
    }
    if (busy || query.isFetching) return;
    const target = readUnavailable
      ? unavailableReading.current
      : read
        ? read.fields.length === 0
          ? emptyReading.current
          : readingHeading.current
        : null;
    if (!target?.isConnected) return;
    readFocus.current = undefined;
    target.focus();
  }, [busy, query.isFetching, read, readUnavailable, readEpoch, lifetime]);
  const locked =
    busy || !!pending.current || failure?.refreshDefinitions === true;
  const fieldAdmission = useRef({ read, locked, created, session, rows });
  fieldAdmission.current = { read, locked, created, session, rows };
  const fieldEditAllowed = (rowId: string) => {
    const current = fieldAdmission.current;
    const row = current.rows.find((entry) => entry.id === rowId);
    return (
      lifetime.active() &&
      isReadEpochCurrent(readEpoch) &&
      !!current.read &&
      !current.locked &&
      !current.created &&
      current.session === "signed-in" &&
      !running.current &&
      !pending.current &&
      !!row &&
      !row.command &&
      !row.uncertain &&
      row.result?.ok !== true
    );
  };
  const draftDirty =
    !created &&
    ((!id &&
      (terms.length !== 1 ||
        terms.some(
          (term, index) =>
            (index === 0 && term.language !== locale) ||
            !!term.label ||
            !!term.description ||
            !!term.aliases,
        ))) ||
      rows.some((row) =>
        row.result?.ok
          ? false
          : row.source
            ? statementDraftChanged(
                statementInput(row.source),
                row.statement,
              ) || row.original === true
            : true,
      ));
  const pendingWrite =
    (pending.current !== null && pendingUncertain.current) ||
    rows.some((row) => row.uncertain);
  const name = (id: string) =>
    pickText(draftRead?.release.properties[id]?.labels ?? {}, locale).text ||
    id;
  const offeredAdditionalFields = read
    ? availableAdditionalFields(read, rows)
    : [];
  const selectedAdditionalField = offeredAdditionalFields.includes(property)
    ? property
    : "";
  const withdrawnChoice = !!property && !selectedAdditionalField;
  const currentFields = read?.public
    ? [
        ...new Set([
          ...read.fields,
          ...Object.entries(read.public.subject.statements)
            .filter(([, statements]) => statements.length > 0)
            .map(([field]) => field),
        ]),
      ]
    : (read?.fields ?? []);
  async function refreshCurrentDefinitions(
    expectedEpoch = readEpoch,
  ): Promise<boolean> {
    if (!lifetime.active() || expectedEpoch !== readEpochRef.current)
      return false;
    const nextEpoch = readEpochRef.current + 1;
    readEpochRef.current = nextEpoch;
    setReadEpoch(nextEpoch);
    try {
      const refreshed = await query.refetch();
      const admitted =
        !refreshed.isError &&
        refreshed.data?.ok === true &&
        matchesIdentity(refreshed.data) &&
        lifetime.active() &&
        readEpochRef.current === nextEpoch;
      if (admitted) admittedReadEpoch.current = nextEpoch;
      return admitted;
    } catch {
      return false;
    }
  }
  async function retryRead() {
    if (!lifetime.active() || !isReadEpochCurrent(readEpoch) || running.current)
      return;
    // Only this deliberate recovery owns focus; internal reviews and readbacks do not.
    readFocus.current = {
      epoch: readEpochRef.current + 1,
      active: lifetime.active,
    };
    running.current = true;
    setBusy(true);
    try {
      const refreshed = await refreshCurrentDefinitions(readEpoch);
      if (!lifetime.active()) return;
      if (refreshed) {
        if (failure?.refreshDefinitions) setFailure(undefined);
        setRows((previous) =>
          previous.map((row) =>
            !row.uncertain &&
            row.result &&
            !row.result.ok &&
            (row.result.reason === "stale" || row.result.refreshDefinitions)
              ? {
                  ...row,
                  command: undefined,
                  result: undefined,
                  uncertain: false,
                }
              : row,
          ),
        );
      }
    } finally {
      if (!lifetime.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  async function reviewCurrentDefinitions() {
    if (!lifetime.active() || !isReadEpochCurrent(readEpoch) || running.current)
      return;
    running.current = true;
    setBusy(true);
    try {
      if (await refreshCurrentDefinitions(readEpoch)) {
        if (!lifetime.active()) return;
        setFailure(undefined);
      }
    } finally {
      if (!lifetime.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  async function create() {
    if (!lifetime.active() || !isReadEpochCurrent(readEpoch)) return;
    const exactReplay = pending.current !== null && pendingUncertain.current;
    if (
      running.current ||
      (!read && !exactReplay) ||
      created ||
      session !== "signed-in" ||
      failure?.reason === "conflict" ||
      (failure?.refreshDefinitions && !exactReplay)
    )
      return;
    if (!pending.current) {
      if (!read) return;
      const draft = recipeDraft(
        read.release,
        locale,
        terms,
        rows.map((row) => row.statement),
      );
      const originalErrors: RecipeCorrection[] = [];
      const positions = new Map<string, number>();
      for (const row of rows) {
        const property = row.statement.property.id;
        const index = positions.get(property) ?? 0;
        positions.set(property, index + 1);
        if (read.release.properties[property]?.datatype !== "document")
          continue;
        const content =
          row.statement.value.type === "value"
            ? (row.statement.value.content as AuthoredField)
            : undefined;
        const authored = !!content && typeof content === "object";
        if (!authored || !hasDocumentContent(content.document)) {
          draft.errors.push({
            pointer:
              `/statements/${property}/` + index + "/value/content/document",
            code: "required",
          });
        }
        if (authored && !row.original) {
          const owner = recipeRowId(termsId, row.id);
          originalErrors.push({
            id: `${owner}-original-error`,
            owner,
            target: `${owner}-original`,
            label: `${name(property)} · ${m.recipe_original({}, o)}`,
            instruction: m.correction_error_required({}, o),
          });
        }
      }
      for (const row of rows) {
        const pointer = `/statements/${row.statement.property.id}`;
        if (
          !rowMatchesCurrentDefinition(row, read) &&
          !draft.errors.some((error) => error.pointer === pointer)
        )
          draft.errors.push({ pointer, code: "unsupported" });
      }
      if (draft.errors.length || originalErrors.length) {
        reject(
          { ok: false, reason: "invalid", errors: draft.errors },
          originalErrors,
        );
        return;
      }
      pending.current = { item: draft.item, key: crypto.randomUUID() };
      pendingUncertain.current = false;
    }
    const wasUncertain = pendingUncertain.current;
    pendingUncertain.current = true;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    setCorrections([]);
    try {
      const result = await transport.create(pending.current, wasUncertain);
      if (!lifetime.active() || !isReadEpochCurrent(readEpoch)) return;
      if (result.ok) {
        setCreated(result);
        pending.current = null;
        pendingUncertain.current = false;
      } else {
        reject(result);
        const possiblyCommitted =
          wasUncertain || result.reason === "unavailable";
        pendingUncertain.current = possiblyCommitted;
        if (result.reason !== "conflict" && !possiblyCommitted)
          pending.current = null;
      }
    } catch {
      if (!lifetime.active() || !isReadEpochCurrent(readEpoch)) return;
      pendingUncertain.current = true;
      setFailure({ ok: false, reason: "unavailable" });
    } finally {
      if (!lifetime.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  const currentHref = read?.public
    ? subjectHref(
        {
          id: read.public.subject.id,
          label: pickText(read.public.subject.labels, locale).text,
        },
        locale,
      ).href
    : undefined;
  const Workspace = id ? "div" : "form";
  return (
    <article className="mx-auto min-w-0 w-full max-w-3xl space-y-6 px-4 py-8 [overflow-wrap:anywhere] sm:px-6 [&_label]:min-w-0 [&_label]:max-w-full [&_label]:flex-wrap">
      <PageHeading ref={readingHeading} tabIndex={-1}>
        {id ? m.recipe_edit({}, o) : m.recipe_title({}, o)}
      </PageHeading>
      {!id && (
        <a
          className={buttonVariants({
            variant: "outline",
            className: recipeActionClassName,
          })}
          href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ""}`}
        >
          {m.catalogue_create_search({}, o)}
        </a>
      )}
      {session !== "signed-in" && (
        <p role="status">
          {session === "signed-out"
            ? m.catalogue_create_signed_out({}, o)
            : m.candidate_loading({}, o)}
        </p>
      )}
      {(query.isPending || query.isFetching) && (
        <p role="status">{m.candidate_loading({}, o)}</p>
      )}
      {readUnavailable && (
        <div ref={unavailableReading} tabIndex={-1} className="space-y-3">
          {query.data && !query.data.ok && query.data.reason === "concealed" ? (
            <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
          ) : (
            <EditorFailure locale={locale} reason="unavailable" />
          )}
          <Button
            className={recipeActionClassName}
            type="button"
            disabled={busy}
            onClick={() => void retryRead()}
          >
            {m.correction_retry({}, o)}
          </Button>
        </div>
      )}
      {read && read.fields.length === 0 && (
        <p ref={emptyReading} tabIndex={-1} role="status">
          {m.recipe_empty({}, o)}
        </p>
      )}
      {created ? (
        <section className="space-y-4">
          <p role="status">{m.recipe_created({}, o)}</p>
          {created.reader.state === "ready" ? (
            <a
              className={buttonVariants({ className: recipeActionClassName })}
              href={created.reader.href}
            >
              {m.candidate_view_public({}, o)}
            </a>
          ) : (
            <>
              <p>
                {created.reader.state === "concealed"
                  ? m.catalogue_create_concealed({}, o)
                  : m.catalogue_create_reader_unavailable({}, o)}
              </p>
              <Button
                className={recipeActionClassName}
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!lifetime.active()) return;
                  if (running.current) return;
                  running.current = true;
                  setBusy(true);
                  try {
                    const reader = await transport.read(created.id);
                    if (!lifetime.active()) return;
                    setCreated({ ...created, reader });
                  } catch {
                    if (!lifetime.active()) return;
                    setCreated({
                      ...created,
                      reader: { state: "unavailable" },
                    });
                  } finally {
                    if (!lifetime.active()) return;
                    setBusy(false);
                    running.current = false;
                  }
                }}
              >
                {m.correction_retry({}, o)}
              </Button>
            </>
          )}
        </section>
      ) : (
        draftRead &&
        (!id || draftRead.fields.length > 0 || rows.length > 0) && (
          <Workspace
            ref={(node: HTMLDivElement | HTMLFormElement | null) => {
              workspace.current = node;
            }}
            onChangeCapture={(event) => {
              const target = event.target as HTMLElement;
              const ids = new Set([
                target.id,
                ...Array.from(
                  target
                    .closest("section")
                    ?.querySelectorAll('[role="group"]') ?? [],
                )
                  .filter((group) => group.contains(target))
                  .map((group) => group.id),
              ]);
              clearCorrections(
                (error) => !!error.target && ids.has(error.target),
              );
            }}
            className="flex min-w-0 flex-col gap-6"
            noValidate={!id}
            onSubmit={(event) => {
              if (id) return;
              event.preventDefault();
              if (!isReadEpochCurrent(readEpoch)) return;
              void create();
            }}
          >
            {currentHref && (
              <a
                className={`${recipeActionClassName} inline-flex items-center self-start underline underline-offset-4`}
                href={currentHref}
              >
                {m.candidate_view_public({}, o)}
              </a>
            )}
            {!id && (
              <fieldset
                disabled={locked || session !== "signed-in"}
                className="space-y-5"
              >
                <legend className="mb-4 font-semibold">
                  {m.catalogue_create_terms({}, o)}
                </legend>
                {terms.map((term, index) => (
                  <fieldset
                    key={term.id}
                    id={`${termsId}-${term.id}`}
                    className="min-w-0 space-y-3"
                  >
                    <legend className="sr-only">
                      {term.language || m.catalogue_create_language({}, o)}
                    </legend>
                    {(
                      ["language", "label", "description", "aliases"] as const
                    ).map((field) => (
                      <Field key={field}>
                        <FieldLabel htmlFor={`${termsId}-${field}-${term.id}`}>
                          {
                            {
                              language: m.catalogue_create_language({}, o),
                              label: m.catalogue_create_label({}, o),
                              description: m.catalogue_create_description(
                                {},
                                o,
                              ),
                              aliases: m.catalogue_create_aliases({}, o),
                            }[field]
                          }
                        </FieldLabel>
                        {field === "aliases" ? (
                          <Textarea
                            id={`${termsId}-${field}-${term.id}`}
                            {...recipeInvalid(
                              corrections,
                              `${termsId}-${field}-${term.id}`,
                            )}
                            className={recipeInputClassName}
                            value={term[field]}
                            onChange={(event) =>
                              setTerms((previous) =>
                                previous.map((value) =>
                                  value.id === term.id
                                    ? { ...value, [field]: event.target.value }
                                    : value,
                                ),
                              )
                            }
                          />
                        ) : (
                          <Input
                            id={`${termsId}-${field}-${term.id}`}
                            {...recipeInvalid(
                              corrections,
                              `${termsId}-${field}-${term.id}`,
                            )}
                            className={recipeInputClassName}
                            value={term[field]}
                            onChange={(event) =>
                              setTerms((previous) =>
                                previous.map((value) =>
                                  value.id === term.id
                                    ? { ...value, [field]: event.target.value }
                                    : value,
                                ),
                              )
                            }
                          />
                        )}
                      </Field>
                    ))}
                    {index > 0 && (
                      <CreateSubjectLanguageRemove
                        locale={locale}
                        populated={
                          !!(
                            term.language ||
                            term.label ||
                            term.description ||
                            term.aliases
                          )
                        }
                        rowId={`${termsId}-${term.id}`}
                        focusId={
                          terms[index + 1]
                            ? `${termsId}-language-${terms[index + 1]!.id}`
                            : `${termsId}-add`
                        }
                        disabled={locked || session !== "signed-in"}
                        onRemove={() => {
                          if (
                            locked ||
                            running.current ||
                            pending.current ||
                            session !== "signed-in"
                          )
                            return false;
                          setTerms((previous) =>
                            previous.filter((value) => value.id !== term.id),
                          );
                          clearCorrections(
                            (error) => error.owner === `term-${term.id}`,
                          );
                          return true;
                        }}
                      />
                    )}
                  </fieldset>
                ))}
                <Button
                  id={`${termsId}-add`}
                  className={recipeActionClassName}
                  type="button"
                  variant="outline"
                  disabled={locked || session !== "signed-in"}
                  onClick={() => {
                    if (
                      locked ||
                      running.current ||
                      pending.current ||
                      session !== "signed-in"
                    )
                      return;
                    const id = nextTermId.current++;
                    setTerms((previous) => [
                      ...previous,
                      {
                        id,
                        language: "",
                        label: "",
                        description: "",
                        aliases: "",
                      },
                    ]);
                  }}
                >
                  {m.catalogue_create_add_language({}, o)}
                </Button>
              </fieldset>
            )}
            <p className="text-sm text-muted-foreground">
              {m.recipe_ingredients_help({}, o)}
            </p>
            {id &&
              read?.public &&
              currentFields.map((field) => (
                <section key={field} className="min-w-0">
                  <ContentItemFrame as="div" className={recipePanelClassName}>
                    <ContentItemHeading
                      id={`${termsId}-current-${field}`}
                      className="font-semibold"
                    >
                      {name(field)}
                    </ContentItemHeading>
                    {(read!.public!.subject.statements[field] ?? []).map(
                      (source) => (
                        <div
                          key={source.id}
                          className="flex min-w-0 flex-col items-start gap-3 sm:flex-row"
                        >
                          <div
                            data-content-item-slot="preview"
                            className="min-w-0 break-words sm:flex-1"
                          >
                            <CandidateValue
                              snak={source}
                              related={read!.public!.related}
                              locale={locale}
                            />
                          </div>
                          {read!.fields.includes(field) && (
                            <Button
                              data-content-item-slot="actions"
                              type="button"
                              variant="outline"
                              className={recipeActionClassName}
                              disabled={rows.some(
                                (row) => row.source?.id === source.id,
                              )}
                              onClick={() => {
                                if (!isReadEpochCurrent(readEpoch)) return;
                                const definition =
                                  read!.release.properties[field];
                                if (!definition) return;
                                setRows([
                                  ...rows,
                                  {
                                    id: crypto.randomUUID(),
                                    source,
                                    definition: structuredClone(definition),
                                    statement: statementInput(source),
                                  },
                                ]);
                              }}
                            >
                              {m.recipe_correct({}, o)}
                            </Button>
                          )}
                        </div>
                      ),
                    )}
                  </ContentItemFrame>
                </section>
              ))}
            {rows.map((row) => (
              <RecipeField
                key={row.id}
                row={row}
                feedbackId={recipeRowId(termsId, row.id)}
                corrections={corrections}
                clearCorrection={(target) =>
                  clearCorrections((error) => error.target === target)
                }
                read={draftRead}
                currentRead={read}
                readEpoch={readEpoch}
                isReadEpochCurrent={isReadEpochCurrent}
                locale={locale}
                search={search}
                disabled={locked || session !== "signed-in"}
                editAllowed={() => fieldEditAllowed(row.id)}
                removalAllowed={() =>
                  !running.current && !pending.current && !locked && !created
                }
                transport={transport}
                refreshDefinitions={() => refreshCurrentDefinitions(readEpoch)}
                onState={(patch) =>
                  setRows((previous) =>
                    previous.map((entry) =>
                      entry.id === row.id ? { ...entry, ...patch } : entry,
                    ),
                  )
                }
                {...(review ? { review } : {})}
                onChange={(update) => {
                  if (!fieldEditAllowed(row.id)) return;
                  const current = fieldAdmission.current.rows.find(
                    (entry) => entry.id === row.id,
                  )!;
                  const next = update(current);
                  if (next === current) return;
                  if (
                    next.statement.value.type !== current.statement.value.type
                  ) {
                    const prefix = `${recipeRowId(termsId, row.id)}-fact-`;
                    clearCorrections(
                      (error) => !!error.target?.startsWith(prefix),
                    );
                  }
                  fieldAdmission.current.rows = fieldAdmission.current.rows.map(
                    (entry) => (entry.id === row.id ? next : entry),
                  );
                  setRows((previous) =>
                    previous.map((entry) =>
                      entry.id === row.id ? update(entry) : entry,
                    ),
                  );
                }}
                onOriginal={(original) => {
                  if (!fieldEditAllowed(row.id)) return;
                  setRows((previous) =>
                    previous.map((entry) =>
                      entry.id === row.id ? { ...entry, original } : entry,
                    ),
                  );
                }}
                onRemove={() => {
                  if (
                    !lifetime.active() ||
                    !isReadEpochCurrent(readEpoch) ||
                    running.current ||
                    pending.current ||
                    locked ||
                    created
                  )
                    return;
                  setRows((previous) =>
                    previous.filter((entry) => entry.id !== row.id),
                  );
                  clearCorrections(
                    (error) => error.owner === recipeRowId(termsId, row.id),
                  );
                }}
              />
            ))}
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
              <Field className="w-full min-w-0 sm:flex-1">
                <FieldLabel htmlFor={`${termsId}-recipe-field`}>
                  {m.character_add_fact({}, o)}
                </FieldLabel>
                <NativeSelect
                  id={`${termsId}-recipe-field`}
                  className="w-full min-w-0 [&>select]:relative [&>select]:z-10 [&>select]:min-h-11 [&>select]:min-w-11 [&>select:focus-visible]:outline-2 [&>select:focus-visible]:outline-offset-2 [&>select:focus-visible]:outline-ring"
                  disabled={locked}
                  value={selectedAdditionalField}
                  aria-describedby={
                    withdrawnChoice
                      ? `${termsId}-recipe-field-stale`
                      : undefined
                  }
                  onChange={(event) => setProperty(event.target.value)}
                >
                  <NativeSelectOption value="">
                    {m.correction_choose({}, o)}
                  </NativeSelectOption>
                  {offeredAdditionalFields.map((field) => (
                    <NativeSelectOption key={field} value={field}>
                      {name(field)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {withdrawnChoice && (
                <p id={`${termsId}-recipe-field-stale`} role="status">
                  {m.correction_stale({}, o)}
                </p>
              )}
              <Button
                type="button"
                className={recipeActionClassName}
                variant="outline"
                disabled={
                  locked || session !== "signed-in" || !selectedAdditionalField
                }
                onClick={() => {
                  if (!isReadEpochCurrent(readEpoch) || !read) return;
                  if (!availableAdditionalFields(read, rows).includes(property))
                    return;
                  const definition = read.release.properties[property];
                  if (!definition) return;
                  setRows([...rows, newRow(property, definition)]);
                  setProperty("");
                }}
              >
                {m.correction_add({}, o)}
              </Button>
            </div>
            {!id && (
              <>
                {failure &&
                  (failure.reason !== "invalid" || corrections.length > 0) && (
                    <div role="alert" className="space-y-2">
                      <p>
                        {failure.reason === "conflict"
                          ? m.catalogue_create_conflict({}, o)
                          : failure.reason === "invalid"
                            ? m.catalogue_create_invalid({}, o)
                            : failure.reason === "denied"
                              ? m.catalogue_create_denied({}, o)
                              : failure.reason === "signed-out"
                                ? m.catalogue_create_signed_out({}, o)
                                : m.catalogue_create_uncertain({}, o)}
                      </p>
                      {corrections.length > 0 && (
                        <ul
                          aria-label={m.correction_errors({}, o)}
                          className="list-disc space-y-2 ps-5"
                        >
                          {corrections.map((error) => (
                            <li id={error.id} key={error.id}>
                              {error.target ? (
                                <a
                                  href={`#${error.target}`}
                                  className="underline underline-offset-4"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    if (lifetime.active())
                                      focusRecipeCorrection(
                                        event.currentTarget.ownerDocument,
                                        error.target!,
                                      );
                                  }}
                                >
                                  {error.label}
                                </a>
                              ) : (
                                <p>{error.label}</p>
                              )}
                              <p>{error.instruction}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                      {failure.reason === "conflict" && (
                        <Button
                          className={recipeActionClassName}
                          type="button"
                          onClick={() => {
                            if (!pendingUncertain.current)
                              pending.current = null;
                            setFailure(undefined);
                          }}
                        >
                          {m.catalogue_create_review_new({}, o)}
                        </Button>
                      )}
                      {failure.refreshDefinitions && (
                        <Button
                          className={recipeActionClassName}
                          type="button"
                          disabled={busy}
                          onClick={() => void reviewCurrentDefinitions()}
                        >
                          {m.catalogue_create_review_new({}, o)}
                        </Button>
                      )}
                    </div>
                  )}
                <Button
                  type="submit"
                  className={`${recipeActionClassName} self-start`}
                  disabled={
                    busy ||
                    session !== "signed-in" ||
                    failure?.reason === "conflict" ||
                    (failure?.refreshDefinitions === true &&
                      !(pending.current && pendingUncertain.current))
                  }
                >
                  {busy
                    ? m.catalogue_create_saving({}, o)
                    : pending.current
                      ? m.correction_retry({}, o)
                      : m.recipe_title({}, o)}
                </Button>
              </>
            )}
          </Workspace>
        )
      )}
      <RecipeNavigationGuard
        active={lifetime.active()}
        dirty={draftDirty}
        pending={pendingWrite}
      />
    </article>
  );
}

const RecipeField = catalogueEditor(RecipeFieldLive);

function RecipeFieldLive({
  row,
  feedbackId,
  corrections,
  clearCorrection,
  read,
  currentRead,
  readEpoch,
  isReadEpochCurrent,
  locale,
  search,
  disabled,
  editAllowed,
  removalAllowed,
  transport,
  refreshDefinitions,
  review,
  onState,
  onChange,
  onOriginal,
  onRemove,
}: {
  row: Row;
  feedbackId: string;
  corrections: RecipeCorrection[];
  clearCorrection: (target: string) => void;
  read: Ready;
  currentRead: Ready | undefined;
  readEpoch: number;
  isReadEpochCurrent: (epoch: number) => boolean;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  editAllowed: () => boolean;
  removalAllowed: () => boolean;
  transport: RecipeTransport;
  refreshDefinitions: () => Promise<boolean>;
  review?: (
    property: string,
    slot: CandidateSlot | undefined,
    session?: string,
  ) => CandidateTransport;
  onState: (patch: Pick<Row, "command" | "result" | "uncertain">) => void;
  onChange: (update: (current: Row) => Row) => void;
  onRemove: () => void;
  onOriginal: (original: boolean) => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const fieldId = feedbackId;
  const property = row.statement.property.id;
  const currentDefinition = currentRead?.release.properties[property];
  const matchesCurrentDefinition =
    !!currentRead && rowMatchesCurrentDefinition(row, currentRead);
  const currentSource =
    !row.source ||
    (!!currentRead &&
      (currentRead.public?.subject.statements[property] ?? []).some(
        (statement) => statement.id === row.source!.id,
      ));
  const reviewRequired = !matchesCurrentDefinition || !currentSource;
  const definition = matchesCurrentDefinition
    ? currentDefinition!
    : row.definition;
  const label =
    pickText(currentDefinition?.labels ?? row.definition.labels, locale).text ||
    property;
  const [authored, setAuthored] = useState<AuthoredField | undefined>(
    () => row.authored,
  );
  const [picked, setPicked] = useState<EntityPickerSubject[]>(
    () => row.picked ?? [],
  );
  const [citation, setCitation] = useState(() => {
    let current = "";
    for (const reference of row.statement.references)
      for (const part of reference.parts)
        if (
          part.property.id === "schema:url" &&
          part.value.type === "value" &&
          typeof part.value.content === "string"
        )
          current = part.value.content;
    return current;
  });
  const [busy, setBusy] = useState(false);
  const result = row.result;
  const [reviewing, setReviewing] = useState(false);
  const running = useRef(false);
  const command = row.command;
  const wasUncertain = !!command && row.uncertain === true;
  const frozen =
    disabled || busy || !!command || result?.ok === true || reviewRequired;
  const removalLocked =
    disabled ||
    busy ||
    !!command ||
    result?.ok === true ||
    row.uncertain === true;
  const section = useRef<HTMLElement>(null);
  const editing = useRef({ row, authored, frozen, editAllowed });
  editing.current = { row, authored, frozen, editAllowed };
  const canEdit = () =>
    lifetime.active() &&
    isReadEpochCurrent(readEpoch) &&
    !running.current &&
    !editing.current.frozen &&
    editing.current.row.id === row.id &&
    editing.current.editAllowed() &&
    !!section.current?.isConnected;
  const changeRow = (update: (current: Row) => Row) => {
    editing.current.row = update(editing.current.row);
    onChange(update);
  };
  const changePart = (
    part: "value" | "references",
    update: (current: Row) => Row,
  ) => {
    if (
      !canEdit() ||
      editing.current.row.statement[part] !== row.statement[part]
    )
      return false;
    changeRow((current) =>
      current.statement[part] === row.statement[part]
        ? update(current)
        : current,
    );
    return true;
  };
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreRemovalFocus = useRef(false);
  const [removingId, setRemovingId] = useState<string>();
  const confirmingRemoval = removingId === row.id;
  // A queued confirmation must use the current lock and stable row, even after a submit or retirement.
  const removal = useRef({
    locked: removalLocked,
    id: row.id,
    onRemove,
    removalAllowed,
  });
  removal.current = {
    locked: removalLocked,
    id: row.id,
    onRemove,
    removalAllowed,
  };
  const canRemove = () =>
    lifetime.active() &&
    !running.current &&
    !removal.current.locked &&
    removal.current.id === row.id &&
    removal.current.removalAllowed();
  useLayoutEffect(() => {
    if (removalLocked || !lifetime.active()) return;
    if (confirmingRemoval) cancelButton.current?.focus();
    else if (restoreRemovalFocus.current) {
      removeTrigger.current?.focus();
      restoreRemovalFocus.current = false;
    }
  }, [confirmingRemoval, removalLocked, lifetime]);
  const cancelRemoval = () => {
    if (!canRemove()) return;
    restoreRemovalFocus.current = true;
    setRemovingId(undefined);
  };
  const remove = () => {
    const root = section.current;
    if (!canRemove() || !root?.isConnected) return;
    const controls = [
      ...(root.parentElement?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex="0"], [contenteditable="true"]',
      ) ?? []),
    ];
    const first = controls.findIndex((control) => root.contains(control));
    const last = controls.findLastIndex((control) => root.contains(control));
    [...controls.slice(last + 1), ...controls.slice(0, first).reverse()]
      .find(
        (control) =>
          !control.matches(
            ':disabled, [aria-disabled="true"], [type="hidden"]',
          ) && !control.closest("[hidden], [inert]"),
      )
      ?.focus();
    removal.current.onRemove();
  };
  const hasValue = (value: unknown): boolean => {
    if (typeof value === "string") return !!value.trim();
    if (value == null) return false;
    if (typeof value === "object") return Object.values(value).some(hasValue);
    return true;
  };
  const populatedPart = (
    part:
      StatementInput | StatementInput["references"][number]["parts"][number],
  ) => part.value.type !== "value" || hasValue(part.value.content);
  const populated =
    (authored
      ? hasDocumentContent(authored.document) ||
        !!authored.language.trim() ||
        !!authored.licence.trim()
      : populatedPart(row.statement)) ||
    !!row.original ||
    !!picked.length ||
    !!citation.trim() ||
    row.statement.qualifiers?.some(populatedPart) ||
    row.statement.references.some((reference) =>
      reference.parts.some(populatedPart),
    );
  const updateAuthored = (
    patch: Partial<AuthoredField>,
    expected?: AuthoredField,
  ) => {
    if (!canEdit()) return;
    const current = editing.current.authored;
    // A document callback can outlive a language/citation edit, but never its own replacement.
    if (
      expected
        ? !current ||
          (Object.keys(patch) as (keyof AuthoredField)[]).some(
            (key) => current[key] !== expected[key],
          )
        : !!current
    )
      return;
    const next = { ...(current ?? newAuthoredField()), ...patch };
    clearCorrection(`${fieldId}-replace`);
    if (patch.document) clearCorrection(`${fieldId}-document`);
    editing.current.authored = next;
    setAuthored(next);
    changeRow((entry) => ({
      ...entry,
      authored: next,
      statement: { ...entry.statement, value: authoredFieldValue(next) },
    }));
  };
  const slot =
    definition.relation &&
    definition.relation.group !== "classification" &&
    row.statement.value.type === "value" &&
    typeof row.statement.value.content === "string"
      ? { target: row.statement.value.content }
      : undefined;
  async function submit() {
    if (!lifetime.active() || !isReadEpochCurrent(readEpoch)) return;
    const exactReplay = !!command && wasUncertain;
    if (
      (!currentRead?.public && !exactReplay) ||
      running.current ||
      (reviewRequired && !wasUncertain)
    )
      return;
    const pending = command ?? {
      id: currentRead!.public!.subject.id,
      statement: structuredClone(row.statement),
      key: crypto.randomUUID(),
    };
    onState({ command: pending, result: undefined, uncertain: true });
    running.current = true;
    setBusy(true);
    try {
      const next = await transport.propose(pending, wasUncertain);
      if (!lifetime.active() || !isReadEpochCurrent(readEpoch)) return;
      onState({
        command: next.ok ? undefined : pending,
        result: next,
        uncertain: next.ok
          ? false
          : wasUncertain || next.reason === "unavailable",
      });
    } catch {
      if (!lifetime.active() || !isReadEpochCurrent(readEpoch)) return;
      onState({
        command: pending,
        result: { ok: false, reason: "unavailable" },
        uncertain: true,
      });
    } finally {
      if (!lifetime.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  async function reviewCurrentDefinitions() {
    if (
      !lifetime.active() ||
      !isReadEpochCurrent(readEpoch) ||
      running.current ||
      !result ||
      result.ok
    )
      return;
    if (row.uncertain && !result.refreshDefinitions) return;
    if (result.reason !== "stale" && !result.refreshDefinitions) {
      onState({ command: undefined, result: undefined, uncertain: false });
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      if (await refreshDefinitions()) {
        if (!lifetime.active()) return;
        onState(
          row.uncertain
            ? { result: undefined }
            : { command: undefined, result: undefined, uncertain: false },
        );
      }
    } finally {
      if (!lifetime.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  return (
    <section ref={section} className="min-w-0">
      <ContentItemFrame as="div" className={recipePanelClassName}>
        <ContentItemHeading id={`${fieldId}-heading`} className="font-semibold">
          {label}
        </ContentItemHeading>
        <fieldset
          data-content-item-slot="preview"
          disabled={frozen}
          className="min-w-0 space-y-4"
        >
          {definition.datatype === "document" ? (
            <>
              {!authored ? (
                <Button
                  className={recipeActionClassName}
                  type="button"
                  variant="outline"
                  id={`${fieldId}-replace`}
                  {...recipeInvalid(corrections, `${fieldId}-replace`)}
                  onClick={() => updateAuthored({})}
                >
                  {m.recipe_replace_method({}, o)}
                </Button>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {m.recipe_method_help({}, o)}
                  </p>
                  <Field>
                    <FieldLabel htmlFor={`${fieldId}-language`}>
                      {m.catalogue_create_language({}, o)}
                    </FieldLabel>
                    <Input
                      className={recipeInputClassName}
                      id={`${fieldId}-language`}
                      {...recipeInvalid(corrections, `${fieldId}-language`)}
                      aria-label={m.catalogue_create_language({}, o)}
                      value={authored.language}
                      onChange={(event) =>
                        updateAuthored(
                          { language: event.target.value },
                          authored,
                        )
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${fieldId}-licence`}>
                      {m.subject_source_licence({}, o)}
                    </FieldLabel>
                    <Input
                      className={recipeInputClassName}
                      id={`${fieldId}-licence`}
                      {...recipeInvalid(corrections, `${fieldId}-licence`)}
                      aria-label={m.subject_source_licence({}, o)}
                      value={authored.licence}
                      onChange={(event) =>
                        updateAuthored(
                          { licence: event.target.value },
                          authored,
                        )
                      }
                    />
                  </Field>
                  <div
                    id={`${fieldId}-document`}
                    role="group"
                    tabIndex={-1}
                    aria-label={label}
                    {...recipeInvalid(corrections, `${fieldId}-document`)}
                  >
                    <RichTextEditor
                      label={label}
                      labels={editorLabels()}
                      value={authored.document}
                      lang={authored.language}
                      disabled={frozen}
                      onChange={(document) => {
                        updateAuthored({ document }, authored);
                      }}
                    />
                  </div>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`${fieldId}-original`}
                      {...recipeInvalid(corrections, `${fieldId}-original`)}
                      className="size-11 after:inset-0"
                      checked={row.original ?? false}
                      onCheckedChange={(checked) => {
                        if (
                          !canEdit() ||
                          editing.current.row.original !== row.original
                        )
                          return;
                        clearCorrection(`${fieldId}-original`);
                        onOriginal(checked === true);
                      }}
                    />
                    <FieldLabel
                      className="min-h-11 items-center"
                      htmlFor={`${fieldId}-original`}
                    >
                      {m.recipe_original({}, o)}
                    </FieldLabel>
                  </Field>
                </>
              )}
            </>
          ) : definition.datatype === "wikibase-item" ? (
            <div
              id={`${fieldId}-entity`}
              role="group"
              tabIndex={-1}
              aria-label={label}
              {...recipeInvalid(corrections, `${fieldId}-entity`)}
            >
              <EntityPicker
                disabled={frozen}
                label={label}
                value={
                  picked.length
                    ? picked
                    : row.statement.value.type === "value" &&
                        typeof row.statement.value.content === "string" &&
                        row.statement.value.content
                      ? [
                          {
                            id: row.statement.value.content,
                            title:
                              pickText(
                                currentRead?.public?.related[
                                  row.statement.value.content
                                ]?.labels ?? {},
                                locale,
                              ).text || m.subject_value_unlabelled({}, o),
                            types: [],
                            typeLabel: "",
                            cover: null,
                          },
                        ]
                      : []
                }
                search={async (text, signal) =>
                  (await search(text, signal)).filter((entry) =>
                    entry.types.some((type) =>
                      recipeTarget(read.release, property, type),
                    ),
                  )
                }
                src={coverSrc}
                onValueChange={(items) => {
                  if (
                    !changePart("value", (entry) => ({
                      ...entry,
                      picked: items,
                      statement: {
                        ...entry.statement,
                        value: { type: "value", content: items[0]?.id ?? "" },
                      },
                    }))
                  )
                    return;
                  clearCorrection(`${fieldId}-entity`);
                  setPicked(items);
                }}
              />
            </div>
          ) : (
            <ScalarControl
              part={row.statement}
              feedback={{
                id: fieldId,
                address: "fact",
                errors: corrections
                  .filter((error) => !!error.target)
                  .map((error) => ({ ...error, target: error.target! })),
              }}
              definition={definition}
              read={{
                release: read.release,
                public: { related: currentRead?.public?.related ?? {} },
              }}
              locale={locale}
              onChange={(value) =>
                changePart("value", (entry) => ({
                  ...entry,
                  statement: { ...entry.statement, value },
                }))
              }
            />
          )}
          <Field>
            <FieldLabel htmlFor={`citation-${row.id}`}>
              {m.relation_citation({}, o)}
            </FieldLabel>
            <Input
              className={recipeInputClassName}
              id={`citation-${row.id}`}
              {...recipeInvalid(corrections, `citation-${row.id}`)}
              type="url"
              value={citation}
              onChange={(event) => {
                const url = event.target.value;
                if (
                  !canEdit() ||
                  editing.current.row.statement.references !==
                    row.statement.references
                )
                  return;
                setCitation(url);
                changePart("references", (entry) => ({
                  ...entry,
                  statement: {
                    ...entry.statement,
                    references: [
                      ...structuredClone(row.source?.references ?? []).map(
                        (reference) => ({
                          parts: reference.parts.map((part) => ({
                            property: { id: part.property.id },
                            value: part.value,
                          })),
                        }),
                      ),
                      ...(url.trim()
                        ? [
                            {
                              parts: [
                                {
                                  property: { id: "schema:url" },
                                  value: {
                                    type: "value" as const,
                                    content: url.trim(),
                                  },
                                },
                              ],
                            },
                          ]
                        : []),
                    ],
                  },
                }));
              }}
            />
          </Field>
        </fieldset>
        {reviewRequired && (
          <p role="alert">{m.catalogue_create_invalid_field({}, o)}</p>
        )}
        <div
          data-content-item-slot="actions"
          className="flex min-w-0 flex-wrap gap-3"
        >
          {confirmingRemoval ? (
            <div
              role="group"
              aria-label={m.candidate_confirm_title(
                { action: m.recipe_remove_field({}, o) },
                o,
              )}
              className="space-y-2"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRemoval();
                }
              }}
            >
              <p>
                {m.candidate_confirm_title(
                  { action: m.recipe_remove_field({}, o) },
                  o,
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  ref={cancelButton}
                  className={recipeActionClassName}
                  type="button"
                  variant="outline"
                  disabled={removalLocked}
                  onClick={cancelRemoval}
                >
                  {m.candidate_cancel({}, o)}
                </Button>
                <Button
                  className={recipeActionClassName}
                  type="button"
                  variant="destructive"
                  disabled={removalLocked}
                  onClick={remove}
                >
                  {m.recipe_remove_field({}, o)}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              ref={removeTrigger}
              className={recipeActionClassName}
              type="button"
              variant="ghost"
              disabled={removalLocked}
              onClick={() => {
                if (canRemove()) populated ? setRemovingId(row.id) : remove();
              }}
            >
              {m.recipe_remove_field({}, o)}
            </Button>
          )}
        </div>
        {row.uncertain && (!result || !result.ok) ? (
          <EditorFailure reason="unavailable" locale={locale} />
        ) : (
          result &&
          !result.ok && <EditorFailure reason={result.reason} locale={locale} />
        )}
        {result?.ok ? (
          <div className="space-y-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <p data-content-item-slot="state" role="status">
                {m.correction_proposed({}, o)}
              </p>
              {review && (
                <Button
                  className={recipeActionClassName}
                  type="button"
                  onClick={() => {
                    if (isReadEpochCurrent(readEpoch)) setReviewing(true);
                  }}
                >
                  {m.correction_review({}, o)}
                </Button>
              )}
            </div>
            {reviewing && review && currentRead?.public && (
              <CandidateReview
                id={currentRead.public.subject.id}
                locale={locale}
                initialProperty={property}
                exactCandidate={result.candidate}
                slot={slot}
                transport={review(property, slot, result.session)}
              />
            )}
          </div>
        ) : (
          <div
            data-content-item-slot="actions"
            className="flex min-w-0 flex-wrap gap-3"
          >
            {result &&
              !result.ok &&
              (!row.uncertain || result.refreshDefinitions === true) &&
              (result.refreshDefinitions === true ||
                result.reason === "stale" ||
                result.reason === "invalid" ||
                result.reason === "denied") && (
                <Button
                  className={recipeActionClassName}
                  type="button"
                  variant="outline"
                  onClick={() => void reviewCurrentDefinitions()}
                >
                  {m.catalogue_create_review_new({}, o)}
                </Button>
              )}
            {(currentRead?.public || (command && wasUncertain)) && (
              <Button
                className={recipeActionClassName}
                type="button"
                disabled={
                  disabled ||
                  busy ||
                  (!currentRead?.public && !wasUncertain) ||
                  (reviewRequired && !wasUncertain) ||
                  (result &&
                    !result.ok &&
                    result.refreshDefinitions === true &&
                    !wasUncertain) ||
                  (definition.datatype === "document" &&
                    (!authored ||
                      !row.original ||
                      !hasDocumentContent(authored.document))) ||
                  (result &&
                    !result.ok &&
                    result.reason === "stale" &&
                    !wasUncertain)
                }
                onClick={() => void submit()}
              >
                {command
                  ? m.correction_retry({}, o)
                  : m.correction_submit({}, o)}
              </Button>
            )}
          </div>
        )}
      </ContentItemFrame>
    </section>
  );
}

function RecipeNavigationGuard({
  active,
  dirty,
  pending,
}: {
  active: boolean;
  dirty: boolean;
  pending: boolean;
}) {
  const protect = active && (dirty || pending);
  const router = useRouter({ warn: false });
  useEffect(() => {
    if (!protect) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [protect]);

  return router ? (
    <RecipeRouterDepartureGuard protect={protect} pending={pending} />
  ) : null;
}

function RecipeRouterDepartureGuard({
  protect,
  pending,
}: {
  protect: boolean;
  pending: boolean;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const resolved = useRef(false);
  const leaving = useRef(false);
  const shouldBlockFn = useCallback(() => {
    if (!protect) return false;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    resolved.current = false;
    leaving.current = false;
    return true;
  }, [protect]);
  const blocker = useBlocker({
    shouldBlockFn,
    disabled: !protect,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useLayoutEffect(
    () => () => {
      const current = blockerRef.current;
      if (current.status === "blocked" && !resolved.current) {
        resolved.current = true;
        current.reset();
      }
    },
    [],
  );
  useEffect(() => {
    if (!protect && blocker.status === "blocked" && !resolved.current) {
      resolved.current = true;
      blocker.reset();
    }
  }, [protect, blocker]);

  function resolve(leave: boolean) {
    if (blocker.status !== "blocked" || resolved.current) return;
    resolved.current = true;
    leaving.current = leave;
    if (leave) blocker.proceed();
    else blocker.reset();
  }

  return (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => !open && resolve(false)}
    >
      <AlertDialogContent
        initialFocus={stayButton}
        finalFocus={() =>
          leaving.current
            ? false
            : returnFocus.current?.isConnected
              ? returnFocus.current
              : false
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.thread_authoring_discard_title()}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending
              ? m.thread_authoring_discard_pending()
              : m.thread_authoring_discard_unsaved()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={stayButton}>
            {m.thread_authoring_stay()}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => resolve(true)}
          >
            {m.thread_authoring_discard()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
