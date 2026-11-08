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
    // At most 120 MB, and never more than a third of the memory Android gives the app (about 192 MB on a Shield without
    // largeHeap): a high-bitrate feed then rewinds less far instead of running the app out of memory.
    private static final long MAX_BYTES = Math.min(120L << 20, Runtime.getRuntime().maxMemory() / 3);

    /** keyAt: where in the chunk a video keyframe (a whole picture) starts, or -1: a player may only start there. */
    private static final class Chunk {
        final long t; final byte[] data; final long seq; final int keyAt;
        Chunk(long t, byte[] data, long seq, int keyAt) { this.t = t; this.data = data; this.seq = seq; this.keyAt = keyAt; }
    }

    // ---- Where a player can start. Video comes as a whole picture (a keyframe) every second or two, then changes to
    // it; started anywhere else the decoder has nothing to apply them to (green blocks, a frozen smear) until the next
    // one, or for good. So a player starts at a keyframe, after the stream's table of contents (PAT and PMT, which say
    // which packets are video and audio; without them it can't read anything).
    private static final int TS = 188;
    private byte[] pat, pmt;     // the latest table of contents
    private int pmtPid = -1;

    private static int pid(byte[] d, int i) { return ((d[i + 1] & 0x1f) << 8) | (d[i + 2] & 0xff); }
    /** Where the packet's payload starts (past its adaptation field), or -1 if it has none. */
    private static int payload(byte[] d, int i) {
        int afc = (d[i + 3] >> 4) & 3;
        if ((afc & 1) == 0) return -1;
        int p = i + 4 + ((afc & 2) != 0 ? 1 + (d[i + 4] & 0xff) : 0);
        return p < i + TS ? p : -1;
    }

    /** Note the table of contents and find a video keyframe in this chunk: its packet's offset, or -1. */
    private int scan(byte[] d) {
        int key = -1;
        for (int i = 0; i + TS <= d.length; i += TS) {
            if (d[i] != 0x47) return key;   // not aligned: give up on this chunk
            boolean start = (d[i + 1] & 0x40) != 0;
            int pid = pid(d, i), p = payload(d, i);
            if (!start || p < 0) continue;
            if (pid == 0) {   // PAT: the first program's PMT
                pat = java.util.Arrays.copyOfRange(d, i, i + TS);
                int s = p + 1 + (d[p] & 0xff);
                for (int e = s + 8; e + 4 <= i + TS && e + 4 <= s + 3 + (((d[s + 1] & 0x0f) << 8) | (d[s + 2] & 0xff)) - 4; e += 4) {
                    int prog = ((d[e] & 0xff) << 8) | (d[e + 1] & 0xff);
                    if (prog != 0) { pmtPid = ((d[e + 2] & 0x1f) << 8) | (d[e + 3] & 0xff); break; }
                }
            } else if (pid == pmtPid) {
                pmt = java.util.Arrays.copyOfRange(d, i, i + TS);
            } else if (key < 0 && p + 9 < i + TS && d[p] == 0 && d[p + 1] == 0 && d[p + 2] == 1 && (d[p + 3] & 0xf0) == 0xe0) {
                // A video PES: a keyframe if the adaptation field says "random access", or its first pictures are one.
                boolean rai = ((d[i + 3] >> 4) & 2) != 0 && (d[i + 4] & 0xff) > 0 && (d[i + 5] & 0x40) != 0;
                if (rai || keyNal(d, p + 9 + (d[p + 8] & 0xff), i + TS)) key = i;
            }
        }
        return key;
    }

    /** An H.264 IDR or SPS, or an HEVC IRAP or parameter set, among the NAL units starting in d[from, to). */
    private static boolean keyNal(byte[] d, int from, int to) {
        for (int j = from; j + 3 < to; j++) {
            if (d[j] != 0 || d[j + 1] != 0 || d[j + 2] != 1) continue;
            int b = d[j + 3] & 0xff, h264 = b & 0x1f, hevc = (b >> 1) & 0x3f;
            if (h264 == 5 || h264 == 7 || (hevc >= 16 && hevc <= 21) || hevc == 32 || hevc == 33) return true;
        }
        return false;
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

    /**
     * Bumped on every reconnect to the provider. Many IPTV servers start a new connection with the last 10–15 seconds
     * again: stitched onto the buffer, the player saw the game jump back (frozen picture, earlier plays again). So a
     * reconnect starts the buffer over and ends what's being served, and the player picks up again at live.
     */
    private long epoch;

    private void read(String u) {
        boolean first = true;
        while (running && u.equals(url)) {
            HttpURLConnection c = null;
            if (!first) synchronized (this) { chunks.clear(); bytes = 0; epoch++; notifyAll(); Log.i(TAG, "reconnected: buffer starts over"); }
            first = false;
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
        chunks.addLast(new Chunk(now, data, nextSeq++, scan(data)));
        bytes += data.length;
        while (!chunks.isEmpty() && (now - chunks.getFirst().t > KEEP_MS || bytes > MAX_BYTES)) bytes -= chunks.removeFirst().data.length;
        notifyAll();
    }

    /**
     * Send the channel from `secondsBack` ago (0 = live) and keep following, until the client goes away or the
     * channel changes. Blocking: on the server's request thread.
     */
    /** The newest chunk at or before `t` that holds a keyframe, or null. */
    private Chunk lastKey(long t) {
        Chunk found = null;
        for (Chunk ch : chunks) { if (ch.t > t) break; if (ch.keyAt >= 0) found = ch; }
        return found;
    }

    void serve(OutputStream out, int secondsBack) throws IOException {
        String mine;
        long seq, myEpoch;
        byte[] head = null;   // the first chunk's part from its keyframe on, after the table of contents
        synchronized (this) {
            mine = url;
            myEpoch = epoch;
            // Wait for the first keyframe of a fresh channel (a few seconds at most), else make do with what's there.
            long until = System.currentTimeMillis() + 10_000, keyUntil = System.currentTimeMillis() + 6_000;
            while (running && System.currentTimeMillis() < until && (chunks.isEmpty() || (lastKey(Long.MAX_VALUE) == null && System.currentTimeMillis() < keyUntil))) {
                try { wait(300); } catch (InterruptedException e) { return; }
            }
            if (chunks.isEmpty()) return;
            // Live: the newest keyframe; rewound: the last keyframe at or before that moment (else the oldest kept).
            long from = secondsBack > 0 ? System.currentTimeMillis() - secondsBack * 1000L : Long.MAX_VALUE;
            Chunk k = lastKey(from);
            if (k == null && secondsBack > 0) k = chunks.getFirst();
            if (k == null) { seq = chunks.getLast().seq; }   // no keyframe found at all: as before
            else {
                seq = k.seq + 1;
                int at = Math.max(0, k.keyAt);
                java.io.ByteArrayOutputStream h = new java.io.ByteArrayOutputStream(k.data.length + 2 * TS);
                if (pat != null && pmt != null) { h.write(pat, 0, TS); h.write(pmt, 0, TS); }
                h.write(k.data, at, k.data.length - at);
                head = h.toByteArray();
            }
        }
        Log.i(TAG, "player starts " + (head == null ? "at the newest data (no keyframe found)" : "at a keyframe " + (seq - 1 < 0 ? 0 : 1) + ", " + head.length / 1024 + " KB in hand") + (pat != null && pmt != null ? ", with PAT/PMT" : ", no PAT/PMT yet"));
        if (head != null) { out.write(head); out.flush(); }
        while (true) {
            List<byte[]> batch = new ArrayList<>();
            synchronized (this) {
                if (!running || mine == null || !mine.equals(url)) return;
                if (epoch != myEpoch) return;   // the provider reconnected: end here, the player reconnects at live
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
