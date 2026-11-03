package com.fantasytv.app;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;

/**
 * Your Yahoo Fantasy football teams. Yahoo's API needs your OK: you make a free Yahoo developer app once (its Client
 * ID and Secret), sign in from the phone, and paste back the code Yahoo shows. The TV keeps the refresh token in
 * files/yahoo.json and gets a fresh access token by itself every hour. Blocking calls: run off the main thread.
 */
final class Yahoo {
    private static final String AUTH = "https://api.login.yahoo.com/oauth2/request_auth";
    private static final String TOKEN = "https://api.login.yahoo.com/oauth2/get_token";
    private static final String API = "https://fantasysports.yahooapis.com/fantasy/v2";

    private final File file;

    Yahoo(File dir) { file = new File(dir, "yahoo.json"); }

    private synchronized JSONObject load() {
        try { return file.exists() ? new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)) : new JSONObject(); }
        catch (Exception e) { return new JSONObject(); }
    }

    private synchronized void save(JSONObject j) throws IOException {
        try (FileOutputStream f = new FileOutputStream(file)) { f.write(j.toString().getBytes(StandardCharsets.UTF_8)); }
    }

    /**
     * FantasyTV's own Yahoo app, one for everyone (like FantasyPros'): you just sign in and approve. Yahoo sends you
     * back to RETURN, a small page that hands the one-time code to this TV on your Wi-Fi (its address rides along in
     * Yahoo's `state`), and the TV finishes the sign-in itself (/yahoo/done). No keys or codes to copy.
     */
    static final String RETURN = "https://wasuhz.github.io/FantasyTV-releases/yahoo.html";
    static boolean builtIn() { return !BuildConfig.YAHOO_ID.isEmpty() && !BuildConfig.YAHOO_SECRET.isEmpty(); }

    /** Step 1, the easy way: FantasyTV's app; tvBase (http://this-tv:8765) comes back to us through the return page. */
    String startBuiltIn(String tvBase) throws Exception {
        if (!builtIn()) throw new IOException("This FantasyTV build has no Yahoo app yet");
        JSONObject j = load();
        j.put("builtin", true).put("redirect", RETURN);
        j.remove("id"); j.remove("secret"); j.remove("refresh"); j.remove("access");
        save(j);
        return AUTH + "?client_id=" + enc(BuildConfig.YAHOO_ID) + "&redirect_uri=" + enc(RETURN)
                + "&response_type=code&scope=fspt-r&language=en-us&state=" + enc(tvBase);
    }

    /** Step 1 with your own Yahoo app (the old way, still there): keep its keys and give the phone Yahoo's sign-in page. */
    String start(String clientId, String secret, String redirect) throws Exception {
        JSONObject j = load();
        j.remove("builtin");
        String r = redirect == null || redirect.trim().isEmpty() ? "oob" : redirect.trim();
        // Scheme and host in lower case (a phone keyboard's "Https://"): Yahoo matches the address exactly.
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^[A-Za-z]+://[^/]*").matcher(r);
        if (m.find()) r = m.group().toLowerCase(java.util.Locale.ROOT) + r.substring(m.end());
        j.put("id", clientId.trim()).put("secret", secret.trim()).put("redirect", r);
        j.remove("refresh");
        j.remove("access");
        save(j);
        return AUTH + "?client_id=" + enc(j.getString("id")) + "&redirect_uri=" + enc(j.getString("redirect"))
                // fspt-r: Fantasy Sports, read. Without it Yahoo may sign you in but answer the Fantasy API with 403.
                + "&response_type=code&scope=fspt-r&language=en-us";
    }

    /** Step 2: the code Yahoo showed (or the whole address it sent you to) for tokens. */
    void finish(String pasted) throws Exception {
        String code = pasted.trim();
        int i = code.indexOf("code=");
        if (i >= 0) {
            code = code.substring(i + 5);
            int amp = code.indexOf('&');
            if (amp >= 0) code = code.substring(0, amp);
        }
        JSONObject j = load();
        token(j, "grant_type=authorization_code&redirect_uri=" + enc(j.optString("redirect", "oob")) + "&code=" + enc(code));
    }

    void disconnect() throws IOException {
        JSONObject j = load();
        j.remove("refresh");
        j.remove("access");
        save(j);
    }

    boolean connected() { return load().has("refresh"); }

    JSONObject status() throws JSONException {
        JSONObject j = load();
        return new JSONObject().put("connected", j.has("refresh")).put("hasKeys", j.has("id") && j.has("secret"))
                .put("id", j.optString("id")).put("redirect", j.optString("redirect", "oob"))
                .put("builtIn", builtIn()).put("usingBuiltIn", j.optBoolean("builtin"));
    }

    private void token(JSONObject j, String body) throws Exception {
        boolean ours = j.optBoolean("builtin");
        String id = ours ? BuildConfig.YAHOO_ID : j.getString("id"), secret = ours ? BuildConfig.YAHOO_SECRET : j.getString("secret");
        String basic = Base64.encodeToString((id + ":" + secret).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        HttpURLConnection c = (HttpURLConnection) new URL(TOKEN).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(10_000);
        c.setReadTimeout(15_000);
        c.setRequestProperty("Authorization", "Basic " + basic);
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
        int code = c.getResponseCode();
        String text = read(code < 400 ? c.getInputStream() : c.getErrorStream());
        if (code >= 400) {
            String why = text;
            try { JSONObject e = new JSONObject(text); why = e.optString("error_description", e.optString("error", text)); } catch (JSONException ignored) { }
            throw new IOException("Yahoo said: " + why);
        }
        JSONObject t = new JSONObject(text);
        // Which fields Yahoo sent (names only, and the scope if any), for diagnosing permission trouble.
        StringBuilder fields = new StringBuilder();
        for (Iterator<String> it = t.keys(); it.hasNext(); ) fields.append(it.next()).append(' ');
        if (t.has("scope")) fields.append("scope=").append(t.optString("scope"));
        j.put("tokenFields", fields.toString().trim());
        j.put("access", t.getString("access_token"));
        if (t.has("refresh_token")) j.put("refresh", t.getString("refresh_token"));
        j.put("expires", System.currentTimeMillis() + (t.optLong("expires_in", 3600) - 120) * 1000);
        save(j);
    }

    private String access() throws Exception {
        JSONObject j = load();
        if (!j.has("refresh")) throw new IOException("Yahoo isn't connected");
        if (!j.has("access") || System.currentTimeMillis() > j.optLong("expires")) {
            token(j, "grant_type=refresh_token&redirect_uri=" + enc(j.optString("redirect", "oob")) + "&refresh_token=" + enc(j.getString("refresh")));
        }
        return load().getString("access");
    }

    private JSONObject get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(API + path + (path.contains("?") ? "&" : "?") + "format=json").openConnection();
        c.setConnectTimeout(10_000);
        c.setReadTimeout(20_000);
        c.setRequestProperty("Authorization", "Bearer " + access());
        int code = c.getResponseCode();
        String text = read(code < 400 ? c.getInputStream() : c.getErrorStream());
        if (code >= 400) {
            String why = text;
            try { why = new JSONObject(text).getJSONObject("error").optString("description", text); } catch (JSONException ignored) { }
            if (code == 403) why += " (the Yahoo app needs Fantasy Sports · Read, and a fresh sign-in after adding it)";
            throw new IOException("Yahoo API " + code + ": " + why);
        }
        return new JSONObject(text).getJSONObject("fantasy_content");
    }

    /**
     * Your NFL teams this season with this week's roster: [{league, team, rec, players:[{name, team, pos, starter}]}].
     * Yahoo's JSON nests most things in arrays of one-key objects; merged() flattens those.
     */
    JSONArray rosters(int week) throws Exception {
        JSONObject games = get("/users;use_login=1/games;game_codes=nfl/teams").getJSONObject("users")
                .getJSONObject("0").getJSONArray("user").getJSONObject(1).getJSONObject("games");
        // The latest NFL season is the highest-numbered game entry.
        JSONObject game = null;
        for (Iterator<String> it = games.keys(); it.hasNext(); ) {
            String k = it.next();
            if (!k.equals("count")) game = games.getJSONObject(k).getJSONArray("game").length() > 1 ? games.getJSONObject(k) : game;
        }
        JSONArray out = new JSONArray();
        if (game == null) return out;
        JSONObject teams = game.getJSONArray("game").getJSONObject(1).getJSONObject("teams");
        for (Iterator<String> it = teams.keys(); it.hasNext(); ) {
            String k = it.next();
            if (k.equals("count")) continue;
            JSONObject t = merged(teams.getJSONObject(k).getJSONArray("team").getJSONArray(0));
            String teamKey = t.getString("team_key"), leagueKey = teamKey.substring(0, teamKey.indexOf(".t."));
            out.put(new JSONObject().put("team", t.optString("name")).put("league", leagueName(leagueKey))
                    .put("rec", receptionPoints(leagueKey)).put("players", roster(teamKey, week)));
        }
        return out;
    }

    private String leagueName(String leagueKey) {
        try { return merged(get("/league/" + leagueKey).getJSONArray("league")).optString("name", "Yahoo"); }
        catch (Exception e) { return "Yahoo"; }
    }

    /** Points per catch: stat 11 (receptions) in the league's scoring. Yahoo's default is half a point. */
    private double receptionPoints(String leagueKey) {
        try {
            JSONArray stats = get("/league/" + leagueKey + "/settings").getJSONArray("league").getJSONObject(1)
                    .getJSONArray("settings").getJSONObject(0).getJSONObject("stat_modifiers").getJSONArray("stats");
            for (int i = 0; i < stats.length(); i++) {
                JSONObject s = stats.getJSONObject(i).getJSONObject("stat");
                if (s.optInt("stat_id") == 11) return s.optDouble("value", 0);
            }
            return 0;
        } catch (Exception e) {
            return 0.5;
        }
    }

    private JSONArray roster(String teamKey, int week) throws Exception {
        JSONObject players = get("/team/" + teamKey + "/roster;week=" + week).getJSONArray("team").getJSONObject(1)
                .getJSONObject("roster").getJSONObject("0").getJSONObject("players");
        JSONArray out = new JSONArray();
        for (Iterator<String> it = players.keys(); it.hasNext(); ) {
            String k = it.next();
            if (k.equals("count")) continue;
            JSONArray p = players.getJSONObject(k).getJSONArray("player");
            JSONObject info = merged(p.getJSONArray(0));
            String slot = "BN";
            for (int i = 1; i < p.length(); i++) {
                JSONObject o = p.optJSONObject(i);
                if (o != null && o.has("selected_position")) {
                    JSONObject sp = merged(o.getJSONArray("selected_position"));
                    slot = sp.optString("position", "BN");
                }
            }
            String pos = info.optString("display_position", "");
            if (pos.equals("DEF")) continue;
            out.put(new JSONObject().put("name", info.getJSONObject("name").optString("full"))
                    .put("team", info.optString("editorial_team_abbr", "").toUpperCase())
                    .put("pos", pos.contains(",") ? pos.substring(0, pos.indexOf(',')) : pos)
                    .put("starter", !(slot.equals("BN") || slot.equals("IR") || slot.startsWith("IR"))));
        }
        return out;
    }

    /** Diagnostics: the status of a few requests, from the most basic up, plus what the token answer carried. */
    JSONObject check() throws Exception {
        JSONObject out = new JSONObject().put("tokenFields", load().optString("tokenFields"));
        for (String p : new String[]{"/game/nfl", "/users;use_login=1", "/users;use_login=1/games", "/users;use_login=1/games;game_codes=nfl/teams"}) {
            try { get(p); out.put(p, "ok"); }
            catch (Exception e) { out.put(p, e.getMessage()); }
        }
        // The same basic request with other headers: a browser's, XML instead of JSON.
        String token = access();
        String[][] variants = {
                {"browser UA", API + "/game/nfl?format=json", "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"},
                {"xml", API + "/game/nfl", null},
        };
        for (String[] v : variants) {
            HttpURLConnection c = (HttpURLConnection) new URL(v[1]).openConnection();
            c.setRequestProperty("Authorization", "Bearer " + token);
            if (v[2] != null) c.setRequestProperty("User-Agent", v[2]);
            int code = c.getResponseCode();
            String text = read(code < 400 ? c.getInputStream() : c.getErrorStream());
            out.put(v[0], code + " " + text.replaceAll("\\s+", " ").substring(0, Math.min(160, text.length())));
        }
        out.put("tokenLength", token.length());
        // A JWT-style token names its permissions in the middle part; only that part's scope-like fields are shown.
        String[] parts = token.split("\\.");
        if (parts.length == 3) {
            try {
                JSONObject claims = new JSONObject(new String(Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP), StandardCharsets.UTF_8));
                for (String k : new String[]{"scope", "scp", "aud", "iss", "exp"}) if (claims.has(k)) out.put("token." + k, claims.get(k));
            } catch (Exception e) { out.put("token.claims", "unreadable"); }
        } else out.put("token.kind", "opaque (" + parts.length + " parts)");
        return out;
    }

    /** Yahoo's [{"a":1},{"b":2},[]] → {"a":1,"b":2}. */
    private static JSONObject merged(JSONArray a) throws JSONException {
        JSONObject out = new JSONObject();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null) continue;
            for (Iterator<String> it = o.keys(); it.hasNext(); ) { String k = it.next(); out.put(k, o.get(k)); }
        }
        return out;
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream i = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = i.read(buf)) > 0; ) b.write(buf, 0, n);
            return b.toString("UTF-8");
        }
    }
}
