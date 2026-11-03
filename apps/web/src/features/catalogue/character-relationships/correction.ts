import {
  relationDraft,
  validRelationSlot,
  type RelationDraft,
  type RelationSlot,
} from '../../../subject/relation-candidates';
import { voiceCharacterSlot } from './reading';
import type { CharacterAssociationRow, CharacterAssociationStream } from './reading';

export type CharacterAssociationCorrection = {
  id: string;
  statement: RelationDraft;
  slot?: RelationSlot;
  positionEditable: boolean;
  kind: CharacterAssociationStream['kind'];
  returnWork?: string;
};

function slotKeyValue(stream: CharacterAssociationStream, statement: RelationDraft): string | undefined {
  const keyProperty = stream.slotKey;
  if (!keyProperty) return undefined;
  const key = statement.qualifiers.find((part) => part.property.id === keyProperty);
  return key?.value.type === 'value' && typeof key.value.content === 'string' ? key.value.content : undefined;
}

export function associationSlot(
  stream: CharacterAssociationStream,
  statement: RelationDraft,
): RelationSlot | undefined {
  const external = statement.qualifiers.find((part) => part.property.id === 'schema:sameAs');
  const key = slotKeyValue(stream, statement);
  const slot: RelationSlot = {
    property: statement.property.id,
    ...(statement.value.type === 'value' && typeof statement.value.content === 'string'
      ? { target: statement.value.content }
      : statement.value.type === 'somevalue' &&
          external?.value.type === 'value' &&
          typeof external.value.content === 'string'
        ? { sameAs: external.value.content }
        : {}),
    ...(key ? { key } : {}),
  };
  return slot.property === stream.property && validRelationSlot(slot) ? slot : undefined;
}

/** Clone the complete assertion. Appearance age, role and main stay on this statement; they never rebuild from the character. */
export function associationCorrection(
  row: CharacterAssociationRow,
  stream: CharacterAssociationStream,
): CharacterAssociationCorrection | undefined {
  if (!row.statement) return;
  const statement = relationDraft(row.statement);
  const slot = associationSlot(stream, statement);
  if (!slot) return;
  return {
    id: row.holder,
    statement,
    slot,
    positionEditable: false,
    kind: stream.kind,
    ...(stream.kind === 'appearance' ? { returnWork: row.holder } : {}),
  };
}

export function voiceStaysIndependent(stream: CharacterAssociationStream, statement: RelationDraft): boolean {
  if (stream.kind !== 'voice') return true;
  const portrayed = statement.qualifiers.find((part) => part.property.id === voiceCharacterSlot);
  return portrayed?.property.id === voiceCharacterSlot;
}

export function appearanceFactsStayOnSlot(
  stream: CharacterAssociationStream,
  statement: RelationDraft,
  characterId: string,
): boolean {
  if (stream.kind !== 'appearance') return true;
  return (
    statement.property.id === stream.property &&
    statement.value.type === 'value' &&
    statement.value.content === characterId
  );
}
