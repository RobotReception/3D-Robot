import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// the Gemini example talks to its own small server (examples/gemini/server.ts) through /api: the key stays on the server
const api = { "/api": { target: process.env.API_PROXY ?? "http://localhost:8788", changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { proxy: api },
  preview: { proxy: api },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1100,
    rollupOptions: { input: { main: "index.html", minimal: "examples/minimal.html", r3f: "examples/r3f.html", gemini: "examples/gemini.html" } },
  },
});
