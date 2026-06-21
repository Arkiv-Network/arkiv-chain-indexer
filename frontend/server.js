import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.PORT ?? "23560", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const BACKEND_HOST = process.env.BACKEND_HOST ?? "backend";
const BACKEND_PORT = Number.parseInt(process.env.BACKEND_PORT ?? "3000", 10);
const STATIC_DIR = path.resolve(__dirname, "dist");
const INDEX_FILE = path.join(STATIC_DIR, "index.html");
const ONE_WEEK_SECONDS = 60 * 60 * 24 * 7;
const CACHEABLE_INDEX_ASSET_RE = /^index-[^/]+\.(?:js|css)$/;
const ENABLE_BROTLI = process.env.NODE_ENV === "production";
const RUNTIME_CONFIG_ENV_NAMES = [
  "VITE_CHAIN_NAME",
  "VITE_TOKEN_SYMBOL",
  "VITE_TRANSACTION_EXPLORER_BASE_URL",
  "VITE_BLOCK_TIME_MS",
  "VITE_STUB_TICK_MS",
  "VITE_MAX_STUB_BLOCKS",
  "VITE_STUB_VISIBLE_AGE_MS",
  "VITE_PING_START_AGE_MS",
  "VITE_LOADING_METADATA_LEAD_MS",
  "VITE_NEXT_BLOCK_PING_MS",
  "VITE_PING_MIN_INTERVAL_MS",
  "VITE_SCANNER_DELAY_WARNING_AGE_MS",
  "VITE_HISTOGRAM_WINDOW_MINUTES",
  "VITE_HISTOGRAM_REFRESH_MS",
  "VITE_HISTOGRAM_CLOCK_TICK_MS",
  "VITE_NO_BATCHER",
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function cacheHeadersFor(filePath) {
  if (!CACHEABLE_INDEX_ASSET_RE.test(path.basename(filePath))) {
    return {};
  }

  return {
    "cache-control": `public, max-age=${ONE_WEEK_SECONDS}`,
  };
}

function acceptsBrotli(req) {
  const header = req.headers["accept-encoding"];
  if (!header || Array.isArray(header)) {
    return false;
  }

  return header
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .some((encoding) => {
      const [name, ...params] = encoding.split(";").map((part) => part.trim());
      if (name !== "br") {
        return false;
      }

      const quality = params.find((param) => param.startsWith("q="));
      return !quality || Number.parseFloat(quality.slice(2)) > 0;
    });
}

async function getBrotliAsset(filePath, req) {
  if (!ENABLE_BROTLI || !acceptsBrotli(req)) {
    return null;
  }

  const brotliPath = `${filePath}.br`;
  const stats = await stat(brotliPath).catch(() => null);
  if (!stats?.isFile()) {
    return null;
  }

  return { filePath: brotliPath, size: stats.size };
}

async function sendFile(filePath, req, res, { status = 200 } = {}) {
  const brotliAsset = await getBrotliAsset(filePath, req);
  const responsePath = brotliAsset?.filePath ?? filePath;
  const headers = {
    "content-type": mimeFor(filePath),
    ...cacheHeadersFor(filePath),
  };

  if (brotliAsset) {
    headers["content-encoding"] = "br";
    headers["content-length"] = brotliAsset.size;
    headers.vary = "Accept-Encoding";
  } else if (ENABLE_BROTLI) {
    headers.vary = "Accept-Encoding";
  }

  res.writeHead(status, headers);
  const stream = createReadStream(responsePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
    }
    res.end("Internal server error");
  });
  stream.pipe(res);
}

function proxyApi(req, res) {
  const stripped = req.url.replace(/^\/api/, "") || "/";
  const headers = { ...req.headers };
  headers.host = `${BACKEND_HOST}:${BACKEND_PORT}`;
  delete headers["connection"];

  const proxyReq = http.request(
    {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      method: req.method,
      path: stripped,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: `Bad gateway: ${err.message}` }));
  });

  req.pipe(proxyReq);
}

function serveRuntimeConfig(res) {
  const config = {};
  for (const name of RUNTIME_CONFIG_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) {
      config[name] = value;
    }
  }

  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`window.__ARKIV_CONFIG__ = ${JSON.stringify(config)};\n`);
}

async function serveStatic(req, res) {
  const rawPath = (req.url ?? "/").split("?")[0];
  const decoded = decodeURIComponent(rawPath);
  const requestedPath = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.normalize(path.join(STATIC_DIR, requestedPath));

  if (!candidate.startsWith(STATIC_DIR + path.sep) && candidate !== STATIC_DIR) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const stats = await stat(candidate);
    if (stats.isFile()) {
      await sendFile(candidate, req, res);
      return;
    }
  } catch {
    // fall through to SPA index
  }

  try {
    await stat(INDEX_FILE);
    await sendFile(INDEX_FILE, req, res, { status: 200 });
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/config.js" || url.startsWith("/config.js?")) {
    serveRuntimeConfig(res);
    return;
  }
  if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) {
    proxyApi(req, res);
    return;
  }
  serveStatic(req, res).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
    }
    res.end(`Internal server error: ${err.message}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend listening on http://${HOST}:${PORT}`);
  console.log(`Static root: ${STATIC_DIR}`);
  console.log(`Proxying /api/* -> http://${BACKEND_HOST}:${BACKEND_PORT}`);
});
