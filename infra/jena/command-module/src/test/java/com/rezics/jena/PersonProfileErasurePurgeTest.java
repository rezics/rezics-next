package com.rezics.jena;

import static org.junit.Assert.*;
import static com.rezics.jena.PersonProfileErasurePolicyTest.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.function.Consumer;
import org.apache.jena.graph.Node;
import org.apache.jena.query.Dataset;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class PersonProfileErasurePurgeTest {
    private static Path directory() throws Exception { return Files.createTempDirectory(Path.of(System.getProperty("java.io.tmpdir")), "person-purge-"); }
    private static void retainedPerson(DatasetGraph data) {
        data.deleteAny(CURRENT, PERSON, Node.ANY, Node.ANY);
        data.add(CURRENT, PERSON, RDF.type.asNode(), rv("AgentTombstone"));
        data.add(CURRENT, PERSON, rv("agentKind"), rv("PersonAgent"));
        data.add(CURRENT, PERSON, rv("erasureId"), text(ERASURE_ID));
        data.add(CURRENT, PERSON, rv("erasureEpoch"), integer("7"));
    }
    private static Set<Quad> source(Path path, Consumer<DatasetGraph> mutation) {
        Dataset data = TDB2Factory.connectDataset(path.toString()); data.begin(ReadWrite.WRITE);
        try {
            fixture().find().forEachRemaining(data.asDatasetGraph()::add);
            retainedPerson(data.asDatasetGraph()); mutation.accept(data.asDatasetGraph());
            Set<Quad> result = snapshot(data.asDatasetGraph()); data.commit(); return result;
        } finally { data.end(); data.close(); }
    }
    private static void purge(Path source, Path destination, Node target, String epoch) throws Exception {
        ErasurePurge.main(new String[]{source.toString(), destination.toString(), target.getURI(), epoch});
    }
    private static void denied(Consumer<DatasetGraph> mutation, Node target, String epoch) throws Exception {
        Path base = directory(), source = base.resolve("source"), destination = base.resolve("destination");
        Set<Quad> before = source(source, mutation);
        assertThrows(IllegalArgumentException.class, () -> purge(source, destination, target, epoch));
        assertFalse("refusal cannot publish a partial destination", Files.exists(destination));
        Dataset original = TDB2Factory.connectDataset(source.toString()); original.begin(ReadWrite.READ);
        try { assertEquals(before, snapshot(original.asDatasetGraph())); } finally { original.end(); original.close(); }
    }
    @Test public void retainedPersonPurgeScrubsOnlyItsProfileAndExactGraphDocuments() throws Exception {
        Path base = directory(), source = base.resolve("source"), destination = base.resolve("destination");
        Set<Quad> before = source(source, data -> {
            data.add(CURRENT, PERSON, rv("profileBio"), text("Replanted identifying biography"));
            data.add(CURRENT, PERSON, uri("https://schema.org/name"), text("Replanted identifying name"));
        });
        purge(source, destination, PERSON, "7");
        Dataset output = TDB2Factory.connectDataset(destination.toString()); output.begin(ReadWrite.READ);
        try {
            var data = output.asDatasetGraph();
            assertTrue(ErasurePolicy.personTombstone(data, PERSON, text(ERASURE_ID), integer("7")));
            for (Node revision : Set.of(ANCHOR, PROFILE)) {
                assertTrue(data.contains(REVISIONS, revision, RDF.type.asNode(), rv("ErasedRevision")));
                assertTrue(data.contains(REVISIONS, revision, rv("erasureEpoch"), integer("7")));
                assertTrue(data.contains(REVISIONS, revision, rv("component"), PERSON));
                assertFalse(data.contains(REVISIONS, revision, rv("profileBio"), Node.ANY));
            }
            assertTrue(data.contains(REVISIONS, ANCHOR, rv("manifest"), Node.ANY));
            assertTrue(data.contains(REVISIONS, PROFILE, rv("predecessor"), ANCHOR));
            assertTrue(data.contains(CURRENT, CREDIT, rv("agent"), PERSON));
            assertTrue(data.contains(CURRENT, OTHER, rv("head"), ANCHOR));
            assertTrue(data.contains(PUBLIC, FOREIGN_UNIT, rv("resource"), WORK));
            assertTrue(data.contains(PRIVATE, UNIT, rv("resource"), WORK));
            assertFalse(data.contains(PUBLIC, UNIT, Node.ANY, Node.ANY));
        } finally { output.end(); output.close(); }
        Dataset original = TDB2Factory.connectDataset(source.toString()); original.begin(ReadWrite.READ);
        try { assertEquals(before, snapshot(original.asDatasetGraph())); } finally { original.end(); original.close(); }
    }
    @Test public void livePersonOrganizationAndWorkTargetsAreRefused() throws Exception {
        denied(data -> { data.deleteAny(CURRENT, PERSON, RDF.type.asNode(), Node.ANY); data.add(CURRENT, PERSON, RDF.type.asNode(), rv("Agent")); }, PERSON, "7");
        denied(data -> { data.deleteAny(CURRENT, PERSON, rv("agentKind"), Node.ANY); data.add(CURRENT, PERSON, rv("agentKind"), rv("OrganizationAgent")); }, PERSON, "7");
        denied(data -> {}, WORK, "7");
        denied(data -> {}, OTHER, "7");
    }
    @Test public void wrongOwnerAnotherPersonAndWrongRevisionKindRefuseTheWholeCampaign() throws Exception {
        denied(data -> { data.add(REVISIONS, ANCHOR, rv("component"), OTHER); }, PERSON, "7");
        denied(data -> { data.deleteAny(REVISIONS, ANCHOR, rv("component"), Node.ANY); data.add(REVISIONS, ANCHOR, rv("component"), OTHER); }, ANCHOR, "7");
        denied(data -> { data.add(REVISIONS, ANCHOR, RDF.type.asNode(), rv("WorkMetadataRevision")); }, PERSON, "7");
        denied(data -> data.add(REVISIONS, PROFILE, rv("component"), OTHER), PROFILE, "7");
        denied(data -> { data.deleteAny(REVISIONS, PROFILE, rv("component"), Node.ANY); data.add(REVISIONS, PROFILE, rv("component"), WORK); }, PROFILE, "7");
    }
    @Test public void suffixedProvisionAnchorRequiresItsExactModelAndOperation() throws Exception {
        denied(data -> { data.deleteAny(REVISIONS, ANCHOR, rv("operation"), Node.ANY); data.add(REVISIONS, ANCHOR, rv("operation"), uri("urn:rezics:operation:agent-provision:" + id(8))); }, ANCHOR, "7");
        denied(data -> { data.deleteAny(REVISIONS, ANCHOR, rv("modelRevision"), Node.ANY); }, ANCHOR, "7");
        denied(data -> data.add(REVISIONS, ANCHOR, RDF.type.asNode(), rv("AgentPublicProfileRevision")), ANCHOR, "7");
        Path base = directory(), source = base.resolve("source"), destination = base.resolve("destination");
        source(source, data -> {}); purge(source, destination, ANCHOR, "7");
        Dataset output = TDB2Factory.connectDataset(destination.toString()); output.begin(ReadWrite.READ);
        try {
            assertTrue(output.asDatasetGraph().contains(REVISIONS, ANCHOR, rv("component"), PERSON));
            assertFalse(output.asDatasetGraph().contains(REVISIONS, ANCHOR, rv("profileBio"), Node.ANY));
        } finally { output.end(); output.close(); }
    }
    @Test public void staleEpochAmbiguousIdentityAndMixedIndexOwnerAreRefused() throws Exception {
        denied(data -> {}, PERSON, "8");
        denied(data -> data.add(CURRENT, PERSON, rv("erasureId"), text(id(8))), PERSON, "7");
        denied(data -> data.add(PUBLIC, UNIT, rv("resource"), WORK), PERSON, "7");
        denied(data -> data.add(REVISIONS, PROFILE, rv("erasureEpoch"), integer("8")), PERSON, "7");
    }
    @Test public void revisionAndPersonCampaignsBothKeepForeignSameIriDocumentsInAnotherGraph() throws Exception {
        Path base = directory(), source = base.resolve("source"), destination = base.resolve("destination");
        Node revision = resource(19);
        source(source, data -> {
            data.add(REVISIONS, revision, RDF.type.asNode(), rv("RevisionAnchor"));
            data.add(REVISIONS, revision, rv("component"), WORK);
            data.deleteAny(PUBLIC, UNIT, Node.ANY, Node.ANY);
            data.add(PUBLIC, UNIT, rv("revision"), revision);
            data.add(PUBLIC, UNIT, rv("publicTitle"), text("Exact revision payload"));
        });
        purge(source, destination, revision, "7");
        Dataset output = TDB2Factory.connectDataset(destination.toString()); output.begin(ReadWrite.READ);
        try {
            assertFalse(output.asDatasetGraph().contains(PUBLIC, UNIT, Node.ANY, Node.ANY));
            assertTrue(output.asDatasetGraph().contains(PRIVATE, UNIT, rv("resource"), WORK));
            assertTrue(output.asDatasetGraph().contains(REVISIONS, PROFILE, rv("component"), PERSON));
        } finally { output.end(); output.close(); }
    }
    @Test public void sha256ProfileOperationPurgeRemovesAuthorPrefixesWithoutErasingTheWork() throws Exception {
        Path base = directory(), source = base.resolve("source"), destination = base.resolve("destination");
        Set<Quad> before = source(source, data -> {
            data.deleteAny(REVISIONS, PROFILE, rv("operation"), Node.ANY);
            data.add(REVISIONS, PROFILE, rv("operation"), uri("urn:rezics:operation:agent-profile:" + "ab".repeat(32)));
            authorPrefixes(data);
            data.add(PUBLIC, uri("urn:rezics:search:directory:prefix:detached"), rv("prefixAuthor"), PERSON);
            data.add(PUBLIC, uri("urn:rezics:search:directory:prefix:detached"), rv("publicTitle"), text("Exact identifying name"));
            data.add(PUBLIC, SHARED_PREFIX, rv("publicTitle"), text("Exact identifying name"));
        });
        purge(source, destination, PERSON, "7");
        Dataset output = TDB2Factory.connectDataset(destination.toString()); output.begin(ReadWrite.READ);
        try {
            var data = output.asDatasetGraph();
            assertFalse(data.contains(REVISIONS, PROFILE, rv("profileBio"), Node.ANY));
            assertTrue(data.contains(REVISIONS, PROFILE, rv("operation"), uri("urn:rezics:operation:agent-profile:" + "ab".repeat(32))));
            assertFalse(data.contains(PUBLIC, SOLO_PREFIX, Node.ANY, Node.ANY));
            assertFalse(data.contains(PUBLIC, uri("urn:rezics:search:directory:prefix:detached"), Node.ANY, Node.ANY));
            assertFalse(data.contains(PUBLIC, SHARED_PREFIX, rv("publicTitle"), text("Exact identifying name")));
            assertTrue(data.contains(PUBLIC, SHARED_PREFIX, rv("publicTitle"), text("rezicsprefixdirectory")));
            assertFalse(data.contains(PUBLIC, SHARED_PREFIX, rv("prefixAuthor"), PERSON));
            assertTrue(data.contains(PUBLIC, SHARED_PREFIX, rv("prefixAuthor"), OTHER));
            assertTrue(data.contains(PUBLIC, SHARED_PREFIX, rv("prefixWork"), WORK));
            assertTrue(data.contains(PUBLIC, FOREIGN_UNIT, rv("publicTitle"), text("Surviving Work")));
            assertTrue(data.contains(CURRENT, WORK, RDF.type.asNode(), uri("https://schema.org/CreativeWork")));
            assertTrue(data.contains(CURRENT, CREDIT, rv("agent"), PERSON));
        } finally { output.end(); output.close(); }
        Dataset original = TDB2Factory.connectDataset(source.toString()); original.begin(ReadWrite.READ);
        try { assertEquals(before, snapshot(original.asDatasetGraph())); } finally { original.end(); original.close(); }
    }

    @Test public void campaignErasingEveryCreditedAuthorDropsTheirSharedPrefix() throws Exception {
        Path base = directory(), source = base.resolve("source"), destination = base.resolve("destination");
        source(source, data -> {
            authorPrefixes(data);
            data.deleteAny(CURRENT, OTHER, Node.ANY, Node.ANY);
            data.add(CURRENT, OTHER, RDF.type.asNode(), rv("AgentTombstone"));
            data.add(CURRENT, OTHER, rv("agentKind"), rv("PersonAgent"));
            data.add(CURRENT, OTHER, rv("erasureId"), text(id(8)));
            data.add(CURRENT, OTHER, rv("erasureEpoch"), integer("7"));
        });
        Path campaign = base.resolve("campaign.tsv");
        Files.writeString(campaign, PERSON.getURI() + "\t7\n" + OTHER.getURI() + "\t7\n");
        ErasurePurge.main(new String[]{source.toString(), destination.toString(), "--campaign", campaign.toString()});
        Dataset output = TDB2Factory.connectDataset(destination.toString()); output.begin(ReadWrite.READ);
        try {
            var data = output.asDatasetGraph();
            assertFalse(data.contains(PUBLIC, SHARED_PREFIX, Node.ANY, Node.ANY));
            assertTrue(data.contains(PUBLIC, FOREIGN_UNIT, rv("publicTitle"), text("Surviving Work")));
            assertTrue(data.contains(CURRENT, CREDIT, rv("agent"), PERSON));
        } finally { output.end(); output.close(); }
    }

}
