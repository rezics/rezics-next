package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.Dataset;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class ErasurePurgeCampaignTest {
    private static final Node REVISIONS = iri(CommandPolicy.REVISIONS);
    private static final Node PUBLIC = iri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node PRIVATE = iri(CommandPolicy.PRIVATE_SEARCH);
    private static final Node EPOCH = rv("erasureEpoch");
    private static Node iri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String value) { return iri("https://rezics.com/vocab/" + value); }
    private static String target(int n) { return "urn:rezics:content:revision:00000000-0000-4000-8000-" + String.format("%012d", n); }
    private static String row(int n) { return target(n) + "\t" + n + "\n"; }
    private static Set<Quad> quads(Dataset dataset) {
        Set<Quad> result = new HashSet<>();
        dataset.asDatasetGraph().find().forEachRemaining(result::add);
        return result;
    }
    private static Path directory() throws Exception { return Files.createTempDirectory(Path.of(System.getProperty("java.io.tmpdir")), "campaign-"); }

    @Test public void purgedHomeCutDropsAllBindingDigestsAndRetainsTheSiteAndCutIdentity() throws Exception {
        Path base = directory(), sourcePath = base.resolve("source"), destPath = base.resolve("destination");
        String home = "https://rezics.com/id/00000000-0000-4000-8000-0000000000d1";
        Node cut = iri(home), page = iri("urn:home:document"), site = iri("urn:home:site");
        Dataset source = TDB2Factory.connectDataset(sourcePath.toString());
        source.begin(ReadWrite.WRITE);
        var graph = source.asDatasetGraph();
        graph.add(REVISIONS, cut, RDF.type.asNode(), rv("ZoneHomeRevision"));
        graph.add(REVISIONS, cut, rv("component"), page);
        graph.add(REVISIONS, cut, RDF.type.asNode(), rv("ErasedRevision"));
        graph.add(REVISIONS, cut, EPOCH, NodeFactory.createLiteralDT("4", org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        graph.add(iri(CommandPolicy.CURRENT), page, rv("homeDocumentHead"), cut);
        graph.add(REVISIONS, site, rv("homeRevision"), cut);
        graph.add(REVISIONS, site, rv("navigationRevision"), iri("urn:home:navigation"));
        for (int n = 1; n <= 2; n++) {
            Node binding = iri("urn:home:binding:" + n);
            graph.add(REVISIONS, cut, rv("publishedPage"), binding);
            graph.add(REVISIONS, binding, rv("contentRevision"), iri(target(n)));
            graph.add(REVISIONS, binding, rv("byteDigest"), NodeFactory.createLiteralString("digest-" + n));
            graph.add(REVISIONS, binding, rv("page"), page);
        }
        source.commit(); source.end(); source.close();
        ErasurePurge.main(new String[]{sourcePath.toString(), destPath.toString(), home, "4"});
        Dataset output = TDB2Factory.connectDataset(destPath.toString()); output.begin(ReadWrite.READ);
        var copied = output.asDatasetGraph();
        for (int n = 1; n <= 2; n++)
            assertFalse(copied.contains(Node.ANY, iri("urn:home:binding:" + n), Node.ANY, Node.ANY));
        assertTrue(copied.contains(REVISIONS, cut, RDF.type.asNode(), rv("ErasedRevision")));
        assertTrue(copied.contains(iri(CommandPolicy.CURRENT), page, rv("homeDocumentHead"), cut));
        assertTrue(copied.contains(REVISIONS, site, rv("homeRevision"), cut));
        assertTrue(copied.contains(REVISIONS, site, rv("navigationRevision"), iri("urn:home:navigation")));
        assertFalse(copied.contains(REVISIONS, cut, rv("component"), Node.ANY));
        output.end(); output.close();
    }

    @Test public void replacementHomeCutMayRetainOnlyItsOwnErasedPredecessorIdentity() {
        String old = "https://rezics.com/id/00000000-0000-4000-8000-0000000000d1";
        String next = "https://rezics.com/id/00000000-0000-4000-8000-0000000000d2";
        String page = "https://rezics.com/id/00000000-0000-4000-8000-0000000000d3";
        DatasetGraph graph = DatasetGraphFactory.createTxnMem();
        graph.add(REVISIONS, iri(old), RDF.type.asNode(), rv("ErasedRevision"));
        graph.add(iri(CommandPolicy.CURRENT), iri(page), rv("homeDocumentHead"), iri(old));
        String prefix = "PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH <" + CommandPolicy.REVISIONS + "> { <"
            + next + "> a rv:ZoneHomeRevision ; rv:component <" + page + "> ; ";
        for (String predicate : new String[]{"predecessor", "contentRevision", "publishedPage"}) {
            var request = org.apache.jena.update.UpdateFactory.create(prefix + "rv:" + predicate + " <" + old + "> . } }");
            var plan = new CommandPolicy.Plan(request, Set.of(CommandPolicy.REVISIONS), Set.of(), Set.of(next), Set.of(), false, false, false);
            String refusal = ErasurePolicy.preflight(graph, plan, "urn:rezics:receipt:home-publication");
            if (predicate.equals("predecessor")) assertNull(refusal);
            else assertEquals("erased exact revision cannot be reactivated", refusal);
        }
        graph.deleteAny(iri(CommandPolicy.CURRENT), iri(page), rv("homeDocumentHead"), Node.ANY);
        var request = org.apache.jena.update.UpdateFactory.create(prefix + "rv:predecessor <" + old + "> . } }");
        var plan = new CommandPolicy.Plan(request, Set.of(CommandPolicy.REVISIONS), Set.of(), Set.of(next), Set.of(), false, false, false);
        assertEquals("erased exact revision cannot be reactivated", ErasurePolicy.preflight(graph, plan, "urn:rezics:receipt:home-publication"));
        graph.close();
    }

    @Test public void erasedHomePredecessorIsRejectedWhenCurrentHeadNamesAnotherRevision() {
        DatasetGraph graph = DatasetGraphFactory.createTxnMem();
        String old = target(1), next = target(2), page = "urn:home:document";
        graph.add(REVISIONS, iri(old), RDF.type.asNode(), rv("ErasedRevision"));
        graph.add(REVISIONS, iri(target(3)), RDF.type.asNode(), rv("ZoneHomeRevision"));
        graph.add(iri(CommandPolicy.CURRENT), iri(page), rv("homeDocumentHead"), iri(target(3)));
        try {
            assertEquals("erased exact revision cannot be reactivated",
                erasedReferenceRefusal(graph, next, "a rv:ZoneHomeRevision ; rv:component <" + page
                    + "> ; rv:predecessor <" + old + "> ."));
        } finally { graph.close(); }
    }

    @Test public void erasedHomePredecessorIsRejectedForOtherTypedAndUntypedSubjects() {
        DatasetGraph graph = DatasetGraphFactory.createTxnMem();
        String old = target(1), next = target(2), page = "urn:home:document";
        graph.add(REVISIONS, iri(old), RDF.type.asNode(), rv("ErasedRevision"));
        graph.add(iri(CommandPolicy.CURRENT), iri(page), rv("homeDocumentHead"), iri(old));
        try {
            for (String type : new String[]{"a rv:RevisionAnchor ; ", ""}) {
                assertEquals("erased exact revision cannot be reactivated",
                    erasedReferenceRefusal(graph, next, type + "rv:component <" + page
                        + "> ; rv:predecessor <" + old + "> ."));
            }
        } finally { graph.close(); }
    }

    @Test public void erasedHomeRevisionIsRejectedAsObjectOfNonPredecessorPredicates() {
        DatasetGraph graph = DatasetGraphFactory.createTxnMem();
        String old = target(1), next = target(2), page = "urn:home:document";
        graph.add(REVISIONS, iri(old), RDF.type.asNode(), rv("ErasedRevision"));
        graph.add(iri(CommandPolicy.CURRENT), iri(page), rv("homeDocumentHead"), iri(old));
        try {
            for (String predicate : new String[]{"contentRevision", "publishedPage", "component", "homeRevision"}) {
                assertEquals(predicate, "erased exact revision cannot be reactivated",
                    erasedReferenceRefusal(graph, next, "a rv:ZoneHomeRevision ; rv:component <" + page
                        + "> ; rv:" + predicate + " <" + old + "> ."));
            }
        } finally { graph.close(); }
    }

    private static String erasedReferenceRefusal(DatasetGraph graph, String next, String fields) {
        var request = org.apache.jena.update.UpdateFactory.create(
            "PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH <" + CommandPolicy.REVISIONS
                + "> { <" + next + "> " + fields + " } }");
        var plan = new CommandPolicy.Plan(request, Set.of(CommandPolicy.REVISIONS), Set.of(), Set.of(next),
            Set.of(), false, false, false);
        return ErasurePolicy.preflight(graph, plan, "urn:rezics:receipt:home-publication");
    }

    @Test public void purgedNonHomeRevisionRetainsEveryPublishedPageBindingSubject() throws Exception {
        Path base = directory(), sourcePath = base.resolve("source"), destPath = base.resolve("destination");
        String exact = "https://rezics.com/id/00000000-0000-4000-8000-0000000000d1";
        Node revision = iri(exact);
        Set<Quad> bindings = new HashSet<>();
        Dataset source = TDB2Factory.connectDataset(sourcePath.toString());
        source.begin(ReadWrite.WRITE);
        try {
            var graph = source.asDatasetGraph();
            graph.add(REVISIONS, revision, RDF.type.asNode(), rv("RevisionAnchor"));
            graph.add(REVISIONS, revision, RDF.type.asNode(), rv("ErasedRevision"));
            graph.add(REVISIONS, revision, EPOCH,
                NodeFactory.createLiteralDT("4", org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            for (int n = 1; n <= 2; n++) {
                Node binding = iri("urn:home:binding:" + n);
                graph.add(REVISIONS, revision, rv("publishedPage"), binding);
                bindings.add(new Quad(REVISIONS, binding, rv("contentRevision"), iri(target(n + 1))));
                bindings.add(new Quad(REVISIONS, binding, rv("byteDigest"), NodeFactory.createLiteralString("digest-" + n)));
                bindings.add(new Quad(iri(CommandPolicy.CURRENT), binding, rv("page"), iri("urn:home:document")));
            }
            bindings.forEach(graph::add);
            source.commit();
        } finally { source.end(); source.close(); }
        ErasurePurge.main(new String[]{sourcePath.toString(), destPath.toString(), exact, "4"});
        Dataset output = TDB2Factory.connectDataset(destPath.toString());
        output.begin(ReadWrite.READ);
        try {
            var copied = output.asDatasetGraph();
            Set<Quad> retainedBindings = new HashSet<>();
            for (int n = 1; n <= 2; n++)
                copied.find(Node.ANY, iri("urn:home:binding:" + n), Node.ANY, Node.ANY).forEachRemaining(retainedBindings::add);
            assertEquals(bindings, retainedBindings);
            assertTrue(copied.contains(REVISIONS, revision, RDF.type.asNode(), rv("ErasedRevision")));
            assertFalse(copied.contains(REVISIONS, revision, rv("publishedPage"), Node.ANY));
        } finally { output.end(); output.close(); }
    }

    @Test public void exactInputDigestBoundRejectsMixedDuplicateAndInvalidPairs() throws Exception {
        String exact = row(2) + row(1);
        var parsed = ErasurePurge.campaign(exact.getBytes(StandardCharsets.US_ASCII));
        assertEquals(2, parsed.targets().size());
        String iri = "https://rezics.com/id/00000000-0000-4000-8000-000000000002\t7\n";
        assertEquals(1, ErasurePurge.campaign(iri.getBytes(StandardCharsets.US_ASCII)).targets().size());
        assertThrows(IllegalArgumentException.class, () -> ErasurePurge.campaign(
            "https://rezics.com/id/not-a-uuid\t7\n".getBytes(StandardCharsets.US_ASCII)));
        assertNotEquals(parsed.sha256(), ErasurePurge.campaign((row(1) + row(2)).getBytes(StandardCharsets.US_ASCII)).sha256());
        for (String input : new String[]{"", row(1) + row(1), row(1) + target(1) + "\t2\n",
            row(1) + "\n" + row(2), row(1).stripTrailing(), row(1).replace("\n", "\r\n"),
            row(1).replace("\t1", "\t0"), row(1).replace("\t1", "\t01"),
            row(1).replace("\t1", "\t10000000000000000000"), row(1).replace("content:revision", "work:revision"),
            row(1) + "# comment\n", row(1) + "é\t1\n"}) {
            assertThrows(input, IllegalArgumentException.class, () -> ErasurePurge.campaign(input.getBytes(StandardCharsets.UTF_8)));
        }
        StringBuilder max = new StringBuilder();
        for (int n = 1; n <= 64; n++) max.append(row(n));
        assertEquals(64, ErasurePurge.campaign(max.toString().getBytes(StandardCharsets.US_ASCII)).targets().size());
        max.append(row(65));
        assertThrows(IllegalArgumentException.class, () -> ErasurePurge.campaign(max.toString().getBytes(StandardCharsets.US_ASCII)));
    }

    @Test public void oneNativeCopyPreservesUnrelatedBytesPrefixesCustodyAndEveryExactEpochAndText() throws Exception {
        Path base = directory(), sourcePath = base.resolve("source"), destPath = base.resolve("destination");
        Dataset source = TDB2Factory.connectDataset(sourcePath.toString());
        source.begin(ReadWrite.WRITE);
        Set<Quad> retained = new HashSet<>();
        Set<Node> excluded = new HashSet<>();
        StringBuilder campaign = new StringBuilder();
        for (int n = 1; n <= 64; n++) {
            campaign.append(row(n));
            Node revision = iri(target(n)), projection = iri("urn:projection:" + n), unit = iri("urn:unit:" + n);
            excluded.add(projection); excluded.add(unit);
            Node graph = n % 2 == 0 ? PRIVATE : PUBLIC;
            source.asDatasetGraph().add(REVISIONS, projection, RDF.type.asNode(), rv(n % 2 == 0 ? "ContentPrivateProjection" : "ContentProjection"));
            source.asDatasetGraph().add(REVISIONS, projection, rv("contentRevision"), revision);
            source.asDatasetGraph().add(REVISIONS, projection, rv("matchUnit"), unit);
            source.asDatasetGraph().add(graph, unit, RDF.type.asNode(), rv("MatchUnit"));
            source.asDatasetGraph().add(graph, unit, rv("projection"), projection);
            source.asDatasetGraph().add(graph, unit, rv("revision"), revision);
            source.asDatasetGraph().add(graph, unit, rv(n % 2 == 0 ? "privateSearchBody" : "searchBody"), NodeFactory.createLiteralLang("forbidden campaign payload " + n, "en"));
            // Already suppressed targets keep their literal and cannot be renumbered.
            source.asDatasetGraph().add(REVISIONS, revision, RDF.type.asNode(), rv("ErasedRevision"));
            source.asDatasetGraph().add(REVISIONS, revision, EPOCH, NodeFactory.createLiteralDT(Integer.toString(n), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        }
        for (Node graph : new Node[]{PUBLIC, PRIVATE, REVISIONS, iri(CommandPolicy.CONTROL), iri(CommandPolicy.RECEIPTS), Quad.defaultGraphNodeGenerated}) {
            Quad keep = new Quad(graph, iri("urn:retained:" + graph), rv(graph.equals(PRIVATE) ? "privateSearchBody" : "searchBody"), NodeFactory.createLiteralLang("retained unrelated bytes 中文", "zh"));
            source.asDatasetGraph().add(keep);
            // TDB2 find() returns the default graph's canonical IRI.
            retained.add(keep.isDefaultGraph() ? new Quad(Quad.defaultGraphIRI,
                keep.getSubject(), keep.getPredicate(), keep.getObject()) : keep);
            source.asDatasetGraph().getGraph(graph).getPrefixMapping().setNsPrefix("kept", "https://retained.example/");
        }
        // Exact model/command/object and unrelated erasure custody survive byte-for-byte.
        for (String predicate : new String[]{"dataEpoch", "sequence", "requestDigest", "modelRevision", "byteDigest", "erasureEpoch"}) {
            Quad keep = new Quad(REVISIONS, iri("urn:unrelated:custody"), rv(predicate), NodeFactory.createLiteralString("exact-" + predicate));
            source.asDatasetGraph().add(keep); retained.add(keep);
        }
        String receipt = "urn:rezics:receipt:retained-custody";
        var proof = new CommandInvariant.CommitProof("a".repeat(64), "b".repeat(64), "retained-data-epoch", "71", "19");
        CommandInvariant.writeCommitProof(source.asDatasetGraph(), receipt, proof);
        source.asDatasetGraph().find(iri(CommandPolicy.RECEIPTS), iri(receipt), Node.ANY, Node.ANY).forEachRemaining(retained::add);
        source.commit(); source.end();
        source.begin(ReadWrite.READ); Set<Quad> before = quads(source); source.end(); source.close();
        Path input = base.resolve("campaign.tsv"); Files.writeString(input, campaign);
        ErasurePurge.main(new String[]{sourcePath.toString(), destPath.toString(), "--campaign", input.toString()});
        Dataset output = TDB2Factory.connectDataset(destPath.toString()); output.begin(ReadWrite.READ);
        Set<Quad> copied = quads(output);
        assertEquals(retained.size() + 128, copied.size());
        Set<Quad> missing = new HashSet<>(retained); missing.removeAll(copied);
        assertEquals("retained facts differ", Set.of(), missing);
        assertEquals(proof, CommandInvariant.commitProof(output.asDatasetGraph(), receipt));
        for (Quad quad : copied) { assertFalse(excluded.contains(quad.getSubject())); assertFalse(excluded.contains(quad.getObject())); }
        for (int n = 1; n <= 64; n++) {
            assertTrue(output.asDatasetGraph().contains(REVISIONS, iri(target(n)), EPOCH,
                NodeFactory.createLiteralDT(Integer.toString(n), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger)));
        }
        for (Node graph : new Node[]{PUBLIC, PRIVATE, REVISIONS, Quad.defaultGraphNodeGenerated})
            assertEquals("https://retained.example/", output.asDatasetGraph().getGraph(graph).getPrefixMapping().getNsPrefixURI("kept"));
        EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
        definition.set("publicBody", rv("searchBody")); definition.set("privateBody", rv("privateSearchBody"));
        definition.setLangField("lang"); definition.setUidField("uid");
        TextIndexConfig config = new TextIndexConfig(definition); config.setValueStored(true);
        TextIndexLucene index = new TextIndexLucene(new ByteBuffersDirectory(), config);
        var filtered = new FilteredGraphTextIndex(index);
        var indexed = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), filtered, new TextDocProducerTriples(filtered));
        try {
            indexed.begin(ReadWrite.WRITE); copied.forEach(indexed::add); indexed.commit(); indexed.end();
            assertTrue(filtered.query(rv("searchBody"), "forbidden", PUBLIC.getURI(), null, 100).isEmpty());
            assertTrue(filtered.query(rv("privateSearchBody"), "forbidden", PRIVATE.getURI(), null, 100).isEmpty());
            assertEquals(1, filtered.query(rv("searchBody"), "retained", PUBLIC.getURI(), null, 100).size());
            assertEquals(1, filtered.query(rv("privateSearchBody"), "retained", PRIVATE.getURI(), null, 100).size());
        } finally { indexed.close(); index.close(); }
        output.end(); output.close();
        source = TDB2Factory.connectDataset(sourcePath.toString()); source.begin(ReadWrite.READ);
        assertEquals(before, quads(source)); source.end(); source.close();
    }

    @Test public void missingOrStaleTargetDeniesWholeCampaignBeforeDestinationExists() throws Exception {
        Path base = directory(), sourcePath = base.resolve("source");
        Dataset source = TDB2Factory.connectDataset(sourcePath.toString()); source.begin(ReadWrite.WRITE);
        source.asDatasetGraph().add(REVISIONS, iri(target(1)), RDF.type.asNode(), rv("ErasedRevision"));
        source.asDatasetGraph().add(REVISIONS, iri(target(1)), EPOCH, NodeFactory.createLiteralDT("1", org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        source.commit(); source.end(); source.close();
        int i = 0;
        for (String input : new String[]{row(1) + row(2), target(1) + "\t2\n"}) {
            Path file = base.resolve("invalid.tsv"), dest = base.resolve("denied-" + i++); Files.writeString(file, input);
            assertThrows(IllegalArgumentException.class, () -> ErasurePurge.main(new String[]{sourcePath.toString(), dest.toString(), "--campaign", file.toString()}));
            assertFalse(Files.exists(dest));
        }
        Path single = base.resolve("single");
        ErasurePurge.main(new String[]{sourcePath.toString(), single.toString(), target(1), "1"});
        assertTrue(Files.exists(single));
        Path alias = base.resolve("source-alias"); Files.createSymbolicLink(alias, sourcePath);
        assertThrows(IllegalArgumentException.class, () -> ErasurePurge.main(new String[]{sourcePath.toString(), alias.resolve("nested").toString(), target(1), "1"}));
        for (int corruption = 0; corruption < 4; corruption++) {
            source = TDB2Factory.connectDataset(sourcePath.toString()); source.begin(ReadWrite.WRITE);
            var graph = source.asDatasetGraph(); Node revision = iri(target(1));
            graph.deleteAny(REVISIONS, revision, Node.ANY, Node.ANY);
            if (corruption != 3) graph.add(REVISIONS, revision, RDF.type.asNode(), rv("ErasedRevision"));
            if (corruption != 2) graph.add(REVISIONS, revision, EPOCH, corruption == 0
                ? NodeFactory.createLiteralString("1")
                : NodeFactory.createLiteralDT("1", org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            if (corruption == 1) graph.add(REVISIONS, revision, EPOCH,
                NodeFactory.createLiteralDT("2", org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            source.commit(); source.end(); source.close();
            Path denied = base.resolve("corrupt-" + corruption);
            assertThrows(IllegalArgumentException.class, () -> ErasurePurge.main(new String[]{sourcePath.toString(), denied.toString(), target(1), "1"}));
            assertFalse(Files.exists(denied));
        }
    }

    @Test public void middleRevisionPurgeLeavesTheOtherRevisionsAndCurrentPointers() throws Exception {
        Work work = work();
        Dataset output = TDB2Factory.connectDataset(work.destination.toString());
        output.begin(ReadWrite.READ);
        try {
            assertEquals(work.expected, quads(output));
            assertFalse(output.asDatasetGraph().contains(REVISIONS, iri(work.middle), rv("label"), NodeFactory.createLiteralString("two")));
            assertTrue(output.asDatasetGraph().contains(REVISIONS, iri(work.first), rv("label"), NodeFactory.createLiteralString("one")));
            assertTrue(output.asDatasetGraph().contains(REVISIONS, iri(work.last), rv("predecessor"), iri(work.middle)));
            assertTrue(output.asDatasetGraph().contains(iri(CommandPolicy.CURRENT), iri(work.work), rv("formerHead"), iri(work.middle)));
            assertTrue(output.asDatasetGraph().contains(iri(CommandPolicy.CURRENT), iri(work.work), rv("head"), iri(work.last)));
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("publicBody", rv("searchBody")); definition.set("privateBody", rv("privateSearchBody"));
            definition.setLangField("lang"); definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition); config.setValueStored(true);
            TextIndexLucene index = new TextIndexLucene(new ByteBuffersDirectory(), config);
            var filtered = new FilteredGraphTextIndex(index);
            var indexed = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), filtered, new TextDocProducerTriples(filtered));
            try {
                indexed.begin(ReadWrite.WRITE); quads(output).forEach(indexed::add); indexed.commit(); indexed.end();
                assertTrue(filtered.query(rv("searchBody"), "middle", PUBLIC.getURI(), null, 100).isEmpty());
                assertEquals(1, filtered.query(rv("searchBody"), "kept", PUBLIC.getURI(), null, 100).size());
                assertEquals(1, filtered.query(rv("privateSearchBody"), "latest", PRIVATE.getURI(), null, 100).size());
            } finally { indexed.close(); index.close(); }
        } finally { output.end(); output.close(); }
        Dataset source = TDB2Factory.connectDataset(work.source.toString());
        source.begin(ReadWrite.READ);
        try { assertEquals(work.before, quads(source)); }
        finally { source.end(); source.close(); }
    }

    @Test public void restoreDoesNotBringBackAPurgedRevisionPayload() throws Exception {
        Work work = work();
        Dataset restored = TDB2Factory.connectDataset(work.destination.toString());
        restored.begin(ReadWrite.READ);
        try {
            assertEquals(work.expected, quads(restored));
            assertFalse(restored.asDatasetGraph().contains(REVISIONS, iri(work.middle), rv("label"),
                NodeFactory.createLiteralString("two")));
        } finally { restored.end(); restored.close(); }
        String receipt = "urn:rezics:receipt:erasure-restore:" + "ab".repeat(32);
        IllegalArgumentException rejected = assertThrows(IllegalArgumentException.class,
            () -> CommandPolicy.parse(restoreUpdate(work.middle, receipt, true), receipt));
        assertTrue(rejected.getMessage(), rejected.getMessage().contains("tombstone"));
        assertNotNull(CommandPolicy.parse(restoreUpdate(work.middle, receipt, false), receipt));
    }

    private static String restoreUpdate(String revision, String receipt, boolean payload) {
        String extra = payload ? "<" + revision + "> <http://www.w3.org/2000/01/rdf-schema#label> \"two\" . " : "";
        return "DELETE { } INSERT { GRAPH <" + CommandPolicy.REVISIONS + "> { <" + revision
            + "> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://rezics.com/vocab/ErasedRevision> . <"
            + revision + "> <https://rezics.com/vocab/erasureEpoch> \"4\"^^<http://www.w3.org/2001/XMLSchema#integer> . "
            + extra + "} GRAPH <" + CommandPolicy.RECEIPTS + "> { <" + receipt
            + "> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://rezics.com/vocab/OperationReceipt> . } } WHERE { GRAPH <"
            + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> <https://rezics.com/vocab/dataEpoch> \"1\" . } }";
    }

    private record Work(Path source, Path destination, String work, String first, String middle, String last,
                        Set<Quad> before, Set<Quad> expected) {}

    private static Work work() throws Exception {
        String work = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b1";
        String first = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a1";
        String middle = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a2";
        String last = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a3";
        Path base = directory(), sourcePath = base.resolve("source"), destPath = base.resolve("destination");
        Dataset source = TDB2Factory.connectDataset(sourcePath.toString());
        source.begin(ReadWrite.WRITE);
        DatasetGraph graph = source.asDatasetGraph();
        Node current = iri(CommandPolicy.CURRENT);
        Node epoch = NodeFactory.createLiteralDT("4", org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger);
        graph.add(current, iri(work), RDF.type.asNode(), iri("https://schema.org/CreativeWork"));
        graph.add(current, iri(work), rv("head"), iri(last));
        graph.add(current, iri(work), rv("formerHead"), iri(middle));
        revision(graph, first, work, "one");
        revision(graph, middle, work, "two");
        graph.add(REVISIONS, iri(middle), RDF.type.asNode(), rv("ErasedRevision"));
        graph.add(REVISIONS, iri(middle), EPOCH, epoch);
        revision(graph, last, work, "three");
        graph.add(REVISIONS, iri(last), rv("predecessor"), iri(middle));
        graph.add(REVISIONS, iri("urn:rezics:other"), rv("note"), NodeFactory.createLiteralString("untouched"));
        Node gone = iri("urn:rezics:search:gone");
        text(graph, PUBLIC, iri("urn:rezics:search:kept"), first, "kept-secret", "searchBody");
        text(graph, PUBLIC, gone, middle, "middle-secret", "searchBody");
        text(graph, PRIVATE, iri("urn:rezics:search:last"), last, "latest-secret", "privateSearchBody");
        source.commit(); source.end();
        source.begin(ReadWrite.READ);
        Set<Quad> before = quads(source);
        source.end(); source.close();
        ErasurePurge.main(new String[]{sourcePath.toString(), destPath.toString(), middle, "4"});
        Set<Quad> expected = new HashSet<>();
        for (Quad quad : before) {
            boolean ownRevision = REVISIONS.equals(quad.getGraph()) && iri(middle).equals(quad.getSubject());
            boolean ownText = PUBLIC.equals(quad.getGraph()) && gone.equals(quad.getSubject());
            if (!ownRevision && !ownText) expected.add(quad);
        }
        expected.add(new Quad(REVISIONS, iri(middle), RDF.type.asNode(), rv("ErasedRevision")));
        expected.add(new Quad(REVISIONS, iri(middle), EPOCH, epoch));
        return new Work(sourcePath, destPath, work, first, middle, last, before, expected);
    }

    private static void revision(DatasetGraph graph, String revision, String work, String label) {
        graph.add(REVISIONS, iri(revision), RDF.type.asNode(), rv("RevisionAnchor"));
        graph.add(REVISIONS, iri(revision), rv("component"), iri(work));
        graph.add(REVISIONS, iri(revision), rv("label"), NodeFactory.createLiteralString(label));
    }

    private static void text(DatasetGraph graph, Node index, Node unit, String revision, String body, String predicate) {
        graph.add(index, unit, RDF.type.asNode(), rv("MatchUnit"));
        graph.add(index, unit, rv("revision"), iri(revision));
        graph.add(index, unit, rv(predicate), NodeFactory.createLiteralString(body));
    }
}
