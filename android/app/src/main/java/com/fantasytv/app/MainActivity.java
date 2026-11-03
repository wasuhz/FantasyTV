package com.fantasytv.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
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
        clock = new ClockReader(this, surface, (period, seconds, logo, at) -> main.post(() ->
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
        // Updates: 20 s after opening (the page is up by then), then every 6 hours while it runs.
        main.postDelayed(new Runnable() {
            @Override public void run() { checkForUpdate(); main.postDelayed(this, 6 * 3600_000L); }
        }, 20_000);
    }

    /** What the page can ask of the TV. Called on the WebView's thread. */
    final class Bridge {
        @JavascriptInterface public void play(String url) { main.post(() -> { playback.play(url); clock.setActive(true); }); }
        @JavascriptInterface public void stop() { main.post(() -> { playback.stop(); clock.setActive(false); }); }
        /** True while Back should go to the page (closing the Radar, cancelling a switch) instead of leaving. */
        @JavascriptInterface public void setBack(boolean handled) { backHandled = handled; }
        /** Split screen: this channel on the right (muted), the main one moves left. Null or empty: back to one. */
        /** This app's version, for the page and the phone. */
        @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }
        /** False when this TV can't read the game clock off the picture (its chip crashed Google's text recognition). */
        @JavascriptInterface public boolean clockWorks() { return clock.works(); }
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
        @JavascriptInterface public void checkUpdate() { checkForUpdate(); }
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
    }

    private volatile JSONObject newer;   // a newer release on GitHub, once found

    /** Ask GitHub for a newer release (off the main thread); tell the page when there is one. */
    private void checkForUpdate() {
        new Thread(() -> {
            JSONObject r = Updater.check();
            if (r == null) return;
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
        int w = root.getWidth(), h = root.getHeight();
        if (url == null) {
            sidePlayback.stop();
            sideSurface.setVisibility(View.GONE);
            mainSurface.setLayoutParams(new FrameLayout.LayoutParams(-1, -1));
            return;
        }
        FrameLayout.LayoutParams left = new FrameLayout.LayoutParams(w / 2, h / 2), right = new FrameLayout.LayoutParams(w / 2, h / 2);
        left.leftMargin = 0; left.topMargin = h / 4;
        right.leftMargin = w / 2; right.topMargin = h / 4;
        mainSurface.setLayoutParams(left);
        sideSurface.setLayoutParams(right);
        sideSurface.setVisibility(View.VISIBLE);
        sidePlayback.play(url);
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

    @Override protected void onPause() { super.onPause(); playback.pause(); sidePlayback.pause(); clock.setPaused(true); }
    @Override protected void onResume() { super.onResume(); playback.resume(); sidePlayback.resume(); clock.setPaused(false); }
    /** Home or another app in front: AutoTune stops switching until you come back (RosterRadar does the same). */
    @Override protected void onStop() { super.onStop(); playback.suspend(); sidePlayback.suspend(); web.evaluateJavascript("window.ftvAway && ftvAway(true)", null); }
    @Override protected void onStart() { super.onStart(); if (web != null) { playback.wake(); sidePlayback.wake(); web.evaluateJavascript("window.ftvAway && ftvAway(false)", null); } }

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
