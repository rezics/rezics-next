package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Triple;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.graph.GraphWrapper;
import org.apache.jena.util.iterator.ExtendedIterator;
import org.apache.jena.vocabulary.RDF;
import org.apache.jena.vocabulary.RDFS;
import org.junit.Test;

public class ModelMutationPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String ITEM = "urn:probe:item";
    private static final ProfileRegistry PROFILES = ProfileRegistry.load(
        Path.of("src/test/resources/registry-probe"));

    private static Node uri(String value) { return NodeFactory.createURI(value); }

    private static CommandPolicy.Plan plan() {
        return new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT), Set.of(ITEM),
            Set.of(), Set.of(), false, false, true);
    }

    private static DatasetGraph data() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        data.add(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), uri(RV + "RegistryProbe"));
        data.add(uri(CommandPolicy.CURRENT), uri(ITEM), uri(RV + "probeLabel"),
            NodeFactory.createLiteralString("probe"));
        return data;
    }

    private static String report(Map<String, Object> result) {
        assertEquals("invalid", result.get("status"));
        return String.valueOf(result.get("report"));
    }

    @Test public void model15PrestateRouteCannotFallThroughAfterSelectorDeletion() {
        DatasetGraph data = data();
        try {
            Node state = uri(RV + "probeState");
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), state, uri(RV + "Sealed"));
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), uri(RV + "sealedBy"), uri("urn:probe:actor"));
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            data.delete(uri(CommandPolicy.CURRENT), uri(ITEM), state, uri(RV + "Sealed"));
            assertEquals("prestate canonical selector changed: " + ITEM,
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void model16ReverseDependentsHaveAnExplicitBound() {
        DatasetGraph data = data();
        try {
            for (int i = 0; i < 4; i++) addDependent(data, i);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            assertNull(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before));
            for (int i = 4; i < 257; i++) addDependent(data, i);
            assertEquals("reverse dependency footprint exceeds 256",
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void model16UnknownHistoricalParentRejectsAChildTypeChange() {
        DatasetGraph data = data();
        try {
            Node secondary = uri(RV + "RegistryProbeRecord");
            Node parent = uri("urn:probe:historical-parent");
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), secondary);
            data.add(uri(CommandPolicy.REVISIONS), parent, RDF.type.asNode(), uri(RV + "RevisionAnchor"));
            data.add(uri(CommandPolicy.REVISIONS), parent, uri(RV + "item"), uri(ITEM));
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            data.delete(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), secondary);
            assertEquals("uncanonical reverse revision dependency requires staged lifecycle: " + parent.getURI(),
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void stableAgentProfileEditSkipsReverseDependents() {
        ProfileRegistry profiles = ProfileRegistry.load(Path.of("src/test/resources/agent-identity"));
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            String agent = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a1";
            Node node = uri(agent);
            data.add(uri(CommandPolicy.CURRENT), node, RDF.type.asNode(), uri(RV + "Agent"));
            data.add(uri(CommandPolicy.CURRENT), node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            data.add(uri(CommandPolicy.CURRENT), node, RDFS.label.asNode(), NodeFactory.createLiteralString("Old Name"));
            data.add(uri(CommandPolicy.CURRENT), node, uri(RV + "profileHandle"),
                NodeFactory.createLiteralString("agent-00000000-0000-4000-8000-0000000000a1"));
            data.add(uri(CommandPolicy.CURRENT), node, uri(RV + "profileDisclosure"), uri(RV + "Public"));
            for (int i = 0; i < 300; i++) data.add(uri(CommandPolicy.REVISIONS), uri("urn:probe:credit:" + i),
                uri(RV + "author"), node);
            CommandPolicy.Plan plan = new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS),
                Set.of(agent), Set.of(), Set.of(), false, false, true);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(profiles, data, plan);
            data.delete(uri(CommandPolicy.CURRENT), node, RDFS.label.asNode(), NodeFactory.createLiteralString("Old Name"));
            data.add(uri(CommandPolicy.CURRENT), node, RDFS.label.asNode(), NodeFactory.createLiteralString("New Name"));
            assertNull(ModelMutationPolicy.check(profiles, data, plan, "urn:rezics:receipt:agent-profile:probe", before));
            data.delete(uri(CommandPolicy.CURRENT), node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            String broken = report(ModelMutationPolicy.check(profiles, data, plan,
                "urn:rezics:receipt:agent-profile:probe", before));
            assertTrue(broken.contains(RV + "agentKind"));
            assertTrue(!broken.contains("reverse dependency footprint"));
        } finally { data.abort(); data.end(); }
    }

    @Test public void addressedAgentProfileUpgradeRequiresItsCasReceiptAndPreservesKind() {
        ProfileRegistry profiles = ProfileRegistry.load(Path.of("src/test/resources/agent-identity"));
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            String agent = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a1";
            String receipt = "urn:rezics:receipt:agent-profile:probe";
            Node node = uri(agent), prior = uri("urn:probe:prior"), revision = uri("urn:probe:next"), own = uri(receipt);
            Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS), receipts = uri(CommandPolicy.RECEIPTS);
            Node model = uri("https://rezics.com/definition/agent-profile-address-v1");
            data.add(current, node, RDF.type.asNode(), uri(RV + "Agent"));
            data.add(current, node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            data.add(current, node, uri(RV + "head"), prior);
            CommandPolicy.Plan plan = new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT),
                Set.of(agent), Set.of(), Set.of(), false, false, true);
            var before = ModelMutationPolicy.capture(profiles, data, plan).current().get(agent);
            data.add(current, node, uri(RV + "publicProfileHead"), revision);
            data.add(current, node, uri(RV + "profileNameFormat"), uri(RV + "PlainNameAddressV1"));
            data.add(current, node, uri(RV + "profileStateFormat"), uri(RV + "AddressedAgentProfileV1"));
            data.add(revisions, revision, uri(RV + "predecessor"), prior);
            data.add(revisions, revision, uri(RV + "component"), node);
            data.add(revisions, revision, uri(RV + "modelRevision"), model);
            data.add(revisions, revision, uri(RV + "shapeRevision"), model);
            data.add(receipts, own, RDF.type.asNode(), uri(RV + "OperationReceipt"));
            data.add(receipts, own, uri(RV + "agent"), node);
            data.add(receipts, own, uri(RV + "profileRevision"), revision);
            data.add(receipts, own, uri(RV + "outcome"), uri(RV + "Succeeded"));
            assertTrue(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, before));
            assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, "urn:probe:unrelated", agent, before));
            for (String field : new String[] { "predecessor", "component", "modelRevision", "shapeRevision" }) {
                Node value = field.equals("predecessor") ? prior : field.equals("component") ? node : model;
                data.delete(revisions, revision, uri(RV + field), value);
                assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, before));
                data.add(revisions, revision, uri(RV + field), value);
            }
            data.delete(current, node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            data.add(current, node, uri(RV + "agentKind"), uri(RV + "ServiceAgent"));
            assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, before));
            data.delete(current, node, uri(RV + "agentKind"), uri(RV + "ServiceAgent"));
            data.add(current, node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            var translated = new ModelMutationPolicy.Subject(before.graph(), before.selection(),
                Map.of(RV + "profileNameFormat", Set.of(uri(RV + "LocalizedNameV2"))), before.types(), before.mutationBasis());
            assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, translated));
            data.delete(current, node, uri(RV + "profileNameFormat"), uri(RV + "PlainNameAddressV1"));
            data.add(current, node, uri(RV + "profileNameFormat"), uri(RV + "LocalizedNameAddressV1"));
            assertTrue(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, translated));
        } finally { data.abort(); data.end(); }
    }

    private static final String ZONE = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b1";

    /** The generated registry, so Zone routing and shapes are the authored ones. */
    private static ProfileRegistry zoneProfiles() {
        return ProfileRegistry.load(Files.isDirectory(Path.of("profiles"))
            ? Path.of("profiles") : Path.of("../../../generated/model"));
    }

    private static Node zoneRevision(DatasetGraph data, String id, Node zone, Node predecessor) {
        Node revision = uri("urn:probe:zone-revision:" + id);
        Node revisions = uri(CommandPolicy.REVISIONS);
        data.add(revisions, revision, RDF.type.asNode(), uri(RV + "ZoneRevision"));
        data.add(revisions, revision, RDF.type.asNode(), uri(RV + "RevisionAnchor"));
        data.add(revisions, revision, uri(RV + "component"), zone);
        if (predecessor != null) data.add(revisions, revision, uri(RV + "predecessor"), predecessor);
        return revision;
    }

    /** A Zone with a navigation, 1,000 canonical mounts and 1,000 historical revisions. */
    private static Node zoneWithHistory(DatasetGraph data, int mounts) {
        Node current = uri(CommandPolicy.CURRENT);
        Node zone = uri(ZONE), space = uri("urn:probe:space"), head = zoneRevision(data, "head", zone, null);
        data.add(current, space, RDF.type.asNode(), uri(RV + "Space"));
        data.add(current, zone, RDF.type.asNode(), uri(RV + "Zone"));
        data.add(current, zone, uri(RV + "space"), space);
        data.add(current, zone, uri(RV + "zoneState"), uri(RV + "Active"));
        data.add(current, zone, uri(RV + "zoneHead"), head);
        data.add(current, zone, uri(RV + "disclosure"), uri(RV + "Public"));
        for (int i = 0; i < mounts; i++) {
            Node mount = uri("urn:probe:zone-mount:" + i);
            data.add(current, mount, RDF.type.asNode(), uri(RV + "ZoneMount"));
            data.add(current, mount, uri(RV + "zone"), zone);
            data.add(current, mount, uri(RV + "routeSegment"), NodeFactory.createLiteralString("m" + i));
            data.add(current, mount, uri(RV + "disclosure"), uri(RV + "Public"));
            zoneRevision(data, "history:" + i, zone, head);
        }
        return zone;
    }

    private static CommandPolicy.Plan zonePlan(String... names) {
        return new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Set.of(names),
            Set.of(), Set.of(), false, false, true);
    }

    /** Physical oracle: records every dataset and graph-view read the policy and SHACL issue. */
    private static final class ReadLog extends DatasetGraphWrapper {
        final List<String> reads = new ArrayList<>();
        ReadLog(DatasetGraph delegate) { super(delegate); }
        private static String text(Node node) { return node == null || node == Node.ANY ? "*" : node.toString(); }
        void record(String kind, Node g, Node s, Node p, Node o) {
            reads.add(kind + " " + text(g) + " " + text(s) + " " + text(p) + " " + text(o));
        }
        @Override public Iterator<Quad> find() { record("find", null, null, null, null); return super.find(); }
        @Override public Iterator<Quad> find(Quad quad) {
            record("find", quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
            return super.find(quad);
        }
        @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
            record("find", g, s, p, o); return super.find(g, s, p, o);
        }
        @Override public boolean contains(Node g, Node s, Node p, Node o) {
            record("contains", g, s, p, o); return super.contains(g, s, p, o);
        }
        @Override public boolean contains(Quad quad) {
            record("contains", quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
            return super.contains(quad);
        }
        @Override public Graph getGraph(Node graph) {
            return new GraphWrapper(super.getGraph(graph)) {
                @Override public ExtendedIterator<Triple> find(Triple m) {
                    record("graph-find", graph, m.getMatchSubject(), m.getMatchPredicate(), m.getMatchObject());
                    return super.find(m);
                }
                @Override public ExtendedIterator<Triple> find(Node s, Node p, Node o) {
                    record("graph-find", graph, s, p, o); return super.find(s, p, o);
                }
                @Override public boolean contains(Triple t) {
                    record("graph-contains", graph, t.getSubject(), t.getPredicate(), t.getObject());
                    return super.contains(t);
                }
                @Override public boolean contains(Node s, Node p, Node o) {
                    record("graph-contains", graph, s, p, o); return super.contains(s, p, o);
                }
                @Override public Stream<Triple> stream(Node s, Node p, Node o) {
                    record("graph-stream", graph, s, p, o); return super.stream(s, p, o);
                }
            };
        }
    }

    /** Edits one Zone's head, presentation and disclosure over a corpus of {@code mounts}
     * mounts and as many historical revisions; returns the sorted reads the policy check issued
     * (SHACL visits properties in hash order). */
    private static List<String> zoneEditReads(int mounts) {
        ProfileRegistry profiles = zoneProfiles();
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            Node current = uri(CommandPolicy.CURRENT), zone = zoneWithHistory(data, mounts);
            CommandPolicy.Plan plan = zonePlan(ZONE);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(profiles, data, plan);
            Node old = zoneRevision(data, "head", zone, null), next = zoneRevision(data, "next", zone, old);
            data.delete(current, zone, uri(RV + "zoneHead"), old);
            data.add(current, zone, uri(RV + "zoneHead"), next);
            data.add(current, zone, uri(RV + "presentation"), uri("https://rezics.com/definition/zone-presentation-v2"));
            data.delete(current, zone, uri(RV + "disclosure"), uri(RV + "Public"));
            data.add(current, zone, uri(RV + "disclosure"), uri(RV + "Private"));
            ReadLog log = new ReadLog(data);
            assertNull(ModelMutationPolicy.check(profiles, log, plan, "urn:rezics:receipt:zone:probe", before));
            return log.reads.stream().sorted().toList();
        } finally { data.abort(); data.end(); }
    }

    @Test public void zoneConfigurationEditWithUnchangedTypeNeverScansMountsOrRevisions() {
        List<String> small = zoneEditReads(3), large = zoneEditReads(1_100);
        // Point work only: no read leaves the subject unbound while its object is the Zone
        // (the inbound mount, Space and revision scan), and the work does not grow with the corpus.
        for (List<String> reads : List.of(small, large)) {
            assertFalse(reads.isEmpty());
            for (String read : reads) {
                String[] part = read.split(" ");
                assertFalse(read, part[2].equals("*") && part[4].equals(ZONE));
            }
        }
        assertEquals(small, large);
        assertEquals(34, large.size());
    }

    @Test public void zoneEditStillRefusesInvalidDirectFieldsAndTypeRemoval() {
        ProfileRegistry profiles = zoneProfiles();
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            Node current = uri(CommandPolicy.CURRENT), zone = zoneWithHistory(data, 1_100);
            CommandPolicy.Plan plan = zonePlan(ZONE);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(profiles, data, plan);
            data.delete(current, zone, uri(RV + "space"), uri("urn:probe:space"));
            String missing = report(ModelMutationPolicy.check(profiles, data, plan, "urn:rezics:receipt:zone:probe", before));
            assertTrue(missing, missing.contains(RV + "space") && !missing.contains("reverse dependency"));
            data.add(current, zone, uri(RV + "space"), uri("urn:probe:space"));
            data.add(current, zone, uri(RV + "zoneState"), uri(RV + "Archived"));
            String state = report(ModelMutationPolicy.check(profiles, data, plan, "urn:rezics:receipt:zone:probe", before));
            assertTrue(state, state.contains(RV + "zoneState"));
            data.delete(current, zone, uri(RV + "zoneState"), uri(RV + "Archived"));
            data.delete(current, zone, RDF.type.asNode(), uri(RV + "Zone"));
            assertEquals("prestate canonical type removed: " + ZONE,
                report(ModelMutationPolicy.check(profiles, data, plan, "urn:rezics:receipt:zone:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void touchedZoneMountStillValidatesAndRefusesAnInvalidMount() {
        ProfileRegistry profiles = zoneProfiles();
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            Node current = uri(CommandPolicy.CURRENT), zone = zoneWithHistory(data, 3);
            String mount = "urn:probe:zone-mount:1";
            CommandPolicy.Plan plan = zonePlan(ZONE, mount);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(profiles, data, plan);
            assertNull(ModelMutationPolicy.check(profiles, data, plan, "urn:rezics:receipt:zone:probe", before));
            data.delete(current, uri(mount), uri(RV + "zone"), zone);
            data.add(current, uri(mount), uri(RV + "zone"), uri("urn:probe:not-a-zone"));
            String report = report(ModelMutationPolicy.check(profiles, data, plan, "urn:rezics:receipt:zone:probe", before));
            assertTrue(report, report.contains(RV + "zone"));
        } finally { data.abort(); data.end(); }
    }

    private static void addDependent(DatasetGraph data, int index) {
        Node record = uri("urn:probe:record:" + index);
        data.add(uri(CommandPolicy.REVISIONS), record, RDF.type.asNode(), uri(RV + "RegistryProbeRecord"));
        data.add(uri(CommandPolicy.REVISIONS), record, uri(RV + "item"), uri(ITEM));
    }
}
