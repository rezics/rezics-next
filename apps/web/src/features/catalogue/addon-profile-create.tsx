import { useEffect, useId, useRef, useState } from 'react';
import type { SubjectRead } from '@rezics/client';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { CreateSubjectForm } from './create-subject-form';
import { createTypes, type CreateResult, type CreatedReader } from './create-subject';
import { GameInitialFacts } from './game-profile-fields';
import { AddonBaseWorkspace, type AddonBaseDraft } from './addon-base-workspace';
import type { StatementInput } from './statement-editor';
import { addonCreateControl, captureAddonHolders, type AddonCapturedHolder } from './addon-create-address';
import {
  addonAdmitCreatedReader,
  addonFactDrafts,
  applyAddonReuse,
  captureAddonReuse,
  refreshAddonReuse,
  type AddonReuseState,
} from './addon-create-review-model';
import { AddonCreateReview } from './addon-create-review';
import { ReferenceReusePanel } from './reference-reuse-view';
import { addonBase, addonInitialDraft, addonType, type AddonRead, type AddonTransport } from './addon-profile';
import type { GameItem } from './game-profile';

type InitialFact = { key: string; statement: StatementInput };

function jump(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  const focus = target.matches('input, select, textarea, button')
    ? target
    : target.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
      );
  if (focus) focus.focus();
  else {
    target.setAttribute('tabindex', '-1');
    target.focus();
  }
}

/** Configures the existing game creation controls for the one admitted add-on Type. */
export function AddonProfileCreate({
  read,
  locale,
  session,
  transport,
  search,
  onCreated,
}: {
  read: Extract<AddonRead, { ok: true }>;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: AddonTransport;
  search: EntityPickerSearch;
  onCreated: (result: Extract<CreateResult, { ok: true }>) => void;
}) {
  const o = { locale: locale as never };
  const [release, setRelease] = useState(read.release);
  useEffect(() => setRelease(read.release), [read.release]);
  const [facts, setFacts] = useState<InitialFact[]>([]);
  const [baseDraft, setBaseDraft] = useState<AddonBaseDraft>();
  const [baseChecking, setBaseChecking] = useState(false);
  const [chosenBase, setChosenBase] = useState<SubjectRead>();
  const [reuse, setReuse] = useState<AddonReuseState | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ key: string; index: number; nonce: number }>();
  const captured = useRef<AddonCapturedHolder[]>([]);
  const factsId = useId();
  function admit(id: string, reader: CreatedReader) {
    return addonAdmitCreatedReader(reader, id);
  }
  return (
    <CreateSubjectForm
      locale={locale}
      session={session}
      transport={{
        definitions: async (refresh) => {
          const current = refresh ? await transport.load({ work: read.workId }) : read;
          if (!current.ok) return { ok: false };
          if (refresh) setRelease(current.release);
          return { ok: true, types: createTypes(current.release, locale).filter((entry) => entry.id === addonType) };
        },
        submit: async (command) => {
          const result = await transport.create(command);
          if (!result.ok) return result;
          return { ...result, reader: admit(result.id, result.reader) };
        },
        read: async (id) => admit(id, await transport.read(id)),
      }}
      onNavigate={() => undefined}
      onCreated={(result) => onCreated({ ...result, reader: admit(result.id, result.reader) })}
      profile={{
        title: m.addon_title({}, o),
        scope: 'addon',
        type: addonType,
        href: `/${locale}/catalogue/addon${read.workId ? `?work=${encodeURIComponent(read.workId)}` : ''}`,
        metadata: {
          ready: true,
          pending: baseChecking,
          failure: <p>{m.addon_base_check_failed({}, o)}</p>,
          types: createTypes(release, locale).filter((entry) => entry.id === addonType),
        },
        hideHeading: true,
        labelLanguage: (type) => pageText(release.types[type]?.labels, locale).lang,
        descriptionLanguage: (type) => pageText(release.types[type]?.descriptions, locale).lang,
        control: (pointer) => addonCreateControl(pointer, captured.current, facts, baseDraft, release, locale, factsId),
        prepare: (initial) => {
          captured.current = captureAddonHolders(facts, baseDraft);
          return addonInitialDraft(release, initial, [
            ...facts.map((row) => row.statement),
            ...(baseDraft ? [baseDraft.statement] : []),
          ]);
        },
        review: ({ item, stale }) => (
          <AddonCreateReview
            item={item as GameItem}
            captured={captured.current}
            release={release}
            locale={locale}
            stale={stale}
            suggested={read.work}
            chosen={chosenBase}
            factsId={factsId}
            onJump={jump}
          />
        ),
        fields: (_type, disabled, canEdit, invalidate) => {
          const touch = () => invalidate?.();
          return (
            <ContentItemFrame
              as="div"
              id={factsId}
              data-slot="addon-initial-facts"
              role="group"
              aria-label={m.game_profile_initial({}, o)}
              tabIndex={-1}
              className="min-w-0 max-w-full space-y-5 py-3 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:py-4"
            >
              <AddonBaseWorkspace
                read={{ ...read, release }}
                locale={locale}
                search={search}
                load={async (address) => {
                  const current = await transport.load(address);
                  if (
                    current.ok &&
                    current.work &&
                    !current.workIssue &&
                    address.work &&
                    current.work.subject.id === address.work
                  )
                    setChosenBase(current.work);
                  return current;
                }}
                disabled={disabled || !canEdit()}
                draft={baseDraft}
                change={(next) => {
                  setBaseDraft(next);
                  const target =
                    next?.statement.value.type === 'value' && typeof next.statement.value.content === 'string'
                      ? next.statement.value.content
                      : '';
                  if (!next || !target) setChosenBase(undefined);
                  touch();
                }}
                releaseChanged={(next) => {
                  setRelease(next);
                  touch();
                }}
                checkingChanged={setBaseChecking}
              />
              <GameInitialFacts
                type={addonType}
                release={release}
                locale={locale}
                search={search}
                statements={facts}
                disabled={disabled}
                change={(next) => {
                  setFacts(next);
                  setReuse((current) =>
                    current && !next.some((row) => row.key === current.source.holder) ? null : current,
                  );
                  touch();
                }}
                editAllowed={canEdit}
                omitProperties={[addonBase]}
                stablePartAddresses
                reuse={
                  canEdit() ? { onReuse: (key, index) => setReuse(captureAddonReuse(facts, key, index)) } : undefined
                }
                {...(focusCopy ? { focusReference: focusCopy } : {})}
              />
              {reuse && (
                <>
                  <p className="text-sm text-muted-foreground">{m.addon_create_review_reuse_base({}, o)}</p>
                  <ReferenceReusePanel
                    source={reuse.source}
                    drafts={addonFactDrafts(facts)}
                    selected={reuse.selected}
                    read={{ release, public: { related: {} } }}
                    locale={locale}
                    capture={reuse.capture}
                    applied={reuse.applied}
                    refused={reuse.refused}
                    onSelected={(selected) => setReuse({ ...reuse, selected, applied: [], refused: [] })}
                    onApply={() => {
                      if (!canEdit()) return;
                      const result = applyAddonReuse(facts, reuse, release);
                      setFacts(result.facts);
                      setReuse({ ...reuse, applied: result.applied, refused: result.refused });
                      const first = result.applied[0];
                      if (first) setFocusCopy({ key: first.holder, index: first.index, nonce: Date.now() });
                      touch();
                    }}
                    onCancel={() => setReuse(null)}
                    onRefresh={() => {
                      const next = refreshAddonReuse(facts, reuse);
                      if (next) setReuse(next);
                    }}
                    onOpen={(holder, index) => setFocusCopy({ key: holder, index, nonce: Date.now() })}
                  />
                </>
              )}
            </ContentItemFrame>
          );
        },
      }}
    />
  );
}
