package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.apache.jena.datatypes.TypeMapper;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexException;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.StringField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.apache.lucene.store.FSDirectory;
import org.junit.Test;

public class TextEntityDocumentsTest {
    private static final String UNIT = "urn:rezics:entity:example", RV = "https://rezics.com/vocab/";
    private static final TextEntityDocuments.Source SOURCE = new TextEntityDocuments.Source(
        "urn:rezics:source:original", "a".repeat(64), "urn:rezics:head:original", "source-epoch", "text-recipe-v1");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static TextEntityDocuments.Scope scope(String field) {
        return new TextEntityDocuments.Scope(UNIT, field.equals("privateBody")
            ? CommandPolicy.PRIVATE_SEARCH : CommandPolicy.PUBLIC_SEARCH, field);
    }
    private static TextEntityDocuments.Row row(String text, String language) {
        return new TextEntityDocuments.Row(language.isEmpty() ? NodeFactory.createLiteralString(text)
            : NodeFactory.createLiteralLang(text, language), SOURCE);
    }
    private static TextEntityDocuments.Source source(String head, String epoch) {
        return new TextEntityDocuments.Source(SOURCE.reference(), SOURCE.digest(), head, epoch, SOURCE.recipe());
    }
    private static TextIndexConfig config(boolean stored) {
        var definition = new EntityDefinition("uri", "label", "graph");
        definition.set("label", uri("http://www.w3.org/2000/01/rdf-schema#label"));
        definition.set("body", uri(RV + "searchBody"));
        definition.set("publicTitle", uri(RV + "publicTitle"));
        definition.set("privateBody", uri(RV + "privateSearchBody"));
        definition.setLangField("lang"); definition.setUidField("uid");
        var config = new TextIndexConfig(definition);
        config.setValueStored(stored);
        config.setAnalyzer(new FilteredGraphTextAssembler.CjkBigramV2());
        return config;
    }
    private static final class Fixture implements AutoCloseable {
        final ByteBuffersDirectory directory = new ByteBuffersDirectory();
        final TextIndexConfig config = config(true);
        final TextIndexLucene index = new TextIndexLucene(directory, config);
        final FilteredGraphTextIndex filtered = new FilteredGraphTextIndex(index);
        @Override public void close() throws Exception { index.close(); directory.close(); config.getAnalyzer().close(); }
        void put(String field, List<TextEntityDocuments.Row> rows) {
            TextEntityDocuments.replace(index, scope(field), rows); index.commit();
            TextEntityDocuments.verifyCommitted(index, scope(field), rows);
        }
        List<org.apache.jena.query.text.TextHit> hits(String field, String query) {
            String predicate = field.equals("label") ? "http://www.w3.org/2000/01/rdf-schema#label"
                : RV + (field.equals("body") ? "searchBody" : field.equals("privateBody") ? "privateSearchBody" : "publicTitle");
            return filtered.query(uri(predicate), query, scope(field).graph(), null, 64);
        }
    }

    @Test public void taggedAliasesRemainSeparateAndNeverFormCrossAliasPhrases() throws Exception {
        try (var f = new Fixture()) {
            var rows = List.of(row("alpha", "sr-Latn"), row("beta", "en-US"), row("مرحبا", "ar"), row("bonjour", "fr"));
            f.put("publicTitle", rows);
            assertEquals(rows.get(0).literal(), f.hits("publicTitle", "alpha").getFirst().getLiteral());
            assertEquals(rows.get(1).literal(), f.hits("publicTitle", "beta").getFirst().getLiteral());
            assertEquals(rows.get(2).literal(), f.hits("publicTitle", "مرحبا").getFirst().getLiteral());
            assertEquals(rows.get(3).literal(), f.hits("publicTitle", "bonjour").getFirst().getLiteral());
            assertTrue(f.hits("publicTitle", "\"alpha beta\"").isEmpty());
            assertTrue(f.hits("publicTitle", "alpha AND beta").isEmpty());
            // Jena's own graph/language query consumes these external fields.
            var hits = f.index.query(UNIT, List.of(ResourceFactory.createResource(RV + "publicTitle")),
                "alpha", CommandPolicy.PUBLIC_SEARCH, "sr-Latn", 64, null);
            assertEquals(1, hits.size()); assertEquals(rows.getFirst().literal(), hits.getFirst().getLiteral());
        }
    }

    @Test public void cjkFoldingPreservesOriginalLexicalAndLanguageAcrossPublicAndPrivateFields() throws Exception {
        try (var f = new Fixture()) {
            for (String field : List.of("label", "body", "publicTitle", "privateBody")) {
                var rows = List.of(row("魔法禁書目錄", "zh-Hant"), row("ｶﾞﾗｽ", "ja"), row("ＲＵＳＴ", "en-US"));
                f.put(field, rows);
                assertEquals(rows.get(0).literal(), f.hits(field, "\"魔法禁书目录\"").getFirst().getLiteral());
                assertEquals(rows.get(1).literal(), f.hits(field, "\"がらす\"").getFirst().getLiteral());
                assertEquals(rows.get(2).literal(), f.hits(field, "rust").getFirst().getLiteral());
                assertTrue(f.hits(field, "\"カラス\"").isEmpty());
            }
        }
    }

    @Test public void exactLexicalDatatypeIdentityDoesNotCollapseJenaUidCollisions() throws Exception {
        try (var f = new Fixture()) {
            Node integer = NodeFactory.createLiteralDT("01", XSDDatatype.XSDinteger);
            Node custom = NodeFactory.createLiteralDT("01", TypeMapper.getInstance().getSafeTypeByName("urn:rezics:datatype:code"));
            var rows = List.of(new TextEntityDocuments.Row(integer, SOURCE), new TextEntityDocuments.Row(custom, SOURCE), row("01", ""));
            f.put("publicTitle", rows);
            assertEquals(3, f.hits("publicTitle", "01").size());
            assertEquals(java.util.Set.of(integer, custom, rows.get(2).literal()),
                f.hits("publicTitle", "01").stream().map(hit -> hit.getLiteral()).collect(java.util.stream.Collectors.toSet()));
            // Two Jena UIDs can collide, but leaf row keys and exact source checks cannot.
            try (var reader = DirectoryReader.open(f.directory)) {
                var stored = new IndexSearcher(reader).storedFields();
                assertEquals(stored.document(0).get("uid"), stored.document(1).get("uid"));
                assertNotEquals(stored.document(0).get("externalTextKey"), stored.document(1).get("externalTextKey"));
            }
            assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommitted(f.index, scope("publicTitle"), rows.subList(0, 2)));
        }
    }

    @Test public void replacementAndAbsencePreserveOtherFieldsGraphsUnitsAndNativeDocuments() throws Exception {
        try (var f = new Fixture()) {
            f.put("publicTitle", List.of(row("oldname", "en")));
            var body = List.of(row("publicbody", "en"));
            var privateRows = List.of(row("secretbody", "en"));
            f.put("body", body); f.put("privateBody", privateRows);
            var other = new TextEntityDocuments.Scope("urn:rezics:entity:neighbor", CommandPolicy.PUBLIC_SEARCH, "publicTitle");
            var otherRows = List.of(row("neighbor", "en"));
            TextEntityDocuments.replace(f.index, other, otherRows);
            Entity nativeRow = new Entity(UNIT, CommandPolicy.PUBLIC_SEARCH, "en", null);
            nativeRow.put("publicTitle", "nativealias"); f.index.addEntity(nativeRow); f.index.commit();
            f.put("publicTitle", List.of(row("newname", "en")));
            assertTrue(f.hits("publicTitle", "oldname").isEmpty());
            assertEquals(1, f.hits("publicTitle", "newname").size());
            assertEquals(1, f.hits("publicTitle", "nativealias").size());
            TextEntityDocuments.verifyCommitted(f.index, scope("body"), body);
            TextEntityDocuments.verifyCommitted(f.index, scope("privateBody"), privateRows);
            TextEntityDocuments.verifyCommitted(f.index, other, otherRows);
            assertTrue(f.filtered.query(uri(RV + "searchBody"), "secretbody", CommandPolicy.PUBLIC_SEARCH, null, 64).isEmpty());
            f.put("publicTitle", List.of());
            assertEquals(1, f.hits("publicTitle", "nativealias").size());
            assertTrue(f.hits("publicTitle", "newname").isEmpty());
            TextEntityDocuments.verifyCommitted(f.index, scope("privateBody"), privateRows);
        }
    }

    @Test public void committedVerificationNeverAcknowledgesPendingWritesAndRollbackRestoresPriorRows() throws Exception {
        try (var f = new Fixture()) {
            var before = List.of(row("before", "en"));
            var after = List.of(row("after", "en"));
            f.put("body", before);
            TextEntityDocuments.replace(f.index, scope("body"), after);
            TextEntityDocuments.verifyCommitted(f.index, scope("body"), before);
            assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommitted(f.index, scope("body"), after));
            assertTrue(f.hits("body", "after").isEmpty());
            f.index.rollback();
            TextEntityDocuments.verifyCommitted(f.index, scope("body"), before);
            TextEntityDocuments.replace(f.index, scope("body"), List.of());
            f.index.rollback();
            TextEntityDocuments.verifyCommitted(f.index, scope("body"), before);
            f.put("body", after);
            assertTrue(f.hits("body", "before").isEmpty());
        }
    }

    @Test public void sourceHeadEpochRecipeAndOriginalDigestMustAgreeExactly() throws Exception {
        try (var f = new Fixture()) {
            var original = row("same bytes", "en-US"); f.put("body", List.of(original));
            List<TextEntityDocuments.Source> stale = List.of(source("urn:rezics:head:next", SOURCE.epoch()),
                source(SOURCE.head(), "recovered-epoch"),
                new TextEntityDocuments.Source(SOURCE.reference(), "b".repeat(64), SOURCE.head(), SOURCE.epoch(), SOURCE.recipe()),
                new TextEntityDocuments.Source("urn:rezics:source:other", SOURCE.digest(), SOURCE.head(), SOURCE.epoch(), SOURCE.recipe()),
                new TextEntityDocuments.Source(SOURCE.reference(), SOURCE.digest(), SOURCE.head(), SOURCE.epoch(), "text-recipe-v2"));
            for (var value : stale) assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommitted(f.index,
                scope("body"), List.of(new TextEntityDocuments.Row(original.literal(), value))));
            var next = new TextEntityDocuments.Row(original.literal(), stale.getFirst());
            f.put("body", List.of(next));
            assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommitted(f.index, scope("body"), List.of(original)));
        }
    }

    private static Document storedDocument(Fixture f) throws Exception {
        try (var reader = DirectoryReader.open(f.directory)) {
            var searcher = new IndexSearcher(reader);
            var hit = searcher.search(new TermQuery(new Term("externalTextField", "body")), 1).scoreDocs[0];
            Document stored = searcher.storedFields().document(hit.doc), copy = new Document();
            for (var field : stored.getFields()) {
                if (field.name().equals("body")) copy.add(new org.apache.lucene.document.TextField(field.name(), field.stringValue(), Field.Store.YES));
                else if (List.of("uri", "graph").contains(field.name()))
                    copy.add(new Field(field.name(), field.stringValue(), TextIndexLucene.ftIRI));
                else if (List.of("externalTextSource", "externalTextDigest", "externalTextSchema").contains(field.name()))
                    copy.add(new org.apache.lucene.document.StoredField(field.name(), field.stringValue()));
                else copy.add(new StringField(field.name(), field.stringValue(), Field.Store.YES));
            }
            return copy;
        }
    }
    @Test public void exactReaderRefusesDuplicatesMissingSchemaAndForgedDigestsWithChangedText() throws Exception {
        try (var f = new Fixture()) {
            var rows = List.of(row("exact", "en")); f.put("body", rows);
            Document original = storedDocument(f);
            f.index.getIndexWriter().addDocument(original); f.index.commit();
            assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommitted(f.index, scope("body"), rows));
            f.put("body", rows);
            for (boolean stored : List.of(true, false)) {
                Document forged = storedDocument(f);
                forged.add(new org.apache.lucene.document.TextField("privateBody", "secret", stored ? Field.Store.YES : Field.Store.NO));
                f.index.getIndexWriter().deleteDocuments(new Term("externalTextKey", original.get("externalTextKey")));
                f.index.getIndexWriter().addDocument(forged); f.index.commit();
                assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommitted(f.index, scope("body"), rows));
                f.put("body", rows);
            }
            for (String changed : List.of("body", "externalTextSchema", "externalTextSource", "lang", "uid")) {
                Document forged = storedDocument(f); forged.removeFields(changed);
                if (changed.equals("body")) forged.add(new org.apache.lucene.document.TextField(changed, "forged", Field.Store.YES));
                else if (changed.equals("externalTextSource")) forged.add(new org.apache.lucene.document.StoredField(changed, "forged"));
                else if (!changed.equals("externalTextSchema")) forged.add(new StringField(changed, "forged", Field.Store.YES));
                f.index.getIndexWriter().deleteDocuments(new Term("externalTextKey", original.get("externalTextKey")));
                f.index.getIndexWriter().addDocument(forged); f.index.commit();
                assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommitted(f.index, scope("body"), rows));
                f.put("body", rows);
            }
        }
    }

    @Test public void countByteDuplicateAndLateRowBoundsRefuseBeforeAnyDeletion() throws Exception {
        try (var f = new Fixture()) {
            var prior = List.of(row("prior", "en")); f.put("body", prior);
            var tooMany = new ArrayList<TextEntityDocuments.Row>();
            for (int i = 0; i <= TextEntityDocuments.MAX_ROWS; i++) tooMany.add(row("value" + i, "en"));
            var tooLarge = new ArrayList<TextEntityDocuments.Row>();
            for (int i = 0; i < 11; i++) tooLarge.add(row("界".repeat(65_535) + (char)('a' + i), "zh"));
            for (var rejected : List.of(tooMany, tooLarge, List.of(prior.getFirst(), prior.getFirst()))) {
                assertThrows(IllegalArgumentException.class, () -> TextEntityDocuments.replace(f.index, scope("body"), rejected));
                f.index.commit(); TextEntityDocuments.verifyCommitted(f.index, scope("body"), prior);
            }
            var nullLast = new ArrayList<>(prior); nullLast.add(null);
            assertThrows(NullPointerException.class, () -> TextEntityDocuments.replace(f.index, scope("body"), nullLast));
            f.index.commit(); TextEntityDocuments.verifyCommitted(f.index, scope("body"), prior);
            f.put("body", tooMany.subList(0, TextEntityDocuments.MAX_ROWS));
            var boundary = List.of(row("界".repeat(65_536), "zh"));
            f.put("body", boundary);
            assertThrows(IllegalArgumentException.class, () -> row("a".repeat(65_537), "en"));
            assertThrows(IllegalArgumentException.class, () -> row("\ud800", "en"));
            assertThrows(IllegalArgumentException.class, () -> row("valid", "en_US"));
            assertThrows(IllegalArgumentException.class, () -> new TextEntityDocuments.Row(uri(UNIT), SOURCE));
            assertThrows(IllegalArgumentException.class, () -> new TextEntityDocuments.Row(
                NodeFactory.createLiteralDT("untagged", TypeMapper.getInstance().getSafeTypeByName(org.apache.jena.vocabulary.RDF.langString.getURI())), SOURCE));
        }
    }

    @Test public void scopeSourceAndLayoutRefuseUnsupportedOrAmbiguousInputs() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> new TextEntityDocuments.Scope(UNIT, CommandPolicy.PUBLIC_SEARCH, "privateBody"));
        assertThrows(IllegalArgumentException.class, () -> new TextEntityDocuments.Scope(UNIT, CommandPolicy.PRIVATE_SEARCH, "body"));
        assertThrows(IllegalArgumentException.class, () -> new TextEntityDocuments.Scope(UNIT, CommandPolicy.PUBLIC_SEARCH, "occurrenceLabel"));
        assertThrows(IllegalArgumentException.class, () -> source("relative", SOURCE.epoch()));
        assertThrows(IllegalArgumentException.class, () -> source(SOURCE.head(), ""));
        assertThrows(IllegalArgumentException.class, () -> new TextEntityDocuments.Source(SOURCE.reference(), "invalid", SOURCE.head(), SOURCE.epoch(), SOURCE.recipe()));
        var config = config(false);
        try (var directory = new ByteBuffersDirectory()) {
            var index = new TextIndexLucene(directory, config);
            try { assertThrows(IllegalArgumentException.class, () -> TextEntityDocuments.replace(index, scope("body"), List.of(row("unstored", "en")))); }
            finally { index.close(); config.getAnalyzer().close(); }
        }
    }

    @Test(timeout = 90_000) public void canonicalReceiptIdentityReadsTypedMultilingualBodiesInTheNativeCommittedWriter() throws Exception {
        Files.createDirectories(java.nio.file.Path.of(".temp"));
        var root = Files.createTempDirectory(java.nio.file.Path.of(".temp"), "text-body-identity-");
        var config = config(true);
        var index = new TextIndexLucene(FSDirectory.open(root.resolve("lucene")), config);
        var storage = TDB2Factory.connectDataset(root.resolve("tdb2").toString()).asDatasetGraph();
        var filtered = new FilteredGraphTextIndex(index);
        var data = new DatasetGraphText(storage, filtered, new TextDocProducerTriples(filtered), true);
        var literals = List.of(NodeFactory.createLiteralLang("魔法禁書目錄 alpha β🙂", "zh-Hant"),
            NodeFactory.createLiteralLang("Latin ć", "sr-Latn"), NodeFactory.createLiteralLang("مرحبا", "ar"),
            NodeFactory.createLiteralLang("RUST", "en-US"), NodeFactory.createLiteralDT("01", XSDDatatype.XSDinteger),
            NodeFactory.createLiteralDT("01", TypeMapper.getInstance().getSafeTypeByName("urn:rezics:datatype:code")),
            NodeFactory.createLiteralString("01"));
        var identities = new java.util.HashSet<String>();
        try {
            for (Node literal : literals) {
                String identity = TextEntityDocuments.bodyIdentity(scope("body"), literal);
                assertTrue(identities.add(identity));
                data.begin(ReadWrite.WRITE);
                try {
                    data.deleteAny(uri("urn:test:receipt"), uri(UNIT), uri(RV + "searchDeltaContentBodyDigest"), Node.ANY);
                    data.add(uri("urn:test:receipt"), uri(UNIT), uri(RV + "searchDeltaContentBodyDigest"), NodeFactory.createLiteralString(identity));
                    TextEntityDocuments.replaceRankedBody(index, scope("body"), List.of(new TextEntityDocuments.Row(literal, SOURCE)), UNIT, UNIT);
                    data.commit();
                } finally { data.end(); }
                TextEntityDocuments.verifyCommittedRankedIdentity(index, scope("body"), identity, SOURCE, literal.getLiteralLanguage(), UNIT, UNIT);
                assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommittedRankedIdentity(index, scope("body"),
                    "0".repeat(64), SOURCE, literal.getLiteralLanguage(), UNIT, UNIT));
                assertThrows(TextIndexException.class, () -> TextEntityDocuments.verifyCommittedRankedIdentity(index, scope("body"),
                    identity, source("urn:test:wrong-head", SOURCE.epoch()), literal.getLiteralLanguage(), UNIT, UNIT));
            }
            assertThrows(IllegalArgumentException.class, () -> TextEntityDocuments.bodyIdentity(scope("body"),
                NodeFactory.createLiteralString("x".repeat(TextEntityDocuments.MAX_CHARACTERS + 1))));
            assertThrows(IllegalArgumentException.class, () -> TextEntityDocuments.bodyIdentity(scope("body"), NodeFactory.createLiteralString("\uD800")));
            assertThrows(IllegalArgumentException.class, () -> TextEntityDocuments.bodyIdentity(scope("body"), NodeFactory.createLiteralLang("x", "a".repeat(101))));
            for (int i = 0; i < 256; i++) {
                Entity neighbor = new Entity("urn:test:unrelated:" + i, CommandPolicy.PUBLIC_SEARCH, "en", null);
                neighbor.put("publicTitle", "unrelated name"); index.addEntity(neighbor);
            }
            index.commit();
            String identity = TextEntityDocuments.bodyIdentity(scope("body"), literals.getLast());
            TextEntityDocuments.verifyCommittedRankedIdentity(index, scope("body"), identity, SOURCE, "", UNIT, UNIT);
            try (var reader = DirectoryReader.open(index.getDirectory())) { assertEquals(257, reader.numDocs()); }
            data.begin(ReadWrite.READ);
            try { assertFalse(data.contains(Node.ANY, uri(UNIT), uri(RV + "searchBody"), Node.ANY)); }
            finally { data.end(); }
        } finally {
            if (data.isInTransaction()) { data.abort(); data.end(); }
            data.close(); config.getAnalyzer().close(); org.apache.jena.tdb2.sys.TDBInternal.expel(storage);
            try (var paths = Files.walk(root)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }

    @Test public void sameTdb2JenaWriterCommitsAndAbortsExternalRowsWithoutPayloadQuads() throws Exception {
        Files.createDirectories(java.nio.file.Path.of(".temp"));
        var root = Files.createTempDirectory(java.nio.file.Path.of(".temp"), "text-entity-documents-");
        var config = config(true);
        try (var directory = FSDirectory.open(root.resolve("lucene"))) {
            var index = new TextIndexLucene(directory, config);
            var filtered = new FilteredGraphTextIndex(index);
            var data = new DatasetGraphText(TDB2Factory.connectDataset(root.resolve("tdb2").toString()).asDatasetGraph(),
                filtered, new TextDocProducerTriples(filtered), true);
            var oldRows = List.of(row("original", "en"));
            var nextRows = List.of(row("replacement", "en"));
            Node graph = uri("urn:rezics:owner:current"), owner = uri(UNIT), head = uri(RV + "head");
            try {
                data.begin(ReadWrite.WRITE);
                data.add(graph, owner, head, uri(SOURCE.head()));
                TextEntityDocuments.replace(index, scope("body"), oldRows); data.commit(); data.end();
                long committed = TextEntityDocuments.verifyCommitted(index, scope("body"), oldRows);
                data.begin(ReadWrite.WRITE);
                data.deleteAny(graph, owner, head, Node.ANY); data.add(graph, owner, head, uri("urn:rezics:head:next"));
                TextEntityDocuments.replace(index, scope("body"), nextRows);
                assertEquals(committed, TextEntityDocuments.verifyCommitted(index, scope("body"), oldRows));
                data.abort(); data.end();
                TextEntityDocuments.verifyCommitted(index, scope("body"), oldRows);
                data.begin(ReadWrite.READ);
                assertTrue(data.contains(graph, owner, head, uri(SOURCE.head())));
                assertFalse(data.contains(Node.ANY, owner, uri(RV + "searchBody"), Node.ANY)); data.end();
                data.begin(ReadWrite.WRITE);
                TextEntityDocuments.replace(index, scope("body"), nextRows); data.commit(); data.end();
                TextEntityDocuments.verifyCommitted(index, scope("body"), nextRows);
            } finally { if (data.isInTransaction()) { data.abort(); data.end(); } data.close(); config.getAnalyzer().close(); }
        }
        try (var paths = Files.walk(root)) {
            for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
        }
    }
}
