import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * FantasyTV test server: serves web/, relays state and commands between the TV page and the phone remote, and proxies
 * your IPTV server (Dispatcharr has no CORS, so the browser can't read its guide or play its streams directly).
 * Run: java server/Server.java [port]. Listens on every network address, so a phone on the same Wi-Fi can pair.
 */
public class Server {
    static final Path WEB = Paths.get("web").toAbsolutePath().normalize();
    static volatile byte[] state = "{}".getBytes(StandardCharsets.UTF_8);
    static final List<String> commands = Collections.synchronizedList(new ArrayList<>());
    static final Map<String, String> TYPES = Map.of(
            "html", "text/html; charset=utf-8", "js", "text/javascript; charset=utf-8", "css", "text/css; charset=utf-8",
            "json", "application/json", "svg", "image/svg+xml", "png", "image/png", "ico", "image/x-icon");

    public static void main(String[] args) throws IOException {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8765;
        HttpServer s = HttpServer.create(new InetSocketAddress(port), 0);
        s.createContext("/", Server::handle);
        s.setExecutor(Executors.newCachedThreadPool());
        s.start();
        System.out.println("FantasyTV on http://localhost:" + port + "/  (phone: " + lanUrl(port) + "remote.html)");
    }

    static String lanUrl(int port) {
        try {
            for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!n.isUp() || n.isLoopback() || n.isVirtual()) continue;
                String name = n.getDisplayName().toLowerCase();
                if (name.contains("virtual") || name.contains("vmware") || name.contains("hyper-v") || name.contains("wsl")) continue;
                for (InetAddress a : Collections.list(n.getInetAddresses()))
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) return "http://" + a.getHostAddress() + ":" + port + "/";
            }
        } catch (Exception ignored) { }
        return "http://localhost:" + port + "/";
    }

    static void handle(HttpExchange x) throws IOException {
        try {
            x.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
            x.getResponseHeaders().add("Cache-Control", "no-store");
            String path = x.getRequestURI().getPath(), method = x.getRequestMethod();
            if (path.equals("/api/state")) {
                if (method.equals("POST")) { state = x.getRequestBody().readAllBytes(); send(x, 204, null, null); }
                else send(x, 200, "application/json", state);
            } else if (path.equals("/api/cmd")) {
                if (method.equals("POST")) {
                    commands.add(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                    send(x, 204, null, null);
                } else {
                    String out;
                    synchronized (commands) { out = "[" + String.join(",", commands) + "]"; commands.clear(); }
                    send(x, 200, "application/json", out.getBytes(StandardCharsets.UTF_8));
                }
            } else if (path.equals("/api/info")) {
                String json = "{\"remote\":\"" + lanUrl(x.getLocalAddress().getPort()) + "remote.html\"}";
                send(x, 200, "application/json", json.getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/api/config")) {
                Path f = Paths.get("config.json");
                if (method.equals("POST")) { Files.write(f, x.getRequestBody().readAllBytes()); send(x, 204, null, null); }
                else send(x, 200, "application/json", Files.exists(f) ? Files.readAllBytes(f) : "{}".getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/proxy")) {
                proxy(x);
            } else {
                serveFile(x, path);
            }
        } catch (Exception e) {
            try { send(x, 502, "text/plain", String.valueOf(e.getMessage()).getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) { }
        } finally {
            x.close();
        }
    }

    /** /proxy?url=… — GET only, http(s) only, streamed through so live video plays as it arrives. */
    static void proxy(HttpExchange x) throws IOException {
        String q = x.getRequestURI().getRawQuery();
        String target = q == null || !q.startsWith("url=") ? null : URLDecoder.decode(q.substring(4), StandardCharsets.UTF_8);
        if (target == null || !(target.startsWith("http://") || target.startsWith("https://"))) {
            send(x, 400, "text/plain", "url= needed".getBytes(StandardCharsets.UTF_8));
            return;
        }
        HttpURLConnection c = (HttpURLConnection) URI.create(target).toURL().openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(8000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "FantasyTV/0.1");
        int code;
        try {
            code = c.getResponseCode();
        } catch (IOException e) {
            send(x, 502, "text/plain", (e.getClass().getSimpleName() + ": " + e.getMessage()).getBytes(StandardCharsets.UTF_8));
            return;
        }
        String type = c.getContentType();
        if (type != null) x.getResponseHeaders().add("Content-Type", type);
        x.sendResponseHeaders(code, 0);
        try (InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream(); OutputStream out = x.getResponseBody()) {
            if (in == null) return;
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) { out.write(buf, 0, n); out.flush(); }
        } finally {
            c.disconnect();
        }
    }

    static void serveFile(HttpExchange x, String path) throws IOException {
        if (path.endsWith("/")) path += "index.html";
        Path f = WEB.resolve(path.substring(1)).normalize();
        if (!f.startsWith(WEB) || !Files.isRegularFile(f)) { send(x, 404, "text/plain", "not found".getBytes()); return; }
        String name = f.getFileName().toString(), ext = name.substring(name.lastIndexOf('.') + 1);
        send(x, 200, TYPES.getOrDefault(ext, "application/octet-stream"), Files.readAllBytes(f));
    }

    static void send(HttpExchange x, int code, String type, byte[] body) throws IOException {
        if (type != null) x.getResponseHeaders().add("Content-Type", type);
        x.sendResponseHeaders(code, body == null ? -1 : body.length);
        if (body != null) try (OutputStream o = x.getResponseBody()) { o.write(body); }
    }
}
