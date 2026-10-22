import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist-lib", import.meta.url));
const specifier = /(from\s*|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+)\2/g;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".d.ts")) await rewrite(path);
  }
}

async function rewrite(path) {
  const source = await readFile(path, "utf8");
  const output = source.replace(
    specifier,
    (match, prefix, quote, target) =>
      /\.(?:[cm]?js|json|d\.ts)$/.test(target) ? match : `${prefix}${quote}${target}.js${quote}`,
  );
  if (output !== source) await writeFile(path, output);
}

await walk(root);
