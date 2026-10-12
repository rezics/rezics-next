package com.rezics.jena;

import static org.junit.Assert.*;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class ContentWithdrawalTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String VARIANT = "urn:test:content:variant";
    private static final String RESOURCE = "urn:test:content:work";
    private static final String PUBLICATION = "urn:test:content:publication";
    private static final String WITHDRAWAL = "urn:test:content:withdrawal";
    private static final String REPUBLICATION = "urn:test:content:republication";
    private static final String ELIGIBILITY = "urn:test:content:eligibility";
    private static final String PROJECTION = "urn:test:content:projection";
    private static final String RECEIPT = "urn:rezics:receipt:content:withdrawal";
    private static final String UNIT = "urn:rezics:content:match-unit:" + "a".repeat(64);
    private static final String REVISION = "urn:rezics:content:revision:00000000-0000-4000-8000-000000000001";
    private static final String EPOCH = "00000000-0000-4000-8000-000000000002";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static final Node PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = uri(CommandPolicy.CONTROL);
    private static final Node PRODUCT = uri("urn:rezics:dataset:product");
    private static final List<String> SOURCE_PINS = List.of("contentRevision", "contentPreparation",
        "byteDigest", "contentFormat", "contentModel", "contentLanguageKind", "contentLanguage",
        "contentDirection", "ownerDataEpoch", "ownerSequence");

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node integer(int value) {
        return NodeFactory.createLiteralByValue(BigInteger.valueOf(value), XSDDatatype.XSDinteger);
    }
    private static void put(DatasetGraph data, Node graph, String subject, String predicate, Node value) {
        data.deleteAny(graph, uri(subject), p(predicate), Node.ANY);
        data.add(graph, uri(subject), p(predicate), value);
    }
    private static Node value(DatasetGraph data, Node graph, String subject, String predicate) {
        var rows = data.find(graph, uri(subject), p(predicate), Node.ANY);
        try {
            assertTrue(rows.hasNext());
            Node found = rows.next().getObject();
            assertFalse(rows.hasNext());
            return found;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static void decision(DatasetGraph data, String id, boolean withdrawal) {
        data.add(REVISIONS, uri(id), RDF.type.asNode(), p(withdrawal
            ? "ContentWithdrawalDecision" : "ContentPublicationDecision"));
        data.add(REVISIONS, uri(id), RDF.type.asNode(), p("RevisionAnchor"));
        put(data, REVISIONS, id, "component", uri(VARIANT));
        put(data, REVISIONS, id, "resource", uri(RESOURCE));
        put(data, REVISIONS, id, "operation", uri("urn:rezics:operation:" + "c".repeat(64)));
        put(data, REVISIONS, id, "contentRevision", uri(REVISION));
        put(data, REVISIONS, id, "contentPreparation", text("prepared"));
        put(data, REVISIONS, id, "byteDigest", text("b".repeat(64)));
        put(data, REVISIONS, id, "contentFormat", text("rezics-content-json-v1"));
        put(data, REVISIONS, id, "contentModel", text("rezics-content-json-v1"));
        put(data, REVISIONS, id, "contentLanguageKind", text("tag"));
        put(data, REVISIONS, id, "contentLanguage", text("en"));
        put(data, REVISIONS, id, "contentDirection", text("ltr"));
        put(data, REVISIONS, id, "ownerDataEpoch", text(EPOCH));
        put(data, REVISIONS, id, "ownerSequence", text("1"));
        String profile = "https://rezics.com/definition/content-" + (withdrawal ? "withdrawal-v1" : "publication-v1");
        put(data, REVISIONS, id, "modelRevision", uri(profile));
        put(data, REVISIONS, id, "shapeRevision", uri(profile));
        put(data, REVISIONS, id, "datasetId", PRODUCT);
        put(data, REVISIONS, id, "dataEpoch", text(EPOCH));
        put(data, REVISIONS, id, "sequence", integer(2));
    }
    private static void receipt(DatasetGraph data, String selected) {
        data.add(RECEIPTS, uri(RECEIPT), RDF.type.asNode(), p("OperationReceipt"));
        put(data, RECEIPTS, RECEIPT, "publicationDecision", uri(selected));
        put(data, RECEIPTS, RECEIPT, "variant", uri(VARIANT));
        put(data, RECEIPTS, RECEIPT, "outcome", p("Succeeded"));
        for (String field : List.of("operation", "contentRevision", "contentPreparation", "resource", "byteDigest",
            "ownerDataEpoch", "ownerSequence", "datasetId", "dataEpoch", "sequence"))
            put(data, RECEIPTS, RECEIPT, field, value(data, REVISIONS, selected, field));
        if (WITHDRAWAL.equals(selected)) {
            put(data, RECEIPTS, RECEIPT, "predecessor", uri(PUBLICATION));
            put(data, RECEIPTS, RECEIPT, "expectedHead", uri(PUBLICATION));
        }
    }
    private static DatasetGraph published() {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(CURRENT, uri(VARIANT), RDF.type.asNode(), p("ContentVariant"));
            data.add(CURRENT, uri(RESOURCE), RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
            put(data, CURRENT, VARIANT, "resource", uri(RESOURCE));
            put(data, CURRENT, VARIANT, "contentPublicationHead", uri(PUBLICATION));
            put(data, CURRENT, VARIANT, "publicSearchEligibilityHead", uri(ELIGIBILITY));
            put(data, CONTROL, PRODUCT.getURI(), "dataEpoch", text(EPOCH));
            put(data, CONTROL, PRODUCT.getURI(), "routingEpoch", text("routing"));
            put(data, CONTROL, PRODUCT.getURI(), "sequence", integer(2));
            put(data, CONTROL, PRODUCT.getURI(), "textIndexGeneration",
                uri("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
            decision(data, PUBLICATION, false);
            data.add(REVISIONS, uri(ELIGIBILITY), RDF.type.asNode(), p("ContentSearchEligibilityDecision"));
            put(data, REVISIONS, ELIGIBILITY, "component", uri(VARIANT));
            put(data, REVISIONS, ELIGIBILITY, "variant", uri(VARIANT));
            put(data, REVISIONS, ELIGIBILITY, "resource", uri(RESOURCE));
            put(data, REVISIONS, ELIGIBILITY, "publicationDecision", uri(PUBLICATION));
            put(data, REVISIONS, ELIGIBILITY, "rightsBasis", p("OriginalContribution"));
            put(data, REVISIONS, ELIGIBILITY, "disclosure", p("Public"));
            put(data, REVISIONS, ELIGIBILITY, "admittedScope", text("content:search-eligibility:" + VARIANT));
            put(data, REVISIONS, ELIGIBILITY, "modelRevision",
                uri("https://rezics.com/definition/content-search-eligibility-v1"));
            data.commit();
        } finally { data.end(); }
        return data;
    }
    private static CommandPolicy.Plan withdrawalPlan() {
        return CommandPolicy.parse("""
            PREFIX rv: <https://rezics.com/vocab/>
            DELETE { GRAPH <urn:rezics:graph:current> { <%s> rv:contentPublicationHead ?previous } }
            INSERT {
              GRAPH <urn:rezics:graph:current> { <%s> rv:contentPublicationHead <%s> }
              GRAPH <urn:rezics:graph:revisions> { <%s> a rv:ContentWithdrawalDecision }
              GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt }
            }
            WHERE { OPTIONAL { GRAPH <urn:rezics:graph:current> { <%s> rv:contentPublicationHead ?previous } } }
            """.formatted(VARIANT, VARIANT, WITHDRAWAL, WITHDRAWAL, RECEIPT, VARIANT), RECEIPT);
    }
    private static Map<String, Node> withdraw(DatasetGraph data) {
        var plan = withdrawalPlan();
        var before = CommandService.contentPublicationHeadsBefore(data, plan);
        UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
        decision(data, WITHDRAWAL, true);
        put(data, REVISIONS, WITHDRAWAL, "predecessor", uri(PUBLICATION));
        receipt(data, WITHDRAWAL);
        return before;
    }
    private static String withdrawalFailure(DatasetGraph data, Map<String, Node> before) {
        return CommandService.contentPublicationLinks(data, RECEIPT, WITHDRAWAL, true, true, before);
    }
    private static CommandService.Validation focus(String profile, String subject, String shape, String graph) {
        return new CommandService.Validation(profile, null, "https://rezics.com/definition/" + profile + "/" + shape,
            List.of(subject), List.of(graph), Map.of());
    }
    @Test public void generatedWithdrawalShapeRequiresIriPredecessorAndFixedAnchorFields() {
        DatasetGraph data = published();
        data.begin(ReadWrite.WRITE);
        try {
            withdraw(data);
            ProfileRegistry profiles = SlimCommandTest.profiles();
            var profile = profiles.get("content-withdrawal-v1");
            assertNotNull(profile);
            var validation = new CommandService.Validation("content-withdrawal-v1", profile,
                "https://rezics.com/definition/content-withdrawal-v1/decision-shape",
                List.of(WITHDRAWAL), List.of(CommandPolicy.REVISIONS), Map.of());
            assertNull(CanonicalPolicy.validate(profiles, data, WITHDRAWAL, true));
            assertNull(CommandService.validateOne(data, validation));
            put(data, REVISIONS, WITHDRAWAL, "predecessor", text(PUBLICATION));
            assertNotNull(CommandService.validateOne(data, validation));
            put(data, REVISIONS, WITHDRAWAL, "predecessor", uri(PUBLICATION));
            for (String field : List.of("contentFormat", "modelRevision", "shapeRevision", "datasetId")) {
                Node retained = value(data, REVISIONS, WITHDRAWAL, field);
                data.deleteAny(REVISIONS, uri(WITHDRAWAL), p(field), Node.ANY);
                assertNotNull("fixed field must be present: " + field, CommandService.validateOne(data, validation));
                put(data, REVISIONS, WITHDRAWAL, field, retained);
            }
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void withdrawalIsItsOwnValidHeadAndRequiresItsOwnFocus() {
        DatasetGraph data = published();
        data.begin(ReadWrite.WRITE);
        try {
            assertTrue(CommandService.contentPublicationPublishable(data, uri(PUBLICATION)));
            assertNull(CommandService.contentEligibilityLinks(data, null, ELIGIBILITY, false));
            var before = withdraw(data);
            assertEquals(uri(PUBLICATION), before.get(VARIANT));
            assertNull(withdrawalFailure(data, before));
            assertNull(CommandService.contentPublicationLinks(data, RECEIPT, VARIANT, false, true, before));
            assertFalse(CommandService.contentPublicationPublishable(data, uri(WITHDRAWAL)));
            put(data, REVISIONS, ELIGIBILITY, "publicationDecision", uri(WITHDRAWAL));
            assertNotNull(CommandService.contentEligibilityLinks(data, null, ELIGIBILITY, false));
            for (var target : List.of(Map.entry(VARIANT, "variant-shape"), Map.entry(WITHDRAWAL, "decision-shape"))) {
                String graph = target.getKey().equals(VARIANT) ? CommandPolicy.CURRENT : CommandPolicy.REVISIONS;
                assertFalse(CommandService.hasContentFocus(data, List.of(), target.getKey(), target.getValue(), graph));
                assertFalse(CommandService.hasContentFocus(data, List.of(focus("content-publication-v1", target.getKey(),
                    target.getValue(), graph)), target.getKey(), target.getValue(), graph));
                assertTrue(CommandService.hasContentFocus(data, List.of(focus("content-withdrawal-v1", target.getKey(),
                    target.getValue(), graph)), target.getKey(), target.getValue(), graph));
                assertFalse(CommandService.hasContentFocus(data, List.of(focus("content-withdrawal-v1", target.getKey(),
                    "wrong-shape", graph)), target.getKey(), target.getValue(), graph));
                assertFalse(CommandService.hasContentFocus(data, List.of(focus("content-withdrawal-v1", target.getKey(),
                    target.getValue(), CommandPolicy.RECEIPTS)), target.getKey(), target.getValue(), graph));
            }
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void neverPublishedOrStalePredecessorCannotBeWithdrawn() {
        for (boolean absent : List.of(true, false)) {
            DatasetGraph data = published();
            data.begin(ReadWrite.WRITE);
            try {
                if (absent) data.deleteAny(CURRENT, uri(VARIANT), p("contentPublicationHead"), Node.ANY);
                else put(data, CURRENT, VARIANT, "contentPublicationHead", uri("urn:test:concurrent-publication"));
                var before = withdraw(data);
                assertNotNull(withdrawalFailure(data, before));
            } finally { data.abort(); data.end(); }
            data.begin(ReadWrite.READ);
            try {
                assertEquals(uri(PUBLICATION), value(data, CURRENT, VARIANT, "contentPublicationHead"));
                assertFalse(data.contains(REVISIONS, uri(WITHDRAWAL), Node.ANY, Node.ANY));
                assertFalse(data.contains(RECEIPTS, uri(RECEIPT), Node.ANY, Node.ANY));
            } finally { data.end(); data.close(); }
        }
    }

    @Test public void withdrawalMustRetainEverySourcePinAndReceiptPredecessor() {
        for (String field : SOURCE_PINS) {
            DatasetGraph data = published();
            data.begin(ReadWrite.WRITE);
            try {
                var before = withdraw(data);
                Node original = value(data, REVISIONS, WITHDRAWAL, field);
                put(data, REVISIONS, WITHDRAWAL, field, original.isURI() ? uri("urn:test:changed-source") : text("changed"));
                assertNotNull("changed retained pin: " + field, withdrawalFailure(data, before));
                data.deleteAny(REVISIONS, uri(WITHDRAWAL), p(field), Node.ANY);
                assertNotNull("missing retained pin: " + field, withdrawalFailure(data, before));
            } finally { data.abort(); data.end(); data.close(); }
        }
        for (String field : List.of("predecessor", "expectedHead")) {
            DatasetGraph data = published();
            data.begin(ReadWrite.WRITE);
            try {
                var before = withdraw(data);
                put(data, RECEIPTS, RECEIPT, field, uri("urn:test:stale-publication"));
                assertNotNull("receipt predecessor: " + field, withdrawalFailure(data, before));
            } finally { data.abort(); data.end(); data.close(); }
        }
    }

    @Test public void withdrawalPreservesAbsentLanguageAndCannotChooseAHistoricalPredecessor() {
        DatasetGraph data = published();
        data.begin(ReadWrite.WRITE);
        try {
            put(data, REVISIONS, PUBLICATION, "contentLanguageKind", text("missing"));
            data.deleteAny(REVISIONS, uri(PUBLICATION), p("contentLanguage"), Node.ANY);
            var before = withdraw(data);
            put(data, REVISIONS, WITHDRAWAL, "contentLanguageKind", text("missing"));
            data.deleteAny(REVISIONS, uri(WITHDRAWAL), p("contentLanguage"), Node.ANY);
            assertNull(withdrawalFailure(data, before));
            put(data, REVISIONS, WITHDRAWAL, "contentLanguage", text("en"));
            assertNotNull(withdrawalFailure(data, before));
            data.deleteAny(REVISIONS, uri(WITHDRAWAL), p("contentLanguage"), Node.ANY);
            decision(data, REPUBLICATION, false);
            put(data, REVISIONS, WITHDRAWAL, "predecessor", uri(REPUBLICATION));
            put(data, RECEIPTS, RECEIPT, "predecessor", uri(REPUBLICATION));
            put(data, RECEIPTS, RECEIPT, "expectedHead", uri(REPUBLICATION));
            assertNotNull(withdrawalFailure(data, before));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void dualTypedAndErasedPublicationDecisionsAreNotPublishable() {
        DatasetGraph data = published();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(REVISIONS, uri(PUBLICATION), RDF.type.asNode(), p("ContentWithdrawalDecision"));
            assertFalse(CommandService.contentPublicationPublishable(data, uri(PUBLICATION)));
            var before = withdraw(data);
            assertNotNull(withdrawalFailure(data, before));
            data.delete(REVISIONS, uri(PUBLICATION), RDF.type.asNode(), p("ContentWithdrawalDecision"));
            data.add(REVISIONS, uri(PUBLICATION), RDF.type.asNode(), p("ErasedRevision"));
            assertFalse(CommandService.contentPublicationPublishable(data, uri(PUBLICATION)));
            assertNotNull(withdrawalFailure(data, before));
            data.delete(REVISIONS, uri(PUBLICATION), RDF.type.asNode(), p("ErasedRevision"));
            data.add(REVISIONS, uri(WITHDRAWAL), RDF.type.asNode(), p("ContentPublicationDecision"));
            assertNotNull(withdrawalFailure(data, before));
        } finally { data.abort(); data.end(); data.close(); }
    }

    private static final class TextFixture implements AutoCloseable {
        final TextIndexLucene index;
        final DatasetGraphText data;
        TextFixture() {
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", p("searchBody"));
            definition.setLangField("lang");
            definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition);
            config.setValueStored(true);
            index = new TextIndexLucene(new ByteBuffersDirectory(), config);
            var filtered = new FilteredGraphTextIndex(index);
            data = new DatasetGraphText(published(), filtered, new TextDocProducerTriples(filtered), true);
            filtered.bindRankData(data);
            data.begin(ReadWrite.WRITE);
            try { SearchDeltaJournal.initialize(data); data.commit(); }
            finally { data.end(); }
        }
        void project(DatasetGraph target, String publication) {
            data.add(REVISIONS, uri(PROJECTION), RDF.type.asNode(), p("ContentProjection"));
            for (var pin : List.of(Map.entry("matchUnit", uri(UNIT)), Map.entry("component", uri(VARIANT)),
                Map.entry("resource", uri(RESOURCE)), Map.entry("contentRevision", uri(REVISION)),
                Map.entry("publicationDecision", uri(publication)), Map.entry("eligibility", uri(ELIGIBILITY)),
                Map.entry("modelRevision", uri("https://rezics.com/definition/content-match-unit-v1"))))
                put(data, REVISIONS, PROJECTION, pin.getKey(), pin.getValue());
            target.add(PUBLIC, uri(UNIT), RDF.type.asNode(), p("MatchUnit"));
            for (var pin : List.of(Map.entry("variant", uri(VARIANT)), Map.entry("resource", uri(RESOURCE)),
                Map.entry("revision", uri(REVISION)), Map.entry("publicationDecision", uri(publication)),
                Map.entry("eligibility", uri(ELIGIBILITY)), Map.entry("projection", uri(PROJECTION)),
                Map.entry("field", p("Body")), Map.entry("disclosure", p("Public")), Map.entry("language", text("en"))))
                target.add(PUBLIC, uri(UNIT), p(pin.getKey()), pin.getValue());
            target.add(PUBLIC, uri(UNIT), p("searchBody"), NodeFactory.createLiteralLang("published searchable source", "en"));
        }
        int documents() throws Exception {
            try (var reader = DirectoryReader.open(index.getDirectory())) {
                return new IndexSearcher(reader).count(new TermQuery(new Term("uri", UNIT)));
            }
        }
        @Override public void close() { data.close(); index.close(); }
    }

    @Test public void withdrawalExcludesBodyUntilNormalProjectionRemovalAndRepublicationRestoresIt() throws Exception {
        try (var f = new TextFixture()) {
            f.data.begin(ReadWrite.WRITE);
            try {
                var capture = new SearchDeltaJournal.Capture(f.data);
                f.project(capture.observed(), PUBLICATION);
                assertNotNull(FilteredGraphTextIndex.contentBodySource(f.data, UNIT));
                SearchDeltaJournal.append(f.data, capture, 2);
                f.data.commit();
            } finally { f.data.end(); }
            assertEquals(1, f.documents());

            f.data.begin(ReadWrite.WRITE);
            try {
                var before = withdraw(f.data);
                assertNull(withdrawalFailure(f.data, before));
                // Retained stale projection and a forged withdrawal-bound projection both fail closed.
                assertThrows(RuntimeException.class, () -> FilteredGraphTextIndex.contentBodySource(f.data, UNIT));
                put(f.data, PUBLIC, UNIT, "publicationDecision", uri(WITHDRAWAL));
                put(f.data, REVISIONS, ELIGIBILITY, "publicationDecision", uri(WITHDRAWAL));
                put(f.data, REVISIONS, PROJECTION, "publicationDecision", uri(WITHDRAWAL));
                assertThrows(RuntimeException.class, () -> FilteredGraphTextIndex.contentBodySource(f.data, UNIT));
                var capture = new SearchDeltaJournal.Capture(f.data);
                capture.observed().deleteAny(PUBLIC, uri(UNIT), Node.ANY, Node.ANY);
                assertEquals(List.of(new SearchDeltaJournal.Change(UNIT, true, false)), capture.changes());
                assertNull(FilteredGraphTextIndex.contentBodySource(f.data, UNIT));
                SearchDeltaJournal.append(f.data, capture, 4);
                f.data.commit();
            } finally { f.data.end(); }
            assertEquals(0, f.documents());
            f.data.begin(ReadWrite.READ);
            try { assertFalse(f.data.contains(PUBLIC, uri(UNIT), Node.ANY, Node.ANY)); }
            finally { f.data.end(); }

            f.data.begin(ReadWrite.WRITE);
            try {
                var before = CommandService.contentPublicationHeadsBefore(f.data, withdrawalPlan());
                decision(f.data, REPUBLICATION, false);
                put(f.data, CURRENT, VARIANT, "contentPublicationHead", uri(REPUBLICATION));
                receipt(f.data, REPUBLICATION);
                assertNull(CommandService.contentPublicationLinks(f.data, RECEIPT, REPUBLICATION, true, true, before));
                assertTrue(CommandService.contentPublicationPublishable(f.data, uri(REPUBLICATION)));
                put(f.data, REVISIONS, ELIGIBILITY, "publicationDecision", uri(REPUBLICATION));
                assertNull(CommandService.contentEligibilityLinks(f.data, null, ELIGIBILITY, false));
                var capture = new SearchDeltaJournal.Capture(f.data);
                f.project(capture.observed(), REPUBLICATION);
                assertNotNull(FilteredGraphTextIndex.contentBodySource(f.data, UNIT));
                assertEquals(List.of(new SearchDeltaJournal.Change(UNIT, false, true)), capture.changes());
                SearchDeltaJournal.append(f.data, capture, 6);
                f.data.commit();
            } finally { f.data.end(); }
            assertEquals(1, f.documents());
        }
    }
}
