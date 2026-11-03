package com.fantasytv.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * A Stalker (Ministra / MAG) portal: logged in with the portal's address and a MAC address, like a MAG box. The TV
 * turns it into what it already reads from Xtream and Dispatcharr (TvServer: /stalker/m3u and /stalker/epg), and each
 * channel's address is /stalker/play, which asks the portal for a fresh stream link (they expire) and sends the player
 * there. One login per portal and MAC, kept while it works.
 */
final class Stalker {
    static final String UA = "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";
    private static final Map<String, Stalker> logins = new HashMap<>();

    private final String portal, mac;
    private String api;      // the portal's load.php, once found
    private String token;
    private long tokenAt;

    private Stalker(String portal, String mac) { this.portal = portal; this.mac = mac; }

    /** The login for this portal and MAC (made once, reused). */
    static synchronized Stalker of(String portal, String mac) throws IOException {
        if (portal == null || portal.trim().isEmpty()) throw new IOException("No Stalker portal address");
        if (mac == null || !mac.trim().matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}")) throw new IOException("The MAC address should look like 00:1A:79:12:34:56");
        String p = portal.trim().replaceAll("/+$", ""), m = mac.trim().toUpperCase(Locale.ROOT);
        if (!p.matches("(?i)https?://.*")) throw new IOException("The portal address needs http:// or https://");
        return logins.computeIfAbsent(p + "|" + m, k -> new Stalker(p, m));
    }

    // ---- what the TV asks for

    /** Every live channel as an M3U list: its group, number, and a /stalker/play address for the player. */
    synchronized String m3u(String self) throws IOException {
        Map<String, String> genres = new HashMap<>();
        try {
            JSONArray g = call("type=itv&action=get_genres").optJSONArray("js");
            for (int i = 0; g != null && i < g.length(); i++) genres.put(g.getJSONObject(i).optString("id"), g.getJSONObject(i).optString("title"));
        } catch (IOException | JSONException ignored) { /* no groups: still the channels */ }
        StringBuilder b = new StringBuilder("#EXTM3U\n");
        for (JSONObject ch : channels()) {
            String name = ch.optString("name").replace(",", " "), id = ch.optString("id");
            b.append("#EXTINF:-1 tvg-id=\"").append(attr(id)).append("\" tvg-chno=\"").append(attr(ch.optString("number")))
             .append("\" group-title=\"").append(attr(genres.getOrDefault(ch.optString("tv_genre_id"), ""))).append("\",").append(name).append('\n')
             .append(self).append("/stalker/play?cmd=").append(URLEncoder.encode(ch.optString("cmd"), "UTF-8")).append('\n');
        }
        return b.toString();
    }

    /** What's on now and next on every channel, as XMLTV (empty if the portal has no guide). */
    synchronized String epg() {
        StringBuilder b = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n");
        try {
            JSONObject data = call("type=itv&action=get_epg_info&period=6").getJSONObject("js").optJSONObject("data");
            SimpleDateFormat f = new SimpleDateFormat("yyyyMMddHHmmss Z", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            for (Iterator<String> it = data == null ? null : data.keys(); it != null && it.hasNext(); ) {
                String id = it.next();
                JSONArray progs = data.optJSONArray(id);
                for (int i = 0; progs != null && i < progs.length(); i++) {
                    JSONObject p = progs.getJSONObject(i);
                    long start = p.optLong("start_timestamp"), stop = p.optLong("stop_timestamp");
                    if (start <= 0 || stop <= start) continue;
                    b.append("<programme channel=\"").append(xml(id)).append("\" start=\"").append(f.format(new Date(start * 1000)))
                     .append("\" stop=\"").append(f.format(new Date(stop * 1000))).append("\"><title>").append(xml(p.optString("name")))
                     .append("</title><desc>").append(xml(p.optString("descr"))).append("</desc></programme>\n");
                }
            }
        } catch (IOException | JSONException ignored) { /* no guide: channel names still find games */ }
        return b.append("</tv>\n").toString();
    }

    /** A playable address for a channel's command, fresh from the portal. */
    synchronized String link(String cmd) throws IOException {
        try {
            String got = call("type=itv&action=create_link&cmd=" + URLEncoder.encode(cmd, "UTF-8") + "&series=&forced_storage=0&disable_ad=0&download=0")
                    .getJSONObject("js").optString("cmd");
            int http = got.indexOf("http");
            if (http < 0) throw new IOException("The portal gave no stream address");
            return got.substring(http).trim();
        } catch (JSONException e) {
            throw new IOException("The portal's answer wasn't readable");
        }
    }

    /**
     * Opens a stream link the way a MAG box would (its User-Agent, MAC cookie and login), on a plain socket: IPTV stream
     * servers often answer in ways Android's web client rejects, and hang up on anything that isn't a box. Follows
     * redirects. Returns the stream with the server's headers already read past.
     */
    java.net.Socket open(String link) throws IOException {
        for (int hops = 0; hops < 5; hops++) {
            URL u = new URL(link);
            java.net.Socket s = new java.net.Socket();
            s.connect(new java.net.InetSocketAddress(u.getHost(), u.getPort() > 0 ? u.getPort() : 80), 10_000);
            s.setSoTimeout(15_000);
            String path = u.getFile().isEmpty() ? "/" : u.getFile();
            String req = "GET " + path + " HTTP/1.1\r\nHost: " + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "")
                    + "\r\nUser-Agent: " + UA + "\r\nX-User-Agent: Model: MAG250; Link: WiFi\r\nAccept: */*\r\nReferer: " + portal + "/"
                    + "\r\nCookie: mac=" + URLEncoder.encode(mac, "UTF-8") + "; stb_lang=en; timezone=" + URLEncoder.encode(TimeZone.getDefault().getID(), "UTF-8")
                    + (token != null ? "\r\nAuthorization: Bearer " + token : "") + "\r\nConnection: close\r\n\r\n";
            s.getOutputStream().write(req.getBytes(StandardCharsets.ISO_8859_1));
            InputStream in = s.getInputStream();
            String status = line(in), location = null;
            for (String h; !(h = line(in)).isEmpty(); )
                if (h.toLowerCase(Locale.ROOT).startsWith("location:")) location = h.substring(9).trim();
            android.util.Log.i("FantasyTVStalker", "stream: " + status + (location != null ? " (redirect)" : ""));
            int code = status.matches("\\S+ \\d{3}.*") ? Integer.parseInt(status.split(" ")[1]) : 200;   // ICY/odd servers: assume it's the stream
            if (code >= 300 && code < 400 && location != null) {
                s.close();
                link = new URL(u, location).toString();
                continue;
            }
            if (code >= 400) { s.close(); throw new IOException("The stream server said " + status); }
            return s;
        }
        throw new IOException("Too many redirects from the stream server");
    }

    /** One header line (without its CRLF). */
    private static String line(InputStream in) throws IOException {
        StringBuilder b = new StringBuilder();
        for (int c; (c = in.read()) >= 0 && c != '\n'; ) if (c != '\r') b.append((char) c);
        return b.toString();
    }

    /** Settings' Test connection: logs in, counts channels, and names a few NFL ones. */
    synchronized JSONObject test() throws IOException {
        List<JSONObject> all = channels();
        JSONArray nfl = new JSONArray();
        int count = 0;
        for (JSONObject ch : all) if (ch.optString("name").matches("(?i).*\\bnfl\\b.*")) { count++; if (nfl.length() < 3) nfl.put(ch.optString("name")); }
        try {
            return new JSONObject().put("ok", true).put("channels", all.size()).put("nfl", count).put("sample", nfl).put("api", api);
        } catch (JSONException e) { throw new IOException(e); }
    }

    // ---- the portal

    private List<JSONObject> channels() throws IOException {
        JSONObject r;
        try {
            r = call("type=itv&action=get_all_channels");
        } catch (IOException e) {
            throw new IOException("Logged in, but the channel list failed: " + e.getMessage());
        }
        try {
            Object js = r.opt("js");
            JSONArray data = js instanceof JSONObject ? ((JSONObject) js).optJSONArray("data") : js instanceof JSONArray ? (JSONArray) js : null;
            List<JSONObject> out = new ArrayList<>();
            for (int i = 0; data != null && i < data.length(); i++) out.add(data.getJSONObject(i));
            if (out.isEmpty()) throw new IOException("Logged in, but the portal lists no channels for this MAC");
            return out;
        } catch (JSONException e) {
            throw new IOException("Logged in, but the channel list wasn't readable");
        }
    }

    /** One portal request (logged in first), logging in again once if the portal has forgotten us. */
    private JSONObject call(String query) throws IOException {
        if (token == null || System.currentTimeMillis() - tokenAt > 3600_000) login();
        try {
            return json(get(api + "?" + query + "&JsHttpRequest=1-xml", true));
        } catch (IOException e) {
            login();
            return json(get(api + "?" + query + "&JsHttpRequest=1-xml", true));
        }
    }

    /** Handshake (finding the portal's API on the way), then the profile, which some portals need before anything else. */
    private void login() throws IOException {
        token = null;
        IOException last = null;
        for (String candidate : api != null ? new String[] { api } : apis()) {
            String t;
            try {
                t = json(get(candidate + "?type=stb&action=handshake&token=&prehash=0&JsHttpRequest=1-xml", false))
                        .getJSONObject("js").optString("token");
            } catch (IOException | JSONException e) {
                last = new IOException("Login (handshake) failed: " + e.getMessage());
                continue;
            }
            if (t.isEmpty()) continue;
            api = candidate;
            token = t;
            tokenAt = System.currentTimeMillis();
            // The profile switches the login on; a portal that doesn't know the MAC says so here.
            JSONObject profile;
            try {
                profile = json(get(api + "?type=stb&action=get_profile&hd=1&stb_type=MAG250&image_version=218&video_out=hdmi"
                        + "&auth_second_step=1&num_banks=2&not_valid_token=0&JsHttpRequest=1-xml", true)).optJSONObject("js");
            } catch (IOException e) {
                token = null;
                throw new IOException("Logged in, but the profile failed: " + e.getMessage());
            }
            String blocked = profile == null ? "" : profile.optString("block_msg", "");
            if (!blocked.isEmpty()) { token = null; throw new IOException("The portal says: " + blocked); }
            return;
        }
        throw last != null ? last : new IOException("Couldn't log in to the portal (check the address and MAC)");
    }

    /** Where portals keep their API: next to /c/, or under stalker_portal. */
    private String[] apis() {
        String root = portal.replaceAll("(?i)/c$", "");
        if (root.toLowerCase(Locale.ROOT).endsWith("/stalker_portal")) return new String[] { root + "/server/load.php" };
        return new String[] { root + "/portal.php", root + "/server/load.php", root + "/stalker_portal/server/load.php" };
    }

    private String get(String url, boolean auth) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("X-User-Agent", "Model: MAG250; Link: WiFi");
        c.setRequestProperty("Referer", portal + "/");
        c.setRequestProperty("Accept", "*/*");
        c.setRequestProperty("Cookie", "mac=" + URLEncoder.encode(mac, "UTF-8") + "; stb_lang=en; timezone="
                + URLEncoder.encode(TimeZone.getDefault().getID(), "UTF-8"));
        if (auth && token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        int code = c.getResponseCode();
        if (code == 401 || code == 403) throw new IOException("The portal turned this MAC down (HTTP " + code + ")");
        if (code >= 400) throw new IOException("Portal error (HTTP " + code + ")");
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            String body = b.toString(StandardCharsets.UTF_8.name());
            if (body.contains("Authorization failed")) throw new IOException("The portal turned this MAC down");
            return body;
        }
    }

    /** The portal's JSON answer; if it isn't JSON, what it said instead (the start of it), so Test connection can show it. */
    private static JSONObject json(String body) throws IOException {
        try { return new JSONObject(body); } catch (JSONException e) {
            String said = body.replaceAll("<[^>]*>", " ").replaceAll("\\s+", " ").trim();
            throw new IOException(said.isEmpty() ? "the portal sent an empty answer" : "the portal said: " + (said.length() > 140 ? said.substring(0, 140) + "…" : said));
        }
    }
    private static String attr(String s) { return s.replace("\"", "'"); }
    private static String xml(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;"); }
}
