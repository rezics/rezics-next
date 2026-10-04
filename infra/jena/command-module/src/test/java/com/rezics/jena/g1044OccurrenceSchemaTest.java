package com.rezics.jena;

import static org.junit.Assert.*;
import static com.rezics.jena.g1022OccurrenceLabelsTest.*;
import java.util.List;
import org.apache.jena.graph.Node;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.Entity;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.FieldInfos;
import org.junit.Test;

public class g1044OccurrenceSchemaTest {
    private static long matches(Fixture f, String query) {
        var items = f.page(query, "", 10).get("items").getAsArray();
        long count = 0;
        for (var item : items) if (item.getAsObject().get("matches").getAsBoolean().value()) count++;
        return count;
    }
    private static Entity entity(int at, String labels) {
        var entity = new Entity(OccurrenceLabelIndex.scope(GENERATION, REVISION, STRUCTURE)
            + String.format("%08d!a!00000000-0000-4000-8000-%012d:chapter", at, 50000 + at),
            OccurrenceLabelIndex.TEXT.getURI(), null, null);
        entity.put(OccurrenceTextSchema.FIELD, "{\"labels\":" + labels + "}");
        return entity;
    }
    private static void schema(Fixture f) throws Exception {
        try (var reader = DirectoryReader.open(f.index.lucene().getIndexWriter())) {
            var fields = FieldInfos.getMergedFieldInfos(reader);
            assertEquals(OccurrenceTextSchema.TYPE.indexOptions(), fields.fieldInfo(OccurrenceTextSchema.FIELD).getIndexOptions());
            assertEquals(OccurrenceTextSchema.TYPE.omitNorms(), fields.fieldInfo(OccurrenceTextSchema.FIELD).omitsNorms());
            assertNotNull(fields.fieldInfo(OccurrenceTextSchema.PAYLOAD));
        }
        assertFalse(OccurrenceTextSchema.incompatible(f.index));
    }
    @Test public void emptyAndLabeledAddUpdateDeleteAndRollbackUseOneDefinitionInBothOrders() throws Exception {
        for (boolean emptyFirst : List.of(true, false)) try (var f = new Fixture()) {
            var empty = entity(0, "[]");
            var labeled = entity(1, "[{\"value\":\"魔法禁書目錄\",\"language\":\"yue\"}]");
            f.index.addEntity(emptyFirst ? empty : labeled); f.index.commit();
            f.index.addEntity(emptyFirst ? labeled : empty); f.index.commit();
            schema(f);
            assertEquals(1, matches(f, "禁书目录"));
            // Jena's update path must preserve the occurrence directory and
            // analyze the carried labels rather than the JSON serialization.
            var edited = entity(1, "[{\"value\":\"Nouvelle rencontre\",\"language\":\"fr\"}]");
            f.index.updateEntity(edited); f.index.commit();
            assertEquals(0, matches(f, "禁书目录"));
            assertEquals(1, matches(f, "rencontre"));
            f.index.updateEntity(entity(1, "[]")); f.index.rollback();
            assertEquals(1, matches(f, "rencontre"));
            f.index.deleteEntity(edited); f.index.commit();
            assertEquals(0, matches(f, "rencontre"));
            f.index.updateEntity(empty); f.index.commit(); schema(f);
        }
    }
    private static void legacy(Fixture f, boolean storedOnly, boolean malformed) throws Exception {
        f.data.begin(ReadWrite.WRITE);
        try {
            fixture(f.data, 1);
            var raw = f.data.getWrapped();
            raw.add(OccurrenceLabelIndex.TEXT, OccurrenceLabelIndex.uri(entity(0, "[]").getId()), p("occurrenceSearchLabels"),
                text(malformed ? "invalid JSON" : "{\"labels\":[{\"value\":\"Recovered café\",\"language\":\"fr\"}]}"));
            f.data.add(OccurrenceLabelIndex.uri(CommandPolicy.PUBLIC_SEARCH), id(90001), p("publicTitle"), text("Retained public title"));
            var old = new Document();
            old.add(storedOnly ? new StoredField(OccurrenceTextSchema.FIELD, "{\"labels\":[]}")
                : new Field(OccurrenceTextSchema.FIELD, "Legacy label", TextField.TYPE_STORED));
            f.index.lucene().getIndexWriter().addDocument(old);
            f.data.commit();
        } finally { f.data.end(); }
    }
    @Test public void startupRebuildsConflictingAndLegacyDefinitionsAndRetainsOtherFields() throws Exception {
        for (boolean storedOnly : List.of(true, false)) try (var f = new Fixture()) {
            legacy(f, storedOnly, false);
            assertTrue(OccurrenceTextSchema.incompatible(f.index));
            assertTrue(OccurrenceTextSchema.rebuildIfIncompatible(f.data));
            schema(f);
            assertEquals(1, matches(f, "CAFÉ"));
            assertEquals(1, f.index.query(p("publicTitle"), "Retained", CommandPolicy.PUBLIC_SEARCH, null).size());
            f.data.begin(ReadWrite.READ);
            try {
                var generation = OccurrenceLabelIndex.textGeneration(f.data);
                assertNotEquals(id(95000), generation);
                assertTrue(generation.getURI().matches("urn:rezics:text-index-generation:[0-9a-f-]{36}"));
            }
            finally { f.data.end(); }
            assertFalse(OccurrenceTextSchema.rebuildIfIncompatible(f.data));
            f.index.addEntity(entity(1, "[]")); f.index.commit(); schema(f);
        }
    }
    @Test public void failedRebuildRollsBackTheIndexAndGenerationAndCanResume() throws Exception {
        try (var f = new Fixture()) {
            legacy(f, true, true);
            assertThrows(IllegalStateException.class, () -> OccurrenceTextSchema.rebuildIfIncompatible(f.data, System.nanoTime()));
            assertThrows(RuntimeException.class, () -> OccurrenceTextSchema.rebuildIfIncompatible(f.data));
            assertTrue(OccurrenceTextSchema.incompatible(f.index));
            assertEquals(1, f.index.query(p("publicTitle"), "Retained", CommandPolicy.PUBLIC_SEARCH, null).size());
            f.data.begin(ReadWrite.WRITE);
            try {
                assertEquals(id(95000), OccurrenceLabelIndex.textGeneration(f.data));
                f.data.getWrapped().deleteAny(OccurrenceLabelIndex.TEXT, Node.ANY, Node.ANY, Node.ANY);
                f.data.getWrapped().add(OccurrenceLabelIndex.TEXT, OccurrenceLabelIndex.uri(entity(0, "[]").getId()),
                    p("occurrenceSearchLabels"), text("{\"labels\":[]}"));
                f.data.commit();
            } finally { f.data.end(); }
            assertTrue(OccurrenceTextSchema.rebuildIfIncompatible(f.data)); schema(f);
        }
    }
}
