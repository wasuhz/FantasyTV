package com.fantasytv.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.provider.Settings;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;

/**
 * The whole app: ExoPlayer plays the IPTV channel full screen, and the TV page (web/tv.html, served by TvServer) sits
 * on top in a transparent WebView, drawing the score bug, your players, the switching countdown and the Radar. The
 * page decides what to watch and calls Android.play(url); the remote's keys go to the page.
 */
public class MainActivity extends Activity {
    private static final String TAG = "FantasyTV";

    private final Handler main = new Handler(Looper.getMainLooper());
    private TvServer server;
    private Playback playback;
    private ClockReader clock;
    private WebView web;
    private volatile boolean backHandled;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // A phone (or a Fold) turns and resizes with you; a TV stays in landscape. The phone is its own remote, so its
        // server answers only this app.
        phone = isPhone();
        if (!phone) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        TvServer.localOnly = phone;

        server = new TvServer(this);
        // The last update's download (about 40 MB) isn't needed once it's installed.
        new java.io.File(getCacheDir(), "update.apk").delete();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        // A SurfaceView: video straight to the TV's video hardware, the smoothest path. The clock reader copies a strip
        // of it with PixelCopy, off the main thread.
        SurfaceView surface = new SurfaceView(this);
        root.addView(surface, new FrameLayout.LayoutParams(-1, -1));
        // Split screen: a second, muted picture on the right; hidden until the page asks for it.
        sideSurface = new SurfaceView(this);
        sideSurface.setVisibility(View.GONE);
        root.addView(sideSurface, new FrameLayout.LayoutParams(-1, -1));
        mainSurface = surface;
        this.root = root;

        playback = new Playback(this, surface, this::tell);
        sidePlayback = new Playback(this, sideSurface, state -> {
            if (state.equals("dead")) web.evaluateJavascript("window.ftvSide && ftvSide('dead')", null);
        }, true);
        clock = new ClockReader(this, surface, playback, (period, seconds, logo, at) -> main.post(() ->
                web.evaluateJavascript("window.ftvClock && ftvClock(" + period + "," + seconds + "," + at + "," + logo + ")", null)));

        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // Lay the page out at the screen's size (its viewport tag), at 100% text size whatever the TV's font setting.
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setFocusable(true);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (phone) {
            fullScreen();
            // The screen changes shape (turning the phone, folding or unfolding): the picture keeps 16:9 inside it.
            root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
                if (r - l != or - ol || b - t != ob - ot) main.post(this::layoutVideo);
            });
        }
        web.requestFocus();
        // The server can wait a few seconds for the port (see TvServer.start), so off the main thread; then the page.
        new Thread(() -> {
            try {
                server.start();
                main.post(() -> web.loadUrl("http://127.0.0.1:" + TvServer.PORT + "/tv.html?android=1"));
            } catch (IOException e) {
                Log.e(TAG, "server", e);
                main.post(() -> Toast.makeText(this, "FantasyTV couldn't open port " + TvServer.PORT, Toast.LENGTH_LONG).show());
            }
        }, "ServerStart").start();
        // Updates: 20 s after opening (the page is up by then), then every hour while it runs, and whenever it comes back
        // to the screen (onStart): Fire TV and Android TV keep the app running behind Home, so "reopening" it isn't a start.
        main.postDelayed(new Runnable() {
            @Override public void run() { checkForUpdate(false); main.postDelayed(this, 3600_000L); }
        }, 20_000);
    }

    /** What the page can ask of the TV. Called on the WebView's thread. */
    final class Bridge {
        @JavascriptInterface public void play(String url) { main.post(() -> { playback.play(url); clock.setActive(true); tuned = true; }); }
        @JavascriptInterface public void stop() { main.post(() -> { playback.stop(); clock.setActive(false); tuned = false; }); }
        /** True while Back should go to the page (closing the Radar, cancelling a switch) instead of leaving. */
        @JavascriptInterface public void setBack(boolean handled) { backHandled = handled; }
        /** Split screen: this channel on the right (muted), the main one moves left. Null or empty: back to one. */
        /** This app's version, for the page and the phone. */
        @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }
        /** False when this TV can't read the game clock off the picture (its chip crashed Google's text recognition). */
        @JavascriptInterface public boolean clockWorks() { return clock.works(); }
        /** Settings: save score-bug samples (the clean bottom strip, every 3 s) for building a digit reader. */
        @JavascriptInterface public void captureBugs(boolean on) { clock.setCapture(on); }
        /**
         * A lower-powered TV (a 32-bit chip, or under 2.5 GB of memory): the 60-second rewind buffer costs it enough to
         * make the picture stutter, so Rewind starts off there (it can still be turned on in Settings).
         */
        @JavascriptInterface public boolean lowPower() {
            android.app.ActivityManager.MemoryInfo m = new android.app.ActivityManager.MemoryInfo();
            ((android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(m);
            return android.os.Build.SUPPORTED_64_BIT_ABIS.length == 0 || m.totalMem < 2_500_000_000L;
        }
        /** Whether Android lets FantasyTV install its own updates ("Install unknown apps"). */
        @JavascriptInterface public boolean canInstall() { return getPackageManager().canRequestPackageInstalls(); }
        /** Opens that setting for FantasyTV (Android closes the app when it's switched on; it reopens on setup). */
        @JavascriptInterface public void allowInstalls() {
            main.post(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                } catch (ActivityNotFoundException e) {
                    try { startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS)); } catch (ActivityNotFoundException ignored) { }
                }
            });
        }
        /** Look for a newer release now; the page hears ftvUpdate(release) when there is one. */
        @JavascriptInterface public void checkUpdate() { checkForUpdate(true); }
        /** Download and install the newer release; the page hears ftvUpdateStatus(message). */
        @JavascriptInterface public void installUpdate() {
            JSONObject r = newer;
            if (r == null) return;
            new Thread(() -> {
                String err = Updater.install(MainActivity.this, r);
                main.post(() -> web.evaluateJavascript("window.ftvUpdateStatus && ftvUpdateStatus(" + JSONObject.quote(
                        err == null ? "Installing… confirm on the screen that opens" : err) + ")", null));
            }, "Update").start();
        }
        /** Rewind `seconds` more (0 = back to live); answers with ftvRewound(seconds behind live). */
        @JavascriptInterface public void rewind(int seconds) {
            main.post(() -> {
                int back = playback.rewind(seconds);
                web.evaluateJavascript("window.ftvRewound && ftvRewound(" + back + ")", null);
            });
        }
        @JavascriptInterface public void split(String url) { main.post(() -> setSplit(url == null || url.isEmpty() ? null : url)); }
        /** A phone or tablet (touch, turns, no remote) rather than a TV. */
        @JavascriptInterface public boolean isPhone() { return phone; }
        /** The device's maker and model ("NVIDIA SHIELD Android TV"): the page picks 4K feeds only where they play. */
        @JavascriptInterface public String model() { return android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL; }
        /** Phone, held upright or unfolded: the picture goes here (screen pixels); a zero width puts it back. */
        @JavascriptInterface public void videoRect(int x, int y, int w, int h) {
            main.post(() -> { videoAt = w > 0 && h > 0 ? new android.graphics.Rect(x, y, x + w, y + h) : null; layoutVideo(); });
        }
    }

    private volatile android.graphics.Rect videoAt;   // where the page wants the picture, when it says

    private boolean phone;

    /** Not a TV: Android TV / Google TV report a television UI mode (and leanback). */
    private boolean isPhone() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_TYPE_MASK;
        return mode != Configuration.UI_MODE_TYPE_TELEVISION && !getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    /** Phone: the game fills the screen, the status and navigation bars come back with a swipe from the edge. */
    @SuppressWarnings("deprecation")
    private void fullScreen() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(android.view.WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (android.os.Build.VERSION.SDK_INT >= 28)
            getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }

    /**
     * Where the picture goes: the whole screen on a TV; on a phone the largest 16:9 box, centred like the page's
     * 1920×1080 stage, so the overlay lines up with the picture and the game isn't stretched.
     */
    private android.graphics.Rect videoBox() {
        int w = root.getWidth(), h = root.getHeight();
        if (!phone || w == 0 || h == 0) return new android.graphics.Rect(0, 0, w, h);
        if (videoAt != null && !isInPictureInPictureMode()) return videoAt;
        float s = Math.min(w / 1920f, h / 1080f);
        int bw = Math.round(1920 * s), bh = Math.round(1080 * s), x = (w - bw) / 2, y = (h - bh) / 2;
        return new android.graphics.Rect(x, y, x + bw, y + bh);
    }

    private String splitUrl;

    private void layoutVideo() {
        if (splitUrl != null) { setSplit(splitUrl); return; }
        android.graphics.Rect b = videoBox();
        FrameLayout.LayoutParams p = new FrameLayout.LayoutParams(b.width(), b.height());
        p.leftMargin = b.left; p.topMargin = b.top;
        mainSurface.setLayoutParams(p);
    }

    private volatile JSONObject newer;   // a newer release on GitHub, once found

    private volatile long lastUpdateCheck;

    /**
     * Ask GitHub for a newer release (off the main thread); tell the page when there is one. Asked for (the game list's
     * row, the phone's button): also says so when this is the newest.
     */
    private void checkForUpdate(boolean asked) {
        lastUpdateCheck = System.currentTimeMillis();
        new Thread(() -> {
            JSONObject r = Updater.check();
            if (r == null) {
                if (asked) main.post(() -> web.evaluateJavascript("window.ftvUpdateStatus && ftvUpdateStatus(" + JSONObject.quote(
                        "You have the newest FantasyTV (" + BuildConfig.VERSION_NAME + ")") + ")", null));
                return;
            }
            newer = r;
            main.post(() -> web.evaluateJavascript("window.ftvUpdate && ftvUpdate(" + r + ")", null));
        }, "UpdateCheck").start();
    }

    private SurfaceView mainSurface, sideSurface;
    private Playback sidePlayback;
    private FrameLayout root;

    /**
     * Side by side, as the page draws it at 1920×1080: each picture half the width and half the height (16:9),
     * centred vertically (y 270–810), leaving the top for titles and the bottom for the score bug and your players.
     */
    private void setSplit(String url) {
        android.graphics.Rect box = videoBox();
        int w = box.width(), h = box.height();
        boolean same = url != null && url.equals(splitUrl);
        splitUrl = url;
        if (url == null) {
            sidePlayback.stop();
            sideSurface.setVisibility(View.GONE);
            if (phone) layoutVideo(); else mainSurface.setLayoutParams(new FrameLayout.LayoutParams(-1, -1));
            return;
        }
        FrameLayout.LayoutParams left = new FrameLayout.LayoutParams(w / 2, h / 2), right = new FrameLayout.LayoutParams(w / 2, h / 2);
        left.leftMargin = box.left; left.topMargin = box.top + h / 4;
        right.leftMargin = box.left + w / 2; right.topMargin = box.top + h / 4;
        mainSurface.setLayoutParams(left);
        sideSurface.setLayoutParams(right);
        sideSurface.setVisibility(View.VISIBLE);
        if (!same) sidePlayback.play(url);   // a new screen shape only moves it
    }

    private void tell(String state) {
        web.evaluateJavascript("window.ftvPlayer && ftvPlayer('" + state + "')", null);
    }

    /** The remote's keys go to the page as the keys the browser version uses. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        String key;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_DPAD_LEFT: key = "ArrowLeft"; break;
            case KeyEvent.KEYCODE_DPAD_RIGHT: key = "ArrowRight"; break;
            case KeyEvent.KEYCODE_DPAD_UP: key = "ArrowUp"; break;
            case KeyEvent.KEYCODE_DPAD_DOWN: key = "ArrowDown"; break;
            case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER: case KeyEvent.KEYCODE_NUMPAD_ENTER: key = "Enter"; break;
            case KeyEvent.KEYCODE_MENU: key = "ContextMenu"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: case KeyEvent.KEYCODE_MEDIA_PAUSE: case KeyEvent.KEYCODE_MEDIA_PLAY: key = "p"; break;
            case KeyEvent.KEYCODE_BACK: if (!backHandled) return super.dispatchKeyEvent(e); key = "Escape"; break;
            default: return super.dispatchKeyEvent(e);
        }
        if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0)
            web.evaluateJavascript("window.ftvKey && ftvKey('" + key + "')", null);
        return true;
    }

    private boolean tuned;   // a channel is playing

    /** Phone: leaving for another app keeps the game in a small window (picture-in-picture), AutoTune still on. */
    @Override protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (!phone || !tuned) return;
        try {
            enterPictureInPictureMode(new android.app.PictureInPictureParams.Builder().setAspectRatio(new android.util.Rational(16, 9)).build());
        } catch (IllegalStateException e) { Log.w(TAG, "pip", e); }
    }
    @Override public void onPictureInPictureModeChanged(boolean on, Configuration c) {
        super.onPictureInPictureModeChanged(on, c);
        web.evaluateJavascript("document.documentElement.classList.toggle('pip', " + on + ")", null);
        main.post(this::layoutVideo);
    }

    @Override protected void onPause() {
        super.onPause();
        if (isInPictureInPictureMode()) return;   // still on screen, in its small window
        playback.pause(); sidePlayback.pause(); clock.setPaused(true);
    }
    @Override protected void onResume() { super.onResume(); playback.resume(); sidePlayback.resume(); clock.setPaused(false); }
    /** Home or another app in front: AutoTune stops switching until you come back (RosterRadar does the same). */
    @Override protected void onStop() { super.onStop(); playback.suspend(); sidePlayback.suspend(); web.evaluateJavascript("window.ftvAway && ftvAway(true)", null); }
    @Override protected void onStart() {
        super.onStart();
        if (web == null) return;
        playback.wake(); sidePlayback.wake(); web.evaluateJavascript("window.ftvAway && ftvAway(false)", null);
        // Back from Home: a fresh look for updates (not more than every 10 minutes).
        if (lastUpdateCheck > 0 && System.currentTimeMillis() - lastUpdateCheck > 10 * 60_000L) checkForUpdate(false);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        server.stop();
        clock.release();
        playback.release();
        sidePlayback.release();
        TvServer.timeshift.stop();   // the rewind buffer goes with the app
        web.destroy();
        super.onDestroy();
    }
}
