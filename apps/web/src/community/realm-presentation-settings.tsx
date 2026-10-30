import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { localizeUrl } from '../paraglide/runtime.js';
import {
  createRealmAppearance,
  realmImageSource,
  type RealmAppearanceAdapter,
  type RealmAppearanceRead,
  type RealmAppearanceSelection,
  type RealmImageSlot,
  type RealmPresentationImage,
  type RealmPresentationOptional,
} from './realm-presentation';

function ImagePreview({
  image,
  title,
  banner = false,
}: {
  image: RealmPresentationOptional<RealmPresentationImage>;
  title: string;
  banner?: boolean;
}) {
  const src = realmImageSource(image);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const value = image.state === 'available' ? image.value : null;
  return (
    <div className="space-y-2">
      <div
        className={`flex items-center justify-center overflow-hidden border bg-muted text-2xl font-semibold text-muted-foreground ${banner ? 'aspect-[3/1] w-full rounded-xl' : 'size-20 rounded-2xl'}`}
        style={value?.placeholder ? { backgroundColor: value.placeholder.color } : undefined}
      >
        {src && !failed ? (
          <img
            src={src}
            alt=""
            className="size-full object-cover"
            style={
              value?.focalPoint
                ? { objectPosition: `${value.focalPoint.x * 100}% ${value.focalPoint.y * 100}%` }
                : undefined
            }
            onError={() => setFailed(true)}
          />
        ) : (
          <span aria-hidden="true">{title.trim().slice(0, 2).toLocaleUpperCase()}</span>
        )}
      </div>
      {image.state === 'unavailable' || failed || (image.state === 'available' && !src) ? (
        <p className="text-sm text-muted-foreground">{m.realm_appearance_image_unavailable()}</p>
      ) : image.state === 'none' ? (
        <p className="text-sm text-muted-foreground">{m.realm_appearance_no_image()}</p>
      ) : null}
      {value?.credit && src && !failed ? (
        <p className="text-xs text-muted-foreground">
          {value.credit.rightsHolder} · {value.credit.license}
        </p>
      ) : null}
    </div>
  );
}

type Selection = {
  slot: RealmImageSlot | 'rules';
  first: string;
  second: string;
  candidate: RealmAppearanceSelection | null;
  busy: boolean;
  unavailable: boolean;
};

/** Reusable settings Pattern. Pages provide only current native data and ordinary command transport. */
export function RealmAppearanceSettings({
  realmId,
  initial,
  adapter,
}: {
  realmId: string;
  initial: RealmAppearanceRead;
  adapter: RealmAppearanceAdapter;
}) {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const control = useMemo(
    () =>
      createRealmAppearance(realmId, initial, {
        read: (...args) => adapterRef.current.read(...args),
        change: (...args) => adapterRef.current.change(...args),
        select: (...args) => adapterRef.current.select(...args),
        upload: (...args) => adapterRef.current.upload(...args),
        resume: (...args) => adapterRef.current.resume(...args),
      }),
    [realmId],
  );
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [clear, setClear] = useState<RealmImageSlot | 'rules' | null>(null);
  const ids = useId();
  useEffect(() => () => control.cancelUpload(), [control]);
  if (state.read.kind === 'hidden') return null;
  const heading = (
    <h2 id={`${ids}-heading`} className="text-xl font-semibold">
      {m.realm_appearance_heading()}
    </h2>
  );
  if (state.read.kind !== 'ready' || !state.draft)
    return (
      <section aria-labelledby={`${ids}-heading`} className="space-y-4 rounded-2xl border p-4 sm:p-6">
        {heading}
        <p role="status">{m.realm_appearance_unavailable()}</p>
        <Button variant="outline" disabled={state.busy} onClick={() => void control.refresh()}>
          {m.realm_appearance_refresh()}
        </Button>
      </section>
    );
  const { draft } = state;
  const { snapshot } = state.read;
  const editable = control.editable() && !selection;
  const label = (slot: RealmImageSlot | 'rules') =>
    slot === 'avatar'
      ? m.realm_appearance_icon()
      : slot === 'banner'
        ? m.realm_appearance_banner()
        : m.realm_appearance_rules();
  async function resolve() {
    if (!selection || selection.busy) return;
    const selected = selection;
    setSelection({ ...selected, busy: true, unavailable: false });
    let candidate: RealmAppearanceSelection;
    try {
      candidate = await adapter.select(
        selected.slot === 'rules'
          ? { kind: 'rules', realmId, postId: selected.first, revisionId: selected.second }
          : {
              kind: 'image',
              realmId,
              mediaId: selected.first,
              purpose: selected.slot === 'avatar' ? 'realm-icon' : 'realm-banner',
            },
      );
    } catch {
      candidate = { kind: 'unavailable' };
    }
    const valid =
      selected.slot === 'rules'
        ? candidate.kind === 'rules' &&
          candidate.rules.postId === selected.first &&
          candidate.rules.revisionId === selected.second
        : candidate.kind === 'image' &&
          candidate.image.id === selected.first &&
          candidate.image.containerId === realmId &&
          Boolean(realmImageSource({ state: 'available', value: candidate.image }));
    setSelection((current) =>
      current === null ? null : { ...selected, busy: false, candidate: valid ? candidate : null, unavailable: !valid },
    );
  }
  const rules = draft.rules.state === 'available' ? draft.rules.value : null;
  return (
    <section aria-labelledby={`${ids}-heading`} className="space-y-6 rounded-2xl border p-4 sm:p-6">
      {heading}
      <p className="text-sm text-muted-foreground">
        {snapshot.canManage ? m.realm_appearance_intro() : m.realm_appearance_readonly()}
      </p>
      <div className="grid gap-6 sm:grid-cols-[7rem_1fr]">
        {(['avatar', 'banner'] as const).map((slot) => (
          <div key={slot} className="min-w-0 space-y-3">
            <h3 className="font-medium">{label(slot)}</h3>
            <ImagePreview image={draft[slot]} title={snapshot.title} banner={slot === 'banner'} />
            {snapshot.canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!editable}
                  onClick={() =>
                    setSelection({ slot, first: '', second: '', candidate: null, busy: false, unavailable: false })
                  }
                >
                  {m.realm_appearance_choose()}
                </Button>
                <Field className="w-auto">
                  <FieldLabel htmlFor={`${ids}-${slot}-upload`} className="text-sm">
                    {m.realm_appearance_upload()}
                  </FieldLabel>
                  <Input
                    id={`${ids}-${slot}-upload`}
                    type="file"
                    className="max-w-56"
                    disabled={!editable}
                    accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                    aria-label={`${label(slot)}: ${m.realm_appearance_upload()}`}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void control.upload(slot, file);
                    }}
                  />
                </Field>
                <Button
                  variant="ghost"
                  disabled={
                    !editable || draft.presentation[slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId'] === null
                  }
                  onClick={() => setClear(slot)}
                >
                  {m.realm_appearance_clear()}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <h3 className="font-medium">{m.realm_appearance_rules()}</h3>
        {rules ? (
          <div className="space-y-2 rounded-xl bg-muted p-4">
            <p className="font-medium">{rules.title}</p>
            <p className="whitespace-pre-wrap text-sm">{rules.summary}</p>
            <a
              className="text-sm text-primary underline"
              href={
                localizeUrl(new URL(`/posts/${rules.postId}/revisions/${rules.revisionId}`, 'https://rezics.local'))
                  .pathname
              }
            >
              {m.realm_appearance_open_revision()}
            </a>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {draft.rules.state === 'unavailable'
              ? m.realm_appearance_rules_unavailable()
              : m.realm_appearance_no_rules()}
          </p>
        )}
        {snapshot.canManage ? (
          <>
            <p className="text-sm text-muted-foreground">{m.realm_appearance_rules_help()}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!editable}
                onClick={() =>
                  setSelection({
                    slot: 'rules',
                    first: '',
                    second: '',
                    candidate: null,
                    busy: false,
                    unavailable: false,
                  })
                }
              >
                {m.realm_appearance_select_rules()}
              </Button>
              <Button
                variant="ghost"
                disabled={!editable || draft.presentation.rules === null}
                onClick={() => setClear('rules')}
              >
                {m.realm_appearance_clear()}
              </Button>
            </div>
          </>
        ) : null}
      </div>
      {selection ? (
        <fieldset className="space-y-4 rounded-xl border p-4" disabled={selection.busy}>
          <legend className="px-2 font-medium">{label(selection.slot)}</legend>
          <Field>
            <FieldLabel htmlFor={`${ids}-reference`}>
              {selection.slot === 'rules' ? m.realm_appearance_post_id() : m.realm_appearance_media_id()}
            </FieldLabel>
            <Input
              id={`${ids}-reference`}
              value={selection.first}
              maxLength={36}
              onChange={(event) => setSelection({ ...selection, first: event.target.value, candidate: null })}
            />
          </Field>
          {selection.slot === 'rules' ? (
            <Field>
              <FieldLabel htmlFor={`${ids}-revision`}>{m.realm_appearance_revision_id()}</FieldLabel>
              <Input
                id={`${ids}-revision`}
                value={selection.second}
                maxLength={36}
                onChange={(event) => setSelection({ ...selection, second: event.target.value, candidate: null })}
              />
            </Field>
          ) : null}
          {selection.candidate?.kind === 'image' ? (
            <ImagePreview
              image={{ state: 'available', value: selection.candidate.image }}
              title={snapshot.title}
              banner={selection.slot === 'banner'}
            />
          ) : null}
          {selection.candidate?.kind === 'rules' ? (
            <div>
              <p className="font-medium">{selection.candidate.rules.title}</p>
              <p className="whitespace-pre-wrap text-sm">{selection.candidate.rules.summary}</p>
            </div>
          ) : null}
          {selection.unavailable ? <p role="alert">{m.realm_appearance_selection_unavailable()}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!selection.first || (selection.slot === 'rules' && !selection.second)}
              onClick={() => void resolve()}
            >
              {m.realm_appearance_preview()}
            </Button>
            <Button
              disabled={!selection.candidate}
              onClick={() => {
                if (selection.candidate) control.choose(selection.slot, selection.candidate);
                setSelection(null);
              }}
            >
              {m.realm_appearance_use_selection()}
            </Button>
            <Button variant="ghost" onClick={() => setSelection(null)}>
              {m.editor_cancel()}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {clear ? (
        <div
          role="group"
          aria-label={m.realm_appearance_clear_confirm()}
          className="space-y-3 rounded-xl border border-destructive p-4"
        >
          <p>
            {m.realm_appearance_clear_confirm()} ({label(clear)})
          </p>
          <p className="text-sm text-muted-foreground">{m.realm_appearance_clear_help()}</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={!editable}
              onClick={() => {
                control.clear(clear);
                setClear(null);
              }}
            >
              {m.realm_appearance_clear()}
            </Button>
            <Button variant="outline" onClick={() => setClear(null)}>
              {m.editor_cancel()}
            </Button>
          </div>
        </div>
      ) : null}
      {state.phase === 'uploading' ? (
        <div role="status" className="flex flex-wrap items-center gap-3">
          <p>{m.realm_appearance_uploading()}</p>
          <Button variant="outline" onClick={control.cancelUpload}>
            {m.editor_cancel()}
          </Button>
        </div>
      ) : null}
      {state.pendingUpload && state.phase !== 'uploading' ? (
        <div role="status" className="space-y-2">
          <p>{m.realm_appearance_upload_pending()}</p>
          <Button
            variant="outline"
            disabled={state.busy}
            onClick={() => void control.upload(state.pendingUpload!.slot)}
          >
            {m.realm_appearance_retry_upload()}
          </Button>
          <Button variant="ghost" onClick={control.cancelUpload}>
            {m.editor_cancel()}
          </Button>
        </div>
      ) : null}
      {state.phase === 'uncertain' ? (
        <div role="alert" className="space-y-2">
          <p>{m.realm_appearance_uncertain()}</p>
          <Button disabled={state.busy} onClick={() => void control.save()}>
            {m.realm_appearance_retry()}
          </Button>
        </div>
      ) : null}
      {state.phase === 'conflict' ? (
        <div role="alert" className="space-y-2">
          <p>{m.realm_appearance_conflict()}</p>
          <Button variant="outline" disabled={state.busy} onClick={() => void control.refresh()}>
            {m.realm_appearance_refresh()}
          </Button>
          {state.reviewed ? (
            <>
              <details className="space-y-3">
                <summary>{m.realm_appearance_current()}</summary>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ImagePreview image={snapshot.avatar} title={snapshot.title} />
                  <ImagePreview image={snapshot.banner} title={snapshot.title} banner />
                </div>
                <p>
                  {snapshot.rules.state === 'available'
                    ? snapshot.rules.value.title
                    : snapshot.rules.state === 'none'
                      ? m.realm_appearance_no_rules()
                      : m.realm_appearance_rules_unavailable()}
                </p>
              </details>
              <Button variant="outline" onClick={control.reviewConflict}>
                {m.realm_appearance_review()}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {state.notice !== 'none' ? <p role="alert">{m.realm_appearance_selection_unavailable()}</p> : null}
      {state.phase === 'saved' ? <p role="status">{m.realm_appearance_saved()}</p> : null}
      {snapshot.canManage ? (
        <Button disabled={!editable || Boolean(clear)} onClick={() => void control.save()}>
          {state.phase === 'saving' ? m.realm_appearance_saving() : m.realm_appearance_save()}
        </Button>
      ) : null}
    </section>
  );
}
