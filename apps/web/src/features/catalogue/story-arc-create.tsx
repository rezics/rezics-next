import { useEffect, useRef, useState, type ReactNode } from 'react';
import { releaseDigest, type Release } from '@rezics/definitions';
import type { Violation } from '@rezics/definitions/validate';
import { m } from '../../paraglide/messages.js';
import { createTypes, type CreateResult, type CreateTransport, type InitialSubject } from './create-subject';
import { CreateSubjectForm } from './create-subject-form';
import { StoryArcCreateFields } from './story-arc-create-fields';
import { StoryArcCreateReview } from './story-arc-create-review';
import {
  createStoryArcFactStore,
  prepareStoryArcInitial,
  storyArcCreateControl,
  type StoryArcFactStore,
  type StoryArcInitialItem,
} from './story-arc-create-model';
import { storyArcType, type StoryArcTransport } from './story-arc-profile';

type Created = Extract<CreateResult, { ok: true }>;
type ReleaseState = { release: Release; ready: boolean };

/** StoryArc creation binds initial evidence to the same prepared native item as its term review. */
export function StoryArcCreate({
  locale,
  session,
  transport,
  release,
  work,
  href,
  onCreated,
  navigation,
}: {
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: StoryArcTransport;
  release: Release;
  work?: string;
  href: string;
  onCreated: (created: Created) => void;
  navigation?: (state: { dirty: boolean; pending: boolean; confirmed: boolean }) => ReactNode;
}) {
  const o = { locale: locale as never };
  const storeRef = useRef<StoryArcFactStore | null>(null);
  if (!storeRef.current) storeRef.current = createStoryArcFactStore();
  const store = storeRef.current;
  const [active, setActive] = useState<ReleaseState>({ release, ready: true });
  const [errors, setErrors] = useState<Pick<Violation, 'pointer' | 'code'>[]>([]);
  const invalidate = useRef<(() => void) | undefined>(undefined);
  const latestRelease = useRef(release);
  const propDigest = releaseDigest(release);

  useEffect(() => {
    if (releaseDigest(latestRelease.current) !== propDigest) {
      latestRelease.current = release;
      setActive({ release, ready: true });
      invalidate.current?.();
    }
  }, [propDigest, release]);

  const createTypesForRelease = (candidate: Release) => createTypes(candidate, locale).filter(({ id }) => id === storyArcType);
  const createTransport: CreateTransport = {
    definitions: async (refresh = false) => {
      let next = active;
      if (refresh) {
        const current = await transport.load({ work });
        if (!current.ok) {
          setActive({ release: active.release, ready: false });
          invalidate.current?.();
          return { ok: false };
        }
        if (releaseDigest(active.release) !== releaseDigest(current.release)) invalidate.current?.();
        next = { release: current.release, ready: true };
        latestRelease.current = current.release;
        setActive(next);
      }
      return next.ready ? { ok: true, types: createTypesForRelease(next.release) } : { ok: false };
    },
    submit: async (command) => {
      const result = await transport.creation.submit(command);
      setErrors(result.ok ? [] : (result.errors ?? []));
      return result;
    },
    read: (id) => transport.creation.read(id),
  };

  const metadataTypes = createTypesForRelease(active.release);
  const admitted = active.ready && !!active.release.types[storyArcType];
  const profileMetadata = {
    ready: admitted,
    pending: !active.ready,
    types: metadataTypes,
  };

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
    focus?.focus();
  }

  return (
    <CreateSubjectForm
      locale={locale}
      session={session}
      transport={createTransport}
      onNavigate={() => {}}
      onCreated={onCreated}
      {...(navigation ? { navigation } : {})}
      profile={{
        scope: 'story-arc',
        hideHeading: true,
        readOnlyType: true,
        metadata: profileMetadata,
        type: storyArcType,
        title: m.story_arc_create({}, o),
        intro: m.story_arc_creation_help({}, o),
        href,
        prepare: (initial: InitialSubject) => {
          const prepared = prepareStoryArcInitial(initial, store.getSnapshot(), active.release, store);
          if (!admitted)
            prepared.errors.push({ pointer: '/type', code: 'unsupported' });
          setErrors(prepared.errors);
          return prepared;
        },
        control: (pointer, type) =>
          type === storyArcType
            ? storyArcCreateControl(pointer, active.release, locale, store.getSnapshot(), store.prepared())
            : undefined,
        review: ({ item, stale }) => (
          <StoryArcCreateReview
            item={item as StoryArcInitialItem}
            release={active.release}
            locale={locale}
            stale={stale}
            identity={store.identity(item as StoryArcInitialItem)}
            onOpen={jump}
          />
        ),
        fields: (type, disabled, canEdit, invalidateReview) => {
          invalidate.current = invalidateReview;
          return type === storyArcType ? (
            <StoryArcCreateFields
              release={active.release}
              locale={locale}
              disabled={disabled || !active.ready}
              canEdit={canEdit}
              store={store}
              errors={errors}
              identity={store.prepared()}
              invalidate={invalidateReview}
            />
          ) : null;
        },
      }}
    />
  );
}
