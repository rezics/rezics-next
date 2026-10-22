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
    private static final Node RV_PUBLISHED_PAGE = uri("https://rezics.com/vocab/publishedPage");
    private static final Node ZONE_HOME_REVISION = uri("https://rezics.com/vocab/ZoneHomeRevision");
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
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static Node rv(String value) { return uri("https://rezics.com/vocab/" + value); }

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
            if (pair.length != 2 || !(pair[0].matches(ErasurePolicy.REVISION_TARGET)
                    || pair[0].matches(ErasurePolicy.PROVISION_TARGET))
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
            Node epochValue = NodeFactory.createLiteralByValue(new BigInteger(epoch),
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger);
            if (!ErasurePolicy.positiveEpoch(epochValue)) throw new IllegalArgumentException("target epoch exceeds owner range");
            if (input.contains(CURRENT, target, Node.ANY, Node.ANY)) {
                requireRetainedPerson(input, target, epochValue);
                epochs.put(target, epochValue);
                return;
            }
            Node person = ErasurePolicy.one(input, REVISIONS, target, rv("component"));
            boolean personRevision = target.getURI().matches(ErasurePolicy.PROVISION_TARGET)
                || input.contains(REVISIONS, target, RDF.type.asNode(), rv("AgentPublicProfileRevision"))
                || person != null && input.contains(CURRENT, person, rv("agentKind"), rv("PersonAgent"));
            if (personRevision) {
                if (person == null) throw new IllegalArgumentException("Person profile revision owner is missing or ambiguous");
                requireRetainedPerson(input, person, epochValue);
                if (!ErasurePolicy.personRevision(input, target, person))
                    throw new IllegalArgumentException("Person revision kind, owner or provisioning anchor differs: " + target);
            } else if (target.getURI().matches(ErasurePolicy.PROVISION_TARGET)
                || target.getURI().startsWith("https://rezics.com/id/")
                    && !ErasurePolicy.priorRevision(input, target.getURI())
                    && !input.contains(REVISIONS, target, RDF.type.asNode(), ERASED_REVISION))
                throw new IllegalArgumentException("target is not an exact revision: " + target);
            var values = input.find(REVISIONS, target, ERASURE_EPOCH, Node.ANY);
            Node prior = values.hasNext() ? values.next().getObject() : null;
            boolean erased = input.contains(REVISIONS, target, RDF.type.asNode(), ERASED_REVISION);
            if (values.hasNext() || erased != (prior != null)
                || (prior != null && (!prior.isLiteral()
                    || !org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger.getURI().equals(prior.getLiteralDatatypeURI())
                    || !prior.getLiteralLexicalForm().matches("[1-9][0-9]{0,18}")
                    || !new BigInteger(epoch).equals(new BigInteger(prior.getLiteralLexicalForm())))))
                throw new IllegalArgumentException("target tombstone/epoch evidence differs: " + target);
            epochs.put(target, prior == null ? epochValue : prior);
        });
        // A retained Person head authorizes only its complete, typed profile
        // history. A suffix or component edge on an arbitrary resource is insufficient.
        for (Node person : campaign.targets().keySet()) if (input.contains(CURRENT, person, RDF.type.asNode(), rv("AgentTombstone"))) {
            Node epoch = epochs.get(person);
            var revisions = input.find(REVISIONS, Node.ANY, rv("component"), person);
            int count = 0;
            try { while (revisions.hasNext()) {
                Node revision = revisions.next().getSubject();
                if (++count > 64 || !ErasurePolicy.personRevision(input, revision, person))
                    throw new IllegalArgumentException("Person profile history differs or exceeds bound");
                Node prior = ErasurePolicy.one(input, REVISIONS, revision, ERASURE_EPOCH);
                if (input.contains(REVISIONS, revision, ERASURE_EPOCH, Node.ANY) && !epoch.equals(prior)
                    || input.contains(REVISIONS, revision, RDF.type.asNode(), ERASED_REVISION) != (prior != null)
                    || epochs.containsKey(revision) && !epoch.equals(epochs.get(revision)))
                    throw new IllegalArgumentException("Person profile epoch differs");
                epochs.put(revision, epoch);
            } } finally { org.apache.jena.atlas.iterator.Iter.close(revisions); }
        }
        personIndexDocuments(input, personTargets(input, epochs.keySet()));
        return epochs;
    }

    private static void requireRetainedPerson(DatasetGraph input, Node person, Node epoch) {
        Node id = ErasurePolicy.one(input, CURRENT, person, rv("erasureId"));
        if (!person.isURI() || !person.getURI().matches(ErasurePolicy.PERSON_TARGET)
            || !rv("AgentTombstone").equals(ErasurePolicy.one(input, CURRENT, person, RDF.type.asNode()))
            || !rv("PersonAgent").equals(ErasurePolicy.one(input, CURRENT, person, rv("agentKind")))
            || id == null || !id.isLiteral() || !"http://www.w3.org/2001/XMLSchema#string".equals(id.getLiteralDatatypeURI())
            || !id.getLiteralLexicalForm().matches("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
            || !epoch.equals(ErasurePolicy.one(input, CURRENT, person, ERASURE_EPOCH)))
            throw new IllegalArgumentException("target is not this epoch's retained Person tombstone: " + person);
        var fields = input.find(CURRENT, person, Node.ANY, Node.ANY);
        int count = 0;
        try { while (fields.hasNext()) {
            Quad field = fields.next();
            if (++count > 64 || !(Set.of(RDF.type.asNode(), rv("agentKind"), rv("erasureId"), ERASURE_EPOCH).contains(field.getPredicate())
                || ErasurePolicy.PROFILE_PREDICATES.contains(field.getPredicate())))
                throw new IllegalArgumentException("retained Person has unsupported current facts");
        } } finally { org.apache.jena.atlas.iterator.Iter.close(fields); }
    }

    private static Set<Node> personTargets(DatasetGraph input, Set<Node> targets) {
        Set<Node> result = new HashSet<>();
        for (Node target : targets) {
            Node owner = ErasurePolicy.one(input, REVISIONS, target, rv("component"));
            if (input.contains(CURRENT, target, RDF.type.asNode(), rv("AgentTombstone"))
                || owner != null && input.contains(CURRENT, owner, rv("agentKind"), rv("PersonAgent"))) result.add(target);
        }
        return result;
    }

    /** Delete only direct Person documents; credited Work documents are rebuilt
     * by the existing projection owner, preserving coauthors and attribution. */
    private record IndexUnit(Node graph, Node subject) {}
    private static Set<IndexUnit> personIndexDocuments(DatasetGraph input, Set<Node> targets) {
        Set<IndexUnit> documents = new HashSet<>();
        for (Node graph : new Node[]{PUBLIC_SEARCH, PRIVATE_SEARCH}) for (Node target : targets)
            for (Node predicate : ErasurePolicy.INDEX_REFERENCES) {
                var found = input.find(graph, Node.ANY, predicate, target);
                try { while (found.hasNext()) {
                    Node unit = found.next().getSubject();
                    for (Node reference : ErasurePolicy.INDEX_REFERENCES) {
                        var owners = input.find(graph, unit, reference, Node.ANY);
                        try { while (owners.hasNext()) if (!targets.contains(owners.next().getObject()))
                            throw new IllegalArgumentException("Person indexed unit has a foreign owner"); }
                        finally { org.apache.jena.atlas.iterator.Iter.close(owners); }
                    }
                    if (documents.add(new IndexUnit(graph, unit)) && documents.size() > 64) throw new IllegalArgumentException("Person indexed unit bound exceeded");
                } } finally { org.apache.jena.atlas.iterator.Iter.close(found); }
            }
        return documents;
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

    /** Match units in the public or private text index that name one purged revision. */
    private static Set<IndexUnit> textIndexDocuments(DatasetGraph source, Set<Node> revisions) {
        Set<IndexUnit> documents = new HashSet<>();
        if (revisions.isEmpty()) return documents;
        for (Node graph : new Node[]{PUBLIC_SEARCH, PRIVATE_SEARCH}) {
            for (Node predicate : new Node[]{RV_REVISION, RV_CONTENT_REVISION}) {
                var found = source.find(graph, Node.ANY, predicate, Node.ANY);
                while (found.hasNext()) {
                    Quad quad = found.next();
                    if (revisions.contains(quad.getObject())) documents.add(new IndexUnit(graph, quad.getSubject()));
                }
            }
        }
        return documents;
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
            QueryWorkService.beginRead(source.asDatasetGraph());
            try {
                DatasetGraph input = source.asDatasetGraph();
                Map<Node, Node> epochs = validateTargets(input, campaign);
                Dataset destination = TDB2Factory.connectDataset(destinationPath.toString());
                try {
                    destination.begin(ReadWrite.WRITE);
                    try {
                        DatasetGraph output = destination.asDatasetGraph();
                        Set<Node> contentTargets = new HashSet<>();
                        Set<Node> revisionTargets = new HashSet<>();
                        Set<Node> personTargets = personTargets(input, epochs.keySet());
                        Set<Node> personHeads = new HashSet<>();
                        for (Node target : epochs.keySet()) {
                            if (input.contains(CURRENT, target, RDF.type.asNode(), rv("AgentTombstone"))) personHeads.add(target);
                            else if (target.getURI().startsWith("https://rezics.com/id/")) revisionTargets.add(target);
                            else contentTargets.add(target);
                        }
                        // A Content URN still drops its projection and every edge that names it.
                        // A revision IRI drops only its own revision-graph quads and its text documents.
                        Set<Node> removed = new HashSet<>(contentTargets);
                        // The cut owns its immutable exact-byte bindings. Remove
                        // those subjects too, including every retained digest;
                        // incoming H naming edges still retain the absent cut.
                        for (Node target : revisionTargets) {
                            if (!input.contains(REVISIONS, target, RDF.type.asNode(), ZONE_HOME_REVISION)) continue;
                            var bindings = input.find(REVISIONS, target, RV_PUBLISHED_PAGE, Node.ANY);
                            while (bindings.hasNext()) removed.add(bindings.next().getObject());
                        }
                        addDependents(input, removed);
                        Set<Node> genericRevisions = new HashSet<>(revisionTargets);
                        genericRevisions.removeAll(personTargets);
                        Set<IndexUnit> textDocuments = textIndexDocuments(input, genericRevisions);
                        Set<IndexUnit> personDocuments = personIndexDocuments(input, personTargets);
                        Set<Node> authorPrefixes = new HashSet<>();
                        for (Node person : personHeads) {
                            var prefixes = input.find(PUBLIC_SEARCH, Node.ANY, rv("prefixAuthor"), person);
                            try { while (prefixes.hasNext()) {
                                Node entry = prefixes.next().getSubject();
                                if (entry.isURI() && entry.getURI().startsWith(PublicNameProjection.PREFIX_DIRECTORY)) authorPrefixes.add(entry);
                            } } finally { org.apache.jena.atlas.iterator.Iter.close(prefixes); }
                        }
                        long retained = 0;
                        long excluded = 0;
                        var quads = input.find();
                        while (quads.hasNext()) {
                            Quad quad = quads.next();
                            boolean dropContent = removed.contains(quad.getSubject()) || removed.contains(quad.getObject());
                            boolean dropRevision = revisionTargets.contains(quad.getSubject())
                                && REVISIONS.equals(quad.getGraph())
                                && (!personTargets.contains(quad.getSubject())
                                    || ErasurePolicy.historicalProfilePredicate(quad.getPredicate()));
                            boolean dropPerson = CURRENT.equals(quad.getGraph()) && personHeads.contains(quad.getSubject())
                                && ErasurePolicy.PROFILE_PREDICATES.contains(quad.getPredicate());
                            boolean dropAuthorPrefix = PUBLIC_SEARCH.equals(quad.getGraph()) && authorPrefixes.contains(quad.getSubject()) && ErasurePolicy.authorPrefixRemoval(input, quad, personHeads);
                            boolean dropText = textDocuments.contains(new IndexUnit(quad.getGraph(), quad.getSubject()))
                                || personDocuments.contains(new IndexUnit(quad.getGraph(), quad.getSubject()));
                            if (dropContent || dropRevision || dropPerson || dropText || dropAuthorPrefix) excluded++;
                            else {
                                // Prefix text is an index sentinel, never an author's
                                // literal name, including detached and shared entries.
                                if (PUBLIC_SEARCH.equals(quad.getGraph()) && authorPrefixes.contains(quad.getSubject())
                                    && rv("publicTitle").equals(quad.getPredicate()))
                                    output.add(quad.getGraph(), quad.getSubject(), quad.getPredicate(), NodeFactory.createLiteralString("rezicsprefixdirectory"));
                                else output.add(quad);
                                retained++;
                            }
                        }
                        org.apache.jena.tdb2.sys.CopyDSG.copyPrefixes(input, output);
                        // Non-sensitive, exact identity and frontier survive compaction.
                        // The product command gate rejects later inserts naming this IRI.
                        epochs.forEach((target, epoch) -> {
                            if (personHeads.contains(target)) return;
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
                QueryWorkService.endRead(source.asDatasetGraph());
            }
        } finally {
            source.close();
        }
    }

    private ErasurePurge() {}
}
