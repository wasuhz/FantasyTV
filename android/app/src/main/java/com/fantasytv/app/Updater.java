package com.fantasytv.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates from GitHub: every release publishes FantasyTV.apk and latest.json ({versionCode, versionName, notes, apk})
 * at github.com/wasuhz/FantasyTV-releases. check() reads latest.json; install() downloads the APK, checks it is
 * FantasyTV and newer, and hands it to Android's installer (which asks once to allow FantasyTV to install apps).
 * Blocking: off the main thread.
 */
final class Updater {
    private static final String TAG = "FantasyTVUpdate";
    static final String LATEST = "https://github.com/wasuhz/FantasyTV-releases/releases/latest/download/latest.json";
    private static final String ACTION = "com.fantasytv.app.UPDATE_STATUS";

    /** The newest release when it's newer than this app, else null. */
    static JSONObject check() {
        try {
            JSONObject j = new JSONObject(new String(get(LATEST), "UTF-8"));
            return j.optInt("versionCode") > BuildConfig.VERSION_CODE ? j : null;
        } catch (Exception e) {
            Log.i(TAG, "check: " + e);
            return null;
        }
    }

    /** Download and install; returns null when handed to the installer, else what went wrong. */
    static String install(Context c, JSONObject release) {
        try {
            File apk = new File(c.getCacheDir(), "update.apk");
            try (FileOutputStream f = new FileOutputStream(apk)) { f.write(get(release.getString("apk"))); }
            PackageInfo theirs = c.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
            if (theirs == null || !c.getPackageName().equals(theirs.packageName)) return "The download isn't FantasyTV";
            if (theirs.versionCode <= BuildConfig.VERSION_CODE) return "That version isn't newer than this one";
            PackageInstaller installer = c.getPackageManager().getPackageInstaller();
            for (PackageInstaller.SessionInfo s : installer.getMySessions()) installer.abandonSession(s.getSessionId());
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(c.getPackageName());
            params.setSize(apk.length());
            // Android 12+: no prompt when FantasyTV installed the version it's replacing (after its first self-update).
            // Otherwise Android still asks, through the Receiver below.
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("FantasyTV.apk", 0, apk.length())) {
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    session.fsync(out);
                }
                Intent done = new Intent(c, Receiver.class).setAction(ACTION);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                session.commit(PendingIntent.getBroadcast(c, id, done, flags).getIntentSender());
            }
            return null;
        } catch (Exception e) {
            Log.w(TAG, "install: " + e);
            return "Update failed: " + e.getMessage();
        }
    }

    /** Android's installer answers: it needs you to confirm (and the first time, to allow FantasyTV to install apps). */
    public static class Receiver extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                try { if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                catch (RuntimeException e) { Log.w(TAG, "installer didn't open: " + e); }
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                Log.w(TAG, "Not installed (" + status + "): " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        }
    }

    /** GET, following GitHub's redirects to its file host. */
    private static byte[] get(String url) throws IOException {
        for (int hops = 0; hops < 5; hops++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(30_000);
            c.setRequestProperty("User-Agent", "FantasyTV/" + BuildConfig.VERSION_NAME);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { url = c.getHeaderField("Location"); c.disconnect(); continue; }
            if (code != 200) { c.disconnect(); throw new IOException("HTTP " + code); }
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
                return b.toByteArray();
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("too many redirects");
    }
}
