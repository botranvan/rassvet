import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": r("./src"),
      // Public surface for extension UIs (extensions/<name>/ui/*.tsx).
      "@rassvet/sdk": r("./src/sdk/index.ts"),
    },
    // Extension sources live outside ui/, make them share the host's copies.
    dedupe: ["react", "react-dom", "react-router", "@tanstack/react-query", "lucide-react"],
  },
  server: {
    port: 5173,
    fs: { allow: [r("."), r("../extensions")] },
    proxy: { "/api": "http://127.0.0.1:8080", "/healthz": "http://127.0.0.1:8080" },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    // Never inline fonts as data: URIs; the server's CSP only allows font-src 'self'.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
});
