package com.rezics.jena;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.Properties;
import java.util.Set;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.main.sys.FusekiAutoModule;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.assembler.Assembler;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.jena.sparql.core.DatasetGraph;

public final class CommandModule implements FusekiAutoModule {
    /** The pom.xml project version, filtered into module.properties at build time. */
    static final String VERSION = version();
    private static final Operation COMMAND = Operation.alloc("https://rezics.com/fuseki/command", "command", "REZICS transactional command");
    private final ProfileRegistry profiles = profiles();

    private static String version() {
        try (InputStream in = CommandModule.class.getResourceAsStream("module.properties")) {
            if (in == null) throw new IllegalStateException("command module version resource missing");
            Properties properties = new Properties();
            properties.load(in);
            String version = properties.getProperty("version", "");
            if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+"))
                throw new IllegalStateException("invalid command module version: " + version);
            return version;
        } catch (IOException ex) {
            throw new IllegalStateException("cannot read command module version", ex);
        }
    }

    private static ProfileRegistry profiles() {
        ProfileRegistry registry = ProfileRegistry.load(Path.of(System.getProperty("rezics.profiles", "/fuseki/profiles")));
        if (!VERSION.equals(registry.commandModule()))
            throw new IllegalStateException("profile manifest targets command module " + registry.commandModule()
                + ", not " + VERSION);
        return registry;
    }

    @Override public String name() { return "rezics-command"; }

    @Override public void start() {
        registerTextAssembler();
    }

    static void registerTextAssembler() {
        org.apache.jena.query.text.TextQuery.init();
        Assembler.general().implementWith(
            ResourceFactory.createResource("https://rezics.com/fuseki/FilteredGraphTextIndex"),
            new FilteredGraphTextAssembler());
        org.apache.jena.sparql.function.FunctionRegistry.get().put(
            "https://rezics.com/vocab/publicTextInventory", FilteredGraphTextAssembler.InventoryFunction.class);
        org.apache.jena.sparql.function.FunctionRegistry.get().put(
            "https://rezics.com/vocab/rankedText", FilteredGraphTextIndex.RankedFunction.class);
        org.apache.jena.sparql.function.FunctionRegistry.get().put(
            "https://rezics.com/vocab/occurrenceSearch", OccurrenceLabelIndex.SearchFunction.class);
    }

    @Override public void prepare(FusekiServer.Builder builder, Set<String> datasetNames, Model configModel) {
        builder.registerOperation(COMMAND, new CommandService(profiles));
        builder.registerOperation(Operation.Update, new TemplateIndexService.RawMembershipUpdate());
        // No endpoint is added. Product assemblers remain command-only; unsafe
        // fixture/maintenance writers must participate in the owner fence.
        for(Operation operation : java.util.List.of(Operation.GSP_RW, Operation.GSP_Direct_RW, Operation.Upload, Operation.Patch))
            builder.registerOperation(operation, new TemplateIndexService.RefuseRawMembershipWrite());
    }

    @Override public void configDataAccessPoint(org.apache.jena.fuseki.server.DataAccessPoint point, Model configModel) {
        // Reconfiguration revokes same-store admission before any startup work can fail.
        var data = point.getDataService().getDataset();
        if (TemplateIndexService.workScopeNativeStorage(data))
            TemplateIndexService.withdrawWorkScopeWriter(data);
        CommandInvariant.initializeRelayStreamAtStartup(point.getDataService().getDataset());
        OccurrenceTextSchema.rebuildIfIncompatible(point.getDataService().getDataset());
        // Qualification precedes HTTP traffic, including after an offline rebuild.
        // Empty/uninitialized datasets stay closed until a qualified startup.
        if (CommandService.deltaExclusive(point.getDataService())) {
            SearchDeltaJournal.proveExclusiveStartup(data);
            // An empty store has no text generation yet, so this audit returns
            // false. The maintenance reset deletes that generation too. The
            // command that stores the fresh graph completes the same admission.
            if (SearchDeltaJournal.qualifyAtStartup(data)) SearchDeltaJournal.clearDeferredAdmission(data);
            else SearchDeltaJournal.deferExclusiveAdmission(data);
            qualifySemanticSources(data);
        } else {
            SearchDeltaJournal.revokeExclusiveStartup(data);
            data.begin(org.apache.jena.query.ReadWrite.WRITE);
            try { SemanticSourceBasis.invalidate(data); CommitHalt.commit(data); }
            finally { data.end(); }
        }
    }

    /** Same source qualification startup runs once a control record exists. */
    static void qualifySemanticSources(DatasetGraph data) {
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            var control = CommandInvariant.readControl(data);
            // Any restoreHold value is an uncertain cut, like a held one: no qualification
            // is minted. Source admission and effects stay closed while inspection can start.
            if (control != null && !control.held() && !hasRestoreHold(data)) {
                long deadline = System.nanoTime() + 10_000_000_000L;
                SemanticSourceBasis.qualifyAtStartup(data, deadline);
                SemanticSourceBasis.check(deadline);
                CommitHalt.commit(data);
            } else data.abort();
        } finally { data.end(); }
    }

    /** One indexed (control, product, restoreHold, ANY) probe; the value's type or truth is not interpreted. */
    static boolean hasRestoreHold(org.apache.jena.sparql.core.DatasetGraph data) {
        return data.contains(
            org.apache.jena.graph.NodeFactory.createURI(CommandPolicy.CONTROL),
            org.apache.jena.graph.NodeFactory.createURI("urn:rezics:dataset:product"),
            org.apache.jena.graph.NodeFactory.createURI("https://rezics.com/vocab/restoreHold"),
            org.apache.jena.graph.Node.ANY);
    }

    @Override public void serverStopped(FusekiServer server) {
        server.getDataAccessPointRegistry().accessPoints().forEach(point ->
            SearchDeltaJournal.stopRecovery(point.getDataService().getDataset()));
    }
}
