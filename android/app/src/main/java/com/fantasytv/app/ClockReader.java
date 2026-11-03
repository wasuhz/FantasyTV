package com.fantasytv.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.util.Log;
import android.view.PixelCopy;
import android.view.SurfaceView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads the broadcast itself, every 3 seconds while a channel plays: a PixelCopy of the video alone (not our overlay;
 * off the main thread, so playback never waits on it), then text recognition of two places:
 * <ul>
 * <li>the bottom strip, for the score bug's quarter and clock ("1ST 1:10", "2ND | 12:34");</li>
 * <li>the top-right corner, for the network's logo ("CBS SPORTS", "FOX NFL", NBC, ESPN, Prime): on screen through the
 *     whole game, replays included, and gone in a commercial.</li>
 * </ul>
 * Each pass reports {quarter, clock or -1, logo seen}. Nothing leaves the TV.
 * <p>
 * The recognition itself runs in {@link OcrService}, a process of its own: on some TV chips Google's library dies with an
 * illegal instruction, and there that only ends the helper. After a few such deaths the reader stays off on this TV.
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

    private final Context context;
    private final SurfaceView view;
    private final Playback playback;   // tunneled: frames come from its stream tap instead of the screen
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final HandlerThread copyThread = new HandlerThread("ClockCopy");
    private final Handler copy;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private volatile boolean active, paused, busy;

    // The helper (OcrService): its Messenger while it's up; answers come back through `replies`.
    private volatile Messenger ocr;
    private final HandlerThread replyThread = new HandlerThread("ClockReplies");
    private final Messenger replies;
    private final LinkedBlockingQueue<Bundle> answer = new LinkedBlockingQueue<>();
    private volatile boolean asking;

    /**
     * The helper dying mid-read (the chip can't run Google's library): counted per TV; at DEATHS it's off for good here
     * (the stream delay setting and the phone's clock sync still work). Reads that just fail with an error rest after
     * GIVE_UP in a row, until the app opens again.
     */
    private static final String PREFS = "clock3", DIED = "died", OFF = "off";
    private static final int DEATHS = 3, GIVE_UP = 40;
    private final SharedPreferences prefs;
    private volatile boolean off;
    private int fails;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName n, IBinder b) { ocr = new Messenger(b); }
        @Override public void onServiceDisconnected(ComponentName n) {
            ocr = null;
            if (asking) died();   // it went while reading: the library crashed in there
        }
    };

    ClockReader(Context context, SurfaceView view, Playback playback, Listener listener) {
        this.playback = playback;
        this.context = context.getApplicationContext();
        this.view = view;
        this.listener = listener;
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        off = prefs.getBoolean(OFF, false);
        copyThread.start();
        copy = new Handler(copyThread.getLooper());
        replyThread.start();
        replies = new Messenger(new Handler(replyThread.getLooper(), m -> { answer.offer(m.getData()); return true; }));
        if (!off) this.context.bindService(new Intent(this.context, OcrService.class), connection, Context.BIND_AUTO_CREATE);
        main.postDelayed(this::tick, EVERY_MS);   // frames also feed score-bug samples, even where reading is off
    }

    /** False when clock reading is off on this TV (its chip can't run the text recognition). */
    boolean works() { return !off; }

    void setActive(boolean on) { active = on; }
    void setPaused(boolean on) { paused = on; }

    void release() {
        main.removeCallbacksAndMessages(null);
        copyThread.quitSafely();
        replyThread.quitSafely();
        work.shutdownNow();
        try { context.unbindService(connection); } catch (IllegalArgumentException ignored) { }
    }

    private void died() {
        int d = prefs.getInt(DIED, 0) + 1;
        Log.w(TAG, "the text-recognition helper crashed (" + d + " of " + DEATHS + ")");
        if (d >= DEATHS) {
            off = true;
            Log.w(TAG, "clock reading is off on this TV: its chip can't run Google's text recognition");
            try { context.unbindService(connection); } catch (IllegalArgumentException ignored) { }
        }
        prefs.edit().putInt(DIED, d).putBoolean(OFF, off).apply();
        answer.offer(new Bundle());   // wake the read that was waiting
    }

    private void tick() {
        main.postDelayed(this::tick, EVERY_MS);
        boolean reading = !off && ocr != null && fails < GIVE_UP;
        if ((!reading && !capture) || !active || paused || busy || view.getWidth() == 0 || !view.getHolder().getSurface().isValid()) return;
        busy = true;
        long at = System.currentTimeMillis();
        // Tunneled playback goes straight to the display, so the screen can't be copied: decode a frame from the
        // stream's own last few seconds instead (off-screen, from bytes the player already has).
        if (playback.tunneled() && playback.tap != null) {
            work.execute(() -> {
                Bitmap f = playback.tap.grab(1280, 720);
                if (f == null) { busy = false; return; }
                read(f, at);
            });
            return;
        }
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
        try {
            Bundle ask = new Bundle();
            byte[] strip = jpeg(frame, 0, 504, 1280, 216);
            if (capture) save(strip, at);   // samples for building a digit reader (Settings: save score-bug samples)
            ask.putByteArray("bottom", strip);   // bottom 30%: the score bug
            ask.putByteArray("corner", jpeg(frame, 893, 0, 387, 127));    // top right: the network logo
            Messenger to = ocr;
            if (to == null || off || fails >= GIVE_UP) return;   // reading off here: the sample above was all
            Message m = Message.obtain(null, OcrService.READ);
            m.setData(ask);
            m.replyTo = replies;
            answer.clear();
            asking = true;
            to.send(m);
            Bundle got = answer.poll(10, TimeUnit.SECONDS);
            asking = false;
            if (got == null || got.containsKey("error") || !got.containsKey("bottom")) {
                if (++fails == GIVE_UP) Log.w(TAG, GIVE_UP + " clock reads failed in a row, resting until FantasyTV opens again");
                return;
            }
            fails = 0;
            List<String> bottom = got.getStringArrayList("bottom"), corner = got.getStringArrayList("corner");
            int[] t = parse(bottom);
            String all = (String.join(" ", corner) + " " + String.join(" ", bottom)).toUpperCase(Locale.ROOT);
            listener.read(t != null ? t[0] : 0, t != null ? t[1] : -1, LOGO.matcher(all).find(), at);   // some networks put the logo bottom right
        } catch (Exception e) {
            asking = false;
            Log.w(TAG, "read: " + e);
        } finally {
            frame.recycle();
            busy = false;
        }
    }

    // ---- Score-bug samples: the clean bottom strip of the broadcast (no overlay), every 3 s while switched on, the
    // newest 300 kept in files/bugs (served at /api/bugs and /bugs/NAME for building a reader of each network's digits).
    private volatile boolean capture;
    void setCapture(boolean on) { capture = on; }

    private void save(byte[] jpeg, long at) {
        File dir = new File(context.getFilesDir(), "bugs");
        if (!dir.isDirectory() && !dir.mkdirs()) return;
        try (FileOutputStream f = new FileOutputStream(new File(dir, at + ".jpg"))) { f.write(jpeg); }
        catch (IOException e) { return; }
        File[] all = dir.listFiles();
        if (all != null && all.length > 300) {
            java.util.Arrays.sort(all, (a, b) -> a.getName().compareTo(b.getName()));
            for (int i = 0; i < all.length - 300; i++) all[i].delete();
        }
    }

    /** A piece of the frame as a JPEG, small enough to hand to the helper process. */
    private static byte[] jpeg(Bitmap frame, int x, int y, int w, int h) {
        Bitmap part = Bitmap.createBitmap(frame, x, y, w, h);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        part.compress(Bitmap.CompressFormat.JPEG, 90, out);
        part.recycle();
        return out.toByteArray();
    }

    /** {period, seconds left} from the lines read, or null. A quarter and a clock on the same line win. */
    static int[] parse(List<String> read) {
        List<String> lines = new ArrayList<>();
        for (String l : read) lines.add(l.toUpperCase(Locale.ROOT).replace('O', '0').replace("0T", "OT"));
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
