import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Local dev: /aggregates and /steamomega are files the refresher writes in production.
// Point the dev server at a running container (docker run -p 8080:8080 ...) when needed.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
    // Never inline font subsets as data URIs: the Korean display face ships ~90
    // unicode-range files and the browser should fetch only the ones a page uses.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      "/aggregates": "http://127.0.0.1:8080",
      "/steamomega": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
