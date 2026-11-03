package com.fantasytv.app;

import android.app.Activity;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.SurfaceView;
import android.view.WindowManager;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.TeeDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.hls.DefaultHlsExtractorFactory;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;

import java.util.Locale;

/**
 * ExoPlayer set up for live IPTV the way TiviMate does it:
 * <ul>
 * <li>a live buffer: start after 2.5 s, then keep 15–40 s ahead, and 5 s before resuming after a stall, so a hiccup
 *     from the provider is ridden out instead of freezing;</li>
 * <li>MPEG-TS read leniently (access units detected, non-IDR keyframes allowed): faster starts and fewer broken
 *     channels with odd encoders; the same for HLS;</li>
 * <li>hardware decoders first, falling back to another decoder when one fails on a stream's format;</li>
 * <li>auto frame rate: the TV's display mode switched to the channel's frame rate (59.94, 60, 50, 29.97…), so motion
 *     doesn't judder, and put back when you leave;</li>
 * <li>reconnects: after an error or the stream ending (sooner at first), and when the picture stops moving for 10 s
 *     without any error.</li>
 * </ul>
 * Main thread only.
 */
@OptIn(markerClass = UnstableApi.class)
final class Playback {
    /** How FantasyTV introduces itself to IPTV servers (and the Cloudflare in front of some of them). */
    static final String USER_AGENT = "FantasyTV/" + BuildConfig.VERSION_NAME;
    private static final String TAG = "FantasyTVPlayer";
    private static final long STALL_MS = 8_000;

    interface Listener { void state(String state); }

    private final Activity activity;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    final ExoPlayer player;
    private final DefaultTrackSelector tracks;
    private boolean tunnel = true;   // the main picture: tunneled unless Settings turns it off ("#notunnel")
    private final DefaultHttpDataSource.Factory http;
    /** The main picture's last few seconds of stream, for reading the clock off a frame (null on the split-screen side). */
    final StreamTap tap;
    private final DefaultExtractorsFactory extractors;
    private final int originalMode;
    private String url;
    private int retries;
    private long lastPos = -1, lastMove;
    // Frame-rate estimate from frame timestamps, when the stream doesn't state it: the first 30 frames are skipped
    // (start-up catch-up), then 97 are timed. One measurement per channel.
    private static final int SKIP = 30;
    private final long[] stamps = new long[97];
    private int stampCount;
    private volatile boolean measured;

    /** The second picture in split screen: muted, and it leaves the TV's display mode to the main one. */
    private final boolean side;

    Playback(Activity a, SurfaceView surface, Listener l) { this(a, surface, l, false); }

    Playback(Activity a, SurfaceView surface, Listener l, boolean side) {
        activity = a;
        listener = l;
        this.side = side;
        tap = side ? null : new StreamTap(a.getCacheDir());
        originalMode = a.getWindow().getAttributes().preferredDisplayModeId;

        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(15_000, 40_000, 2_500, 5_000)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(a)
                .setEnableDecoderFallback(true)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON);
        http = new DefaultHttpDataSource.Factory()
                .setUserAgent(USER_AGENT)
                .setConnectTimeoutMs(10_000)
                .setReadTimeoutMs(15_000)
                .setAllowCrossProtocolRedirects(true);
        extractors = new DefaultExtractorsFactory()
                .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS
                        | DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)
                .setTsExtractorTimestampSearchBytes(1500 * 188);

        // Tunneled playback (the way TiviMate plays smoothly on ordinary TV boxes): the decoder hands frames straight to
        // the display hardware, which keeps them in step with the sound, instead of this app timing every frame on a CPU
        // that may be too slow to do it evenly. The split-screen picture stays normal (two tunnels at once is too much).
        tracks = new DefaultTrackSelector(a);
        player = new ExoPlayer.Builder(a, renderers).setLoadControl(load).setTrackSelector(tracks).build();
        player.setVideoSurfaceView(surface);
        player.setVideoScalingMode(C.VIDEO_SCALING_MODE_SCALE_TO_FIT);
        if (side) player.setVolume(0f);
        player.setVideoFrameMetadataListener((presentationTimeUs, releaseTimeNs, format, mediaFormat) -> {
            if (measured || side) return;
            float stated = format.frameRate > 0 ? format.frameRate
                    : mediaFormat != null && mediaFormat.containsKey(android.media.MediaFormat.KEY_FRAME_RATE)
                    ? mediaFormat.getNumber(android.media.MediaFormat.KEY_FRAME_RATE).floatValue() : 0;
            if (stated > 0) { measured = true; foundRate(stated); return; }
            synchronized (stamps) {
                int i = stampCount++ - SKIP;
                if (i >= 0 && i < stamps.length) stamps[i] = presentationTimeUs;
                if (i == stamps.length - 1) { measured = true; foundRate(estimate()); }
            }
        });
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) { retries = 0; listener.state("playing"); }
                else if (state == Player.STATE_BUFFERING) listener.state("buffering");
                else if (state == Player.STATE_ENDED) retry("ended");
            }
            @Override public void onPlayerError(PlaybackException e) {
                if (e.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    player.seekToDefaultPosition();
                    player.prepare();
                    return;
                }
                listener.state("error");
                retry(e.getErrorCodeName());
            }
        });
        main.postDelayed(this::watch, 2_000);
    }

    /** Whether the picture goes straight to the display (then it can't be copied off the screen: use the tap). */
    boolean tunneled() { return tunnel; }

    void play(String newUrl) {
        if (newUrl == null) return;
        // "#norewind" on the end: Rewind is off in settings, so the channel plays straight from the server (less work
        // for a slower TV).
        boolean noTunnel = newUrl.endsWith("#notunnel");   // Settings: smooth playback (tunneling) off, for a TV it upsets
        if (noTunnel) newUrl = newUrl.substring(0, newUrl.length() - "#notunnel".length());
        boolean noRewind = newUrl.endsWith("#norewind");
        if (noRewind) newUrl = newUrl.substring(0, newUrl.length() - "#norewind".length());
        tunnel = !side && !noTunnel;
        if (tap != null) tap.reset();   // a new channel: the old one's bytes are no use
        url = newUrl;
        retries = 0;
        back = 0;
        // The main picture reads through the rewind buffer (plain MPEG-TS channels; HLS plays direct).
        shifted = !side && !isHls(newUrl) && !noRewind;
        if (shifted) TvServer.timeshift.tune(newUrl);
        open();
    }

    void stop() {
        url = null;
        if (shifted) TvServer.timeshift.stop();
        player.stop();
        player.clearMediaItems();
        restoreMode();
    }

    /** Rewind: `seconds` further back than now (up to what the buffer holds); 0 or less = back to live. Returns how far back it plays. */
    int rewind(int seconds) {
        if (!shifted || url == null) return 0;
        back = seconds <= 0 ? 0 : Math.min(TvServer.timeshift.secondsKept() - 2, back + seconds);
        if (back < 0) back = 0;
        open();
        return back;
    }

    private boolean shifted;
    private int back;          // seconds behind live, while rewound
    private long opens;

    void pause() { player.pause(); }
    void resume() { if (url != null) player.play(); }

    /** Leaving the app: stop the stream and free the rewind buffer; wake() picks the same channel up again, live. */
    void suspend() {
        if (url == null) return;
        suspended = url;
        stop();
    }

    void wake() {
        if (suspended != null && url == null) play(suspended);
        suspended = null;
    }

    private String suspended;

    void release() {
        main.removeCallbacksAndMessages(null);
        restoreMode();
        player.release();
    }

    private void open() {
        measured = false;
        synchronized (stamps) { stampCount = 0; }
        lastPos = -1;
        lastMove = System.currentTimeMillis();
        tracks.setParameters(tracks.buildUponParameters().setTunnelingEnabled(tunnel));
        player.setMediaSource(source(shifted
                ? "http://127.0.0.1:" + TvServer.PORT + "/ts?back=" + back + "&n=" + (opens++)
                : url));
        player.prepare();
        player.play();
    }

    private static boolean isHls(String u) {
        String lower = u.toLowerCase(Locale.ROOT);
        return lower.contains(".m3u8") || lower.contains("/hls/") || lower.contains("output=m3u8");
    }

    private MediaSource source(String u) {
        MediaItem item = MediaItem.fromUri(Uri.parse(u));
        if (isHls(u)) {
            return new HlsMediaSource.Factory(http)
                    .setExtractorFactory(new DefaultHlsExtractorFactory(DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS
                            | DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES, true))
                    .setAllowChunklessPreparation(true)
                    .createMediaSource(item);
        }
        // The main picture's bytes are also copied into the tap as they arrive (for the clock reader's frames).
        DataSource.Factory from = tap == null ? http : () -> new TeeDataSource(http.createDataSource(), tap);
        return new ProgressiveMediaSource.Factory(from, extractors).createMediaSource(item);
    }

    /** Live streams drop now and then: reconnect after 1, 2, 4… up to 15 seconds. */
    private void retry(String why) {
        String u = url;
        if (u == null) return;
        // 1, 2, 4, then every 5 s: a live game can't wait 15 s for the next try.
        long wait = Math.min(5_000, 1_000L << Math.min(3, retries++));
        if (retries == 4) listener.state("dead");
        Log.i(TAG, "reconnecting in " + wait + " ms: " + why);
        main.postDelayed(() -> { if (u.equals(url)) open(); }, wait);
    }

    /** Every 2 s: a picture that hasn't moved for 10 s while it should be playing is a silent stall. */
    private void watch() {
        main.postDelayed(this::watch, 2_000);
        if (url == null || !player.getPlayWhenReady()) return;
        long pos = player.getCurrentPosition(), now = System.currentTimeMillis();
        if (pos != lastPos) { lastPos = pos; lastMove = now; return; }
        if (now - lastMove > STALL_MS) {
            lastMove = now;
            listener.state("error");
            retry("stalled");
        }
    }

    /**
     * The most common gap between frames (in 0.5 ms buckets, so a dropped or doubled frame doesn't sway it), averaged
     * over the gaps in that bucket for the exact rate.
     */
    private float estimate() {
        java.util.Map<Long, long[]> buckets = new java.util.HashMap<>();   // bucket -> {count, sum}
        for (int i = 1; i < stamps.length; i++) {
            long d = stamps[i] - stamps[i - 1];
            if (d <= 0 || d > 100_000) continue;
            long[] b = buckets.computeIfAbsent(Math.round(d / 500.0), k -> new long[2]);
            b[0]++;
            b[1] += d;
        }
        long[] best = null;
        for (long[] b : buckets.values()) if (best == null || b[0] > best[0]) best = b;
        return best == null ? 0 : 1_000_000f * best[0] / best[1];
    }

    /** Broadcast rates; a measured rate snaps to the nearest within 3%. */
    private static final float[] RATES = {23.976f, 24f, 25f, 29.97f, 30f, 50f, 59.94f, 60f, 100f, 119.88f, 120f};

    private void foundRate(float measured) {
        float fps = 0;
        for (float r : RATES) if (Math.abs(measured - r) / r < 0.03f && (fps == 0 || Math.abs(measured - r) < Math.abs(measured - fps))) fps = r;
        if (fps == 0) { Log.i(TAG, String.format(Locale.US, "%.3f fps: not a broadcast rate, display left alone", measured)); return; }
        final float rate = fps;
        main.post(() -> matchDisplay(rate));
    }

    /**
     * Auto frame rate: the display mode at the current resolution whose refresh rate is the frame rate or a whole
     * multiple of it (59.94 for 29.97, 50 for 25), exact rates first. Android 6+ lets an app ask; the TV may say no.
     */
    private void matchDisplay(float fps) {
        Display display = Build.VERSION.SDK_INT >= 30 ? activity.getDisplay() : activity.getWindowManager().getDefaultDisplay();
        if (display == null) return;
        Display.Mode current = display.getMode();
        // TV video (25, 29.97, 30 fps) goes to twice the rate (50, 59.94, 60 Hz): the same smoothness without a 25 Hz
        // flicker. Film (23.976, 24) stays exact; 50/60 fps stays as it is.
        int[] order = fps > 24.5f && fps < 31f ? new int[]{2, 1, 4} : new int[]{1, 2, 4};
        Display.Mode best = null;
        int bestRank = Integer.MAX_VALUE;
        for (Display.Mode m : display.getSupportedModes()) {
            if (m.getPhysicalWidth() != current.getPhysicalWidth() || m.getPhysicalHeight() != current.getPhysicalHeight()) continue;
            float r = m.getRefreshRate();
            for (int rank = 0; rank < order.length; rank++) {
                int k = order[rank];
                if (Math.abs(r - fps * k) < 0.05f * k && rank < bestRank) { best = m; bestRank = rank; }
            }
        }
        if (best == null || best.getModeId() == current.getModeId()) {
            Log.i(TAG, String.format(Locale.US, "%.3f fps: display stays at %.3f Hz", fps, current.getRefreshRate()));
            return;
        }
        Log.i(TAG, String.format(Locale.US, "%.3f fps: display %.3f → %.3f Hz", fps, current.getRefreshRate(), best.getRefreshRate()));
        WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
        lp.preferredDisplayModeId = best.getModeId();
        activity.getWindow().setAttributes(lp);
    }

    private void restoreMode() {
        if (side) return;
        WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
        if (lp.preferredDisplayModeId == originalMode) return;
        lp.preferredDisplayModeId = originalMode;
        activity.getWindow().setAttributes(lp);
    }
}
