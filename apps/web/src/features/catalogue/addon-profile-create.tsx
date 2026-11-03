import { useEffect, useId, useState } from 'react';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { CreateSubjectForm } from './create-subject-form';
import { createTypes, type CreateResult } from './create-subject';
import { GameInitialFacts } from './game-profile-fields';
import { AddonBaseWorkspace, type AddonBaseDraft } from './addon-base-workspace';
import type { StatementInput } from './statement-editor';
import {
  addonBase,
  addonInitialDraft,
  addonType,
  type AddonRead,
  type AddonTransport,
} from './addon-profile';

type InitialFact = { key: string; statement: StatementInput };
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
  const factsId = useId();
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
        submit: transport.create,
        read: transport.read,
      }}
      onNavigate={() => undefined}
      onCreated={onCreated}
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
        control: (pointer) => (pointer.startsWith('/statements') ? factsId : undefined),
        prepare: (initial) =>
          addonInitialDraft(
            release,
            initial,
            [...facts.map((row) => row.statement), ...(baseDraft ? [baseDraft.statement] : [])],
          ),
        fields: (_type, disabled, canEdit) => (
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
              load={transport.load}
              disabled={disabled || !canEdit()}
              draft={baseDraft}
              change={setBaseDraft}
              releaseChanged={setRelease}
              checkingChanged={setBaseChecking}
            />
            <GameInitialFacts
              type={addonType}
              release={release}
              locale={locale}
              search={search}
              statements={facts}
              disabled={disabled}
              change={setFacts}
              editAllowed={canEdit}
              omitProperties={[addonBase]}
            />
          </ContentItemFrame>
        ),
      }}
    />
  );
}
