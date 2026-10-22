package com.rezics.jena;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonNull;
import org.apache.jena.atlas.json.JsonObject;

/** Opt-in private producer transport. Only validated propagation trace IDs and
 * fixed lifecycle counters leave the JVM. No HTTP endpoint or request payload
 * is added. A bounded nonce file requests a fresh, atomically replaced capture;
 * merely reading an old file never establishes current idle. */
final class NativeReadObservation implements AutoCloseable {
    static final String DIRECTORY_PROPERTY = "rezics.readObservation.directory";
    private final Path directory;
    private final Map<String, QueryWorkService.ReadWorkerObservation> sources = new LinkedHashMap<>();
    private final ScheduledExecutorService polling = Executors.newSingleThreadScheduledExecutor(work -> {
        var thread = new Thread(work, "native-read-observation-files"); thread.setDaemon(true); return thread;
    });
    private long cursor, transportFailures, filesWritten, bytesWritten;
    private String request = "ready";
    private boolean closed, drained;

    static NativeReadObservation install() {
        String configured = System.getProperty(DIRECTORY_PROPERTY);
        if (configured == null) return null;
        if (!Path.of(configured).isAbsolute()) throw new IllegalArgumentException("Native observation directory must be absolute");
        try { return new NativeReadObservation(Path.of(configured)); }
        catch (IOException failure) { throw new IllegalStateException("Native observation transport unavailable", failure); }
    }

    NativeReadObservation(Path directory) throws IOException {
        this(directory, Map.of("native-worker", QueryWorkService.readWorkers(),
            "native-engine", QueryWorkService.READ_ENGINES, "native-lock", QueryWorkService.READ_LOCKS,
            "native-transaction", QueryWorkService.READ_TRANSACTIONS));
    }

    NativeReadObservation(Path directory, Map<String, QueryWorkService.ReadWorkerLifecycle> owners) throws IOException {
        this.directory = directory;
        Files.createDirectories(directory);
        // A leftover control file belongs to a different capture and cannot
        // silently detach a newly attached producer.
        if (Files.exists(directory.resolve("stop")) || Files.exists(directory.resolve("snapshot.json")))
            throw new IOException("Native observation directory must be fresh");
        try {
            for (var entry : owners.entrySet()) sources.put(entry.getKey(), entry.getValue().observe(event -> {}));
            publish();
            polling.scheduleWithFixedDelay(this::poll, 0, 10, TimeUnit.MILLISECONDS);
        } catch (IOException | RuntimeException failure) {
            close(); throw failure;
        }
    }

    private synchronized void poll() {
        if (closed) return;
        try {
            if (Files.exists(directory.resolve("stop"))) { close(); return; }
            Path input = directory.resolve("request");
            if (!Files.exists(input)) return;
            byte[] bytes;
            try (var stream = Files.newInputStream(input)) { bytes = stream.readNBytes(65); }
            if (bytes.length > 64) throw new IOException("Native observation nonce exceeds bound");
            String nonce = new String(bytes, StandardCharsets.US_ASCII).trim();
            if (!nonce.matches("[a-zA-Z0-9-]{1,64}")) throw new IOException("Invalid native observation nonce");
            if (!request.equals(nonce)) { request = nonce; publish(); }
        } catch (IOException | RuntimeException failure) { transportFailures++; }
    }

    private static JsonObject meter(QueryWorkService.ReadWorkerMeter value) {
        var object = new JsonObject();
        object.put("starts", value.starts()); object.put("released", value.released());
        object.put("active", value.active()); object.put("pending", value.pending());
        if (value.lastStartAt() == null) object.put("lastStartAt", JsonNull.instance);
        else object.put("lastStartAt", value.lastStartAt());
        if (value.zeroSince() == null) object.put("zeroSince", JsonNull.instance);
        else object.put("zeroSince", value.zeroSince());
        return object;
    }

    private void publish() throws IOException {
        var output = new JsonObject(); var values = new JsonObject();
        boolean complete = transportFailures == 0; long dropped = 0;
        for (var entry : sources.entrySet()) {
            var captured = entry.getValue().snapshot(); var status = captured.status();
            var source = new JsonObject(); var state = new JsonObject(); var traces = new JsonObject();
            state.put("attached", status.attached()); state.put("complete", status.complete());
            state.put("failures", status.failures()); state.put("dropped", status.dropped());
            state.put("pendingNotifications", status.pendingNotifications());
            if (status.detachedAt() == null) state.put("detachedAt", JsonNull.instance);
            else state.put("detachedAt", status.detachedAt());
            state.put("totals", meter(status.totals()));
            for (var trace : captured.traces().entrySet()) traces.put(trace.getKey(), meter(trace.getValue()));
            source.put("attachedAt", captured.attachedAt()); source.put("status", state); source.put("traces", traces);
            values.put(entry.getKey(), source);
            complete &= status.complete() && status.failures() == 0 && status.dropped() == 0;
            dropped += status.dropped();
        }
        output.put("format", "native-read-lifecycle-snapshot-v1"); output.put("request", request);
        output.put("capturedAt", System.currentTimeMillis()); output.put("cursor", ++cursor);
        output.put("complete", complete); output.put("dropped", dropped); output.put("transportFailures", transportFailures);
        output.put("closed", closed); output.put("drained", drained); output.put("sources", values);
        byte[] bytes = (JSON.toStringFlat(output) + "\n").getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 16 * 1024 * 1024) throw new IOException("Native observation snapshot exceeds bound");
        atomic("snapshot.json", bytes);
        filesWritten++; bytesWritten += bytes.length;
        if (closed) {
            var receipt = new JsonObject();
            receipt.put("format", "native-read-lifecycle-close-v1"); receipt.put("drained", drained);
            receipt.put("snapshotBytes", bytes.length); receipt.put("snapshotSha256", sha256(bytes));
            receipt.put("filesWritten", filesWritten); receipt.put("bytesWritten", bytesWritten);
            receipt.put("flushed", true); receipt.put("closed", true); receipt.put("transportFailures", transportFailures);
            atomic("receipt.json", (JSON.toStringFlat(receipt) + "\n").getBytes(StandardCharsets.UTF_8));
        }
    }

    private void atomic(String name, byte[] bytes) throws IOException {
        Path pending = directory.resolve(name + ".pending");
        try (var channel = FileChannel.open(pending, StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
            var buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) channel.write(buffer);
            channel.force(true);
        }
        Files.move(pending, directory.resolve(name), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    private static String sha256(byte[] bytes) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true; polling.shutdown();
        for (var source : sources.values()) source.detach();
        drained = true;
        for (var source : sources.values()) {
            try { drained &= source.drain(); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); drained = false; }
        }
        try { publish(); }
        catch (IOException | RuntimeException failure) { transportFailures++; }
        // Undrained source slots stay reserved by their lifecycle owner, as with
        // an in-process observer. Dropping our references cannot claim release.
        sources.clear();
    }
}
