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

    @Test public void exactInputDigestBoundRejectsMixedDuplicateAndInvalidPairs() throws Exception {
        String exact = row(2) + row(1);
        var parsed = ErasurePurge.campaign(exact.getBytes(StandardCharsets.US_ASCII));
        assertEquals(2, parsed.targets().size());
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
}
