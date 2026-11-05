import canonicalize from 'canonicalize';
import { posix } from 'node:path';
import {
  libraryAt as at,
  validateLibraryProfileSource,
  type LibraryLabels,
  type LibraryProgressUnit,
  type LibraryCountForms,
  type LibraryProfile,
  type LibraryProfileReference,
  type LibraryProfileSource,
} from './library-profile.ts';
import type { CatalogueViolation } from './compile.ts';

type Node = Record<string, unknown>;
type Location = { file: string; pointer: string };
type Report = (location: Location, code: CatalogueViolation['code'], message: string) => void;
type Home = { children: Map<string, Home> } | { labels: LibraryLabels; seen: Set<string>; unit?: LibraryProgressUnit };
type Declaration = { profile: LibraryProfile; home: Home; location: Location; source: string };
const record = (v: unknown): v is Node => v !== null && typeof v === 'object' && !Array.isArray(v);
const branch = (): Home & { children: Map<string, Home> } => ({ children: new Map() });
const locales = new Set(['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);

/** Owns source declarations and their presentation, never induced LinkML annotations. */
export function compileLibraryProfiles(schemas: Record<string, Node>, report: Report) {
  const groups = new Map<string, Map<string, Declaration>>();
  const authored = new Map<string, Declaration>();
  const parents = new Map<string, string>();
  const locations = new Map<string, Location>();
  const nearest = new Map<string, Declaration | undefined>();
  const children = new Set<string>();
  for (const source of Object.values(schemas)) {
    if (!record(source.classes)) continue;
    for (const definition of Object.values(source.classes))
      if (record(definition) && typeof definition.is_a === 'string') children.add(definition.is_a);
  }

  function labelled(source: LibraryProfileSource) {
    const home = branch();
    const leaf = (parent: Home & { children: Map<string, Home> }, id: string): LibraryLabels => {
      const labels: LibraryLabels = { en: '' };
      parent.children.set(id, { labels, seen: new Set() });
      return labels;
    };
    const profile: LibraryProfile = {
      id: source.id,
      ...(source.importSources === undefined ? {} : { importSources: source.importSources }),
    };
    if (source.entryStateSet) {
      const states = branch();
      home.children.set('states', states);
      profile.entryStateSet = {
        ...source.entryStateSet,
        states: source.entryStateSet.states.map((state) => ({ ...state, labels: leaf(states, state.id) })),
      };
    }
    if (source.progress) {
      const units = branch();
      home.children.set('units', units);
      profile.progress = {
        allowed: source.progress.allowed.map((mode) => {
          const pairs = branch();
          units.children.set(mode.mode, pairs);
          return {
            ...mode,
            units: mode.units.map((unit) => {
              const released = { ...unit, labels: leaf(pairs, unit.id) };
              const home = pairs.children.get(unit.id)!;
              if ('labels' in home) home.unit = released;
              return released;
            }),
          };
        }),
      };
    }
    if (source.copies) {
      const kinds = branch();
      const statuses = branch();
      home.children.set('copyKinds', kinds);
      home.children.set('copyStatuses', statuses);
      profile.copies = {
        kinds: source.copies.kinds.map((kind) => {
          const values = branch();
          statuses.children.set(kind.id, values);
          return {
            ...kind,
            labels: leaf(kinds, kind.id),
            statuses: kind.statuses.map((status) => ({ ...status, labels: leaf(values, status.id) })),
          };
        }),
      };
    }
    return { profile, home };
  }

  for (const [file, source] of Object.entries(schemas)) {
    if (!record(source.classes)) continue;
    const group = posix.basename(file).replace(/\.ya?ml$/u, '');
    for (const [name, definition] of Object.entries(source.classes)) {
      if (!record(definition)) continue;
      const location = { file, pointer: at('/classes', name) };
      locations.set(name, location);
      if (typeof definition.is_a === 'string') parents.set(name, definition.is_a);
      if (!record(definition.annotations) || !Object.hasOwn(definition.annotations, 'library')) continue;
      const declarationLocation = { ...location, pointer: `${location.pointer}/annotations/library` };
      const value = definition.annotations.library;
      if (
        !validateLibraryProfileSource(value, (pointer) =>
          report({ ...location, pointer: declarationLocation.pointer + pointer }, 'invalid', 'Invalid library profile'),
        )
      )
        continue;
      if (
        value.id === 'legacy-fixed-v1' &&
        (definition.abstract !== true || Object.hasOwn(definition, 'class_uri') || children.has(name))
      )
        report(declarationLocation, 'invalid', 'Legacy data requires an unattached abstract declaration without a URI');
      const declarations = groups.get(group) ?? new Map<string, Declaration>();
      groups.set(group, declarations);
      const canonical = canonicalize(value)!;
      const previous = declarations.get(value.id);
      if (previous) {
        if (previous.source !== canonical)
          report(declarationLocation, 'duplicate', 'Conflicting library profile declarations');
        authored.set(name, previous);
      } else {
        const entry = { ...labelled(value), location: declarationLocation, source: canonical };
        declarations.set(value.id, entry);
        authored.set(name, entry);
      }
    }
  }

  function reference(name: string): LibraryProfileReference | undefined {
    const trail: string[] = [];
    const visited = new Set<string>();
    let current: string | undefined = name;
    let declaration: Declaration | undefined;
    while (current !== undefined && !visited.has(current)) {
      if (nearest.has(current)) {
        declaration = nearest.get(current);
        break;
      }
      visited.add(current);
      trail.push(current);
      declaration = authored.get(current);
      if (declaration) break;
      current = parents.get(current);
    }
    for (const ancestor of trail) nearest.set(ancestor, declaration);
    if (!declaration) return undefined;
    if (declaration.profile.id === 'legacy-fixed-v1') {
      report(locations.get(name)!, 'invalid', 'Accepting types cannot inherit the legacy profile');
      return undefined;
    }
    return { profileId: declaration.profile.id };
  }

  function presentation(group: string | undefined, locale: string, value: unknown, file: string) {
    const root = '/libraryProfiles';
    if (!record(value)) {
      report({ file, pointer: root }, 'invalid', 'Expected library profile presentation maps');
      return;
    }
    const visit = (home: Home, value: unknown, pointer: string) => {
      if ('children' in home) {
        if (!record(value)) {
          report({ file, pointer }, 'invalid', 'Expected a presentation map');
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          const target = home.children.get(key);
          if (!target) report({ file, pointer: at(pointer, key) }, 'invalid', 'Unknown presentation home');
          else visit(target, child, at(pointer, key));
        }
      } else {
        const text = (value: unknown, pointer: string): value is string => {
          if (typeof value === 'string' && [...value].length >= 1 && [...value].length <= 80) return true;
          report({ file, pointer }, 'invalid', 'Library labels require a launch locale and 1–80 code points');
          return false;
        };
        let label = value;
        let forms: LibraryCountForms | undefined;
        if (home.unit && record(value)) {
          let valid = true;
          for (const key of Object.keys(value))
            if (key !== 'label' && key !== 'countForms') {
              report({ file, pointer: at(pointer, key) }, 'invalid', 'Unknown unit presentation member');
              valid = false;
            }
          label = value.label;
          if (!text(label, at(pointer, 'label'))) valid = false;
          const formPointer = at(pointer, 'countForms');
          if (!record(value.countForms)) {
            report({ file, pointer: formPointer }, 'invalid', 'Expected count forms');
            valid = false;
          } else {
            if (!Object.hasOwn(value.countForms, 'other')) {
              report({ file, pointer: at(formPointer, 'other') }, 'invalid', 'Other count form is required');
              valid = false;
            }
            for (const [category, form] of Object.entries(value.countForms)) {
              if (!['other', 'zero', 'one', 'two', 'few', 'many'].includes(category)) {
                report({ file, pointer: at(formPointer, category) }, 'invalid', 'Unknown count category');
                valid = false;
              } else if (!text(form, at(formPointer, category))) valid = false;
            }
            if (valid) forms = { ...value.countForms } as LibraryCountForms;
          }
          if (!valid) return;
        } else if (!text(label, pointer)) return;
        if (home.seen.has(locale)) report({ file, pointer }, 'duplicate', 'Duplicate library label');
        else {
          home.seen.add(locale);
          Object.assign(home.labels, { [locale]: label });
          if (forms && home.unit) {
            home.unit.countForms ??= {};
            Object.assign(home.unit.countForms, { [locale]: forms });
          }
        }
      }
    };
    for (const [id, body] of Object.entries(value)) {
      const declaration = group === undefined ? undefined : groups.get(group)?.get(id);
      if (!declaration || !locales.has(locale))
        report({ file, pointer: at(root, id) }, 'invalid', 'Unknown profile, declaration home or locale');
      else visit(declaration.home, body, at(root, id));
    }
  }

  function registry(): Record<string, LibraryProfile> | undefined {
    if (!groups.size) return undefined;
    const result: Record<string, LibraryProfile> = Object.create(null);
    const canonical = new Map<string, string>();
    const requireEnglish = (home: Home, location: Location) => {
      if ('children' in home)
        for (const [key, child] of home.children)
          requireEnglish(child, { ...location, pointer: at(location.pointer, key) });
      else if (!home.seen.has('en')) report(location, 'missing_label', 'English library label is required');
    };
    for (const [group, declarations] of groups)
      for (const [id, entry] of declarations) {
        requireEnglish(entry.home, { file: `presentation/${group}/en`, pointer: at('/libraryProfiles', id) });
        const bytes = canonicalize(entry.profile)!;
        if (canonical.has(id) && canonical.get(id) !== bytes)
          report(entry.location, 'duplicate', 'Conflicting fully labelled library profiles');
        else {
          canonical.set(id, bytes);
          result[id] = entry.profile;
        }
      }
    return result;
  }
  return { reference, presentation, registry };
}
