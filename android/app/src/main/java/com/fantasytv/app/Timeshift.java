package com.fantasytv.app;

import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Rewind for live IPTV: the channel on screen is read through here, and the last 60 seconds of it are kept in memory
 * (about 60 MB at 8 Mbit/s; never more than 120 MB). The player reads it back from any point in that minute:
 * live, or N seconds ago, then follows on as more arrives. One channel at a time; a new channel starts a new buffer.
 */
final class Timeshift {
    private static final String TAG = "FantasyTVTimeshift";
    private static final long KEEP_MS = 60_000;
    private static final long MAX_BYTES = 120L << 20;

    private static final class Chunk {
        final long t; final byte[] data; final long seq;
        Chunk(long t, byte[] data, long seq) { this.t = t; this.data = data; this.seq = seq; }
    }

    private final ArrayDeque<Chunk> chunks = new ArrayDeque<>();
    private long bytes, nextSeq;
    private String url;
    private Thread reader;
    private volatile boolean running;

    /** Start buffering this channel (no-op if it's the one already buffering). */
    synchronized void tune(String newUrl) {
        if (newUrl.equals(url) && running) return;
        stop();
        url = newUrl;
        chunks.clear();
        bytes = 0;
        running = true;
        final String u = newUrl;
        reader = new Thread(() -> read(u), "Timeshift");
        reader.setDaemon(true);
        reader.start();
    }

    /** Stop reading the channel and drop the buffer: nothing kept once you're not watching. */
    synchronized void stop() {
        running = false;
        if (reader != null) reader.interrupt();
        reader = null;
        url = null;
        chunks.clear();
        bytes = 0;
        notifyAll();
    }

    /** Seconds of picture kept so far (how far back a rewind can go). */
    synchronized int secondsKept() {
        return chunks.isEmpty() ? 0 : (int) ((chunks.getLast().t - chunks.getFirst().t) / 1000);
    }

    private void read(String u) {
        while (running && u.equals(url)) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(u).openConnection();
                c.setConnectTimeout(10_000);
                c.setReadTimeout(15_000);
                c.setRequestProperty("User-Agent", Playback.USER_AGENT);
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[188 * 350];   // whole TS packets, ~64 KB
                    while (running && u.equals(url)) {
                        int n = 0;
                        while (n < buf.length) { int r = in.read(buf, n, buf.length - n); if (r < 0) break; n += r; }
                        if (n <= 0) break;
                        byte[] copy = new byte[n];
                        System.arraycopy(buf, 0, copy, 0, n);
                        add(copy);
                    }
                }
            } catch (IOException e) {
                if (running) Log.i(TAG, "upstream: " + e);
            } finally {
                if (c != null) c.disconnect();
            }
            if (running) try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
        }
    }

    private synchronized void add(byte[] data) {
        long now = System.currentTimeMillis();
        chunks.addLast(new Chunk(now, data, nextSeq++));
        bytes += data.length;
        while (!chunks.isEmpty() && (now - chunks.getFirst().t > KEEP_MS || bytes > MAX_BYTES)) bytes -= chunks.removeFirst().data.length;
        notifyAll();
    }

    /**
     * Send the channel from `secondsBack` ago (0 = live) and keep following, until the client goes away or the
     * channel changes. Blocking: on the server's request thread.
     */
    void serve(OutputStream out, int secondsBack) throws IOException {
        String mine;
        long seq;
        synchronized (this) {
            mine = url;
            // Wait briefly for the first data of a fresh channel.
            long until = System.currentTimeMillis() + 10_000;
            while (chunks.isEmpty() && running && System.currentTimeMillis() < until) {
                try { wait(500); } catch (InterruptedException e) { return; }
            }
            if (chunks.isEmpty()) return;
            long from = System.currentTimeMillis() - secondsBack * 1000L;
            seq = chunks.getLast().seq;   // live: the newest chunk
            if (secondsBack > 0) for (Chunk ch : chunks) if (ch.t >= from) { seq = ch.seq; break; }
        }
        while (true) {
            List<byte[]> batch = new ArrayList<>();
            synchronized (this) {
                if (!running || mine == null || !mine.equals(url)) return;
                long first = chunks.isEmpty() ? seq : chunks.getFirst().seq;
                if (seq < first) seq = first;   // fell behind the buffer: carry on from its start
                for (Chunk ch : chunks) if (ch.seq >= seq) batch.add(ch.data);
                if (batch.isEmpty()) {
                    try { wait(2000); } catch (InterruptedException e) { return; }
                    continue;
                }
                seq += batch.size();
            }
            for (byte[] b : batch) out.write(b);
            out.flush();
        }
    }
}
