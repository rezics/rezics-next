package com.rezics.jena;

import static org.junit.Assert.*;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Startup qualification names why it refused, and never writes a document body into that line. */
public class SearchDeltaJournalStartupTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String GENERATION = "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111";
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = NodeFactory.createURI(CommandPolicy.CONTROL);
    private static final Node PRODUCT = NodeFactory.createURI("urn:rezics:dataset:product");
    private static final Node UNIT = NodeFactory.createURI("urn:rezics:match:test");
    private static final Node ANCHOR = NodeFactory.createURI(CommandPolicy.PUBLIC_ANCHOR);
    private static final Node BODY = NodeFactory.createURI(RV + "searchBody");
    private static final Node MATCH = NodeFactory.createURI(RV + "MatchUnit");
    private static final String RDF_BODY = "alpha-body-must-stay-out-of-the-log";
    private static final String INDEX_BODY = "beta-body-must-stay-out-of-the-log";

    private static Node property(String name) { return NodeFactory.createURI(RV + name); }
    private static Node integer(String value) {
        return NodeFactory.createLiteralByValue(new BigInteger(value), XSDDatatype.XSDinteger);
    }

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
            data = new DatasetGraphText(org.apache.jena.sparql.core.DatasetGraphFactory.createTxnMem(), index,
                new TextDocProducerTriples(index));
            data.begin(ReadWrite.WRITE);
            try {
                data.add(CONTROL, PRODUCT, property("dataEpoch"), NodeFactory.createLiteralString("epoch"));
                data.add(CONTROL, PRODUCT, property("routingEpoch"), NodeFactory.createLiteralString("routing"));
                data.add(CONTROL, PRODUCT, property("sequence"), integer("0"));
                data.add(CONTROL, PRODUCT, property("textIndexGeneration"), NodeFactory.createURI(GENERATION));
                SearchDeltaJournal.initialize(data);
                data.commit();
            } finally { data.end(); }
        }
        void anchor() {
            data.begin(ReadWrite.WRITE);
            try {
                data.add(PUBLIC, ANCHOR, RDF.type.asNode(), property("SearchGraphAnchor"));
                data.commit();
            } finally { data.end(); }
        }
        @Override public void close() { data.close(); index.close(); }
    }

    private List<String> capture() {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        SearchDeltaJournal.logged = lines::add;
        return lines;
    }
    private void release(org.apache.jena.sparql.core.DatasetGraph data) {
        SearchDeltaJournal.logged = null;
        SearchDeltaJournal.stopRecovery(data);
    }

    @Test public void absentAnchorNamesTheRefusalAndInstallsNoBaseline() {
        try (Fixture fixture = new Fixture()) {
            List<String> lines = capture();
            try {
                assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.contains("startup-audit failed: public anchor absent"));
                assertTrue(lines.contains("journal invalidated: startup audit returned no baseline [qualify]"));
                assertFalse(lines.stream().anyMatch(line -> line.startsWith("search journal baseline installed:")));
                assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            } finally { release(fixture.data); }
        }
    }

    @Test public void bodyMismatchNamesTheSubjectAndOmitsBothBodies() {
        try (Fixture fixture = new Fixture()) {
            fixture.anchor();
            // Write RDF under the text wrapper so the producer does not index the real body.
            var base = ((org.apache.jena.sparql.core.DatasetGraphWrapper) fixture.data).getWrapped();
            base.begin(ReadWrite.WRITE);
            try {
                base.add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                base.add(PUBLIC, UNIT, BODY, NodeFactory.createLiteralLang(RDF_BODY, "en"));
                base.commit();
            } finally { base.end(); }
            Entity stored = new Entity(UNIT.getURI(), CommandPolicy.PUBLIC_SEARCH, "en", null);
            stored.put("body", INDEX_BODY);
            fixture.index.addEntity(stored);
            fixture.index.commit();
            List<String> lines = capture();
            try {
                assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.contains(
                    "startup-audit failed: public index differs from RDF [" + UNIT.getURI() + "]"));
                assertFalse(lines.stream().anyMatch(line -> line.contains(RDF_BODY) || line.contains(INDEX_BODY)));
            } finally { release(fixture.data); }
        }
    }

    @Test public void qualifiedBaselineLogsEpochGenerationPopulationAndLuceneGeneration() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                var observed = capture.observed();
                observed.add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                observed.add(PUBLIC, UNIT, BODY, NodeFactory.createLiteralLang("same selected body", "en"));
                SearchDeltaJournal.append(fixture.data, capture, 2);
                fixture.data.commit();
            } finally { fixture.data.end(); }
            fixture.anchor();
            List<String> lines = capture();
            try {
                assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.stream().anyMatch(line -> line.matches(
                    "search journal baseline installed: epoch=epoch generation=" + GENERATION
                        + " population=1 luceneGeneration=[0-9]+")));
                assertEquals(true, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            } finally { release(fixture.data); }
        }
    }

    @Test public void directInvalidationNamesItsCaller() {
        try (Fixture fixture = new Fixture()) {
            List<String> lines = capture();
            try {
                SearchDeltaJournal.invalidate(fixture.data);
                assertTrue(lines.contains("journal invalidated: qualification withdrawn ["
                    + "SearchDeltaJournalStartupTest.directInvalidationNamesItsCaller]"));
            } finally { release(fixture.data); }
        }
    }

}
