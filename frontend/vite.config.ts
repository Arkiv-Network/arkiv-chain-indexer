import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
