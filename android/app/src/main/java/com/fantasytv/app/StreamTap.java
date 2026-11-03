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
    private static final int RING = 4 << 20;    // 4 MB: several seconds of a broadcast-quality stream
    private static final int TAKE = 3 << 20;    // decode from the newest 3 MB
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

    /** The newest TAKE bytes, oldest first, or null while there aren't enough yet. */
    private synchronized byte[] latest() {
        if (written < TAKE) return null;
        byte[] out = new byte[TAKE];
        long start = written - TAKE;
        for (int i = 0; i < TAKE; ) {
            int at = (int) ((start + i) % RING), n = Math.min(TAKE - i, RING - at);
            System.arraycopy(ring, at, out, i, n);
            i += n;
        }
        return out;
    }

    /**
     * The newest key frame in the last few seconds, at width × height, or null (no data yet, not MPEG-TS, nothing
     * decodable). Blocking: call it off the main thread.
     */
    Bitmap grab(int width, int height) {
        byte[] data = latest();
        if (data == null) return null;
        // Start on a packet boundary: three sync bytes 188 apart.
        int from = -1;
        for (int i = 0; i + 2 * TS < Math.min(data.length, 64 * TS); i++)
            if (data[i] == 0x47 && data[i + TS] == 0x47 && data[i + 2 * TS] == 0x47) { from = i; break; }
        if (from < 0) return null;
        int len = (data.length - from) / TS * TS;
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            try (FileOutputStream f = new FileOutputStream(scratch)) { f.write(data, from, len); }
            mmr.setDataSource(scratch.getAbsolutePath());
            long durUs = 0;
            String d = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (d != null) try { durUs = Long.parseLong(d) * 1000; } catch (NumberFormatException ignored) { }
            // The last key frame before the end: the newest picture there is.
            Bitmap b = Build.VERSION.SDK_INT >= 27
                    ? mmr.getScaledFrameAtTime(durUs, MediaMetadataRetriever.OPTION_PREVIOUS_SYNC, width, height)
                    : mmr.getFrameAtTime(durUs, MediaMetadataRetriever.OPTION_PREVIOUS_SYNC);
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
}
