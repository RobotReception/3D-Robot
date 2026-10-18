import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1100,
    rollupOptions: { input: { main: "index.html", minimal: "examples/minimal.html", r3f: "examples/r3f.html" } },
  },
});
