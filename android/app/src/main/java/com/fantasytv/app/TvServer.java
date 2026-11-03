package com.fantasytv.app;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The TV's own small web server, the same as server/Server.java on the PC: the pages (from the APK's assets), the
 * TV ↔ phone relay (/api/state, /api/cmd), the settings file (/api/config, files/config.json) and /proxy for the
 * IPTV server, which browsers (and the WebView) can't read directly. Port 8765 on every address, so the phone
 * remote reaches it over the home network.
 */
final class TvServer {
    private static final String TAG = "FantasyTVServer";
    static final int PORT = 8765;

    private final Context context;
    private final File config;
    private final Yahoo yahoo;
    /** The rewind buffer of the channel on screen (Playback tunes it; /ts reads it). */
    static final Timeshift timeshift = new Timeshift();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private ServerSocket server;
    private volatile byte[] state = "{}".getBytes(StandardCharsets.UTF_8);
    private final List<String> commands = Collections.synchronizedList(new ArrayList<>());

    TvServer(Context c) {
        context = c.getApplicationContext();
        File dir = c.getExternalFilesDir(null);
        config = new File(dir != null ? dir : c.getFilesDir(), "config.json");
        // Yahoo's tokens stay in the app's private storage, out of reach of adb pulls of the shared folder.
        yahoo = new Yahoo(c.getFilesDir());
    }

    void start() throws IOException {
        // Right after a restart or an update the old FantasyTV can still hold the port for a moment: keep trying ~6 s.
        for (int tries = 0; ; tries++) {
            server = new ServerSocket();
            server.setReuseAddress(true);
            try {
                server.bind(new java.net.InetSocketAddress(PORT));
                break;
            } catch (IOException e) {
                server.close();
                if (tries >= 12) throw e;
                try { Thread.sleep(500); } catch (InterruptedException ie) { throw e; }
            }
        }
        pool.execute(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException e) {
                    if (!server.isClosed()) Log.w(TAG, "accept: " + e);
                }
            }
        });
    }

    void stop() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        pool.shutdownNow();
    }

    /** The phone remote's address: this TV on the home network. */
    static String remoteUrl() {
        try {
            for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!n.isUp() || n.isLoopback() || n.getName().startsWith("tun")) continue;
                for (InetAddress a : Collections.list(n.getInetAddresses()))
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) return "http://" + a.getHostAddress() + ":" + PORT + "/remote.html";
            }
        } catch (Exception ignored) { }
        return "http://127.0.0.1:" + PORT + "/remote.html";
    }

    private void handle(Socket s) {
        try (Socket sock = s; InputStream in = sock.getInputStream(); OutputStream out = sock.getOutputStream()) {
            sock.setSoTimeout(15_000);
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            if (req.length < 2) return;
            String method = req[0], target = req[1];
            int length = 0;
            for (String l : lines) {
                int c = l.indexOf(':');
                if (c > 0 && l.substring(0, c).trim().equalsIgnoreCase("content-length")) length = Integer.parseInt(l.substring(c + 1).trim());
            }
            byte[] body = method.equals("POST") ? readBody(in, Math.min(length, 1 << 20)) : new byte[0];
            int q = target.indexOf('?');
            String path = q < 0 ? target : target.substring(0, q), query = q < 0 ? "" : target.substring(q + 1);

            switch (path) {
                case "/api/state":
                    if (method.equals("POST")) { state = body; send(out, 204, null, null); }
                    else send(out, 200, "application/json", state);
                    break;
                case "/api/cmd":
                    if (method.equals("POST")) { commands.add(new String(body, StandardCharsets.UTF_8)); send(out, 204, null, null); }
                    else {
                        String all;
                        synchronized (commands) { all = "[" + String.join(",", commands) + "]"; commands.clear(); }
                        send(out, 200, "application/json", all.getBytes(StandardCharsets.UTF_8));
                    }
                    break;
                case "/api/info":
                    send(out, 200, "application/json", ("{\"remote\":\"" + remoteUrl() + "\",\"tv\":true}").getBytes(StandardCharsets.UTF_8));
                    break;
                case "/api/config":
                    if (method.equals("POST")) {
                        try (FileOutputStream f = new FileOutputStream(config)) { f.write(body); }
                        send(out, 204, null, null);
                    } else {
                        send(out, 200, "application/json", config.exists() ? Files.readAllBytes(config.toPath()) : "{}".getBytes(StandardCharsets.UTF_8));
                    }
                    break;
                case "/proxy":
                    proxy(out, query);
                    break;
                case "/ts": {   // the channel on screen, from the rewind buffer: ?back=seconds (0 = live)
                    int back = 0;
                    for (String p : query.split("&")) if (p.startsWith("back=")) back = Math.max(0, Integer.parseInt(p.substring(5)));
                    out.write(("HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
                            .getBytes(StandardCharsets.ISO_8859_1));
                    timeshift.serve(out, back);
                    break;
                }
                case "/api/yahoo/status": case "/api/yahoo/start": case "/api/yahoo/code": case "/api/yahoo/connect":
                case "/api/yahoo/roster": case "/api/yahoo/disconnect": case "/api/yahoo/check":
                    yahoo(out, path.substring("/api/yahoo/".length()), query, body);
                    break;
                case "/yahoo/done":   // back from Yahoo through the return page: finish the sign-in here, then the remote
                    yahooDone(out, query);
                    break;
                case "/api/bugs": {   // the saved score-bug samples (Settings: save score-bug samples), newest last
                    File[] all = new File(context.getFilesDir(), "bugs").listFiles();
                    StringBuilder j = new StringBuilder("[");
                    if (all != null) {
                        java.util.Arrays.sort(all, (a, b) -> a.getName().compareTo(b.getName()));
                        for (File f : all) j.append(j.length() > 1 ? "," : "").append('"').append(f.getName()).append('"');
                    }
                    send(out, 200, "application/json", j.append(']').toString().getBytes(StandardCharsets.UTF_8));
                    break;
                }
                default:
                    if (path.startsWith("/bugs/") && path.matches("/bugs/\\d+\\.jpg")) {   // one sample (digits only: no other files)
                        File f = new File(new File(context.getFilesDir(), "bugs"), path.substring(6));
                        if (f.isFile()) { send(out, 200, "image/jpeg", Files.readAllBytes(f.toPath())); break; }
                    }
                    asset(out, path);
            }
        } catch (Exception e) {
            Log.w(TAG, "request: " + e);
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, last4 = 0;
        while ((c = in.read()) != -1) {
            b.write(c);
            last4 = (last4 << 8) | c;
            if (last4 == 0x0d0a0d0a) return b.toString("ISO-8859-1");   // \r\n\r\n
            if (b.size() > 16384) return null;
        }
        return null;
    }

    private static byte[] readBody(InputStream in, int length) throws IOException {
        byte[] b = new byte[length];
        int off = 0;
        while (off < length) {
            int n = in.read(b, off, length - off);
            if (n < 0) break;
            off += n;
        }
        return b;
    }

    /** /yahoo/done?code=…: finish the Yahoo sign-in, then a small page that sends the phone back to the remote. */
    private void yahooDone(OutputStream out, String query) throws IOException {
        String code = null, error = null;
        for (String p : query.split("&")) {
            if (p.startsWith("code=")) code = URLDecoder.decode(p.substring(5), "UTF-8");
            else if (p.startsWith("error=")) error = URLDecoder.decode(p.substring(6), "UTF-8");
        }
        String msg;
        boolean ok = false;
        if (code == null || code.isEmpty()) msg = error != null && error.contains("denied") ? "You didn't approve FantasyTV on Yahoo." : "Yahoo didn't send a code back.";
        else {
            try { yahoo.finish(code); yahooCache = null; ok = true; msg = "Yahoo connected. Your Yahoo teams are loading on the TV."; }
            catch (Exception e) { Log.w(TAG, "yahoo done: " + e); msg = "Couldn't finish: " + e.getMessage(); }
        }
        if (ok) synchronized (commands) { commands.add("{\"type\":\"syncRosters\"}"); }   // the TV reloads your teams
        String safe = msg.replace("&", "&amp;").replace("<", "&lt;");
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>FantasyTV · Yahoo</title>"
                + "<body style='margin:0;font:600 18px/1.4 system-ui,sans-serif;background:#021838;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px;box-sizing:border-box'>"
                + "<div><div style='font-size:56px'>" + (ok ? "✓" : "✗") + "</div><p>" + safe + "</p>"
                + "<a href='/remote.html' style='display:inline-block;margin-top:12px;padding:14px 22px;border-radius:10px;background:#e8213a;color:#fff;text-decoration:none'>Back to FantasyTV</a></div>"
                + (ok ? "<script>setTimeout(()=>location.replace('/remote.html'),2500)</script>" : "") + "</body>";
        send(out, 200, "text/html; charset=utf-8", html.getBytes(StandardCharsets.UTF_8));
    }

    /** Yahoo sign-in and rosters (Yahoo.java), as JSON; failures as {"error": "…"} with status 500. */
    private void yahoo(OutputStream out, String action, String query, byte[] body) throws IOException {
        try {
            Object result;
            int week = 1;
            for (String p : query.split("&")) if (p.startsWith("week=")) week = Integer.parseInt(p.substring(5));
            switch (action) {
                case "status": result = yahoo.status(); break;
                case "connect":   // the easy way: FantasyTV's own Yahoo app, back to this TV afterwards
                    result = new org.json.JSONObject().put("url", yahoo.startBuiltIn(remoteUrl().replace("/remote.html", "")));
                    break;
                case "check": result = yahoo.check(); break;
                case "start": {
                    org.json.JSONObject b = new org.json.JSONObject(new String(body, StandardCharsets.UTF_8));
                    result = new org.json.JSONObject().put("url", yahoo.start(b.optString("id"), b.optString("secret"), b.optString("redirect")));
                    break;
                }
                case "code": {
                    yahoo.finish(new org.json.JSONObject(new String(body, StandardCharsets.UTF_8)).optString("code"));
                    yahooCache = null;
                    result = rosters(week);
                    break;
                }
                case "disconnect": yahoo.disconnect(); yahooCache = null; result = new org.json.JSONObject().put("ok", true); break;
                default: result = yahoo.connected() ? rosters(week) : new org.json.JSONArray();
            }
            send(out, 200, "application/json", result.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "yahoo " + action + ": " + e);
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            String json;
            try { json = new org.json.JSONObject().put("error", msg).toString(); } catch (org.json.JSONException j) { json = "{}"; }
            send(out, 500, "application/json", json.getBytes(StandardCharsets.UTF_8));
        }
    }

    private volatile org.json.JSONArray yahooCache;
    private volatile long yahooCacheAt;
    private volatile int yahooCacheWeek;

    /** Yahoo rosters, kept 5 minutes (the TV re-reads every 10). */
    private org.json.JSONArray rosters(int week) throws Exception {
        org.json.JSONArray c = yahooCache;
        if (c != null && yahooCacheWeek == week && System.currentTimeMillis() - yahooCacheAt < 5 * 60_000) return c;
        c = yahoo.rosters(week);
        yahooCache = c;
        yahooCacheWeek = week;
        yahooCacheAt = System.currentTimeMillis();
        return c;
    }

    /** GET only, http(s) only, passed through as it arrives (live video too). */
    private void proxy(OutputStream out, String query) throws IOException {
        // &cookie=: a private ESPN fantasy league's espn_s2/SWID login (the page can't set cookies itself). Only ever
        // sent to espn.com, wherever the url points.
        String cookie = null;
        int k = query.indexOf("&cookie=");
        if (k >= 0) {
            String rest = query.substring(k + 8);
            int amp = rest.indexOf('&');
            cookie = URLDecoder.decode(amp < 0 ? rest : rest.substring(0, amp), "UTF-8");
            query = query.substring(0, k) + (amp < 0 ? "" : rest.substring(amp));
        }
        String ua = Playback.USER_AGENT;
        int u = query.indexOf("&ua=");   // for checking a server: try another User-Agent
        if (u >= 0) { ua = URLDecoder.decode(query.substring(u + 4), "UTF-8"); query = query.substring(0, u); }
        String url = query.startsWith("url=") ? URLDecoder.decode(query.substring(4), "UTF-8") : "";
        if (!url.startsWith("http://") && !url.startsWith("https://")) { send(out, 400, "text/plain", "url= needed".getBytes()); return; }
        HttpURLConnection c;
        int code;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", ua);
            String host = c.getURL().getHost();
            if (cookie != null && (host.equals("espn.com") || host.endsWith(".espn.com"))) c.setRequestProperty("Cookie", cookie);
            code = c.getResponseCode();
        } catch (IOException e) {
            // Unreachable server, wrong port, bad name: say so (the phone's Test connection shows it).
            String why = e instanceof java.net.UnknownHostException ? "Server name not found"
                    : e instanceof java.net.SocketTimeoutException ? "No answer from the server (timed out)"
                    : e instanceof java.net.ConnectException ? "Connection refused (wrong port, or the server is off)"
                    : e.getClass().getSimpleName() + ": " + e.getMessage();
            send(out, 502, "text/plain", why.getBytes(StandardCharsets.UTF_8));
            return;
        }
        String type = c.getContentType();
        out.write(("HTTP/1.1 " + code + " OK\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n"
                + (type != null ? "Content-Type: " + type + "\r\n" : "") + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
        try (InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream()) {
            if (in == null) return;
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) { out.write(buf, 0, n); out.flush(); }
        } finally {
            c.disconnect();
        }
    }

    private void asset(OutputStream out, String path) throws IOException {
        if (path.endsWith("/")) path += "index.html";
        String name = path.substring(1);
        if (name.contains("..")) { send(out, 404, "text/plain", "not found".getBytes()); return; }
        byte[] data;
        try (InputStream in = context.getAssets().open(name)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            data = b.toByteArray();
        } catch (IOException e) {
            send(out, 404, "text/plain", "not found".getBytes());
            return;
        }
        String ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String type = ext.equals("html") ? "text/html; charset=utf-8" : ext.equals("js") ? "text/javascript; charset=utf-8"
                : ext.equals("css") ? "text/css; charset=utf-8" : ext.equals("svg") ? "image/svg+xml" : ext.equals("png") ? "image/png" : "application/octet-stream";
        send(out, 200, type, data);
    }

    private static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(code).append(code == 200 ? " OK" : code == 204 ? " No Content" : " Error")
                .append("\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n");
        if (type != null) h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(body == null ? 0 : body.length).append("\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (body != null) out.write(body);
        out.flush();
    }
}
