import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL("src/index.ts", import.meta.url)),
        viewer: fileURLToPath(new URL("src/viewer/RobotViewer.ts", import.meta.url)),
        react: fileURLToPath(new URL("src/adapters/r3f.tsx", import.meta.url)),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        /^three($|\/)/,
        /^react($|\/)/,
        /^react-dom($|\/)/,
        /^@react-three\/fiber($|\/)/,
      ],
      output: {
        preserveModules: true,
        preserveModulesRoot: fileURLToPath(new URL("src", import.meta.url)),
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
      },
    },
  },
  root,
});
