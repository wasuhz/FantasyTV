package com.fantasytv.app;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;
import android.view.PixelCopy;
import android.view.SurfaceView;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads the broadcast itself, every 2 seconds while a channel plays: a PixelCopy of the video alone (not our overlay;
 * off the main thread, so playback never waits on it), then on-device text recognition of two places:
 * <ul>
 * <li>the bottom strip, for the score bug's quarter and clock ("1ST 1:10", "2ND | 12:34");</li>
 * <li>the top-right corner, for the network's logo ("CBS SPORTS", "FOX NFL", NBC, ESPN, Prime): on screen through the
 *     whole game, replays included, and gone in a commercial.</li>
 * </ul>
 * Each pass reports {quarter, clock or -1, logo seen}. Nothing leaves the TV.
 */
final class ClockReader {
    private static final String TAG = "FantasyTVClock";
    private static final long EVERY_MS = 3_000;   // a clock or logo shows for seconds at a time: every 3 s is plenty

    interface Listener { void read(int period, int seconds, boolean logo, long at); }

    // The quarter, but not a down ("2ND & 9", "3RD AND 4").
    private static final Pattern QUARTER = Pattern.compile("\\b(1ST|2ND|3RD|4TH|OT)\\b(?!\\s*(&|AND\\b))");
    // A game clock (0:00 to 15:00), not a time of day ("7:30 PM", "8:15 ET").
    private static final Pattern CLOCK = Pattern.compile("\\b(1[0-5]|[0-9]):([0-5][0-9])\\b(?!\\s*(AM|PM|ET|CT|PT|MT)\\b)");
    // Network logos as text recognition reads them.
    private static final Pattern LOGO = Pattern.compile("\\b(CBS|FOX|NBC|ESPN|ABC|NFL|PRIME|SPORTS|NETWORK|PEACOCK|NETFLIX)\\b");

    private final SurfaceView view;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final HandlerThread copyThread = new HandlerThread("ClockCopy");
    private final Handler copy;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    private volatile boolean active, paused, busy;

    ClockReader(SurfaceView view, Listener listener) {
        this.view = view;
        this.listener = listener;
        copyThread.start();
        copy = new Handler(copyThread.getLooper());
        main.postDelayed(this::tick, EVERY_MS);
    }

    void setActive(boolean on) { active = on; }
    void setPaused(boolean on) { paused = on; }

    void release() {
        main.removeCallbacksAndMessages(null);
        copyThread.quitSafely();
        work.shutdownNow();
        recognizer.close();
    }

    private void tick() {
        main.postDelayed(this::tick, EVERY_MS);
        if (!active || paused || busy || view.getWidth() == 0 || !view.getHolder().getSurface().isValid()) return;
        busy = true;
        long at = System.currentTimeMillis();
        Bitmap frame = Bitmap.createBitmap(1280, 720, Bitmap.Config.ARGB_8888);   // the picture at 720p: sharp enough to read, far less to copy
        try {
            PixelCopy.request(view, frame, result -> {
                if (result != PixelCopy.SUCCESS) { frame.recycle(); busy = false; return; }
                work.execute(() -> read(frame, at));
            }, copy);
        } catch (RuntimeException e) {
            frame.recycle();
            busy = false;
        }
    }

    private void read(Bitmap frame, long at) {
        Bitmap bottom = null, corner = null;
        try {
            bottom = Bitmap.createBitmap(frame, 0, 504, 1280, 216);        // bottom 30%: the score bug
            corner = Bitmap.createBitmap(frame, 893, 0, 387, 127);         // top right: the network logo
            Task<Text> b = recognizer.process(InputImage.fromBitmap(bottom, 0));
            Task<Text> c = recognizer.process(InputImage.fromBitmap(corner, 0));
            Text bt = Tasks.await(b), ct = Tasks.await(c);
            int[] got = parse(bt);
            boolean logo = LOGO.matcher(ct.getText().toUpperCase(Locale.ROOT)).find()
                    || LOGO.matcher(bt.getText().toUpperCase(Locale.ROOT)).find();   // some networks put it bottom right
            listener.read(got != null ? got[0] : 0, got != null ? got[1] : -1, logo, at);
        } catch (Exception e) {
            Log.w(TAG, "read: " + e);
        } finally {
            frame.recycle();
            if (bottom != null) bottom.recycle();
            if (corner != null) corner.recycle();
            busy = false;
        }
    }

    /** {period, seconds left} from what was read, or null. A quarter and a clock on the same line win. */
    static int[] parse(Text text) {
        List<String> lines = new ArrayList<>();
        for (Text.TextBlock b : text.getTextBlocks()) for (Text.Line l : b.getLines()) lines.add(l.getText().toUpperCase(Locale.ROOT).replace('O', '0').replace("0T", "OT"));
        int period = 0, seconds = -1, loosePeriod = 0, looseSeconds = -1, clocks = 0;
        for (String line : lines) {
            Matcher q = QUARTER.matcher(line), c = CLOCK.matcher(line);
            int p = q.find() ? quarter(q.group(1)) : 0;
            if (c.find()) {
                clocks++;
                int s = Integer.parseInt(c.group(1)) * 60 + Integer.parseInt(c.group(2));
                if (s > 900) continue;
                if (p > 0 && period == 0) { period = p; seconds = s; }
                else if (looseSeconds < 0) looseSeconds = s;
            } else if (p > 0 && loosePeriod == 0) loosePeriod = p;
        }
        if (period > 0) return new int[]{period, seconds};
        // The quarter and clock read as separate lines ("1ST" | "1:10"): fine when there is exactly one clock.
        if (loosePeriod > 0 && looseSeconds >= 0 && clocks == 1) return new int[]{loosePeriod, looseSeconds};
        return null;
    }

    private static int quarter(String q) {
        switch (q) { case "1ST": return 1; case "2ND": return 2; case "3RD": return 3; case "4TH": return 4; default: return 5; }
    }
}
