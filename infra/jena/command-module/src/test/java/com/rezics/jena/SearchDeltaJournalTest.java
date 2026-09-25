package com.rezics.jena;

import static org.junit.Assert.*;

import java.util.List;
import java.util.Map;
import org.apache.jena.fuseki.server.DataService;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.jena.update.UpdateAction;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class SearchDeltaJournalTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = NodeFactory.createURI(CommandPolicy.CONTROL);
    private static final Node PRODUCT = NodeFactory.createURI("urn:rezics:dataset:product");
    private static final Node UNIT = NodeFactory.createURI("urn:rezics:match:test");
    private static final Node BODY = NodeFactory.createURI(RV + "searchBody");
    private static final Node MATCH = NodeFactory.createURI(RV + "MatchUnit");
    private static final Node LITERAL = NodeFactory.createLiteralLang("same selected body", "en");
    private static Node property(String name) { return NodeFactory.createURI(RV + name); }

    private static final class Fixture implements AutoCloseable {
        final TextIndexLucene index;
        final DatasetGraphText data;
        Fixture() {
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", BODY);
            definition.setLangField("lang");
            definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition);
            config.setValueStored(true);
            index = new TextIndexLucene(new ByteBuffersDirectory(), config);
            data = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), index,
                new TextDocProducerTriples(index));
            data.begin(ReadWrite.WRITE);
            try {
                data.add(CONTROL, PRODUCT, property("dataEpoch"), NodeFactory.createLiteralString("epoch"));
                data.add(CONTROL, PRODUCT, property("routingEpoch"), NodeFactory.createLiteralString("routing"));
                data.add(CONTROL, PRODUCT, property("sequence"), NodeFactory.createLiteralString("0"));
                data.add(CONTROL, PRODUCT, property("textIndexGeneration"),
                    NodeFactory.createURI("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
                SearchDeltaJournal.initialize(data);
                data.commit();
            } finally { data.end(); }
        }
        void sequence(String oldValue, String newValue) {
            data.delete(CONTROL, PRODUCT, property("sequence"), NodeFactory.createLiteralString(oldValue));
            data.add(CONTROL, PRODUCT, property("sequence"), NodeFactory.createLiteralString(newValue));
        }
        @Override public void close() { data.close(); index.close(); }
    }

    @Test public void actualBeforeAfterAndExactLuceneDocuments() {
        try (Fixture fixture = new Fixture()) {
            DatasetGraphText data = fixture.data;
            assertEquals(true, SearchDeltaJournal.proof(data, -1, 0).get("available"));
            data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(data);
                DatasetGraph observed = capture.observed();
                observed.add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                observed.add(PUBLIC, UNIT, BODY, LITERAL);
                fixture.sequence("0", "1");
                assertEquals(List.of(new SearchDeltaJournal.Change(UNIT.getURI(), false, true)),
                    capture.changes());
                SearchDeltaJournal.append(data, capture, 2);
                data.commit();
            } finally { data.end(); }
            Map<String, Object> first = SearchDeltaJournal.proof(data, 0, 2);
            assertEquals(true, first.get("available"));
            assertEquals("1", first.get("ordinal"));

            data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(data);
                DatasetGraph observed = capture.observed();
                observed.add(PUBLIC, UNIT, BODY, LITERAL); // no-op add is not a delta
                observed.delete(PUBLIC, UNIT, BODY, LITERAL);
                observed.add(PUBLIC, UNIT, BODY, LITERAL);
                fixture.sequence("1", "2");
                assertEquals(List.of(new SearchDeltaJournal.Change(UNIT.getURI(), true, true)),
                    capture.changes());
                SearchDeltaJournal.append(data, capture, 4);
                data.commit();
            } finally { data.end(); }
            assertEquals(true, SearchDeltaJournal.proof(data, 1, 4).get("available"));

            // Jena's TextIndex.get(uri) sees only the first document. The exact
            // reader must reject an extra document for the same unit and graph.
            Entity duplicate = new Entity(UNIT.getURI(), CommandPolicy.PUBLIC_SEARCH, "en", null);
            duplicate.put("body", LITERAL.getLiteralLexicalForm());
            fixture.index.addEntity(duplicate);
            fixture.index.commit();
            assertEquals(false, SearchDeltaJournal.proof(data, 1, 4).get("available"));
        }
    }

    @Test public void actualSubjectOverflowAndCallerClaimMismatchReject() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                DatasetGraph observed = capture.observed();
                for (int i = 0; i < SearchDeltaJournal.MAX_UNITS; i++)
                    observed.add(PUBLIC, NodeFactory.createURI("urn:rezics:match:" + i),
                        RDF.type.asNode(), MATCH);
                try {
                    observed.add(PUBLIC, NodeFactory.createURI("urn:rezics:match:overflow"),
                        RDF.type.asNode(), MATCH);
                    fail("actual 65th subject must reject before commit");
                } catch (IllegalArgumentException expected) {
                    assertTrue(expected.getMessage().contains("64 units"));
                }
                fixture.data.abort();
            } finally { fixture.data.end(); }
        }
        List<SearchDeltaJournal.Change> changed = List.of(
            new SearchDeltaJournal.Change("urn:rezics:match:old", true, false),
            new SearchDeltaJournal.Change("urn:rezics:match:new", false, true));
        assertTrue(SearchDeltaJournal.matchesClaim(changed, "urn:rezics:match:new"));
        assertFalse(SearchDeltaJournal.matchesClaim(changed, null));
        assertFalse(SearchDeltaJournal.matchesClaim(changed, "urn:rezics:match:extra"));
        assertFalse(SearchDeltaJournal.matchesClaim(List.of(
            new SearchDeltaJournal.Change("urn:rezics:match:new", false, true),
            new SearchDeltaJournal.Change("urn:rezics:match:extra", false, true)),
            "urn:rezics:match:new"));

        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                DatasetGraph observed = capture.observed();
                for (String id : List.of("urn:rezics:match:new", "urn:rezics:match:extra")) {
                    Node unit = NodeFactory.createURI(id);
                    observed.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    observed.add(PUBLIC, unit, BODY, LITERAL);
                }
                assertEquals(2, capture.changes().size());
                assertFalse(SearchDeltaJournal.matchesClaim(capture.changes(), "urn:rezics:match:new"));
                fixture.data.abort();
            } finally { fixture.data.end(); }
        }
    }

    @Test public void rollbackAndBoundedJournalFailClosed() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                capture.observed().add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                capture.observed().add(PUBLIC, UNIT, BODY, LITERAL);
                fixture.sequence("0", "1");
                SearchDeltaJournal.append(fixture.data, capture, 2);
                fixture.data.abort();
            } finally { fixture.data.end(); }
            assertEquals("0", SearchDeltaJournal.proof(fixture.data, -1, 2).get("ordinal"));
            assertFalse(fixture.data.contains(PUBLIC, UNIT, BODY, LITERAL));

            for (int i = 1; i <= SearchDeltaJournal.MAX_ENTRIES + 1; i++) {
                fixture.data.begin(ReadWrite.WRITE);
                try {
                    fixture.sequence(Integer.toString(i - 1), Integer.toString(i));
                    SearchDeltaJournal.append(fixture.data,
                        new SearchDeltaJournal.Capture(fixture.data), i * 2L);
                    fixture.data.commit();
                } finally { fixture.data.end(); }
            }
            assertEquals(false, SearchDeltaJournal.proof(fixture.data, 0,
                (SearchDeltaJournal.MAX_ENTRIES + 1) * 2L).get("available"));
            assertEquals(true, SearchDeltaJournal.proof(fixture.data, 1,
                (SearchDeltaJournal.MAX_ENTRIES + 1) * 2L).get("available"));
        }
    }

    @Test public void variableSubjectUpdateCannotExceedActualUnitCap() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                for (int i = 0; i <= SearchDeltaJournal.MAX_UNITS; i++) {
                    Node unit = NodeFactory.createURI("urn:rezics:match:variable:" + i);
                    fixture.data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    fixture.data.add(PUBLIC, unit, BODY, LITERAL);
                }
                fixture.data.commit();
            } finally { fixture.data.end(); }
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                try {
                    UpdateAction.parseExecute("DELETE { GRAPH <" + CommandPolicy.PUBLIC_SEARCH + "> {"
                        + " ?unit <" + RV + "searchBody> ?body } } WHERE { GRAPH <"
                        + CommandPolicy.PUBLIC_SEARCH + "> { ?unit <" + RV
                        + "searchBody> ?body } }", DatasetFactory.wrap(capture.observed()));
                    fail("variable template touched more than 64 actual subjects");
                } catch (IllegalArgumentException expected) {
                    assertTrue(expected.getMessage().contains("64 units"));
                }
                fixture.data.abort();
            } finally { fixture.data.end(); }
            assertTrue(fixture.data.contains(PUBLIC,
                NodeFactory.createURI("urn:rezics:match:variable:64"), BODY, LITERAL));
        }
    }

    @Test public void onlyQueryAndNativeCommandAdmitDeltaReplay() {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        Operation command = Operation.alloc("https://rezics.com/fuseki/command", "command", "native command");
        DataService product = DataService.newBuilder(data)
            .addEndpoint(Operation.Query).addEndpoint(command).build();
        assertTrue(CommandService.deltaExclusive(product));
        for (Operation bypass : List.of(Operation.Update, Operation.GSP_RW,
            Operation.GSP_Direct_RW, Operation.Upload, Operation.Patch,
            Operation.alloc("urn:rezics:unknown-writer", "unknown", "unknown"))) {
            DataService qa = DataService.newBuilder(data)
                .addEndpoint(Operation.Query).addEndpoint(command).addEndpoint(bypass).build();
            assertFalse("bypass operation " + bypass, CommandService.deltaExclusive(qa));
        }
    }
}
