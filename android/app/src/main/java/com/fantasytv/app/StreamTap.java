package com.fantasytv.app;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.util.Log;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSink;
import androidx.media3.datasource.DataSpec;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * The last few seconds of the channel's stream, kept in memory as it reaches the player (a copy of the bytes, no second
 * connection to the server), and a picture from them on demand: the newest whole frame, decoded off-screen. That frame
 * is what the clock reader reads, so it works even when the picture itself can't be copied off the screen (tunneled
 * playback hands frames straight to the display).
 * <p>
 * The bytes are a moment ahead of the screen (the player keeps about 2.5 s in hand) and the frame is the last key frame
 * in them (usually under 2 s old): roughly level with the picture.
 */
@OptIn(markerClass = UnstableApi.class)
final class StreamTap implements DataSink {
    private static final String TAG = "FantasyTVTap";
    // Enough for a key frame: some feeds send a whole picture only every 4–6 s (about 3 MB of a 1080p stream, so a
    // 3 MB slice often held none and decoded nothing).
    private static final int RING = 12 << 20;   // 12 MB: ten seconds or so of a broadcast-quality stream
    private static final int TAKE = 8 << 20;    // decode from the newest 8 MB
    private static final int TS = 188;          // MPEG-TS packet size

    private final byte[] ring = new byte[RING];
    private long written;                       // bytes ever written (position in the ring = written % RING)
    private final File scratch;

    StreamTap(File cacheDir) { scratch = new File(cacheDir, "frame.ts"); }

    // ---- DataSink: the player's bytes, copied in as they pass ----
    @Override public void open(DataSpec spec) { }
    @Override public synchronized void write(byte[] buf, int off, int len) {
        while (len > 0) {
            int at = (int) (written % RING), n = Math.min(len, RING - at);
            System.arraycopy(buf, off, ring, at, n);
            written += n; off += n; len -= n;
        }
    }
    @Override public void close() { }

    /** Forget the old channel's bytes (a new channel starts). */
    synchronized void reset() { written = 0; }

    private byte ringAt(long pos) { return ring[(int) (pos % RING)]; }

    /**
     * The newest TAKE bytes into the scratch file, straight from the ring and starting on an MPEG-TS packet boundary
     * (three sync bytes 188 apart): no copy in memory (an 8 MB array every 3 s, beside the rewind buffer, ran a Shield
     * out of memory). False while there isn't enough yet, or no packet start.
     */
    private synchronized boolean latestToFile() throws IOException {
        if (written < TAKE) return false;
        long start = written - TAKE, from = -1;
        for (long p = start; p + 2 * TS < start + 64 * TS; p++)
            if (ringAt(p) == 0x47 && ringAt(p + TS) == 0x47 && ringAt(p + 2 * TS) == 0x47) { from = p; break; }
        if (from < 0) return false;
        long len = (written - from) / TS * TS;
        try (FileOutputStream f = new FileOutputStream(scratch)) {
            for (long done = 0; done < len; ) {
                int at = (int) ((from + done) % RING), n = (int) Math.min(len - done, RING - at);
                f.write(ring, at, n);
                done += n;
            }
        }
        return true;
    }

    /**
     * The newest key frame in the last few seconds, at width × height, or null (no data yet, not MPEG-TS, nothing
     * decodable). Blocking: call it off the main thread.
     */
    Bitmap grab(int width, int height) {
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            if (!latestToFile()) return null;
            long len = scratch.length();
            mmr.setDataSource(scratch.getAbsolutePath());
            long durUs = 0;
            String d = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (d != null) try { durUs = Long.parseLong(d) * 1000; } catch (NumberFormatException ignored) { }
            // The last key frame before the end: the newest picture there is. A slice cut from a live stream can report
            // a duration its timestamps don't match (some TVs, the onn among them, then decode nothing at the end): so
            // whichever way worked last time first, then the others.
            Bitmap b = null;
            for (int i = 0; i < WAYS && b == null; i++) {
                int way = (way0 + i) % WAYS;
                try { b = frame(mmr, way, durUs, width, height); } catch (RuntimeException ignored) { }
                if (b != null && way != way0) { Log.i(TAG, "frames by way " + way); way0 = way; }
            }
            if (b == null && misses++ % 20 == 0) Log.w(TAG, "no frame in " + len / 1024 + " KB (duration " + durUs / 1000 + " ms)");
            if (b != null && (b.getWidth() != width || b.getHeight() != height)) {
                Bitmap s = Bitmap.createScaledBitmap(b, width, height, true);
                b.recycle();
                b = s;
            }
            return b;
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "grab: " + e);
            return null;
        } finally {
            try { mmr.release(); } catch (IOException ignored) { }
        }
    }

    private static final int WAYS = 4;
    private volatile int way0;   // the way that last gave a frame on this TV
    private int misses;

    /** One way to get a frame: 0 the key frame before the end, 1 the frame nearest the end, 2 halfway, 3 any frame. */
    private static Bitmap frame(MediaMetadataRetriever mmr, int way, long durUs, int width, int height) {
        long at = way == 2 ? durUs / 2 : durUs;
        int opt = way == 1 ? MediaMetadataRetriever.OPTION_CLOSEST_SYNC : MediaMetadataRetriever.OPTION_PREVIOUS_SYNC;
        if (way == 3) return mmr.getFrameAtTime();
        return Build.VERSION.SDK_INT >= 27 ? mmr.getScaledFrameAtTime(at, opt, width, height) : mmr.getFrameAtTime(at, opt);
    }
}
