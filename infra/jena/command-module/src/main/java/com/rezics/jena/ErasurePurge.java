package com.rezics.jena;

import java.nio.file.Files;
import java.nio.file.Path;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.Dataset;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.vocabulary.RDF;

/** Offline, fail-closed copy excluding one bounded campaign of exact revisions and body projections.
 * The source is opened read-only by procedure, never changed here. The caller must hold the owner lock,
 * prove a clean stop and keep the output unpublished until Lucene and retained-copy checks pass.
 */
public final class ErasurePurge {
    private static final Node RV_CONTENT_REVISION = uri("https://rezics.com/vocab/contentRevision");
    private static final Node RV_REVISION = uri("https://rezics.com/vocab/revision");
    private static final Node RV_PROJECTION = uri("https://rezics.com/vocab/projection");
    private static final Node RV_MATCH_UNIT = uri("https://rezics.com/vocab/matchUnit");
    private static final Node RV_PUBLICATION_DECISION = uri("https://rezics.com/vocab/publicationDecision");
    private static final Node MATCH_UNIT = uri("https://rezics.com/vocab/MatchUnit");
    private static final Node CONTENT_PROJECTION = uri("https://rezics.com/vocab/ContentProjection");
    private static final Node CONTENT_PRIVATE_PROJECTION = uri("https://rezics.com/vocab/ContentPrivateProjection");
    private static final Node PUBLIC_SEARCH = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node PRIVATE_SEARCH = uri(CommandPolicy.PRIVATE_SEARCH);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node ERASED_REVISION = uri("https://rezics.com/vocab/ErasedRevision");
    private static final Node ERASURE_EPOCH = uri("https://rezics.com/vocab/erasureEpoch");

    private static Node uri(String value) { return NodeFactory.createURI(value); }

    record Campaign(Map<Node, String> targets, String sha256) {}

    static Campaign campaign(byte[] bytes) throws Exception {
        // Hash the supplied bytes, not a reordered or permissively parsed interpretation.
        if (bytes.length == 0 || bytes.length > 8192 || bytes[bytes.length - 1] != '\n')
            throw new IllegalArgumentException("campaign must contain 1..64 LF-terminated exact pairs");
        String text = new String(bytes, StandardCharsets.US_ASCII);
        Map<Node, String> targets = new LinkedHashMap<>();
        for (String row : text.substring(0, text.length() - 1).split("\n", -1)) {
            String[] pair = row.split("\t", -1);
            if (pair.length != 2 || !pair[0].matches("urn:rezics:content:revision:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                || !pair[1].matches("[1-9][0-9]{0,18}") || targets.size() == 64
                || targets.putIfAbsent(uri(pair[0]), pair[1]) != null)
                throw new IllegalArgumentException("invalid, duplicate or oversized campaign pair");
        }
        return new Campaign(java.util.Collections.unmodifiableMap(targets),
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
    }

    private static Map<Node, Node> validateTargets(DatasetGraph input, Campaign campaign) {
        Map<Node, Node> epochs = new LinkedHashMap<>();
        campaign.targets().forEach((target, epoch) -> {
            if (!input.contains(Node.ANY, target, Node.ANY, Node.ANY)
                && !input.contains(Node.ANY, Node.ANY, Node.ANY, target))
                throw new IllegalArgumentException("target has no graph footprint: " + target);
            if (input.contains(target, Node.ANY, Node.ANY, Node.ANY)
                || input.contains(Node.ANY, Node.ANY, target, Node.ANY))
                throw new IllegalArgumentException("target used outside revision identity: " + target);
            var values = input.find(REVISIONS, target, ERASURE_EPOCH, Node.ANY);
            Node prior = values.hasNext() ? values.next().getObject() : null;
            boolean erased = input.contains(REVISIONS, target, RDF.type.asNode(), ERASED_REVISION);
            if (values.hasNext() || erased != (prior != null)
                || (prior != null && (!prior.isLiteral()
                    || !org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger.getURI().equals(prior.getLiteralDatatypeURI())
                    || !prior.getLiteralLexicalForm().matches("[1-9][0-9]{0,18}")
                    || !new BigInteger(epoch).equals(new BigInteger(prior.getLiteralLexicalForm())))))
                throw new IllegalArgumentException("target tombstone/epoch evidence differs: " + target);
            epochs.put(target, prior == null ? NodeFactory.createLiteralByValue(new BigInteger(epoch),
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger) : prior);
        });
        return epochs;
    }

    private static byte[] readCampaign(Path path) throws Exception {
        try (var input = Files.newInputStream(path)) { return input.readNBytes(8193); }
    }

    private static Path resolvedDestination(Path path) throws Exception {
        Path absolute = path.toAbsolutePath().normalize();
        if (Files.exists(absolute)) return absolute.toRealPath();
        Path parent = absolute.getParent();
        if (parent == null) throw new IllegalArgumentException("destination has no parent");
        return resolvedDestination(parent).resolve(absolute.getFileName());
    }

    private static void requireEmpty(Path destination) throws Exception {
        if (Files.exists(destination)) {
            try (var entries = Files.list(destination)) {
                if (entries.findAny().isPresent()) throw new IllegalArgumentException("destination is not empty");
            }
        }
    }

    private static void addDependents(DatasetGraph source, Set<Node> removed) {
        // Only typed Content projection nodes are evicted as whole subjects.
        // Other incoming references lose the exact edge, preserving unrelated facts.
        boolean changed;
        do {
            changed = false;
            var quads = source.find();
            while (quads.hasNext()) {
                Quad quad = quads.next();
                if (!removed.contains(quad.getObject()) || removed.contains(quad.getSubject())) continue;
                Node subject = quad.getSubject();
                Node graph = quad.getGraph();
                boolean projection = REVISIONS.equals(graph)
                    && (source.contains(graph, subject, RDF.type.asNode(), CONTENT_PROJECTION)
                        || source.contains(graph, subject, RDF.type.asNode(), CONTENT_PRIVATE_PROJECTION))
                    && Set.of(RV_CONTENT_REVISION, RV_MATCH_UNIT, RV_PUBLICATION_DECISION).contains(quad.getPredicate());
                boolean unit = (PUBLIC_SEARCH.equals(graph) || PRIVATE_SEARCH.equals(graph))
                    && source.contains(graph, subject, RDF.type.asNode(), MATCH_UNIT)
                    && Set.of(RV_REVISION, RV_PROJECTION, RV_PUBLICATION_DECISION).contains(quad.getPredicate());
                if (projection || unit) changed |= removed.add(subject);
            }
        } while (changed);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4)
            throw new IllegalArgumentException("usage: ErasurePurge SOURCE_TDB2 EMPTY_DEST_TDB2 --campaign FILE | EXACT_IRI ERASURE_EPOCH");
        Campaign campaign = campaign("--campaign".equals(args[2]) ? readCampaign(Path.of(args[3]))
            : (args[2] + "\t" + args[3] + "\n").getBytes(StandardCharsets.UTF_8));
        Path sourcePath = Path.of(args[0]).toRealPath();
        Path destinationPath = resolvedDestination(Path.of(args[1]));
        if (sourcePath.equals(destinationPath) || destinationPath.startsWith(sourcePath)
            || sourcePath.startsWith(destinationPath)) throw new IllegalArgumentException("source and destination overlap");
        requireEmpty(destinationPath);
        Dataset source = TDB2Factory.connectDataset(sourcePath.toString());
        try {
            source.begin(ReadWrite.READ);
            try {
                DatasetGraph input = source.asDatasetGraph();
                Map<Node, Node> epochs = validateTargets(input, campaign);
                Dataset destination = TDB2Factory.connectDataset(destinationPath.toString());
                try {
                    destination.begin(ReadWrite.WRITE);
                    try {
                        DatasetGraph output = destination.asDatasetGraph();
                        Set<Node> removed = new HashSet<>();
                        removed.addAll(campaign.targets().keySet());
                        addDependents(input, removed);
                        long retained = 0;
                        long excluded = 0;
                        var quads = input.find();
                        while (quads.hasNext()) {
                            Quad quad = quads.next();
                            if (removed.contains(quad.getSubject()) || removed.contains(quad.getObject())) excluded++;
                            else { output.add(quad); retained++; }
                        }
                        org.apache.jena.tdb2.sys.CopyDSG.copyPrefixes(input, output);
                        // Non-sensitive, exact identity and frontier survive compaction.
                        // The product command gate rejects later inserts naming this IRI.
                        epochs.forEach((target, epoch) -> {
                            output.add(REVISIONS, target, RDF.type.asNode(), ERASED_REVISION);
                            output.add(REVISIONS, target, ERASURE_EPOCH, epoch);
                        });
                        CommitHalt.commit(destination);
                        System.out.println("campaignSha256=" + campaign.sha256() + " campaignTargets=" + campaign.targets().size()
                            + " retainedQuads=" + retained + " excludedQuads=" + excluded
                            + " excludedSubjects=" + removed.size());
                    } finally { destination.end(); }
                } finally { destination.close(); }
            } finally {
                source.end();
            }
        } finally {
            source.close();
        }
    }

    private ErasurePurge() {}
}
