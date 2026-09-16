import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

// Keep the public HTML document outside React routing in dev and preview too.
function serveDocumentation(server: Pick<ViteDevServer, "middlewares">) {
  server.middlewares.use((req, _res, next) => {
    if (req.url) {
      req.url = req.url.replace(
        /^\/documentation\/(architecture|product)\/?(?=\?|$)/,
        "/documentation/$1.html",
      );
    }
    next();
  });
}

const documentation: Plugin = {
  name: "static-documentation",
  configureServer: serveDocumentation,
  configurePreviewServer: serveDocumentation,
};

export default defineConfig({
  plugins: [react(), documentation],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://apex.arkiv-global.net:23560",
        changeOrigin: true,
        secure: false,
        // Set this when targeting Bun directly; a frontend/nginx target already
        // owns the prefix rewrite. Keep OAuth cookies on the local dev origin.
        ...(process.env.VITE_API_TARGET_STRIP_PREFIX === "true"
          ? { rewrite: (path: string) => path.replace(/^\/api(?=\/|\?|$)/, "") || "/" }
          : {}),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  worker: {
    format: "es",
  },
});
