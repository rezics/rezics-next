package com.rezics.jena;

import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.atlas.json.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.fuseki.servlets.ActionService;
import org.apache.jena.fuseki.servlets.HttpAction;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.fuseki.server.DataService;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.jena.shacl.ShaclValidator;
import org.apache.jena.shacl.Shapes;
import org.apache.jena.shacl.ValidationReport;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;

final class CommandService extends ActionService {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String SH = "http://www.w3.org/ns/shacl#";
    private static final int MAX_REQUEST = 2_000_000;
    private final ProfileRegistry profiles;
    private final byte[] maintenanceCapability;
    private final byte[] admittedCapability;
    private final String instanceId = java.util.UUID.randomUUID().toString();
    // Odd means one native transaction touching the public index is still open.
    // The TDB write lock serializes those transactions; the counter also changes
    // for a rolled-back attempt, which conservatively invalidates cached proof.
    private final AtomicLong publicSearchWriteEpoch = new AtomicLong();
    private final AtomicLong privateSearchWriteEpoch = new AtomicLong();

    CommandService(ProfileRegistry profiles) {
        this.profiles = profiles;
        this.maintenanceCapability = capability("FUSEKI_MAINTENANCE_TOKEN");
        this.admittedCapability = capability("FUSEKI_COMMAND_TOKEN");
    }

    private static byte[] capability(String name) {
        String configured = System.getenv(name);
        if (configured == null || !configured.matches("[0-9a-f]{64}"))
            throw new IllegalStateException(name + " must be a 64-character lowercase hex secret");
        return configured.getBytes(StandardCharsets.US_ASCII);
    }

    @Override public void validate(HttpAction action) {}
    @Override public void execute(HttpAction action) {}
    static boolean deltaExclusive(DataService service) {
        // Only the read endpoint and this native command may address the text
        // dataset. Update, Graph Store RW, upload, patch and unknown operations
        // all invalidate the journal's complete-writer premise.
        return service.getOperations().stream().allMatch(operation ->
            operation.equals(Operation.Query) || operation.getId().getURI().equals("https://rezics.com/fuseki/command"));
    }
    @Override public void execGet(HttpAction action) {
        long epoch = publicSearchWriteEpoch.get();
        boolean deltaExclusive = deltaExclusive(action.getDataService());
        String since = action.getRequest().getParameter("deltaSince");
        if (since != null) {
            if (!deltaExclusive || !since.matches("-1|(0|[1-9][0-9]*)") || (epoch & 1L) != 0L) {
                respond(action, 200, Map.of("available", false)); return;
            }
            try {
                Map<String, Object> proof = SearchDeltaJournal.proof(action.getDataService().getDataset(),
                    Long.parseLong(since), epoch);
                if (publicSearchWriteEpoch.get() != epoch) proof = Map.of("available", false);
                respond(action, 200, proof);
            } catch (IllegalArgumentException | IllegalStateException ex) {
                respond(action, 200, Map.of("available", false));
            }
            return;
        }
        long privateEpoch = privateSearchWriteEpoch.get();
        respond(action, 200, Map.of("moduleVersion", "0.5.22",
            "instanceId", instanceId, "publicSearchWriteEpoch", Long.toString(epoch),
            "publicSearchWriteActive", (epoch & 1L) != 0L,
            "privateSearchWriteEpoch", Long.toString(privateEpoch),
            "privateSearchWriteActive", (privateEpoch & 1L) != 0L,
            "publicSearchDeltaAvailable", deltaExclusive, "profiles", profiles.digests()));
    }
    @Override public void execPost(HttpAction action) {
        if (!"application/json".equalsIgnoreCase(action.getRequestContentType())) {
            respond(action, 415, Map.of("status", "bad-request", "message", "application/json required")); return;
        }
        try {
            byte[] bytes = action.getRequestInputStream().readNBytes(MAX_REQUEST + 1);
            if (bytes.length > MAX_REQUEST) throw new IllegalArgumentException("request too large");
            JsonObject body = JSON.parse(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
            String receipt = iri(ProfileRegistry.required(body, "receipt"));
            byte[] required = CommandPolicy.maintenanceReceipt(receipt)
                ? maintenanceCapability : admittedCapability;
            if (!authorized(action, required)) {
                respond(action, 403, Map.of("status", "forbidden")); return;
            }
            String digest = ProfileRegistry.required(body, "digest");
            String update = ProfileRegistry.required(body, "update");
            JsonValue deadlineValue = body.get("deadlineMs");
            long deadlineMs = deadlineValue == null ? 10_000 : deadlineValue.getAsNumber().value().longValue();
            if (deadlineMs < 1 || deadlineMs > 120_000) throw new IllegalArgumentException("invalid deadlineMs");
            CommandPolicy.Plan plan = CommandPolicy.parse(update, receipt);
            List<Validation> validations = parseValidations(body.get("validations"));
            long deadline = System.nanoTime() + deadlineMs * 1_000_000L;
            respond(action, 200, run(action.getDataService().getDataset(), receipt, digest, plan, validations, deadline));
        } catch (UnknownProfile ex) {
            respond(action, 200, Map.of("status", "unknown-profile"));
        } catch (IllegalArgumentException ex) {
            respond(action, 400, Map.of("status", "bad-request", "message", ex.getMessage()));
        } catch (IOException ex) {
            respond(action, 400, Map.of("status", "bad-request", "message", "invalid JSON"));
        } catch (RuntimeException ex) {
            action.log.error("command failed", ex);
            respond(action, 500, Map.of("status", "error"));
        }
    }

    private boolean authorized(HttpAction action, byte[] expected) {
        String authorization = action.getRequest().getHeader("Authorization");
        if (authorization == null || !authorization.startsWith("Bearer ")) return false;
        String candidate = authorization.substring("Bearer ".length());
        return candidate.matches("[0-9a-f]{64}") && MessageDigest.isEqual(
            expected, candidate.getBytes(StandardCharsets.US_ASCII));
    }

    static record Validation(String profileId, ProfileRegistry.Profile profile, String shape, List<String> focus,
                             List<String> graphs, Map<String, String> binding) {}
    private List<Validation> parseValidations(JsonValue entries) {
        if (entries == null || !entries.isArray() || entries.getAsArray().size() > 100) throw new IllegalArgumentException("invalid validations");
        List<Validation> result = new ArrayList<>();
        for (JsonValue item : entries.getAsArray()) {
            JsonObject entry = item.getAsObject();
            String profileId = ProfileRegistry.required(entry, "profile");
            ProfileRegistry.Profile profile = profiles.get(profileId);
            if (profile == null || !profile.sha256().equalsIgnoreCase(ProfileRegistry.required(entry, "sha256")))
                throw new UnknownProfile();
            String shape = iri(ProfileRegistry.required(entry, "shape"));
            if (!profile.shapes().contains(ResourceFactory.createResource(shape), org.apache.jena.vocabulary.RDF.type, ResourceFactory.createResource(SH + "NodeShape"))) throw new UnknownProfile();
            List<String> graphs = iris(entry.get("graphs"));
            boolean translationLinkShape = profileId.equals("translation-link-v1")
                && shape.equals("https://rezics.com/definition/translation-link-v1/link-shape");
            boolean workDerivationShape = profileId.equals("work-derivation-v1")
                && shape.equals("https://rezics.com/definition/work-derivation-v1/derivation-shape");
            boolean fixedReleaseShape = profileId.equals("fixed-native-text-release-v1")
                && shape.equals("https://rezics.com/definition/fixed-native-text-release-v1/release-shape");
            if (graphs.stream().anyMatch(graph -> !graph.equals(CommandPolicy.CURRENT)
                && !graph.equals(CommandPolicy.REVISIONS)
                && !((translationLinkShape || workDerivationShape || fixedReleaseShape) && (graph.equals(CommandPolicy.RECEIPTS)
                    || graph.equals(CommandPolicy.CONTROL)))
                && !(graph.equals(CommandPolicy.SOURCE)
                    && profileId.equals("source-open-library-work-v1"))
                && !(graph.equals(CommandPolicy.PUBLIC_SEARCH)
                    && profileId.equals("content-match-unit-v1")
                    && shape.equals("https://rezics.com/definition/content-match-unit-v1/unit-shape"))))
                throw new IllegalArgumentException("validation graph not admitted");
            if (translationLinkShape && !Set.copyOf(graphs).equals(Set.of(CommandPolicy.CURRENT,
                CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS, CommandPolicy.CONTROL)))
                throw new IllegalArgumentException("translation link validation graphs differ");
            if (workDerivationShape && !Set.copyOf(graphs).equals(Set.of(CommandPolicy.CURRENT,
                CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS, CommandPolicy.CONTROL)))
                throw new IllegalArgumentException("work derivation validation graphs differ");
            if (fixedReleaseShape && !Set.copyOf(graphs).equals(Set.of(CommandPolicy.CURRENT,
                CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS, CommandPolicy.CONTROL)))
                throw new IllegalArgumentException("fixed release validation graphs differ");
            result.add(new Validation(profileId, profile, shape, iris(entry.get("focus")), graphs, binding(entry.get("binding"))));
        }
        return result;
    }
    private static Map<String, String> binding(JsonValue value) {
        if (value == null) return Map.of();
        if (!value.isObject() || value.getAsObject().size() > 20)
            throw new IllegalArgumentException("invalid binding object");
        Map<String, String> result = new LinkedHashMap<>();
        value.getAsObject().forEach((key, item) -> {
            if (!item.isString()) throw new IllegalArgumentException("binding value must be a string");
            result.put(key, item.getAsString().value());
        });
        return result;
    }
    private static List<String> iris(JsonValue array) {
        if (array == null || !array.isArray() || array.getAsArray().isEmpty() || array.getAsArray().size() > 100) throw new IllegalArgumentException("invalid IRI list");
        List<String> result = new ArrayList<>();
        array.getAsArray().forEach(item -> result.add(iri(item.getAsString().value())));
        return result;
    }
    private static String iri(String value) {
        if (!(value.startsWith("https://") || value.startsWith("http://") || value.startsWith("urn:")) || value.contains(" "))
            throw new IllegalArgumentException("invalid IRI");
        return value;
    }
    private static final class UnknownProfile extends IllegalArgumentException {}

    private Map<String, Object> run(DatasetGraph dataset, String receipt, String digest, CommandPolicy.Plan plan,
                                    List<Validation> validations, long deadline) {
        dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
        boolean touchesPublicIndex = plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH);
        boolean touchesPrivateIndex = plan.graphs().contains(CommandPolicy.PRIVATE_SEARCH);
        if (touchesPublicIndex) publicSearchWriteEpoch.incrementAndGet();
        if (touchesPrivateIndex) privateSearchWriteEpoch.incrementAndGet();
        SearchDeltaJournal.Capture delta = touchesPublicIndex
            ? new SearchDeltaJournal.Capture(dataset, plan.rebuild()) : null;
        boolean commit = false;
        try {
            String existing = receiptValue(dataset, receipt, "requestDigest");
            if (existing != null) return existing.equals(digest) ? committed(dataset, receipt) : Map.of("status", "conflict");
            String preflight = CommandInvariant.preflight(dataset, receipt, plan);
            if (preflight != null) return invalid(preflight);
            CommandInvariant.Control before = plan.bootstrap() ? null : CommandInvariant.readControl(dataset);
            HeadCasPolicy.Snapshot heads = HeadCasPolicy.capture(dataset, plan, receipt);
            RebuildPolicy.Snapshot rebuild = RebuildPolicy.capture(dataset, plan, receipt);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(delta == null ? dataset : delta.observed()));
            String stored = receiptValue(dataset, receipt, "requestDigest");
            if (stored == null) return Map.of("status", "guard-unmatched");
            if (!stored.equals(digest)) return Map.of("status", "conflict");
            String invariant = CommandInvariant.check(dataset, receipt, digest, plan, before);
            if (invariant != null) return invalid(invariant);
            String headInvariant = HeadCasPolicy.check(dataset, receipt, heads);
            if (headInvariant != null) return invalid(headInvariant);
            String rebuildInvariant = RebuildPolicy.check(dataset, receipt, rebuild);
            if (rebuildInvariant != null) return invalid(rebuildInvariant);
            Map<String, Object> scope = validateScope(dataset, receipt, plan, validations);
            if (scope != null) return scope;
            String sourceBinding = SourceProjectionPolicy.check(dataset, receipt, plan);
            if (sourceBinding != null) return invalid(sourceBinding);
            Map<String, List<Validation>> grouped = new LinkedHashMap<>();
            for (Validation entry : validations) grouped.computeIfAbsent(entry.profileId(), ignored -> new ArrayList<>()).add(entry);
            for (var group : grouped.entrySet()) {
                String report = BindingPolicy.check(dataset, group.getKey(), group.getValue());
                if (report != null) return invalid(report);
            }
            for (Validation validation : validations) {
                Map<String, Object> invalid = validateOne(dataset, validation);
                if (invalid != null) return invalid;
                if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            }
            if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            Map<String, Object> result = committed(dataset, receipt);
            if (!result.containsKey("position")) return Map.of("status", "invalid", "report", "receipt position incomplete");
            if (delta != null) {
                if (!plan.bootstrap() && !plan.rebuild()) {
                    String claimed = receiptValue(dataset, receipt, "matchUnit");
                    if (!SearchDeltaJournal.matchesClaim(delta.changes(), claimed))
                        return invalid("public MatchUnit differs from receipt claim");
                }
                if (plan.bootstrap()) SearchDeltaJournal.initialize(dataset);
                else SearchDeltaJournal.append(dataset, delta, publicSearchWriteEpoch.get() + 1);
            }
            dataset.commit(); commit = true;
            return result;
        } finally {
            try {
                if (!commit) dataset.abort();
            } finally {
                try {
                    if (touchesPublicIndex) publicSearchWriteEpoch.incrementAndGet();
                    if (touchesPrivateIndex) privateSearchWriteEpoch.incrementAndGet();
                } finally {
                    dataset.end();
                }
            }
        }
    }
    private Map<String, Object> validateScope(DatasetGraph dataset, String receipt, CommandPolicy.Plan plan,
                                              List<Validation> validations) {
        boolean productData = !plan.current().isEmpty() || !plan.revisions().isEmpty()
            || !plan.source().isEmpty()
            || plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH) && !plan.bootstrap();
        if (plan.rebuild()) {
            if (!validations.isEmpty()) return invalid("rebuild does not admit product profile validation");
            return null;
        }
        if (productData && validations.isEmpty()) return invalid("product data requires profile validation");
        Set<String> directCurrent = new HashSet<>();
        Set<String> revisionFocus = new HashSet<>();
        Set<String> sourceFocus = new HashSet<>();
        for (Validation validation : validations) {
            if (validation.graphs().contains(CommandPolicy.CURRENT)) directCurrent.addAll(validation.focus());
            if (validation.graphs().contains(CommandPolicy.REVISIONS)) revisionFocus.addAll(validation.focus());
            if (validation.graphs().contains(CommandPolicy.SOURCE)
                && validation.profileId().equals("source-open-library-work-v1")) {
                sourceFocus.addAll(validation.focus());
            }
        }
        if (!sourceFocus.containsAll(plan.source()) || !plan.source().containsAll(sourceFocus)) {
            return invalid("source graph focus differs from touched subjects");
        }
        Node revisionGraph = NodeFactory.createURI(CommandPolicy.REVISIONS);
        Node component = NodeFactory.createURI(RV + "component");
        boolean freshPublication = plan.revisions().stream().anyMatch(subject ->
            hasType(dataset, CommandPolicy.REVISIONS, subject, "ContentPublicationDecision"));
        for (String subject : plan.current()) {
            boolean covered = directCurrent.contains(subject);
            if (!covered) {
                Node node = NodeFactory.createURI(subject);
                for (String focus : revisionFocus) {
                    if (dataset.contains(revisionGraph, NodeFactory.createURI(focus), component, node)) {
                        covered = true; break;
                    }
                }
            }
            if (!covered) return invalid("current graph focus omitted: " + subject);
            Map<String, Object> canonical = validateCanonical(dataset, subject, false);
            if (canonical != null) return canonical;
            if (hasType(dataset, CommandPolicy.CURRENT, subject, "ContentVariant")) {
                if (!hasContentFocus(validations, subject, "variant-shape", CommandPolicy.CURRENT))
                    return invalid("Content variant focus omitted: " + subject);
                String link = contentPublicationLinks(dataset, receipt, subject, false, freshPublication);
                if (link != null) return invalid(link);
            }
            String boundProfile = requiredBindingProfile(dataset, revisionGraph, subject, false);
            if (boundProfile != null && !boundFocus(validations, boundProfile, subject))
                return invalid("bound profile focus omitted: " + subject);
        }
        for (String subject : plan.revisions()) {
            Map<String, Object> canonical = validateCanonical(dataset, subject, true);
            if (canonical != null) return canonical;
            if (hasType(dataset, CommandPolicy.REVISIONS, subject, "ContentPublicationDecision")) {
                if (!hasContentFocus(validations, subject, "decision-shape", CommandPolicy.REVISIONS))
                    return invalid("Content publication decision focus omitted: " + subject);
                String link = contentPublicationLinks(dataset, receipt, subject, true, true);
                if (link != null) return invalid(link);
            }
            if (hasType(dataset, CommandPolicy.REVISIONS, subject, "ContentSearchEligibilityDecision")) {
                if (!hasNamedFocus(validations, "content-search-eligibility-v1", "decision-shape",
                    subject, CommandPolicy.REVISIONS))
                    return invalid("Content search eligibility focus omitted: " + subject);
                String link = contentEligibilityLinks(dataset, receipt, subject, true);
                if (link != null) return invalid(link);
            }
            if (hasType(dataset, CommandPolicy.REVISIONS, subject, "ContentProjection")) {
                if (!hasNamedFocus(validations, "content-match-unit-v1", "projection-shape",
                    subject, CommandPolicy.REVISIONS))
                    return invalid("Content projection focus omitted: " + subject);
                Map<String, Object> projection = validateContentProjection(dataset, receipt, subject, plan,
                    validations);
                if (projection != null) return projection;
            }
            String boundProfile = requiredBindingProfile(dataset, revisionGraph, subject, true);
            if (boundProfile != null && !boundFocus(validations, boundProfile, subject))
                return invalid("bound profile focus omitted: " + subject);
            Node node = NodeFactory.createURI(subject);
            for (String type : List.of("PublicationDecision", "ContentPublicationDecision",
                "ContentSearchEligibilityDecision", "ContentProjection", "PublicationSelection",
                "RealmPublicationRejection", "ClassificationDecision", "RatingObservationRevision",
                "TranslationLink", "WorkDerivation")) {
                if (dataset.contains(revisionGraph, node,
                    org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + type))
                    && !revisionFocus.contains(subject)) return invalid("revision graph focus omitted: " + subject);
            }
        }
        return null;
    }
    private static boolean boundFocus(List<Validation> validations, String profile, String subject) {
        return validations.stream().anyMatch(entry -> entry.profileId().equals(profile)
            && entry.focus().contains(subject) && !entry.binding().isEmpty());
    }
    private static boolean hasType(DatasetGraph dataset, String graph, String subject, String type) {
        return dataset.contains(NodeFactory.createURI(graph), NodeFactory.createURI(subject),
            org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + type));
    }
    private static boolean hasContentFocus(List<Validation> validations, String subject, String shape,
                                           String graph) {
        return hasNamedFocus(validations, "content-publication-v1", shape, subject, graph);
    }
    private static boolean hasNamedFocus(List<Validation> validations, String profile, String shape,
                                         String subject, String graph) {
        String expected = "https://rezics.com/definition/" + profile + "/" + shape;
        return validations.stream().anyMatch(entry -> entry.profileId().equals(profile)
            && entry.shape().equals(expected) && entry.focus().contains(subject)
            && entry.graphs().contains(graph));
    }
    private static Node exactlyOne(DatasetGraph dataset, Node graph, Node subject, String property) {
        var values = dataset.find(graph, subject, NodeFactory.createURI(RV + property), Node.ANY);
        if (!values.hasNext()) return null;
        Node value = values.next().getObject();
        return values.hasNext() ? null : value;
    }
    /** Fixed poststate link and position checks; request-supplied focus cannot redirect them. */
    private static String contentPublicationLinks(DatasetGraph dataset, String receipt, String subject,
                                                  boolean revision, boolean fresh) {
        Node current = NodeFactory.createURI(CommandPolicy.CURRENT);
        Node revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
        Node variant = NodeFactory.createURI(subject);
        Node decision = revision ? variant : exactlyOne(dataset, current, variant, "contentPublicationHead");
        if (revision) variant = exactlyOne(dataset, revisions, decision, "component");
        if (variant == null || !variant.isURI() || decision == null || !decision.isURI()
            || !hasType(dataset, CommandPolicy.CURRENT, variant.getURI(), "ContentVariant")
            || !hasType(dataset, CommandPolicy.REVISIONS, decision.getURI(), "ContentPublicationDecision"))
            return "Content publication component/head missing or mistyped: " + subject;
        Node head = exactlyOne(dataset, current, variant, "contentPublicationHead");
        Node component = exactlyOne(dataset, revisions, decision, "component");
        Node currentResource = exactlyOne(dataset, current, variant, "resource");
        Node revisionResource = exactlyOne(dataset, revisions, decision, "resource");
        if (!decision.equals(head) || !variant.equals(component) || currentResource == null
            || !currentResource.equals(revisionResource))
            return "Content publication reciprocal head/resource mismatch: " + subject;
        if (!fresh) return null;
        Node product = NodeFactory.createURI("urn:rezics:dataset:product");
        Node control = NodeFactory.createURI(CommandPolicy.CONTROL);
        Node graphEpoch = exactlyOne(dataset, revisions, decision, "dataEpoch");
        Node graphSequence = exactlyOne(dataset, revisions, decision, "sequence");
        Node controlEpoch = exactlyOne(dataset, control, product, "dataEpoch");
        Node controlSequence = exactlyOne(dataset, control, product, "sequence");
        if (graphEpoch == null || !graphEpoch.equals(controlEpoch) || graphSequence == null
            || !graphSequence.equals(controlSequence))
            return "Content publication graph position mismatch: " + subject;
        Node receipts = NodeFactory.createURI(CommandPolicy.RECEIPTS);
        Node receiptNode = NodeFactory.createURI(receipt);
        if (!decision.equals(exactlyOne(dataset, receipts, receiptNode, "publicationDecision"))
            || !variant.equals(exactlyOne(dataset, receipts, receiptNode, "variant"))
            || !NodeFactory.createURI(RV + "Succeeded").equals(
                exactlyOne(dataset, receipts, receiptNode, "outcome")))
            return "Content publication receipt identity/outcome mismatch: " + subject;
        for (String property : List.of("operation", "contentRevision", "contentPreparation",
            "resource", "byteDigest", "ownerDataEpoch", "ownerSequence", "datasetId",
            "dataEpoch", "sequence")) {
            Node selected = exactlyOne(dataset, revisions, decision, property);
            if (selected == null || !selected.equals(exactlyOne(dataset, receipts, receiptNode, property)))
                return "Content publication receipt field mismatch: " + property;
        }
        return null;
    }
    private static boolean same(DatasetGraph dataset, Node leftGraph, Node leftSubject,
                                Node rightGraph, Node rightSubject, String property) {
        Node value = exactlyOne(dataset, leftGraph, leftSubject, property);
        return value != null && value.equals(exactlyOne(dataset, rightGraph, rightSubject, property));
    }
    private static String contentEligibilityLinks(DatasetGraph dataset, String receipt, String subject,
                                                  boolean fresh) {
        Node current = NodeFactory.createURI(CommandPolicy.CURRENT);
        Node revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
        Node decision = NodeFactory.createURI(subject);
        Node variant = exactlyOne(dataset, revisions, decision, "variant");
        Node component = exactlyOne(dataset, revisions, decision, "component");
        Node resource = exactlyOne(dataset, revisions, decision, "resource");
        Node publication = exactlyOne(dataset, revisions, decision, "publicationDecision");
        if (variant == null || !variant.isURI() || !variant.equals(component)
            || resource == null || !resource.isURI() || publication == null || !publication.isURI()
            || !hasType(dataset, CommandPolicy.CURRENT, variant.getURI(), "ContentVariant")
            || !hasType(dataset, CommandPolicy.REVISIONS, publication.getURI(), "ContentPublicationDecision")
            || !decision.equals(exactlyOne(dataset, current, variant, "publicSearchEligibilityHead"))
            || !publication.equals(exactlyOne(dataset, current, variant, "contentPublicationHead"))
            || !resource.equals(exactlyOne(dataset, current, variant, "resource"))
            || !resource.equals(exactlyOne(dataset, revisions, publication, "resource"))
            || !variant.equals(exactlyOne(dataset, revisions, publication, "component")))
            return "Content search eligibility current publication link mismatch: " + subject;
        if (!NodeFactory.createURI(RV + "OriginalContribution").equals(
                exactlyOne(dataset, revisions, decision, "rightsBasis"))
            || !NodeFactory.createURI(RV + "Public").equals(
                exactlyOne(dataset, revisions, decision, "disclosure")))
            return "Content search eligibility rights/disclosure mismatch: " + subject;
        Node scope = exactlyOne(dataset, revisions, decision, "admittedScope");
        if (scope == null || !scope.isLiteral()
            || !scope.getLiteralLexicalForm().equals("content:search-eligibility:" + variant.getURI()))
            return "Content search eligibility admission scope mismatch: " + subject;
        if (!fresh) return null;
        Node product = NodeFactory.createURI("urn:rezics:dataset:product");
        Node control = NodeFactory.createURI(CommandPolicy.CONTROL);
        if (!same(dataset, revisions, decision, control, product, "dataEpoch")
            || !same(dataset, revisions, decision, control, product, "sequence"))
            return "Content search eligibility graph position mismatch: " + subject;
        Node receipts = NodeFactory.createURI(CommandPolicy.RECEIPTS);
        Node receiptNode = NodeFactory.createURI(receipt);
        if (!decision.equals(exactlyOne(dataset, receipts, receiptNode, "eligibilityDecision"))
            || !NodeFactory.createURI(RV + "Succeeded").equals(
                exactlyOne(dataset, receipts, receiptNode, "outcome")))
            return "Content search eligibility receipt identity/outcome mismatch: " + subject;
        for (String property : List.of("variant", "resource", "publicationDecision",
            "rightsBasis", "disclosure", "admissionId", "authorityEpoch", "admittedScope",
            "actingSubject", "datasetId", "dataEpoch", "sequence")) {
            if (!same(dataset, revisions, decision, receipts, receiptNode, property))
                return "Content search eligibility receipt field mismatch: " + property;
        }
        return null;
    }
    private Map<String, Object> validateContentProjection(DatasetGraph dataset, String receipt,
                                                          String subject, CommandPolicy.Plan plan,
                                                          List<Validation> validations) {
        if (!plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH))
            return invalid("Content projection requires public search update");
        Node current = NodeFactory.createURI(CommandPolicy.CURRENT);
        Node revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
        Node search = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
        Node receipts = NodeFactory.createURI(CommandPolicy.RECEIPTS);
        Node anchor = NodeFactory.createURI(subject);
        Node receiptNode = NodeFactory.createURI(receipt);
        Node variant = exactlyOne(dataset, revisions, anchor, "component");
        Node resource = exactlyOne(dataset, revisions, anchor, "resource");
        Node contentRevision = exactlyOne(dataset, revisions, anchor, "contentRevision");
        Node publication = exactlyOne(dataset, revisions, anchor, "publicationDecision");
        Node eligibility = exactlyOne(dataset, revisions, anchor, "eligibility");
        Node unit = exactlyOne(dataset, revisions, anchor, "matchUnit");
        if (variant == null || !variant.isURI() || resource == null || !resource.isURI()
            || contentRevision == null || !contentRevision.isURI()
            || publication == null || !publication.isURI() || eligibility == null || !eligibility.isURI()
            || unit == null || !unit.isURI()
            || !hasType(dataset, CommandPolicy.CURRENT, variant.getURI(), "ContentVariant")
            || !hasType(dataset, CommandPolicy.REVISIONS, publication.getURI(), "ContentPublicationDecision")
            || !hasType(dataset, CommandPolicy.REVISIONS, eligibility.getURI(), "ContentSearchEligibilityDecision")
            || !resource.equals(exactlyOne(dataset, current, variant, "resource"))
            || !publication.equals(exactlyOne(dataset, current, variant, "contentPublicationHead"))
            || !eligibility.equals(exactlyOne(dataset, current, variant, "publicSearchEligibilityHead"))
            || !contentRevision.equals(exactlyOne(dataset, revisions, publication, "contentRevision"))
            || !resource.equals(exactlyOne(dataset, revisions, publication, "resource"))
            || !variant.equals(exactlyOne(dataset, revisions, publication, "component")))
            return invalid("Content projection exact publication link mismatch: " + subject);
        if (!hasNamedFocus(validations, "content-match-unit-v1", "unit-shape",
            unit.getURI(), CommandPolicy.PUBLIC_SEARCH))
            return invalid("Content MatchUnit focus omitted: " + unit.getURI());
        ProfileRegistry.Profile eligibilityProfile = profiles.get("content-search-eligibility-v1");
        if (eligibilityProfile == null) return invalid("Content search eligibility profile unavailable");
        Map<String, Object> eligibilityShape = validateOne(dataset, new Validation(
            "content-search-eligibility-v1", eligibilityProfile,
            "https://rezics.com/definition/content-search-eligibility-v1/decision-shape",
            List.of(eligibility.getURI()), List.of(CommandPolicy.REVISIONS), Map.of()));
        if (eligibilityShape != null) return eligibilityShape;
        String eligibilityLink = contentEligibilityLinks(dataset, receipt, eligibility.getURI(), false);
        if (eligibilityLink != null) return invalid(eligibilityLink);
        for (String property : List.of("resource", "variant", "publicationDecision", "eligibility")) {
            Node expected = switch (property) {
                case "resource" -> resource; case "variant" -> variant;
                case "publicationDecision" -> publication; default -> eligibility;
            };
            if (!expected.equals(exactlyOne(dataset, search, unit, property)))
                return invalid("Content MatchUnit link mismatch: " + property);
        }
        if (!contentRevision.equals(exactlyOne(dataset, search, unit, "revision"))
            || !anchor.equals(exactlyOne(dataset, search, unit, "projection")))
            return invalid("Content MatchUnit revision/projection mismatch: " + subject);
        ProfileRegistry.Profile matchProfile = profiles.get("content-match-unit-v1");
        if (matchProfile == null) return invalid("Content MatchUnit profile unavailable");
        Map<String, Object> unitShape = validateOne(dataset, new Validation(
            "content-match-unit-v1", matchProfile,
            "https://rezics.com/definition/content-match-unit-v1/unit-shape",
            List.of(unit.getURI()), List.of(CommandPolicy.PUBLIC_SEARCH), Map.of()));
        if (unitShape != null) return unitShape;
        Node body = exactlyOne(dataset, search, unit, "searchBody");
        Node language = exactlyOne(dataset, search, unit, "language");
        if (body == null || !body.isLiteral() || language == null || !language.isLiteral()
            || !body.getLiteralLanguage().equalsIgnoreCase(language.getLiteralLexicalForm())
            || body.getLiteralLexicalForm().getBytes(StandardCharsets.UTF_8).length > 65_536)
            return invalid("Content MatchUnit body language or byte limit mismatch: " + subject);
        int units = 0;
        var found = dataset.find(search, Node.ANY, NodeFactory.createURI(RV + "variant"), variant);
        while (found.hasNext()) {
            Node candidate = found.next().getSubject();
            if (dataset.contains(search, candidate, org.apache.jena.vocabulary.RDF.type.asNode(),
                NodeFactory.createURI(RV + "MatchUnit"))) {
                if (!candidate.equals(unit)) return invalid("stale Content MatchUnit remains: " + subject);
                units++;
            }
        }
        if (units != 1) return invalid("one Content MatchUnit required: " + subject);
        Node product = NodeFactory.createURI("urn:rezics:dataset:product");
        Node control = NodeFactory.createURI(CommandPolicy.CONTROL);
        if (!same(dataset, revisions, anchor, control, product, "dataEpoch")
            || !same(dataset, revisions, anchor, control, product, "sequence"))
            return invalid("Content projection graph position mismatch: " + subject);
        if (!anchor.equals(exactlyOne(dataset, receipts, receiptNode, "projection"))
            || !unit.equals(exactlyOne(dataset, receipts, receiptNode, "matchUnit"))
            || !NodeFactory.createURI(RV + "Succeeded").equals(
                exactlyOne(dataset, receipts, receiptNode, "outcome")))
            return invalid("Content projection receipt identity/outcome mismatch: " + subject);
        for (String property : List.of("resource", "ownerDataEpoch", "ownerSequence",
            "contentRevision", "publicationDecision", "eligibility", "datasetId",
            "dataEpoch", "sequence")) {
            if (!same(dataset, revisions, anchor, receipts, receiptNode, property))
                return invalid("Content projection receipt field mismatch: " + property);
        }
        if (!variant.equals(exactlyOne(dataset, receipts, receiptNode, "variant")))
            return invalid("Content projection receipt variant mismatch: " + subject);
        return null;
    }
    private static String requiredBindingProfile(DatasetGraph dataset, Node revisionGraph,
                                                 String subject, boolean revision) {
        Node graph = revision ? revisionGraph : NodeFactory.createURI(CommandPolicy.CURRENT);
        Node node = NodeFactory.createURI(subject);
        Node type = org.apache.jena.vocabulary.RDF.type.asNode();
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "ClassificationApplication"))
            || dataset.contains(graph, node, type, NodeFactory.createURI(RV + "ClassificationDecision")))
            return "classification-direct-decision-v1";
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "RatingObservation"))
            || dataset.contains(graph, node, type, NodeFactory.createURI(RV + "RatingObservationRevision")))
            return "realm-standing-rating-observation-v1";
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "RatingContext")))
            return "realm-standing-rating-context-v1";
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "TranslationLink")))
            return "translation-link-v1";
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "WorkDerivation")))
            return "work-derivation-v1";
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "FixedRelease")))
            return "fixed-native-text-release-v1";
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "ClassificationContext")))
            return "classification-context-v1";
        if (dataset.contains(graph, node, type, NodeFactory.createURI(RV + "ClassificationSense"))
            || dataset.contains(graph, node, type, NodeFactory.createURI(RV + "ConceptPath"))
            || dataset.contains(graph, node, type, NodeFactory.createURI(RV + "ClassificationExpression"))
            || dataset.contains(graph, node, type, NodeFactory.createURI("http://www.w3.org/2004/02/skos/core#Concept"))
            || dataset.contains(graph, node, type, NodeFactory.createURI("http://www.w3.org/2004/02/skos/core#ConceptScheme")))
            return "classification-proposition-v1";
        return null;
    }
    private static Map<String, Object> invalid(String report) {
        return Map.of("status", "invalid", "report", report);
    }
    private record Canonical(String profile, String shape) {}
    private Map<String, Object> validateCanonical(DatasetGraph dataset, String subject, boolean revision) {
        Node graph = NodeFactory.createURI(revision ? CommandPolicy.REVISIONS : CommandPolicy.CURRENT);
        Node node = NodeFactory.createURI(subject);
        Set<String> types = new HashSet<>();
        dataset.find(graph, node, org.apache.jena.vocabulary.RDF.type.asNode(), Node.ANY)
            .forEachRemaining(quad -> { if (quad.getObject().isURI()) types.add(quad.getObject().getURI()); });
        if (!revision && types.isEmpty()) return invalid("current graph subject has no type: " + subject);
        Canonical canonical = null;
        String basis = "https://rezics.com/definition/";
        if (types.contains("https://schema.org/CreativeWork"))
            canonical = new Canonical("work-metadata-v1", "work-shape");
        else if (types.contains(RV + "MainVersion"))
            canonical = new Canonical("work-metadata-v1", "main-version-shape");
        else if (types.contains(RV + "ContentVariant"))
            canonical = new Canonical("content-publication-v1", "variant-shape");
        else if (types.contains(RV + "ContentPublicationDecision"))
            canonical = new Canonical("content-publication-v1", "decision-shape");
        else if (types.contains(RV + "ContentSearchEligibilityDecision"))
            canonical = new Canonical("content-search-eligibility-v1", "decision-shape");
        else if (types.contains(RV + "ContentProjection"))
            canonical = new Canonical("content-match-unit-v1", "projection-shape");
        else if (types.contains(RV + "Space")) canonical = new Canonical("space-realm-v1", "space-shape");
        else if (types.contains(RV + "Realm")) canonical = new Canonical("space-realm-v1", "realm-shape");
        else if (types.contains(RV + "RatingContext"))
            canonical = new Canonical("realm-standing-rating-context-v1", "context-shape");
        else if (types.contains(RV + "RatingObservation"))
            canonical = new Canonical("realm-standing-rating-observation-v1", "observation-shape");
        else if (types.contains(RV + "RatingObservationRevision"))
            canonical = new Canonical("realm-standing-rating-observation-v1", "revision-shape");
        else if (types.contains(RV + "RouteBinding")) {
            String state = singleObject(dataset, graph, node, RV + "routeState");
            String disposition = singleObject(dataset, graph, node, RV + "routeDisposition");
            canonical = (RV + "Retired").equals(state)
                ? new Canonical("work-address-disposition-v1", "retired-route-shape")
                : (RV + "Redirected").equals(state) && (RV + "Merged").equals(disposition)
                ? new Canonical("work-address-disposition-v1", "merged-route-shape")
                : (RV + "Redirected").equals(state)
                ? new Canonical("work-address-lifecycle-v1", "redirect-shape")
                : new Canonical("work-address-claim-v1", "binding-shape");
        }
        else if (types.contains(RV + "TranslationLink"))
            canonical = new Canonical("translation-link-v1", "link-shape");
        else if (types.contains(RV + "WorkDerivation"))
            canonical = new Canonical("work-derivation-v1", "derivation-shape");
        else if (types.contains(RV + "FixedRelease"))
            canonical = new Canonical("fixed-native-text-release-v1", "release-shape");
        else if (types.contains(RV + "TextContribution"))
            canonical = new Canonical("text-contribution-v1", "contribution-shape");
        else if (types.contains(RV + "PublicationDecision"))
            canonical = new Canonical("text-publication-v1", "decision-shape");
        else if (types.contains(RV + "ClassificationApplication"))
            canonical = new Canonical("classification-direct-decision-v1", "application-shape");
        else if (types.contains(RV + "ClassificationDecision"))
            canonical = new Canonical("classification-direct-decision-v1", "decision-shape");
        else if (types.contains(RV + "ClassificationSense"))
            canonical = new Canonical("classification-proposition-v1", "sense-shape");
        else if (types.contains(RV + "ClassificationContext")) {
            String role = singleObject(dataset, graph, node, RV + "contextRole");
            canonical = new Canonical("classification-context-v1",
                (RV + "GlobalClassification").equals(role) ? "global-shape" : "context-shape");
        } else if (types.contains(RV + "PublicationSelection")) {
            String selectionBasis = singleObject(dataset, graph, node, RV + "selectionBasis");
            canonical = (RV + "MainMaintainer").equals(selectionBasis)
                ? new Canonical("main-default-selection-v1", "selection-shape")
                : new Canonical("realm-local-selection-v1", "selection-shape");
        } else if (types.contains(RV + "RealmPublicationRejection"))
            canonical = new Canonical("realm-local-rejection-v1", "rejection-shape");
        else if (types.contains("http://www.w3.org/2004/02/skos/core#ConceptScheme"))
            canonical = new Canonical("classification-proposition-v1", "scheme-shape");
        else if (types.contains("http://www.w3.org/2004/02/skos/core#Concept"))
            canonical = new Canonical("classification-proposition-v1", "concept-shape");
        else if (types.contains(RV + "ConceptPath"))
            canonical = new Canonical("classification-proposition-v1", "path-shape");
        else if (types.contains(RV + "ClassificationExpression"))
            canonical = new Canonical("classification-proposition-v1", "expression-shape");
        else if (types.contains(RV + "RealmPublicationSlot")) {
            for (String predicate : List.of("realm", "mainVersion", "work", "selectionHead")) {
                if (singleObject(dataset, graph, node, RV + predicate) == null)
                    return invalid("incomplete Realm publication slot: " + subject);
            }
            return null;
        }
        if (canonical == null) return revision ? null : invalid("unrecognized current graph type: " + subject);
        ProfileRegistry.Profile profile = profiles.get(canonical.profile());
        if (profile == null) return invalid("canonical profile unavailable: " + canonical.profile());
        return validateOne(dataset, new Validation(canonical.profile(), profile, basis + canonical.profile() + "/" + canonical.shape(),
            List.of(subject), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
    }
    private static String singleObject(DatasetGraph dataset, Node graph, Node subject, String predicate) {
        var values = dataset.find(graph, subject, NodeFactory.createURI(predicate), Node.ANY);
        if (!values.hasNext()) return null;
        Node first = values.next().getObject();
        if (values.hasNext()) return null;
        return first.isURI() ? first.getURI() : first.isLiteral() ? first.getLiteralLexicalForm() : null;
    }
    private Map<String, Object> validateOne(DatasetGraph dataset, Validation validation) {
        Model shapes = ModelFactory.createDefaultModel().add(validation.profile().shapes());
        for (String focus : validation.focus()) {
            shapes.createResource(validation.shape())
                .addProperty(shapes.createProperty(SH, "targetNode"), shapes.createResource(focus));
        }
        Graph union = SelectedGraphUnion.readOnly(dataset, validation.graphs());
        ValidationReport report = ShaclValidator.get().validate(Shapes.parse(shapes.getGraph()), union);
        if (!report.conforms()) return Map.of("status", "invalid", "report", boundedReport(report.getModel()));
        return null;
    }
    private static String boundedReport(Model report) {
        Set<String> paths = new java.util.TreeSet<>();
        var pathStatements = report.listStatements(null, report.createProperty(SH, "resultPath"), (org.apache.jena.rdf.model.RDFNode) null);
        while (pathStatements.hasNext()) {
            var path = pathStatements.next().getObject();
            if (path.isURIResource()) paths.add(path.asResource().getURI());
        }
        StringBuilder summary = new StringBuilder();
        for (String path : paths) summary.append("sh:resultPath <").append(path).append(">\n");
        var statements = report.listStatements();
        int count = 0;
        while (statements.hasNext() && count++ < 20 && summary.length() < 4000) summary.append(statements.next()).append("\n");
        return summary.substring(0, Math.min(4096, summary.length()));
    }
    private static String receiptValue(DatasetGraph dataset, String receipt, String predicate) {
        var iter = dataset.find(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(receipt),
            NodeFactory.createURI(RV + predicate), Node.ANY);
        if (!iter.hasNext()) return null;
        Node value = iter.next().getObject();
        if (iter.hasNext()) throw new IllegalArgumentException("ambiguous receipt " + predicate);
        return value.isURI() ? value.getURI() : value.getLiteralLexicalForm();
    }
    private static Map<String, Object> committed(DatasetGraph dataset, String receipt) {
        String datasetId = receiptValue(dataset, receipt, "datasetId");
        String epoch = receiptValue(dataset, receipt, "dataEpoch");
        String sequence = receiptValue(dataset, receipt, "sequence");
        if (datasetId == null || epoch == null || sequence == null) return Map.of("status", "committed");
        return Map.of("status", "committed", "position", Map.of("datasetId", datasetId, "dataEpoch", epoch, "sequence", sequence));
    }
    private static JsonObject jsonObject(Map<String, ?> payload) {
        JsonObject result = new JsonObject();
        payload.forEach((key, value) -> {
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> nested = new LinkedHashMap<>();
                map.forEach((k, v) -> nested.put(String.valueOf(k), v));
                result.put(key, jsonObject(nested));
            } else if (value instanceof List<?> list) {
                org.apache.jena.atlas.json.JsonArray array = new org.apache.jena.atlas.json.JsonArray();
                for (Object item : list) {
                    if (!(item instanceof Map<?, ?> map)) throw new IllegalArgumentException("JSON list item must be object");
                    Map<String, Object> nested = new LinkedHashMap<>();
                    map.forEach((k, v) -> nested.put(String.valueOf(k), v));
                    array.add(jsonObject(nested));
                }
                result.put(key, array);
            } else if (value instanceof Number number) result.put(key, number.longValue());
            else if (value instanceof Boolean bool) result.put(key, bool);
            else result.put(key, String.valueOf(value));
        });
        return result;
    }
    private static void respond(HttpAction action, int status, Map<String, ?> payload) {
        try {
            action.getResponse().setStatus(status);
            action.getResponse().setContentType("application/json; charset=utf-8");
            JSON.write(action.getResponse().getOutputStream(), jsonObject(payload));
        } catch (IOException ex) { throw new IllegalStateException(ex); }
    }
}
