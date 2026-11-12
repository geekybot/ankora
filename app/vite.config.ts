import { defineConfig, type Plugin } from "vite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

// One application, one server: the landing (../site) at /, this app at /app/, the same paths as production
// (scripts/build-web.sh puts site/ at the web root and this build at /app/).
const SITE = resolve(__dirname, "../site");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".avif": "image/avif", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4",
};
function landing(): Plugin {
  return {
    name: "ankora-landing",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "/").split("?")[0]!;
        if (url === "/app") { res.statusCode = 302; res.setHeader("Location", "/app/"); return res.end(); }
        if (url.startsWith("/app/") || url.startsWith("/@") || url.startsWith("/node_modules/") || url.startsWith("/src/")) return next();
        let file = normalize(join(SITE, decodeURIComponent(url)));
        if (!file.startsWith(SITE)) { res.statusCode = 403; return res.end(); } // no path traversal out of site/
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-store"); // dev: never serve a stale landing script
        res.end(readFileSync(file));
      });
    },
  };
}

// client/ sits next to app/ and is imported as TypeScript source.
export default defineConfig({
  base: "/app/",
  plugins: [landing()],
  server: { port: 5180, strictPort: true, fs: { allow: [".."] }, open: false },
  build: { target: "es2022" },
});
