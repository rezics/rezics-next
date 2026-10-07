package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import java.util.function.Supplier;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** The authored startup callback on a physical TDB2/Lucene store: a restore hold, of any value, is an
 * uncertain cut. The server can start for inspection, but Source qualification is never minted. */
public class CommandModuleStartupTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri(SlimCommandTest.RV + name); }
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), PRODUCT = uri("urn:rezics:dataset:product"),
        HOLD = p("restoreHold"), STATE = PublicNameProjection.REPAIR,
        CHECKPOINT = uri("urn:rezics:projection:semantic-source-basis"), QUALIFICATION = p("semanticSourceQualification"),
        RESOURCE = uri("https://rezics.com/id/00000000-0000-4000-8000-000000000001"),
        SCALAR = uri("https://schema.org/episodeNumber");
    private static final Node TRUE = NodeFactory.createLiteralByValue(true, XSDDatatype.XSDboolean),
        FALSE = NodeFactory.createLiteralByValue(false, XSDDatatype.XSDboolean);

    private static final class Fixture implements AutoCloseable {
        final DatasetGraphText data;
        Fixture() {
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", p("searchBody"));
            definition.set("publicTitle", p("publicTitle"));
            definition.set("label", uri("http://www.w3.org/2000/01/rdf-schema#label"));
            definition.setLangField("lang"); definition.setUidField("uid");
            var config = new TextIndexConfig(definition); config.setValueStored(true);
            var index = new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(), config));
            data = new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),
                index, new TextDocProducerTriples(index));
            index.bindRankData(data);
            var seed = SlimCommandTest.dataset();
            try {
                seed.begin(ReadWrite.READ);
                write(() -> {
                    var rows = seed.find();
                    try { rows.forEachRemaining(data::add); }
                    finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                    data.add(CONTROL, PRODUCT, p("textIndexGeneration"),
                        uri("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
                    SearchDeltaJournal.initialize(data); return null;
                });
                seed.end();
            } finally { seed.close(); }
        }
        <T> T write(Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T result = operation.get(); data.commit(); return result; }
            catch (RuntimeException | Error failure) { data.abort(); throw failure; }
            finally { if (data.isInTransaction()) data.end(); }
        }
        <T> T read(Supplier<T> operation) {
            data.begin(ReadWrite.READ);
            try { return operation.get(); } finally { data.end(); }
        }
        void hold(Node... values) { write(() -> { for (Node value : values) data.add(CONTROL, PRODUCT, HOLD, value); return null; }); }
        void releaseHolds() { write(() -> { data.deleteAny(CONTROL, PRODUCT, HOLD, Node.ANY); return null; }); }
        /** The exact qualification ticket, or null when none exists. */
        Node ticket() {
            return read(() -> {
                var rows = data.find(STATE, CHECKPOINT, QUALIFICATION, Node.ANY);
                try { return rows.hasNext() ? rows.next().getObject() : null; }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            });
        }
        int holds() {
            return read(() -> {
                int count = 0; var rows = data.find(CONTROL, PRODUCT, HOLD, Node.ANY);
                try { while (rows.hasNext()) { rows.next(); count++; } }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                return count;
            });
        }
        /** Source admission: the first thing a Source proof does is check the qualified lineage. */
        String admission() {
            return read(() -> {
                try { SemanticSourceBasis.proof(data, RESOURCE, SCALAR, Long.MAX_VALUE); return "admitted"; }
                catch (IllegalStateException refused) { return refused.getMessage(); }
            });
        }
        @Override public void close() { SearchDeltaJournal.stopRecovery(data); data.close(); }
    }

    /** Parse the authored endpoint configuration with Fuseki's own builder, binding it to this physical store,
     * then run the real startup callback. No listener lifecycle is needed. */
    private static void startup(Fixture fixture) {
        var model = org.apache.jena.riot.RDFDataMgr.loadModel("fuseki-text.ttl");
        String previous = System.getProperty("rezics.profiles");
        System.setProperty("rezics.profiles", "profiles");
        try {
            var module = new CommandModule();
            var service = model.listResourcesWithProperty(org.apache.jena.vocabulary.RDF.type,
                model.createResource("http://jena.apache.org/fuseki#Service")).nextResource();
            var dataset = service.getPropertyResourceValue(model.createProperty("http://jena.apache.org/fuseki#dataset"));
            var descriptions = new org.apache.jena.fuseki.build.DatasetDescriptionMap();
            descriptions.register(dataset.asNode(), fixture.data);
            var point = org.apache.jena.fuseki.build.FusekiConfig.buildDataAccessPoint(
                model.getGraph(), service.asNode(), descriptions);
            assertNotNull(point);
            assertSame(fixture.data, point.getDataService().getDataset());
            assertTrue("the authored configuration is the exclusive native writer",
                CommandService.deltaExclusive(point.getDataService()));
            module.configDataAccessPoint(point, model);
        } finally {
            if (previous == null) System.clearProperty("rezics.profiles");
            else System.setProperty("rezics.profiles", previous);
            model.close();
        }
    }

    @Test public void activeLineageWithoutAnyHoldQualifiesSourceAtStartup() {
        try (Fixture f = new Fixture()) {
            assertNull(f.ticket());
            startup(f);
            assertNotNull("startup mints the Source qualification", f.ticket());
            assertEquals(0, f.holds());
            // Past qualification, the proof reaches the Resource, which this fixture does not have.
            assertEquals("semantic source Resource is unavailable", f.admission());
        }
    }

    @Test public void everyKindOfRestoreHoldStartsForInspectionAndRefusesSourceAdmission() {
        List<Node[]> cases = List.of(
            new Node[] {TRUE},
            new Node[] {FALSE},
            new Node[] {NodeFactory.createLiteralString("true")},
            new Node[] {NodeFactory.createLiteralDT("maybe", XSDDatatype.XSDboolean)},
            new Node[] {NodeFactory.createLiteralByValue(1, XSDDatatype.XSDinteger)},
            new Node[] {uri("urn:rezics:test:hold")},
            new Node[] {FALSE, TRUE},
            new Node[] {FALSE, NodeFactory.createLiteralString("hold")});
        for (Node[] values : cases) try (Fixture f = new Fixture()) {
            f.hold(values);
            String label = java.util.Arrays.toString(values);
            startup(f);
            assertNull("no ticket is minted for " + label, f.ticket());
            assertEquals("inspection keeps every hold value for " + label, values.length, f.holds());
            assertEquals("lineage stays readable for inspection", "test", f.read(() ->
                f.data.find(CONTROL, PRODUCT, p("dataEpoch"), Node.ANY).next().getObject().getLiteralLexicalForm()));
            // One value is refused as held; competing values are refused as an ambiguous field.
            assertEquals(values.length == 1 ? "semantic source lineage is unavailable or held"
                : "semantic source field is ambiguous", f.admission());
        }
    }

    @Test public void holdThatIsNotTheProductControlFactDoesNotBlockQualification() {
        try (Fixture f = new Fixture()) {
            f.write(() -> {
                f.data.add(CONTROL, uri("urn:rezics:dataset:other"), HOLD, TRUE);
                f.data.add(uri(CommandPolicy.CURRENT), PRODUCT, HOLD, TRUE);
                f.data.add(CONTROL, PRODUCT, p("restoreHoldNote"), TRUE);
                return null;
            });
            startup(f);
            assertNotNull(f.ticket());
            assertEquals("semantic source Resource is unavailable", f.admission());
        }
    }

    @Test public void holdAfterQualificationNeverMintsOrRevivesATicketAndReleaseReQualifies() {
        try (Fixture f = new Fixture()) {
            startup(f);
            Node first = f.ticket();
            assertNotNull(first);
            f.hold(FALSE);
            startup(f);
            // Startup skips qualification exactly as for a held cut: the old ticket is neither replaced nor
            // accepted, because every Source proof still checks the hold.
            assertEquals(first, f.ticket());
            assertEquals("semantic source lineage is unavailable or held", f.admission());
            f.releaseHolds();
            startup(f);
            assertNotEquals("a released hold is qualified again by a fresh startup", first, f.ticket());
            assertEquals("semantic source Resource is unavailable", f.admission());
        }
    }
}
