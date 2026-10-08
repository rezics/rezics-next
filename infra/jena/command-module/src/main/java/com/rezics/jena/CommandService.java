package com.rezics.jena;

import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonArray;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.iterator.Iter;
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
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.jena.shacl.Shapes;
import org.apache.jena.shacl.ValidationReport;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.DatasetGraphWrapperView;
import org.apache.jena.sparql.core.GraphView;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.update.UpdateAction;

final class CommandService extends ActionService {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String SH = "http://www.w3.org/ns/shacl#";
    private static final int MAX_REQUEST = 16_000_000;
    private final ProfileRegistry profiles;
    private final byte[] maintenanceCapability;
    private final byte[] admittedCapability;
    private final byte[] titleAdmissionKey;
    private final String instanceId = java.util.UUID.randomUUID().toString();
    // Odd means one native transaction touching the public index is still open.
    // The TDB write lock serializes those transactions; the counter also changes
    // for a rolled-back attempt, which conservatively invalidates cached proof.
    private final AtomicLong publicSearchWriteEpoch = new AtomicLong();
    private final AtomicLong privateSearchWriteEpoch = new AtomicLong();
    // The image entrypoint leaves this marker after an unclean stop; only the
    // offline empty-index rebuild removes it. Its state is fixed for this JVM.
    private final boolean textIndexUncertain = java.nio.file.Files.exists(java.nio.file.Path.of(
        System.getenv().getOrDefault("FUSEKI_BASE", "."), "databases/rezics/lucene.uncertain"));

    CommandService(ProfileRegistry profiles) {
        this(profiles, capability("FUSEKI_MAINTENANCE_TOKEN"), capability("FUSEKI_COMMAND_TOKEN"), capability("FUSEKI_TITLE_ADMISSION_KEY"));
    }
    CommandService(ProfileRegistry profiles, byte[] maintenance, byte[] admitted, byte[] title) {
        this.profiles = profiles;
        this.maintenanceCapability = maintenance;
        this.admittedCapability = admitted;
        this.titleAdmissionKey = title;
        if (MessageDigest.isEqual(titleAdmissionKey, admittedCapability) || MessageDigest.isEqual(titleAdmissionKey, maintenanceCapability))
            throw new IllegalStateException("title admission key must be independently provisioned");
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
                Map<String, Object> proof = SearchDeltaJournal.qualifiedProof(action.getDataService().getDataset(),
                    Long.parseLong(since), epoch);
                if (publicSearchWriteEpoch.get() != epoch) proof = Map.of("available", false);
                respond(action, 200, proof);
            } catch (IllegalArgumentException | IllegalStateException ex) {
                respond(action, 200, Map.of("available", false));
            }
            return;
        }
        long privateEpoch = privateSearchWriteEpoch.get();
        respond(action, 200, Map.of("moduleVersion", CommandModule.VERSION,
            "instanceId", instanceId, "publicSearchWriteEpoch", Long.toString(epoch),
            "publicSearchWriteActive", (epoch & 1L) != 0L,
            "privateSearchWriteEpoch", Long.toString(privateEpoch),
            "privateSearchWriteActive", (privateEpoch & 1L) != 0L,
            "publicSearchDeltaAvailable", deltaExclusive, "textIndexUncertain", textIndexUncertain,
            "profiles", profiles.digests()));
    }
    @Override public void execPost(HttpAction action) {
        if (!"application/json".equalsIgnoreCase(action.getRequestContentType())) {
            respond(action, 415, Map.of("status", "bad-request", "message", "application/json required")); return;
        }
        try (CommandWork work = new CommandWork()) {
            byte[] bytes = action.getRequestInputStream().readNBytes(MAX_REQUEST + 1);
            if (bytes.length > MAX_REQUEST) throw new IllegalArgumentException("request too large");
            String requestJSON = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
            TitleControlPolicy.commandJSONDepth(requestJSON);
            JsonObject body = JSON.parse(requestJSON);
            if (body.get("titleCandidate") != null) {
                if (!authorized(action, admittedCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                if (!body.keys().equals(Set.of("receipt", "digest", "update", "validations", "deadlineMs", "titleCandidate", "titleAdmission"))
                    || body.get("update") == null || !body.get("update").isString()
                    || !"".equals(body.get("update").getAsString().value())
                    || body.get("validations") == null || !body.get("validations").isArray()
                    || body.get("validations").getAsArray().size() != 0
                    || !body.get("titleCandidate").isObject()
                    || body.get("titleAdmission") == null || !body.get("titleAdmission").isObject()
                    || body.get("deadlineMs") == null || !body.get("deadlineMs").isNumber()
                    || !"10000".equals(body.get("deadlineMs").toString()))
                    throw new IllegalArgumentException("invalid title candidate command envelope");
                String receipt = iri(ProfileRegistry.required(body, "receipt"));
                String digest = ProfileRegistry.required(body, "digest");
                if (!digest.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid title candidate digest");
                JsonObject candidate = body.get("titleCandidate").getAsObject();
                if (!candidate.keys().equals(Set.of("frame", "custodySha256", "mode"))
                    || ProfileRegistry.required(candidate, "frame").getBytes(StandardCharsets.UTF_8).length > 32768)
                    throw new IllegalArgumentException("invalid title candidate command frame");
                long deadline = System.nanoTime() + 10_000_000_000L;
                CommandWork.enter("queue");
                Map<String, Object> result = runTitleCandidate(action.getDataService().getDataset(), receipt, digest,
                    candidate, body.get("titleAdmission"), deadline);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, result); return;
            }
            if (body.get("claimFoldClassifySeal") != null) {
                if (!authorized(action, maintenanceCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                var request = ClaimFoldInventory.parseClassifySeal(bytes);
                var result = ClaimFoldInventory.sealClassification(action.getDataService().getDataset(), request, publicSearchWriteEpoch);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, result); return;
            }
            if (body.get("claimFoldClassify") != null) {
                if (!authorized(action, maintenanceCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                var request = ClaimFoldInventory.parseClassify(bytes);
                var result = ClaimFoldInventory.classify(action.getDataService().getDataset(), request);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, result); return;
            }
            if (body.get("claimFoldRetain") != null) {
                if (!authorized(action, maintenanceCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                var request = ClaimFoldInventory.parseRetain(bytes);
                var result = ClaimFoldInventory.retain(action.getDataService().getDataset(), request, profiles, publicSearchWriteEpoch);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, result); return;
            }
            if (body.get("workScopeDirectory") != null) {
                // Capability before the closed envelope, same as the other maintenance commands.
                if (!authorized(action, maintenanceCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                if (!body.keys().equals(Set.of("workScopeDirectory")) || !body.get("workScopeDirectory").isObject()
                    || !body.get("workScopeDirectory").getAsObject().keys().isEmpty())
                    throw new IllegalArgumentException("invalid work scope directory envelope");
                // One existing page. The 10-second command budget is not widened.
                long deadline = System.nanoTime() + 10_000_000_000L;
                Map<String, Object> result = runWorkScopeDirectory(action.getDataService().getDataset(), deadline);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                // The exclusive-writer refusal is a typed conflict. Prepared and deadline pages stay successful.
                respond(action, "unavailable".equals(result.get("status")) ? 409 : 200, result); return;
            }
            if (body.get("claimFoldMembers") != null) {
                if (!authorized(action, maintenanceCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                var request = ClaimFoldInventory.parseMembers(bytes);
                var result = ClaimFoldInventory.readMembers(action.getDataService().getDataset(), request);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, result); return;
            }
            if (body.get("claimFoldDisposition") != null) {
                if (!authorized(action, maintenanceCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                var request = ClaimFoldInventory.parseDisposition(bytes);
                var result = ClaimFoldInventory.readDisposition(action.getDataService().getDataset(), request);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, result); return;
            }
            if (body.get("claimFoldInventory") != null) {
                // Inventory is an owned maintenance operation. Check its
                // capability before the closed raw-wire decoder or size gate.
                if (!authorized(action, maintenanceCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                if (bytes.length > 16 * 1024 || !body.keys().equals(Set.of("claimFoldInventory")))
                    throw new IllegalArgumentException("invalid Claim inventory envelope");
                var request = ClaimFoldInventory.parse(bytes);
                var result = ClaimFoldInventory.turn(action.getDataService().getDataset(), request);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, ClaimFoldInventory.json(result)); return;
            }
            if (body.get("templateIndex") != null) {
                if (!authorized(action, admittedCapability)) { respond(action,403,Map.of("status","forbidden")); return; }
                respond(action,200,TemplateIndexService.read(action.getDataService().getDataset(),body.get("templateIndex").getAsObject())); return;
            }
            if (body.get("templateQuery") != null) {
                if (!authorized(action, admittedCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                if (bytes.length > 512 * 1024 || body.keys().size() != 1)
                    throw new IllegalArgumentException("invalid template query envelope");
                JsonObject result = TemplateQueryService.select(action.getDataService().getDataset(),
                    body.get("templateQuery").getAsObject());
                action.getResponse().setStatus(200);
                action.getResponse().setContentType("application/sparql-results+json; charset=utf-8");
                JSON.write(action.getResponse().getOutputStream(), result);
                return;
            }
            if (body.get("retireProof") != null) {
                if (bytes.length > 2_000_000 || body.size() != 1)
                    throw new IllegalArgumentException("invalid retirement envelope");
                if (!authorized(action, admittedCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                JsonObject evidence = body.get("retireProof").getAsObject();
                if (evidence.size() != 7) throw new IllegalArgumentException("invalid retirement evidence");
                Map<String, Object> result = retireProof(action.getDataService().getDataset(), new Retirement(
                    iri(ProfileRegistry.required(evidence, "receipt")), ProfileRegistry.required(evidence, "digest"),
                    ProfileRegistry.required(evidence, "payloadSha256"), ProfileRegistry.required(evidence, "dataEpoch"),
                    ProfileRegistry.required(evidence, "sequence"), ProfileRegistry.required(evidence, "streamSequence"),
                    ProfileRegistry.required(evidence, "signature")));
                respond(action, 200, result); return;
            }
            if (body.get("items") != null) {
                if (!authorized(action, admittedCapability)) {
                    respond(action, 403, Map.of("status", "forbidden")); return;
                }
                JsonArray items = body.get("items").getAsArray();
                if (items.isEmpty() || items.size() > 128) throw new IllegalArgumentException("invalid bulk size");
                List<BulkItem> commands = new ArrayList<>();
                java.util.Set<String> receipts = new java.util.HashSet<>();
                for (JsonValue value : items) {
                    JsonObject item = value.getAsObject();
                    String receipt = iri(ProfileRegistry.required(item, "receipt"));
                    String digest = ProfileRegistry.required(item, "digest");
                    String update = ProfileRegistry.required(item, "update");
                    if (CommandPolicy.maintenanceReceipt(receipt) || !receipts.add(receipt))
                        throw new IllegalArgumentException("bulk receipt not admitted");
                    CommandPolicy.Plan plan = CommandPolicy.parse(update, receipt);
                    // Public import batches cannot smuggle recovery, arbitrary
                    // text writes or another command family into their writer.
                    if (!catalogueImport(plan, receipt) || plan.bootstrap() || plan.rebuild()
                        || plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH)
                        || plan.graphs().contains(CommandPolicy.PRIVATE_SEARCH))
                        throw new IllegalArgumentException("bulk requires catalogue import commands");
                    String cancellation = ProfileRegistry.required(item, "cancellation");
                    commands.add(new BulkItem(receipt, digest, update, plan,
                        parseValidations(item.get("validations")), cancellation,
                        CommandPolicy.parse(cancellation, receipt)));
                }
                Map<String, Object> result = runBulk(action.getDataService().getDataset(), commands,
                    System.nanoTime() + 30_000_000_000L);
                action.getResponse().setHeader("Server-Timing", work.serverTiming());
                action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
                respond(action, 200, result); return;
            }
            if (bytes.length > 2_000_000) throw new IllegalArgumentException("single request too large");
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
            CommandWork.enter("queue");
            JsonValue thin = body.get("slim");
            Map<String, Object> result = thin == null
                ? run(action.getDataService().getDataset(), receipt, digest, update, body.get("titleAdmission"), plan, validations, deadline)
                : runSlim(action.getDataService().getDataset(), receipt, digest, update,
                    new Slim(ProfileRegistry.required(thin.getAsObject(), "payloadSha256"),
                        iri(ProfileRegistry.required(thin.getAsObject(), "component")),
                        iri(ProfileRegistry.required(thin.getAsObject(), "revision"))), validations, deadline);
            action.getResponse().setHeader("Server-Timing", work.serverTiming());
            action.getResponse().setHeader("X-Rezics-Command-Work", work.counters());
            respond(action, 200, result);
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
            boolean authorCreditShape = profileId.equals("work-author-credit-v1");
            if (graphs.stream().anyMatch(graph -> !graph.equals(CommandPolicy.CURRENT)
                && !graph.equals(CommandPolicy.REVISIONS)
                && !((translationLinkShape || workDerivationShape || fixedReleaseShape || authorCreditShape) && (graph.equals(CommandPolicy.RECEIPTS)
                    || graph.equals(CommandPolicy.CONTROL)))
                && !(graph.equals(CommandPolicy.SOURCE)
                    && Set.of("source-open-library-work-v1", "source-reification-v1").contains(profileId))
                && !(graph.equals(CommandPolicy.PUBLIC_SEARCH)
                    && profileId.equals("content-match-unit-v1")
                    && shape.equals("https://rezics.com/definition/content-match-unit-v1/unit-shape"))
                && !(graph.equals(CommandPolicy.PRIVATE_SEARCH)
                    && profileId.equals("content-private-match-unit-v1")
                    && shape.equals("https://rezics.com/definition/content-private-match-unit-v1/unit-shape"))))
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
            if (authorCreditShape && !Set.copyOf(graphs).equals(Set.of(CommandPolicy.CURRENT,
                CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS, CommandPolicy.CONTROL)))
                throw new IllegalArgumentException("author credit validation graphs differ");
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

    record Slim(String payloadSha256, String component, String revision) {}
    record Retirement(String receipt, String digest, String payloadSha256, String dataEpoch,
                      String sequence, String streamSequence, String signature) {}

    /** One bounded directory page. The caller retains the cursor and repeats until phase complete. */
    private static Map<String, Object> runWorkScopeDirectory(DatasetGraph dataset, long deadline) {
        synchronized (dataset) {
            dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
            boolean commit = false;
            try {
                TemplateIndexService.workScopeBudget(deadline);
                PublicNameProjection.prepareWorkScopeDirectory(dataset, deadline);
                String phase = PublicNameProjection.workScopeDirectoryPhase(dataset);
                TemplateIndexService.workScopeBudget(deadline);
                CommitHalt.commit(dataset);
                commit = true;
                return Map.of("status", "prepared", "phase", phase, "more", !"complete".equals(phase));
            } catch (java.util.concurrent.CancellationException cancelled) {
                return Map.of("status", "deadline", "phase", "absent", "more", true);
            } catch (IllegalStateException refused) {
                // Only the native exclusive-writer refusal. Every other state failure aborts and stays fatal.
                if (!"Work name scope requires exclusive native writer admission".equals(refused.getMessage())) throw refused;
                return Map.of("status", "unavailable", "reason", "writer-not-exclusive");
            } finally {
                try { if (!commit) dataset.abort(); }
                finally { dataset.end(); }
            }
        }
    }

    /** Closed private acceptance; no source mutation or terminal receipt dispatch. */
    Map<String, Object> runTitleCandidate(DatasetGraph dataset, String receipt, String digest,
        JsonValue candidate, JsonValue proof, long deadline) {
        synchronized (dataset) {
            dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
            boolean commit = false;
            boolean tracksIndex = SearchDeltaJournal.canTrackCommit(dataset);
            if (tracksIndex) {
                publicSearchWriteEpoch.incrementAndGet();
                SearchDeltaJournal.fenceBeforeWrite(dataset);
            }
            try {
                CommandWork.enter("preflight");
                TemplateIndexService.workScopeBudget(deadline);
                try {
                    String frame = ProfileRegistry.required(candidate.getAsObject(), "frame");
                    if (frame.length() > 32768 || frame.getBytes(StandardCharsets.UTF_8).length > 32768)
                        throw new IllegalArgumentException("title candidate frame exceeds its byte bound");
                    TitleControlPolicy.candidateJSONDepth(frame);
                    // Resolve only exact active profile/shape pins; do not execute their source mutation validation.
                    parseValidations(JSON.parseAny(frame).getAsObject().get("validations"));
                } catch (java.util.concurrent.CancellationException cancelled) { throw cancelled;
                } catch (RuntimeException invalid) {
                    TemplateIndexService.workScopeBudget(deadline);
                    return Map.of("status", "conflict", "reason", "title candidate native profile pins differ");
                }
                Map<String, Object> result = new LinkedHashMap<>(TitleControlPolicy.retainCandidate(dataset,
                    receipt, digest, candidate, proof, titleAdmissionKey, deadline));
                Object changed = result.remove("changed");
                if (!(changed instanceof Boolean)) throw new IllegalStateException("title acceptance omitted its write outcome");
                if (!Boolean.TRUE.equals(changed)) return result;
                if (!"accepted".equals(result.get("status")))
                    throw new IllegalStateException("title acceptance changed without an accepted outcome");
                CommandWork.enter("commit");
                TemplateIndexService.workScopeBudget(deadline);
                CommitHalt.commit(dataset); commit = true;
                CommandWork.count("durable_commits", 1);
                return result;
            } catch (java.util.concurrent.CancellationException cancelled) {
                return Map.of("status", "deadline");
            } finally {
                finishNativeWrite(dataset, commit, tracksIndex, false, false, false, false);
            }
        }
    }

    Map<String, Object> runCommand(DatasetGraph dataset, String receipt, String digest, String update,
                                  List<Validation> validations, long deadline) {
        return run(dataset, receipt, digest, update, null, CommandPolicy.parse(update, receipt), validations, deadline);
    }

    Map<String, Object> runSlim(DatasetGraph dataset, String receipt, String digest, String update,
                               Slim slim, List<Validation> validations, long deadline) {
        if (!digest.matches("[0-9a-f]{64}") || !slim.payloadSha256().matches("[0-9a-f]{64}"))
            throw new IllegalArgumentException("invalid slim command digest");
        CommandPolicy.Plan plan = CommandPolicy.parse(update, receipt);
        String footprint = CommandPolicy.slimFootprint(plan, receipt, slim.component(), slim.revision());
        if (footprint != null) return invalid(footprint);
        if (validations.isEmpty() || validations.stream().anyMatch(validation ->
            !Set.of("work-metadata-details-v1", "work-metadata-details-v2").contains(validation.profileId())))
            return invalid("slim command requires metadata profiles");
        synchronized (dataset) {
            return runSerialized(dataset, receipt, digest, update, null, plan, validations, deadline, slim);
        }
    }

    Map<String, Object> retireProof(DatasetGraph dataset, Retirement evidence) {
        // Main signs only after matching the durable owner receipt and exact object.
        // This is a domain-separated custody assertion, never a caller SPARQL delete.
        if (!evidence.digest().matches("[0-9a-f]{64}") || !evidence.payloadSha256().matches("[0-9a-f]{64}")
            || evidence.dataEpoch().isEmpty() || !evidence.sequence().matches("[1-9][0-9]*")
            || !evidence.streamSequence().matches("[1-9][0-9]*"))
            return invalid("owner custody reconciliation evidence is malformed");
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(titleAdmissionKey, "HmacSHA256"));
            String payload = retirementPayload(evidence);
            if (!evidence.signature().matches("[0-9a-f]{64}") || !MessageDigest.isEqual(
                mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)), HexFormat.of().parseHex(evidence.signature())))
                return invalid("owner custody reconciliation signature differs");
        } catch (java.security.GeneralSecurityException ex) { throw new IllegalStateException(ex); }
        synchronized (dataset) {
            dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
            boolean commit = false, tracksIndex = false;
            try {
                CommandInvariant.Control control = CommandInvariant.readControl(dataset);
                if (control == null) return invalid("proof retirement requires valid product control");
                if (control.held()) return invalid("proof retirement cannot run during a graph restore hold");
                CommandInvariant.CommitProof proof = CommandInvariant.commitProof(dataset, evidence.receipt());
                if (proof == null) return Map.of("status", dataset.contains(NodeFactory.createURI(CommandPolicy.RECEIPTS),
                    NodeFactory.createURI(evidence.receipt()), Node.ANY, Node.ANY) ? "conflict" : "retired");
                if (!proof.equals(new CommandInvariant.CommitProof(evidence.digest(), evidence.payloadSha256(),
                    evidence.dataEpoch(), evidence.sequence(), evidence.streamSequence()))) return Map.of("status", "conflict");
                tracksIndex = SearchDeltaJournal.canTrackCommit(dataset);
                if (tracksIndex) {
                    publicSearchWriteEpoch.incrementAndGet();
                    SearchDeltaJournal.fenceBeforeWrite(dataset);
                }
                SearchDeltaJournal.Capture delta = new SearchDeltaJournal.Capture(dataset, false);
                CommandWork.enter("update");
                CommandWork.observe(delta.observed()).deleteAny(NodeFactory.createURI(CommandPolicy.RECEIPTS),
                    NodeFactory.createURI(evidence.receipt()), Node.ANY, Node.ANY);
                if (tracksIndex) SearchDeltaJournal.append(dataset, delta, publicSearchWriteEpoch.get() + 1);
                delta.finishSemanticSources(Long.MAX_VALUE);
                CommandWork.enter("commit");
                SemanticSourceBasis.check(Long.MAX_VALUE);
                TemplateIndexService.workScopeBudget(Long.MAX_VALUE);
                CommitHalt.commit(dataset); commit = true;
                CommandWork.count("durable_commits", 1);
                return Map.of("status", "retired");
            } catch (java.util.concurrent.CancellationException | SemanticSourceBasis.Cancelled cancelled) {
                return Map.of("status", "deadline");
            } finally {
                finishNativeWrite(dataset, commit, tracksIndex, false, false, false, false);
            }
        }
    }

    static String retirementPayload(Retirement evidence) {
        // Canonical compact JSON matches the owner signer; JSON quoting handles all IRI/epoch characters.
        return "[" + java.util.stream.Stream.of("rezics-commit-proof-retirement-v1", evidence.receipt(), evidence.digest(), evidence.payloadSha256(),
            evidence.dataEpoch(), evidence.sequence(), evidence.streamSequence()).map(CommandService::jsonString)
            .collect(java.util.stream.Collectors.joining(",")) + "]";
    }
    private static String jsonString(String value) {
        return JSON.toStringFlat(new org.apache.jena.atlas.json.JsonString(value));
    }

    private static final Set<Node> EDITION_PUBLIC_FIELDS = java.util.stream.Stream.of("name", "bookEdition",
        "publisher", "datePublished", "isbn").map(name -> NodeFactory.createURI("https://schema.org/" + name))
        .collect(java.util.stream.Collectors.toUnmodifiableSet());

    private static List<Quad> editionPublicFacts(DatasetGraph data, Node component, Node revision) {
        Node stored = exactlyOne(data, NodeFactory.createURI(CommandPolicy.REVISIONS), revision, "metadataState");
        if (stored == null || !stored.isLiteral()) throw new IllegalArgumentException("slim edition state is missing");
        JsonObject state = JSON.parse(stored.getLiteralLexicalForm());
        String status = ProfileRegistry.required(state, "status");
        if (!ProfileRegistry.required(state, "kind").equals("edition")
            || !ProfileRegistry.required(state, "id").equals(component.getURI())
            || !Set.of("active", "withdrawn").contains(status)
            || !NodeFactory.createURI(RV + (status.equals("active") ? "Active" : "Withdrawn")).equals(
                exactlyOne(data, NodeFactory.createURI(CommandPolicy.CURRENT), component, "editionState")))
            throw new IllegalArgumentException("slim edition state differs from component");
        List<Quad> facts = new ArrayList<>();
        if (status.equals("withdrawn")) return facts;
        JsonObject title = state.get("title").getAsObject();
        facts.add(new Quad(Quad.defaultGraphNodeGenerated, component, NodeFactory.createURI("https://schema.org/name"),
            NodeFactory.createLiteralLang(ProfileRegistry.required(title, "value"), ProfileRegistry.required(title, "language"))));
        for (String[] field : List.of(new String[]{"editionStatement", "bookEdition"}, new String[]{"publisher", "publisher"},
            new String[]{"isbn13", "isbn"})) {
            JsonValue value = state.get(field[0]);
            if (value != null && !value.isNull()) facts.add(new Quad(Quad.defaultGraphNodeGenerated, component,
                NodeFactory.createURI("https://schema.org/" + field[1]), NodeFactory.createLiteralString(value.getAsString().value())));
        }
        JsonValue year = state.get("publicationYear");
        if (year != null && !year.isNull()) {
            int value = new java.math.BigDecimal(year.getAsNumber().value().toString()).intValueExact();
            if (value < 1 || value > 9999) throw new IllegalArgumentException("slim edition publication year differs");
            facts.add(new Quad(Quad.defaultGraphNodeGenerated, component, NodeFactory.createURI("https://schema.org/datePublished"),
                NodeFactory.createLiteralDT(String.format(java.util.Locale.ROOT, "%04d", value),
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDgYear)));
        }
        return facts;
    }

    /** Shared physical edition partition for live admission and exact held restore. */
    static List<Quad> editionPhysicalFacts(DatasetGraph logical, Node component, Node revision, Node manifest, Node model) {
        List<Quad> logicalFacts = Iter.toList(logical.find(NodeFactory.createURI(CommandPolicy.CURRENT), component, Node.ANY, Node.ANY));
        if (logicalFacts.size() > 64) throw new IllegalArgumentException("slim current component exceeds quad bound");
        List<Quad> physical = new ArrayList<>();
        for (Quad quad : logicalFacts) if (!Set.of(NodeFactory.createURI(RV + "manifest"),
            NodeFactory.createURI(RV + "modelRevision")).contains(quad.getPredicate())
            && !EDITION_PUBLIC_FIELDS.contains(quad.getPredicate()))
            physical.add(new Quad(Quad.defaultGraphNodeGenerated, quad.asTriple()));
        physical.addAll(editionPublicFacts(logical, component, revision));
        physical.add(new Quad(Quad.defaultGraphNodeGenerated, component, NodeFactory.createURI(RV + "manifest"), manifest));
        physical.add(new Quad(Quad.defaultGraphNodeGenerated, component, NodeFactory.createURI(RV + "modelRevision"), model));
        return List.copyOf(physical);
    }

    /** One logical current scope for policy, focused SHACL and text projections.
     * The bounded slim component is physically default-graph data; legacy subjects
     * retain their named storage. Historical envelope types come from its pinned model. */
    static class CurrentScope extends DatasetGraphWrapper implements DatasetGraphWrapperView {
        private static final Node CURRENT = NodeFactory.createURI(CommandPolicy.CURRENT);
        private static final Node REVISIONS = NodeFactory.createURI(CommandPolicy.REVISIONS);
        CurrentScope(DatasetGraph dataset) { super(dataset); }
        private static boolean matches(Node pattern, Node value) {
            return pattern == null || Node.ANY.equals(pattern) || pattern.isVariable() || pattern.equals(value);
        }
        @Override public java.util.Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            if (CURRENT.equals(graph)) return Iter.distinct(Iter.concat(super.find(graph, subject, predicate, object),
                Iter.map(super.find(Quad.defaultGraphNodeGenerated, subject, predicate, object),
                    quad -> new Quad(CURRENT, quad.asTriple()))));
            if (REVISIONS.equals(graph)) return Iter.distinct(Iter.concat(super.find(graph, subject, predicate, object),
                priorRevision(subject, predicate, object).iterator()));
            if (Quad.isUnionGraph(graph)) return Iter.distinct(Iter.map(findNG(Node.ANY, subject, predicate, object),
                quad -> new Quad(Quad.unionGraph, quad.asTriple())));
            return super.find(graph, subject, predicate, object);
        }
        private List<Quad> priorRevision(Node subject, Node predicate, Node object) {
            List<Quad> result = new ArrayList<>();
            if (subject == null || !subject.isURI()) return result;
            var heads = super.find(Quad.defaultGraphNodeGenerated, Node.ANY, NodeFactory.createURI(RV + "metadataHead"), subject);
            try {
                while (heads.hasNext()) {
                    Quad head = heads.next();
                    if (super.contains(REVISIONS, head.getObject(), Node.ANY, Node.ANY)) continue;
                    Node model = exactlyOne(getWrapped(), Quad.defaultGraphNodeGenerated, head.getSubject(), "modelRevision");
                    Node manifest = exactlyOne(getWrapped(), Quad.defaultGraphNodeGenerated, head.getSubject(), "manifest");
                    if (model == null || manifest == null) continue;
                    String type = model.equals(NodeFactory.createURI("https://rezics.com/definition/work-metadata-details-v2"))
                        ? "WorkMetadataDetailsV2Revision" : "WorkMetadataRevision";
                    for (Quad quad : List.of(
                        new Quad(REVISIONS, head.getObject(), org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + type)),
                        new Quad(REVISIONS, head.getObject(), org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + "RevisionAnchor")),
                        new Quad(REVISIONS, head.getObject(), NodeFactory.createURI(RV + "component"), head.getSubject()),
                        new Quad(REVISIONS, head.getObject(), NodeFactory.createURI(RV + "modelRevision"), model),
                        new Quad(REVISIONS, head.getObject(), NodeFactory.createURI(RV + "shapeRevision"), model),
                        new Quad(REVISIONS, head.getObject(), NodeFactory.createURI(RV + "manifest"), manifest)))
                        if (matches(subject, quad.getSubject()) && matches(predicate, quad.getPredicate())
                            && matches(object, quad.getObject())) result.add(quad);
                    if (result.size() > 600) throw new IllegalArgumentException("slim predecessor scope exceeds bound");
                }
            } finally { Iter.close(heads); }
            return result;
        }
        @Override public java.util.Iterator<Quad> find() { return find(Node.ANY, Node.ANY, Node.ANY, Node.ANY); }
        @Override public java.util.Iterator<Quad> find(Quad quad) {
            return find(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
        }
        @Override public java.util.Iterator<Quad> findNG(Node graph, Node subject, Node predicate, Node object) {
            if (Node.ANY.equals(graph)) return Iter.concat(super.findNG(graph, subject, predicate, object),
                Iter.map(super.find(Quad.defaultGraphNodeGenerated, subject, predicate, object),
                    quad -> new Quad(CURRENT, quad.asTriple())));
            return Iter.filter(find(graph, subject, predicate, object), quad -> !quad.isDefaultGraph());
        }
        @Override public boolean contains(Quad quad) {
            return contains(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
        }
        @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
            var rows = find(graph, subject, predicate, object);
            try { return rows.hasNext(); } finally { Iter.close(rows); }
        }
        @Override public void add(Quad quad) {
            Node graph = CURRENT.equals(quad.getGraph()) && getWrapped().contains(
                Quad.defaultGraphNodeGenerated, quad.getSubject(), Node.ANY, Node.ANY)
                ? Quad.defaultGraphNodeGenerated : quad.getGraph();
            getWrapped().add(graph, quad.getSubject(), quad.getPredicate(), quad.getObject());
        }
        @Override public void add(Node graph, Node subject, Node predicate, Node object) { add(new Quad(graph, subject, predicate, object)); }
        @Override public void delete(Quad quad) {
            getWrapped().delete(quad);
            if (CURRENT.equals(quad.getGraph())) getWrapped().delete(Quad.defaultGraphNodeGenerated,
                quad.getSubject(), quad.getPredicate(), quad.getObject());
        }
        @Override public void delete(Node graph, Node subject, Node predicate, Node object) { delete(new Quad(graph, subject, predicate, object)); }
        @Override public void deleteAny(Node graph, Node subject, Node predicate, Node object) {
            Iter.toList(find(graph, subject, predicate, object)).forEach(this::delete);
        }
        @Override public Graph getGraph(Node graph) { return GraphView.createNamedGraph(this, graph); }
        @Override public Graph getDefaultGraph() { return GraphView.createDefaultGraph(this); }
        @Override public Graph getUnionGraph() { return GraphView.createUnionGraph(this); }
        @Override public boolean containsGraph(Node graph) {
            return Quad.isDefaultGraph(graph) || Quad.isUnionGraph(graph) || contains(graph, Node.ANY, Node.ANY, Node.ANY);
        }
        @Override public java.util.Iterator<Node> listGraphNodes() {
            return Iter.distinct(Iter.concat(super.listGraphNodes(),
                super.contains(Quad.defaultGraphNodeGenerated, Node.ANY, Node.ANY, Node.ANY)
                    ? List.of(CURRENT).iterator() : List.<Node>of().iterator()));
        }
    }

    private Map<String, Object> run(DatasetGraph dataset, String receipt, String digest, String update, JsonValue titleAdmission, CommandPolicy.Plan plan,
                                    List<Validation> validations, long deadline) {
        // Jena may release its writer transaction at commit, before end(). Keep
        // native writers serialized until the post-commit baseline is maintained.
        synchronized (dataset) {
            return runSerialized(dataset, receipt, digest, update, titleAdmission, plan, validations, deadline);
        }
    }

    private static boolean catalogueImport(CommandPolicy.Plan plan, String receipt) {
        if (!(plan.request().getOperations().getFirst() instanceof org.apache.jena.sparql.modify.request.UpdateModify modify)) return false;
        return modify.getInsertQuads().stream().anyMatch(quad ->
            quad.getGraph().getURI().equals(CommandPolicy.RECEIPTS)
            && quad.getSubject().getURI().equals(receipt)
            && quad.getPredicate().getURI().equals(RV + "commandFamily")
            && quad.getObject().isLiteral()
            && quad.getObject().getLiteralLexicalForm().equals("work-catalogue-import-v1"));
    }

    record BulkItem(String receipt, String digest, String update, CommandPolicy.Plan plan,
                    List<Validation> validations, String cancellation, CommandPolicy.Plan cancellationPlan) {}

    /** One real transaction, with independently validated, discardable items.
     * A process/commit failure loses the whole physical batch; receipt replay
     * reconciles it. Validation/CAS failures cancel only their own admission. */
    Map<String, Object> runBulk(DatasetGraph dataset, List<BulkItem> items, long deadline) {
        synchronized (dataset) {
            dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
            boolean commit = false, changed = false;
            boolean tracksIndex = SearchDeltaJournal.canTrackCommit(dataset);
            if (tracksIndex) {
                publicSearchWriteEpoch.incrementAndGet();
                SearchDeltaJournal.fenceBeforeWrite(dataset);
            }
            List<Map<String, Object>> results = new ArrayList<>();
            var batchDelta = new SearchDeltaJournal.Capture(dataset, false, deadline);
            try {
                batchDelta.sourceDeadline(deadline);
                if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                    throw new java.util.concurrent.CancellationException("native command cancelled or expired");
                for (BulkItem item : items) {
                    if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                        return bulkDeadline(items);
                    CommandOverlay staged = new CommandOverlay(new CurrentScope(batchDelta.observed()));
                    var publicationMembership = new StatementPublicationMembership(staged, item.plan());
                    SearchDeltaJournal.Capture delta = null;
                    Map<String, Object> result = evaluate(staged, item.receipt(), item.digest(), item.update(),
                        null, item.plan(), item.validations(), deadline, delta);
                    if (Set.of("invalid", "guard-unmatched").contains(result.get("status"))) {
                        // No RDF or Lucene change from the failed candidate has
                        // escaped. Seal its admission at the next logical position.
                        staged = new CommandOverlay(new CurrentScope(batchDelta.observed()));
                        delta = null;
                        String cancellation = item.cancellation().replace("\"candidate-failed\"",
                            "\"" + ("invalid".equals(result.get("status")) ? "invalid" : "stale") + "\"");
                        var cancelled = evaluate(staged, item.receipt(), item.digest(), cancellation, null,
                            CommandPolicy.parse(cancellation, item.receipt()), List.of(), deadline, delta);
                        if (!"committed".equals(cancelled.get("status"))) result = cancelled;
                    }
                    if ("deadline".equals(result.get("status"))) return bulkDeadline(items);
                    if ("committed".equals(result.get("status")) || "invalid".equals(result.get("status"))
                        || "guard-unmatched".equals(result.get("status"))) {
                        if ("committed".equals(result.get("status"))) publicationMembership.advance(item.receipt());
                        changed |= staged.changed();
                        staged.apply();
                    }
                    results.add(result);
                }
                if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                    return bulkDeadline(items);
                if (changed) {
                    // One journal entry per physical commit, so a large names-only
                    // import cannot evict the qualified baseline with item entries.
                    if (tracksIndex) SearchDeltaJournal.append(dataset, batchDelta, publicSearchWriteEpoch.get() + 1, deadline);
                    if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                        return bulkDeadline(items);
                    batchDelta.finishSemanticSources(deadline);
                    CommandWork.enter("commit");
                    SemanticSourceBasis.check(deadline);
                    TemplateIndexService.workScopeBudget(deadline);
                    CommitHalt.commit(dataset); commit = true;
                    CommandWork.count("durable_commits", 1);
                }
                return Map.of("items", results);
            } catch (java.util.concurrent.CancellationException | SemanticSourceBasis.Cancelled cancelled) {
                return bulkDeadline(items);
            } finally {
                // Lucene rollback performs interruptible I/O; preserve cancellation after cleanup.
                boolean interrupted = Thread.interrupted();
                try { if (!commit) dataset.abort(); }
                finally {
                    try {
                        dataset.end();
                        if (commit && tracksIndex && !Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(dataset,
                            -1, publicSearchWriteEpoch.get() + 1).get("available"))) SearchDeltaJournal.invalidate(dataset);
                    } finally {
                        if (tracksIndex) publicSearchWriteEpoch.incrementAndGet();
                        if (interrupted) Thread.currentThread().interrupt();
                    }
                }
            }
        }
    }

    private static Map<String, Object> bulkDeadline(List<BulkItem> items) {
        // No item result survives a cancellation of the shared physical commit.
        return Map.of("status", "deadline", "items",
            java.util.Collections.nCopies(items.size(), Map.of("status", "deadline")));
    }

    private Map<String, Object> runSerialized(DatasetGraph dataset, String receipt, String digest, String update,
                                             JsonValue titleAdmission, CommandPolicy.Plan plan,
                                             List<Validation> validations, long deadline) {
        return runSerialized(dataset, receipt, digest, update, titleAdmission, plan, validations, deadline, null);
    }
    private Map<String, Object> runSerialized(DatasetGraph dataset, String receipt, String digest, String update,
                                             JsonValue titleAdmission, CommandPolicy.Plan plan,
                                             List<Validation> validations, long deadline, Slim slim) {
        if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
            return Map.of("status", "deadline");
        dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
        CommandWork.enter("preflight");
        boolean touchesPublicIndex = plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH);
        boolean touchesPrivateIndex = plan.graphs().contains(CommandPolicy.PRIVATE_SEARCH);
        // Every text-wrapper commit can publish a merge or a mapped field in
        // another graph. Journal those commits without inventing public units.
        boolean tracksIndex = touchesPublicIndex || touchesPrivateIndex || SearchDeltaJournal.canTrackCommit(dataset);
        if (tracksIndex) {
            publicSearchWriteEpoch.incrementAndGet();
            SearchDeltaJournal.fenceBeforeWrite(dataset);
        }
        if (touchesPrivateIndex) privateSearchWriteEpoch.incrementAndGet();
        SearchDeltaJournal.Capture delta = new SearchDeltaJournal.Capture(dataset, touchesPublicIndex && plan.rebuild(), deadline);
        boolean commit = false;
        try {
            delta.sourceDeadline(deadline);
            if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                throw new java.util.concurrent.CancellationException("native command cancelled or expired");
            boolean replay = receiptValue(dataset, receipt, "requestDigest") != null;
            // The fixed Claim fold validates a Claim prestate and a source-free,
            // evidence-empty Statement; it cannot change publication potential.
            var publicationMembership = ClaimStatementFoldPolicy.applies(receipt)
                ? null : new StatementPublicationMembership(dataset, plan);
            Map<String, Object> result;
            if (MetadataRestorePolicy.applies(receipt)) {
                if (slim != null) return invalid("metadata restore cannot carry a live slim envelope");
                result = evaluateMetadataRestore(delta.observed(), receipt, digest, update,
                    plan, validations, deadline, tracksIndex ? delta : null);
            } else if (slim == null) result = evaluate(new CurrentScope(delta.observed()), receipt, digest, update,
                titleAdmission, plan, validations, deadline, tracksIndex ? delta : null);
            else {
                CommandInvariant.CommitProof existing = CommandInvariant.commitProof(dataset, receipt);
                if (existing != null) return existing.digest().equals(digest)
                    && existing.payloadSha256().equals(slim.payloadSha256()) ? committed(dataset, receipt)
                    : Map.of("status", "conflict");
                if (receiptValue(dataset, receipt, "requestDigest") != null) return Map.of("status", "conflict");
                CurrentScope sink = new CurrentScope(delta.observed()) {
                    @Override public void add(Quad quad) { if (persist(quad)) super.add(quad); }
                    @Override public void delete(Quad quad) { if (persist(quad)) super.delete(quad); }
                    private boolean persist(Quad quad) {
                        return !Set.of(NodeFactory.createURI(CommandPolicy.RECEIPTS),
                            NodeFactory.createURI(CommandPolicy.REVISIONS), NodeFactory.createURI(CommandPolicy.OUTBOX))
                            .contains(quad.getGraph())
                            && !(quad.getGraph().equals(NodeFactory.createURI(CommandPolicy.CURRENT))
                                && quad.getSubject().equals(NodeFactory.createURI(slim.component())));
                    }
                };
                Node component = NodeFactory.createURI(slim.component()), revision = NodeFactory.createURI(slim.revision());
                Node current = NodeFactory.createURI(CommandPolicy.CURRENT), revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
                if (sink.contains(revisions, revision, Node.ANY, Node.ANY)) return invalid("slim revision is not fresh");
                Node priorHead = exactlyOne(sink, current, component, "metadataHead");
                Node priorWork = exactlyOne(sink, current, component, "work");
                CommandInvariant.Control beforeControl = CommandInvariant.readControl(sink);
                if (beforeControl == null || beforeControl.held()) return invalid("slim command requires active product lineage");
                if (priorHead == null && sink.contains(current, component, NodeFactory.createURI(RV + "metadataHead"), Node.ANY)
                    || priorWork == null && sink.contains(current, component, NodeFactory.createURI(RV + "work"), Node.ANY))
                    return invalid("slim metadata CAS prestate is ambiguous");
                CommandOverlay staged = new CommandOverlay(sink);
                result = evaluate(staged, receipt, digest, update, null, plan, validations, deadline, null, true);
                if (!"committed".equals(result.get("status"))) return result;
                Node manifest = exactlyOne(staged, revisions, revision, "manifest");
                Node model = exactlyOne(staged, revisions, revision, "modelRevision");
                if (manifest == null || !manifest.isURI() || !manifest.getURI().matches("urn:rezics:sha256:[0-9a-f]{64}")
                    || model == null || !Set.of(NodeFactory.createURI("https://rezics.com/definition/work-metadata-details-v1"),
                        NodeFactory.createURI("https://rezics.com/definition/work-metadata-details-v2")).contains(model))
                    return invalid("slim metadata manifest or model is incomplete");
                Node receipts = NodeFactory.createURI(CommandPolicy.RECEIPTS), own = NodeFactory.createURI(receipt);
                Node work = exactlyOne(staged, receipts, own, "work");
                Node scope = exactlyOne(staged, receipts, own, "admittedScope");
                Node admission = exactlyOne(staged, receipts, own, "admissionId");
                Node authority = exactlyOne(staged, receipts, own, "authorityEpoch");
                if (work == null || !work.isURI() || !work.equals(exactlyOne(staged, current, component, "work"))
                    || priorWork != null && !priorWork.equals(work)
                    || scope == null || !scope.equals(NodeFactory.createLiteralString("work:edit:" + work.getURI()))
                    || admission == null || !admission.isLiteral()
                    || !admission.getLiteralLexicalForm().matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                    || authority == null || !authority.isLiteral() || !authority.getLiteralLexicalForm().matches("[0-9]+")
                    || !component.equals(exactlyOne(staged, revisions, revision, "component"))
                    || !component.equals(exactlyOne(staged, receipts, own, "metadataComponent"))
                    || !revision.equals(exactlyOne(staged, receipts, own, "metadataRevision"))
                    || !revision.equals(exactlyOne(staged, receipts, own, "workRevision"))
                    || !NodeFactory.createLiteralString("work.edit").equals(exactlyOne(staged, receipts, own, "action"))
                    || !NodeFactory.createLiteralString(model.getURI().substring("https://rezics.com/definition/".length()))
                        .equals(exactlyOne(staged, receipts, own, "commandFamily"))
                    || !(priorHead == null ? component : priorHead).equals(exactlyOne(staged, receipts, own, "expectedHead")))
                    return invalid("slim metadata owner, scope or CAS basis differs");
                Node predecessor = exactlyOne(staged, revisions, revision, "predecessor");
                if (!NodeFactory.createURI(RV + "Succeeded").equals(exactlyOne(staged, receipts, own, "outcome"))
                    || !(priorHead == null ? predecessor == null
                        && !staged.contains(revisions, revision, NodeFactory.createURI(RV + "predecessor"), Node.ANY)
                        : priorHead.equals(predecessor))
                    || !revision.equals(exactlyOne(staged, current, component, "metadataHead"))
                    || !NodeFactory.createURI("urn:rezics:dataset:product").equals(exactlyOne(staged, revisions, revision, "datasetId"))
                    || !java.util.Objects.equals(exactlyOne(staged, receipts, own, "dataEpoch"),
                        exactlyOne(staged, revisions, revision, "dataEpoch"))
                    || !java.util.Objects.equals(exactlyOne(staged, receipts, own, "sequence"),
                        exactlyOne(staged, revisions, revision, "sequence")))
                    return invalid("slim success revision differs from exact CAS position");
                List<Quad> physicalFacts;
                try { physicalFacts = editionPhysicalFacts(staged, component, revision, manifest, model); }
                catch (RuntimeException malformed) { return invalid("slim edition physical state is invalid"); }
                // The existing allocator stamped the temporary batch in this same
                // overlay. Its stream control persists while graph outbox facts do not.
                Node streamSequence = exactlyOne(staged, NodeFactory.createURI(CommandPolicy.CONTROL),
                    NodeFactory.createURI(CommandInvariant.MAIN_STREAM_SCOPE), "streamSequence");
                if (streamSequence == null || !streamSequence.isLiteral()
                    || !streamSequence.getLiteralLexicalForm().matches("[1-9][0-9]*"))
                    return invalid("slim command requires an exact Main stream position");
                staged.apply();
                dataset.deleteAny(current, component, Node.ANY, Node.ANY);
                dataset.deleteAny(Quad.defaultGraphNodeGenerated, component, Node.ANY, Node.ANY);
                physicalFacts.forEach(quad -> dataset.add(quad.getGraph(),quad.getSubject(),quad.getPredicate(),quad.getObject()));
                CommandInvariant.Control after = CommandInvariant.readControl(dataset);
                CommandInvariant.writeCommitProof(dataset, receipt, new CommandInvariant.CommitProof(digest,
                    slim.payloadSha256(), after.epoch().getLiteralLexicalForm(), after.sequence().toString(),
                    streamSequence.getLiteralLexicalForm()));
                if (tracksIndex) SearchDeltaJournal.append(dataset, delta, publicSearchWriteEpoch.get() + 1, deadline);
            }
            if (!"committed".equals(result.get("status"))) return result;
            // Replay repair and journal refresh are writes too. Guard their
            // final publication after all validation and mapping work.
            if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                return Map.of("status", "deadline");
            delta.finishSemanticSources(deadline);
            // TDB advances its data version even for an empty writer commit.
            // A validated durable replay must leave the native scope proof unchanged.
            // Content replay repair touches its retained unit and must commit that bounded repair.
            // Exact Content replay has verified the committed reader and retained
            // original pins; an empty Lucene commit would discard that qualification.
            if (replay && (delta.contentReplayIntact() || delta.changes().isEmpty())) return result;
            if (publicationMembership != null) publicationMembership.advance(receipt);
            CommandWork.enter("commit");
            if (ClaimStatementFoldPolicy.applies(receipt)
                && (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline))
                return Map.of("status", "deadline");
            SemanticSourceBasis.check(deadline);
            TemplateIndexService.workScopeBudget(deadline);
            CommitHalt.commit(dataset); commit = true;
            CommandWork.count("durable_commits", 1);
            return result;
        } catch (java.util.concurrent.CancellationException | SemanticSourceBasis.Cancelled cancelled) {
            return Map.of("status", "deadline");
        } finally {
            finishNativeWrite(dataset, commit, tracksIndex, touchesPrivateIndex, touchesPublicIndex,
                plan.rebuild(), plan.bootstrap() || receipt.startsWith("urn:rezics:receipt:content-rebuild:activate:"));
        }
    }
    private void finishNativeWrite(DatasetGraph dataset, boolean commit, boolean tracksIndex,
                                   boolean touchesPrivateIndex, boolean touchesPublicIndex,
                                   boolean rebuild, boolean qualifyGeneration) {
        // Lucene rollback performs interruptible I/O; preserve cancellation after cleanup.
        boolean interrupted = Thread.interrupted();
        try { if (!commit) dataset.abort(); }
        finally {
            try {
                dataset.end();
                CommandWork.enter("qualification");
                if (commit && tracksIndex) {
                    // Keep the odd process epoch and native writer monitor until
                    // qualification completes, including receipt-only commits.
                    try {
                        if (qualifyGeneration) SearchDeltaJournal.qualify(dataset);
                        else if (touchesPublicIndex && rebuild) SearchDeltaJournal.invalidate(dataset);
                        else if (!Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(dataset, -1,
                            publicSearchWriteEpoch.get() + 1).get("available"))) SearchDeltaJournal.invalidate(dataset);
                    } catch (RuntimeException unavailable) { SearchDeltaJournal.invalidate(dataset); }
                }
            } finally {
                if (tracksIndex) publicSearchWriteEpoch.incrementAndGet();
                if (touchesPrivateIndex) privateSearchWriteEpoch.incrementAndGet();
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }
    private Map<String, Object> evaluate(DatasetGraph dataset, String receipt, String digest, String update,
                                        JsonValue titleAdmission, CommandPolicy.Plan plan, List<Validation> validations,
                                        long deadline, SearchDeltaJournal.Capture delta) {
        return evaluate(dataset, receipt, digest, update, titleAdmission, plan, validations, deadline, delta, false);
    }
    private Map<String, Object> evaluate(DatasetGraph dataset, String receipt, String digest, String update,
                                        JsonValue titleAdmission, CommandPolicy.Plan plan, List<Validation> validations,
                                        long deadline, SearchDeltaJournal.Capture delta, boolean slim) {
        boolean touchesPublicIndex = plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH);
            if (ErasureRestorePolicy.applies(receipt)) {
                var before = ErasureRestorePolicy.capture(dataset, plan, receipt, digest,
                    update, titleAdmission, titleAdmissionKey);
                if (before.error() != null) return invalid(before.error());
                if (before.replayed()) return committed(dataset, receipt);
                String preflight = CommandInvariant.preflight(dataset, receipt, plan);
                if (preflight != null) return invalid(preflight);
                if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
                var staged = new CommandOverlay(dataset);
                UpdateAction.execute(plan.request(), DatasetFactory.wrap(staged));
                String report = ErasureRestorePolicy.check(staged, before);
                if (report != null) return invalid(report);
                if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
                staged.apply();
                if (delta != null) SearchDeltaJournal.append(dataset, delta, publicSearchWriteEpoch.get() + 1, deadline);
                return committed(dataset, receipt);
            }
            String existing = receiptValue(dataset, receipt, "requestDigest");
            if (existing != null) {
                if (!existing.equals(digest)
                    || (StatementUpgradePolicy.applies(receipt) && !StatementUpgradePolicy.templateDigest(update)
                        .equals(receiptValue(dataset, receipt, "statementUpgradeTemplateDigest")))
                    || (ClaimStatementFoldPolicy.applies(receipt) && !ClaimStatementFoldPolicy.templateDigest(update)
                        .equals(receiptValue(dataset, receipt, "claimFoldTemplateDigest"))))
                    return Map.of("status", "conflict");
                if (delta != null) SearchDeltaJournal.repairContentReceipt(dataset, receipt, delta, publicSearchWriteEpoch.get() + 1);
                Map<String,Object> replay = new LinkedHashMap<>(committed(dataset,receipt));
                // Native maintenance does not retain a template-directory delta
                // on its initial commit; replay returns that same receipt result.
                if (!slim && !StatementUpgradePolicy.applies(receipt) && !ClaimStatementFoldPolicy.applies(receipt))
                    replay.put("templateIndex",TemplateIndexService.replay(dataset,receipt,plan));
                return replay;
            }
            String legacySlim = slim ? null : CommandInvariant.legacySlimMutation(dataset, plan);
            if (legacySlim != null) return invalid(legacySlim);
            String preflight = CommandInvariant.preflight(dataset, receipt, plan);
            if (preflight != null) return invalid(preflight);
            if (ClaimStatementFoldPolicy.applies(receipt)) {
                if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) return Map.of("status", "deadline");
                String inventory = ClaimFoldInventory.conversionGate(dataset, plan, receipt, deadline);
                if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) return Map.of("status", "deadline");
                if (inventory != null) return invalid(inventory);
                return evaluateClaimStatementFold(dataset, receipt, digest, update, plan, validations, deadline, delta);
            }
            if (StatementUpgradePolicy.applies(receipt))
                return evaluateStatementUpgrade(dataset, receipt, digest, update, plan, validations, deadline, delta);
            String erasure = ErasurePolicy.preflight(dataset, plan, receipt);
            if (erasure != null) return invalid(erasure);
            String authorCredit = AuthorCreditPolicy.preflight(dataset, plan);
            if (authorCredit != null) return invalid(authorCredit);
            String nativeChild = NativeChildPolicy.preflight(dataset, plan, receipt, digest,
                update, titleAdmission, titleAdmissionKey);
            if (nativeChild != null) return invalid(nativeChild);
            CommandInvariant.Control before = plan.bootstrap() ? null : CommandInvariant.readControl(dataset);
            HeadCasPolicy.Snapshot heads = HeadCasPolicy.capture(dataset, plan, receipt);
            ProtectionPolicy.Snapshot protection = ProtectionPolicy.capture(dataset, plan, receipt, digest,
                update, titleAdmission, titleAdmissionKey);
            TitleControlPolicy.Snapshot title = TitleControlPolicy.capture(dataset, plan, receipt, digest,
                update, titleAdmission, titleAdmissionKey, protection != null && protection.action() != null);
            EditorialFieldPolicy.Snapshot editorialField = EditorialFieldPolicy.capture(dataset, plan,
                receipt, digest, update, titleAdmission, titleAdmissionKey,
                protection != null && protection.action() != null);
            RebuildPolicy.Snapshot rebuild = RebuildPolicy.capture(dataset, plan, receipt);
            ModelMutationPolicy.Snapshot model = ModelMutationPolicy.capture(profiles, dataset, plan);
            var releaseCoverage = ReleaseCoveragePolicy.capture(dataset, model);
            java.util.Map<String, ReleasePolicy.Prior> releases = ReleasePolicy.capture(dataset, plan);
            OccurrenceLabelIndex.Capture occurrenceLabels = new OccurrenceLabelIndex.Capture(dataset);
            List<TemplateIndexService.Entity> templateBefore = slim ? List.of() : TemplateIndexService.capture(dataset,plan);
            CommandWork.enter("update");
            // Inspect the bounded actual primary delta, not the declared
            // template size. Apply through the existing observation chain so
            // text/search captures and native projections retain their order.
            CommandOverlay primary = new CommandOverlay(CommandWork.observe(occurrenceLabels.observed(dataset)));
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(primary));
            MembershipNormalFormPolicy.Result membership = MembershipNormalFormPolicy.check(primary, profiles, deadline);
            if (membership.error() != null) return invalid(membership.error());
            primary.apply();
            CommandWork.enter("invariants");
            String stored = receiptValue(dataset, receipt, "requestDigest");
            if (stored == null) return Map.of("status", "guard-unmatched");
            if (!stored.equals(digest)) return Map.of("status", "conflict");
            String invariant = CommandInvariant.check(dataset, receipt, digest, plan, before);
            if (invariant != null) return invalid(invariant);
            String creditInvariant = AuthorCreditPolicy.check(dataset, plan);
            if (creditInvariant != null) return invalid(creditInvariant);
            String childInvariant = NativeChildPolicy.check(dataset, plan);
            if (childInvariant != null) return invalid(childInvariant);
            String headInvariant = HeadCasPolicy.check(dataset, receipt, heads, model);
            if (headInvariant != null) return invalid(headInvariant);
            String titleInvariant = TitleControlPolicy.check(dataset, receipt, title);
            if (titleInvariant != null) return invalid(titleInvariant);
            String fieldInvariant = EditorialFieldPolicy.check(dataset, receipt, editorialField);
            if (fieldInvariant != null) return invalid(fieldInvariant);
            String protectionInvariant = ProtectionPolicy.check(dataset, receipt, protection);
            if (protectionInvariant != null) return invalid(protectionInvariant);
            String rebuildInvariant = RebuildPolicy.check(dataset, receipt, rebuild);
            if (rebuildInvariant != null) return invalid(rebuildInvariant);
            Set<String> retiredCoverage = ReleaseCoveragePolicy.retired(dataset, receipt, model, releaseCoverage);
            Map<String, Object> modelInvariant = ModelMutationPolicy.check(profiles, dataset, plan, receipt,
                ReleaseCoveragePolicy.remaining(model, retiredCoverage), membership.validatedLists());
            if (modelInvariant != null) return modelInvariant;
            String releaseInvariant = ReleasePolicy.check(dataset, plan, receipt, releases);
            if (releaseInvariant != null) return invalid(releaseInvariant);
            Set<String> retiredCurrent = new java.util.HashSet<>(retiredCoverage);
            for (String subject : ChapterPostMigrationPolicy.retired(dataset, receipt, model)) {
                if (!dataset.find(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(subject),
                    Node.ANY, Node.ANY).hasNext()) retiredCurrent.add(subject);
            }
            Map<String, Object> scope = validateScope(dataset, receipt, plan, validations, retiredCurrent, membership.validatedLists());
            if (scope != null) return scope;
            String sourceBinding = SourceProjectionPolicy.check(dataset, receipt, plan);
            if (sourceBinding != null) return invalid(sourceBinding);
            String erasureInvariant = ErasurePolicy.check(dataset, plan);
            if (erasureInvariant != null) return invalid(erasureInvariant);
            // Several independently bound instances of one profile may share a
            // compound command. Every instance still requires its complete roles.
            record Instance(String profile, Map<String, String> binding) {}
            Map<Instance, List<Validation>> grouped = new LinkedHashMap<>();
            for (Validation entry : validations) grouped.computeIfAbsent(new Instance(entry.profileId(), entry.binding()), ignored -> new ArrayList<>()).add(entry);
            for (var group : grouped.entrySet()) {
                String report = BindingPolicy.check(dataset, group.getKey().profile(),
                    profiles.get(group.getKey().profile()).binding(), group.getValue());
                if (report != null) return invalid(report);
            }
            for (Validation validation : validations) {
                Map<String, Object> invalid = validateNativeFocus(dataset, validation, membership.validatedLists());
                if (invalid != null) return invalid;
                if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            }
            if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            occurrenceLabels.refresh(receipt);
            if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            Map<String, Object> result = committed(dataset, receipt);
            if (!result.containsKey("position")) return Map.of("status", "invalid", "report", "receipt position incomplete");
            result = new LinkedHashMap<>(result);
            // Slim edition metadata contains none of the template directory's four entity kinds.
            // Its owner replay remains custodied without retaining unrelated derived payloads.
            if (!slim) {
                var templateDelta = TemplateIndexService.refresh(dataset,templateBefore,plan);
                TemplateIndexService.retain(dataset,receipt,templateDelta);
                result.put("templateIndex",templateDelta);
            }
            CommandWork.enter("projections");
            PublicNameProjection.refresh(CommandWork.observe(dataset), plan, receipt, validations, delta == null ? List.of() : delta.changes());
            RatingPopulationProjection.refresh(CommandWork.observe(dataset), plan, receipt, validations);
            CommandWork.enter("journal");
            if (delta != null) {
                if (touchesPublicIndex && !plan.bootstrap() && !plan.rebuild()
                    && !receipt.startsWith("urn:rezics:receipt:chapter-search-index:")) {
                    if (CatalogueNamePolicy.namesOnly(plan)) {
                        String namesInvariant = CatalogueNamePolicy.check(dataset, receipt, delta.changes());
                        if (namesInvariant != null) return invalid(namesInvariant);
                    } else {
                        String claimed = receiptValue(dataset, receipt, "matchUnit");
                        if (!SearchDeltaJournal.matchesClaim(delta.changes(), claimed))
                            return invalid("public MatchUnit differs from receipt claim");
                    }
                }
                if (plan.bootstrap()) SearchDeltaJournal.initialize(dataset);
                else {
                    SearchDeltaJournal.retainContentReceiptSource(dataset, receipt);
                    SearchDeltaJournal.append(dataset, delta, publicSearchWriteEpoch.get() + 1, deadline);
                }
            }
        String streamInvariant = CommandInvariant.advanceRelayStream(dataset, receipt, plan, before);
        if (streamInvariant != null) return invalid(streamInvariant);
        MembershipNormalFormPolicy.applied(dataset, membership);
        return result;
    }

    /** Metadata recovery reconstructs the custodied representation without dispatching a new product command. */
    private Map<String, Object> evaluateMetadataRestore(DatasetGraph physical, String receipt, String digest,
        String update, CommandPolicy.Plan plan, List<Validation> validations, long deadline, SearchDeltaJournal.Capture delta) {
        String existing = receiptValue(physical, receipt, "requestDigest");
        if (existing != null) return existing.equals(digest)
            && MetadataRestorePolicy.templateDigest(update).equals(receiptValue(physical, receipt, "metadataRestoreTemplateDigest"))
            ? committed(physical, receipt) : Map.of("status", "conflict");
        if (validations.isEmpty() || validations.stream().anyMatch(entry -> !Set.of("work-metadata-details-v1", "work-metadata-details-v2")
            .contains(entry.profileId()))) return invalid("metadata restore requires its original edition profiles");
        var snapshot = MetadataRestorePolicy.capture(physical, receipt, digest, plan, CommandService::editionPhysicalFacts);
        if (snapshot.error() != null) return invalid(snapshot.error());
        if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        DatasetGraph logical = snapshot.logical();
        Map<String, Object> scope = validateScope(logical, receipt, snapshot.plan(), validations, Set.of(), Set.of());
        if (scope != null) return scope;
        record Instance(String profile, Map<String, String> binding) {}
        Map<Instance, List<Validation>> grouped = new LinkedHashMap<>();
        for (Validation entry : validations) grouped.computeIfAbsent(new Instance(entry.profileId(), entry.binding()),
            ignored -> new ArrayList<>()).add(entry);
        for (var group : grouped.entrySet()) {
            String report = BindingPolicy.check(logical, group.getKey().profile(),
                profiles.get(group.getKey().profile()).binding(), group.getValue());
            if (report != null) return invalid(report);
        }
        for (Validation validation : validations) {
            Map<String, Object> invalid = validateOne(logical, validation);
            if (invalid != null) return invalid;
            if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        }
        if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        CommandWork.enter("update");
        CommandOverlay primary = new CommandOverlay(CommandWork.observe(physical));
        MetadataRestorePolicy.apply(primary, snapshot);
        MembershipNormalFormPolicy.Result membership = MembershipNormalFormPolicy.check(primary, profiles, deadline);
        if (membership.error() != null) return invalid(membership.error());
        String stagedInvariant = MetadataRestorePolicy.check(primary, snapshot);
        if (stagedInvariant != null) return invalid(stagedInvariant);
        if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        // Apply the proved bounded operation through its Node writer overload;
        // live persistence observers and injected failures see the same calls.
        MetadataRestorePolicy.apply(CommandWork.observe(physical), snapshot);
        CommandWork.enter("invariants");
        String invariant = MetadataRestorePolicy.check(physical, snapshot);
        if (invariant != null) return invalid(invariant);
        physical.add(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(receipt),
            MetadataRestorePolicy.templateDigestPredicate(), NodeFactory.createLiteralString(MetadataRestorePolicy.templateDigest(update)));
        if (delta != null) SearchDeltaJournal.append(physical, delta, publicSearchWriteEpoch.get() + 1, deadline);
        // The dataset remains held at zero; owner custody retains the old event and both source positions.
        MembershipNormalFormPolicy.applied(physical, membership);
        return committed(physical, receipt);
    }

    /** One fixed retained Claim fold; generic canonical retyping remains refused. */
    private Map<String, Object> evaluateClaimStatementFold(DatasetGraph dataset, String receipt, String digest,
        String update, CommandPolicy.Plan plan, List<Validation> validations, long deadline,
        SearchDeltaJournal.Capture delta) {
        var control = CommandInvariant.readControl(dataset);
        var before = ClaimStatementFoldPolicy.capture(dataset, receipt, digest, plan);
        if (before.error() != null) return invalid(before.error());
        List<Validation> nativeValidations = List.of();
        Node claim = null;
        if (!plan.current().isEmpty()) {
            claim = claimFoldReceiptTerm(plan, receipt, "convertedClaim");
            Node source = claimFoldReceiptTerm(plan, receipt, "sourceClaimRevision");
            Node revision = claimFoldReceiptTerm(plan, receipt, "statementRevision");
            nativeValidations = List.of(
                new Validation("statement-v1", profiles.get("statement-v1"),
                    "https://rezics.com/definition/statement-v1/statement-shape", List.of(claim.getURI()),
                    List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()),
                new Validation("statement-v1", profiles.get("statement-v1"),
                    "https://rezics.com/definition/statement-v1/revision-shape", List.of(revision.getURI()),
                    List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
            for (var focus : List.of(Map.entry("claim", claim), Map.entry("revision", source))) {
                Map<String, Object> report = validateOne(dataset, new Validation("claim-v1", profiles.get("claim-v1"),
                    "https://rezics.com/definition/claim-v1/" + focus.getKey() + "-shape",
                    List.of(focus.getValue().getURI()), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
                if (report != null) return report;
                if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            }
        }
        if (validations.size() != nativeValidations.size())
            return invalid("Claim fold validation footprint differs");
        for (Validation expected : nativeValidations) if (validations.stream().filter(entry ->
            entry.profileId().equals(expected.profileId()) && entry.shape().equals(expected.shape())
                && entry.focus().equals(expected.focus()) && entry.graphs().equals(expected.graphs())
                && entry.binding().isEmpty()).count() != 1)
            return invalid("Claim fold validation focus differs");
        if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        CommandWork.enter("update");
        CommandOverlay primary = new CommandOverlay(CommandWork.observe(delta == null ? dataset : delta.observed()));
        ClaimStatementFoldPolicy.applyExact(primary, before, plan);
        MembershipNormalFormPolicy.Result membership = MembershipNormalFormPolicy.check(primary, profiles, deadline);
        if (membership.error() != null) return invalid(membership.error());
        primary.apply();
        String stored = receiptValue(dataset, receipt, "requestDigest");
        if (stored == null) return Map.of("status", "guard-unmatched");
        if (!digest.equals(stored)) return Map.of("status", "conflict");
        CommandWork.enter("invariants");
        String invariant = CommandInvariant.check(dataset, receipt, digest, plan, control);
        if (invariant != null) return invalid(invariant);
        String conversion = ClaimStatementFoldPolicy.check(dataset, before);
        if (conversion != null) return invalid(conversion);
        // Retained Claim C remains visible for original R and assessment class
        // validation. The fixed native view excludes only that archived descriptor.
        if (claim != null) {
            Map<String, Object> historical = validateOne(dataset, new Validation("claim-v1", profiles.get("claim-v1"),
                "https://rezics.com/definition/claim-v1/claim-shape", List.of(claim.getURI()),
                List.of(CommandPolicy.REVISIONS), Map.of()));
            if (historical != null) return historical;
        }
        DatasetGraph nativeView = ClaimStatementFoldPolicy.validationView(dataset, plan);
        CommandPolicy.Plan nativePlan = ClaimStatementFoldPolicy.nativePlan(plan, receipt);
        Map<String, Object> scope = validateScope(nativeView, receipt, nativePlan, nativeValidations, Set.of(), Set.of());
        if (scope != null) return scope;
        for (Validation validation : nativeValidations) {
            Map<String, Object> report = validateOne(nativeView, validation);
            if (report != null) return report;
            if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        }
        if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        dataset.add(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(receipt),
            NodeFactory.createURI(RV + "claimFoldTemplateDigest"),
            NodeFactory.createLiteralString(ClaimStatementFoldPolicy.templateDigest(update)));
        if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) return Map.of("status", "deadline");
        String disposition = ClaimFoldInventory.stageConverted(CommandWork.observe(dataset), plan, receipt, update, deadline);
        if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) return Map.of("status", "deadline");
        if (disposition != null) return invalid(disposition);
        if (delta != null) SearchDeltaJournal.append(dataset, delta, publicSearchWriteEpoch.get() + 1, deadline);
        // Fixed template and control checks preserve both graph and relay cuts.
        return committed(dataset, receipt);
    }
    private static Node claimFoldReceiptTerm(CommandPolicy.Plan plan, String receipt, String predicate) {
        var modify = (org.apache.jena.sparql.modify.request.UpdateModify) plan.request().getOperations().getFirst();
        List<Node> values = modify.getInsertQuads().stream().filter(quad ->
            quad.getGraph().equals(NodeFactory.createURI(CommandPolicy.RECEIPTS))
                && quad.getSubject().equals(NodeFactory.createURI(receipt))
                && quad.getPredicate().equals(NodeFactory.createURI(RV + predicate)))
            .map(Quad::getObject).toList();
        if (values.size() != 1 || !values.getFirst().isURI())
            throw new IllegalArgumentException("Claim fold receipt reference differs: " + predicate);
        return values.getFirst();
    }

    /** Maintenance has its own closed write footprint, while canonical shapes still validate every native subject. */
    private Map<String, Object> evaluateStatementUpgrade(DatasetGraph dataset, String receipt, String digest,
        String update, CommandPolicy.Plan plan, List<Validation> validations, long deadline,
        SearchDeltaJournal.Capture delta) {
        var control = CommandInvariant.readControl(dataset);
        var before = StatementUpgradePolicy.capture(dataset, receipt, digest, plan);
        if (before.error() != null) return invalid(before.error());
        if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        CommandWork.enter("update");
        CommandOverlay primary = new CommandOverlay(CommandWork.observe(delta == null ? dataset : delta.observed()));
        UpdateAction.execute(plan.request(), DatasetFactory.wrap(primary));
        MembershipNormalFormPolicy.Result membership = MembershipNormalFormPolicy.check(primary, profiles, deadline);
        if (membership.error() != null) return invalid(membership.error());
        primary.apply();
        String stored = receiptValue(dataset, receipt, "requestDigest");
        if (stored == null) return Map.of("status", "guard-unmatched");
        if (!digest.equals(stored)) return Map.of("status", "conflict");
        CommandWork.enter("invariants");
        String invariant = CommandInvariant.check(dataset, receipt, digest, plan, control);
        if (invariant != null) return invalid(invariant);
        String conversion = StatementUpgradePolicy.check(dataset, before);
        if (conversion != null) return invalid(conversion);
        boolean restoring = StatementUpgradePolicy.restoringReceipt(receipt);
        CommandPolicy.Plan validationPlan = restoring ? StatementRestorePolicy.nativePlan(plan, receipt) : plan;
        if (restoring && validations.stream().anyMatch(entry -> !Set.of("statement-v1", "statement-decision-v1")
            .contains(entry.profileId()))) return invalid("classification restore validates only native representation profiles");
        Map<String, Object> scope = validateScope(dataset, receipt, validationPlan, validations, Set.of(), membership.validatedLists());
        if (scope != null) return scope;
        record Instance(String profile, Map<String, String> binding) {}
        Map<Instance, List<Validation>> grouped = new LinkedHashMap<>();
        for (Validation entry : validations) grouped.computeIfAbsent(new Instance(entry.profileId(), entry.binding()),
            ignored -> new ArrayList<>()).add(entry);
        for (var group : grouped.entrySet()) {
            String report = BindingPolicy.check(dataset, group.getKey().profile(),
                profiles.get(group.getKey().profile()).binding(), group.getValue());
            if (report != null) return invalid(report);
        }
        for (Validation validation : validations) {
            Map<String, Object> invalid = validateNativeFocus(dataset, validation, membership.validatedLists());
            if (invalid != null) return invalid;
            if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        }
        if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
        dataset.add(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(receipt),
            StatementUpgradePolicy.templateDigestPredicate(), NodeFactory.createLiteralString(StatementUpgradePolicy.templateDigest(update)));
        if (delta != null) SearchDeltaJournal.append(dataset, delta, publicSearchWriteEpoch.get() + 1, deadline);
        if (restoring) {
            String stream = CommandInvariant.advanceRelayStream(dataset,
                StatementRestorePolicy.originalReceipt(plan, receipt), plan, control);
            if (stream != null) return invalid(stream);
        }
        // Upgrade conversion leaves both positions unchanged; restore stamps only
        // the exact retained batch while the new dataset position remains zero.
        MembershipNormalFormPolicy.applied(dataset, membership);
        return committed(dataset, receipt);
    }

    private Map<String, Object> validateScope(DatasetGraph dataset, String receipt, CommandPolicy.Plan plan,
                                              List<Validation> validations, Set<String> retiredCoverage, Set<Node> membershipLists) {
        boolean productData = !plan.current().isEmpty() || !plan.revisions().isEmpty()
            || !plan.source().isEmpty()
            || plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH) && !plan.bootstrap();
        if (plan.rebuild() || receipt.startsWith("urn:rezics:receipt:chapter-search-index:")
            || receipt.startsWith("urn:rezics:receipt:catalogue-search-index:")) {
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
                && Set.of("source-open-library-work-v1", "source-reification-v1")
                    .contains(validation.profileId())) {
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
            if (retiredCoverage.contains(subject)) continue;
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
            Map<String, Object> canonical = dataset.contains(NodeFactory.createURI(CommandPolicy.CURRENT),NodeFactory.createURI(subject),
                org.apache.jena.vocabulary.RDF.type.asNode(),NodeFactory.createURI("https://schema.org/ItemList"))
                ? validateMembershipList(dataset,subject,membershipLists)
                : CanonicalPolicy.validate(profiles, dataset, subject, false);
            if (canonical != null) return canonical;
            if (hasType(dataset, CommandPolicy.CURRENT, subject, "ContentVariant")) {
                if (!hasContentFocus(validations, subject, "variant-shape", CommandPolicy.CURRENT))
                    return invalid("Content variant focus omitted: " + subject);
                String link = contentPublicationLinks(dataset, receipt, subject, false, freshPublication);
                if (link != null) return invalid(link);
            }
            String boundProfile = CanonicalPolicy.requiredBindingProfile(profiles, dataset, subject, false);
            if (boundProfile != null && !boundFocus(validations, boundProfile, subject))
                return invalid("bound profile focus omitted: " + subject);
        }
        for (String subject : plan.revisions()) {
            Map<String, Object> canonical = CanonicalPolicy.validate(profiles, dataset, subject, true);
            if (canonical != null) return canonical;
            if (hasType(dataset, CommandPolicy.REVISIONS, subject, "ContentPublicationDecision")) {
                if (!hasContentFocus(validations, subject, "decision-shape", CommandPolicy.REVISIONS))
                    return invalid("Content publication decision focus omitted: " + subject);
                String link = contentPublicationLinks(dataset, receipt, subject, true, true);
                if (link != null) return invalid(link);
            }
            if (hasType(dataset, CommandPolicy.REVISIONS, subject, "ContentSearchEligibilityDecision")) {
                String profile = contentEligibilityProfile(dataset, subject);
                if (profile == null || !hasNamedFocus(validations, profile, "decision-shape",
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
            String boundProfile = CanonicalPolicy.requiredBindingProfile(profiles, dataset, subject, true);
            if (boundProfile != null && !boundFocus(validations, boundProfile, subject))
                return invalid("bound profile focus omitted: " + subject);
            Node node = NodeFactory.createURI(subject);
            for (String type : List.of("PublicationDecision", "ContentPublicationDecision",
                "ContentSearchEligibilityDecision", "ContentProjection", "PublicationSelection",
                "RealmPublicationRejection", "ClassificationDecision", "RatingObservationRevision",
                "TranslationLink", "WorkDerivation", "AuthorCreditRevision", "NativeChildRevision",
                "EditorialFieldRevision", "EditorialFieldControlRevision", "EditorialControlRevision")) {
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
    private static String contentEligibilityProfile(DatasetGraph dataset, String subject) {
        Node revision = exactlyOne(dataset, NodeFactory.createURI(CommandPolicy.REVISIONS),
            NodeFactory.createURI(subject), "modelRevision");
        if (revision == null || !revision.isURI()) return null;
        return switch (revision.getURI()) {
            case "https://rezics.com/definition/content-search-eligibility-v1" -> "content-search-eligibility-v1";
            case "https://rezics.com/definition/content-search-eligibility-v2" -> "content-search-eligibility-v2";
            default -> null;
        };
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
        String profile = contentEligibilityProfile(dataset, subject);
        boolean publicDomain = "content-search-eligibility-v2".equals(profile);
        if (profile == null || !NodeFactory.createURI(RV + (publicDomain ? "PublicDomain" : "OriginalContribution")).equals(
                exactlyOne(dataset, revisions, decision, "rightsBasis"))
            || !NodeFactory.createURI(RV + "Public").equals(
                exactlyOne(dataset, revisions, decision, "disclosure")))
            return "Content search eligibility rights/disclosure mismatch: " + subject;
        Node assessment = exactlyOne(dataset, revisions, decision, "rightsAssessment");
        if (publicDomain ? assessment == null || !assessment.isURI()
                || !assessment.getURI().matches("urn:rezics:rights:assessment:[0-9a-f-]{36}")
            : assessment != null)
            return "Content search eligibility assessment mismatch: " + subject;
        Node scope = exactlyOne(dataset, revisions, decision, "admittedScope");
        if (scope == null || !scope.isLiteral()
            || !(scope.getLiteralLexicalForm().equals("content:search-eligibility:" + resource.getURI())
                || scope.getLiteralLexicalForm().equals("content:search-eligibility:" + variant.getURI())))
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
        if (publicDomain && !same(dataset, revisions, decision, receipts, receiptNode, "rightsAssessment"))
            return "Content search eligibility receipt assessment mismatch: " + subject;
        return null;
    }
    /** Java strings count UTF-16 units, matching Content admission's single-unit budget. */
    static boolean admittedContentBody(Node body, Node language) {
        return body != null && body.isLiteral() && language != null && language.isLiteral()
            && body.getLiteralLanguage().equalsIgnoreCase(language.getLiteralLexicalForm())
            && body.getLiteralLexicalForm().length() <= 65_536
            && body.getLiteralLexicalForm().getBytes(StandardCharsets.UTF_8).length <= 196_608;
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
        String eligibilityProfileId = contentEligibilityProfile(dataset, eligibility.getURI());
        ProfileRegistry.Profile eligibilityProfile = eligibilityProfileId == null ? null
            : profiles.get(eligibilityProfileId);
        if (eligibilityProfile == null) return invalid("Content search eligibility profile unavailable");
        Map<String, Object> eligibilityShape = validateOne(dataset, new Validation(
            eligibilityProfileId, eligibilityProfile,
            "https://rezics.com/definition/" + eligibilityProfileId + "/decision-shape",
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
        if (!admittedContentBody(body, language))
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
    private Map<String,Object> validateMembershipList(DatasetGraph data,String subject,Set<Node> validatedLists) {
        return MembershipNormalFormPolicy.validateList(data,profiles,subject,validatedLists);
    }
    private Map<String,Object> validateNativeFocus(DatasetGraph data,Validation validation,Set<Node> validatedLists) {
        if(!validation.profileId().equals("structure-composition-v1")
            || !validation.shape().equals("https://rezics.com/definition/structure-composition-v1/item-list-shape"))
            return validateOne(data,validation);
        if(!new java.util.HashSet<>(validation.graphs()).equals(Set.of(CommandPolicy.CURRENT,CommandPolicy.REVISIONS)))
            return invalid("bounded ItemList validation requires the owner current/revisions scope");
        for(String subject:validation.focus()) {
            Map<String,Object> invalid=validateMembershipList(data,subject,validatedLists);
            if(invalid!=null) return invalid;
        }
        return null;
    }
    static Map<String, Object> invalid(String report) {
        return Map.of("status", "invalid", "report", report);
    }
    static Map<String, Object> validateOne(DatasetGraph dataset, Validation validation) {
        return CommandWork.timed("validation", () -> validateFocused(dataset, validation));
    }
    static Map<String, Object> validateFocused(DatasetGraph dataset, Validation validation) {
        CommandWork.count("validation_focuses", validation.focus().size());
        Graph union = SelectedGraphUnion.readOnly(dataset, validation.graphs());
        Shapes shapes = validation.profile().compiled();
        var shape = shapes.getShape(NodeFactory.createURI(validation.shape()));
        if (shape == null) throw new IllegalArgumentException("validation shape missing from compiled profile");
        var context = org.apache.jena.shacl.engine.ValidationContext.create(shapes, union);
        // Registry profiles have no population targets. Apply the selected
        // immutable shape directly to the changed nodes, including SPARQL and
        // nested constraints, without copying/reparsing it for each focus.
        for (String focus : validation.focus())
            org.apache.jena.shacl.validation.ValidationProc.execValidateShape(context, union,
                shape, NodeFactory.createURI(focus));
        ValidationReport report = context.generateReport();
        if (!report.conforms()) return Map.of("status", "invalid", "report", boundedReport(report.getModel()));
        return null;
    }
    private static String boundedReport(Model report) {
        StringBuilder summary = new StringBuilder();
        var results = report.listSubjectsWithProperty(report.createProperty(SH, "resultSeverity"));
        if (results.hasNext()) {
            Resource first = results.next();
            appendViolationIri(summary, "sh:resultPath", first, report.createProperty(SH, "resultPath"));
            appendViolationIri(summary, "sh:sourceConstraintComponent", first,
                report.createProperty(SH, "sourceConstraintComponent"));
        }
        Set<String> paths = new java.util.TreeSet<>();
        var pathStatements = report.listStatements(null, report.createProperty(SH, "resultPath"), (org.apache.jena.rdf.model.RDFNode) null);
        while (pathStatements.hasNext()) {
            var path = pathStatements.next().getObject();
            if (path.isURIResource()) paths.add(path.asResource().getURI());
        }
        for (String path : paths) summary.append("sh:resultPath <").append(path).append(">\n");
        var statements = report.listStatements();
        int count = 0;
        while (statements.hasNext() && count++ < 20 && summary.length() < 4000) summary.append(statements.next()).append("\n");
        return summary.substring(0, Math.min(4096, summary.length()));
    }
    private static void appendViolationIri(StringBuilder summary, String name, Resource result,
                                           org.apache.jena.rdf.model.Property property) {
        Resource value = result.getPropertyResourceValue(property);
        if (value != null && value.isURIResource()) summary.append(name).append(" <").append(value.getURI()).append(">\n");
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
        if (datasetId == null && CommandInvariant.commitProof(dataset, receipt) != null)
            datasetId = "urn:rezics:dataset:product";
        String epoch = receiptValue(dataset, receipt, "dataEpoch");
        String sequence = receiptValue(dataset, receipt, "sequence");
        if (datasetId == null || epoch == null || sequence == null) return Map.of("status", "committed");
        return Map.of("status", "committed", "position", Map.of("datasetId", datasetId, "dataEpoch", epoch, "sequence", sequence));
    }
    static JsonObject jsonObject(Map<String, ?> payload) {
        JsonObject result = new JsonObject();
        payload.forEach((key, value) -> {
            if (value instanceof JsonValue json) result.put(key,json);
            else if (value instanceof Map<?, ?> map) {
                Map<String, Object> nested = new LinkedHashMap<>();
                map.forEach((k, v) -> nested.put(String.valueOf(k), v));
                result.put(key, jsonObject(nested));
            } else if (value instanceof List<?> list) {
                org.apache.jena.atlas.json.JsonArray array = new org.apache.jena.atlas.json.JsonArray();
                for (Object item : list) {
                    if(item instanceof String text) { array.add(text); continue; }
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
    private static void respond(HttpAction action, int status, JsonObject payload) {
        try {
            action.getResponse().setStatus(status);
            action.getResponse().setContentType("application/json; charset=utf-8");
            JSON.write(action.getResponse().getOutputStream(), payload);
        } catch (IOException ex) { throw new IllegalStateException(ex); }
    }
}
