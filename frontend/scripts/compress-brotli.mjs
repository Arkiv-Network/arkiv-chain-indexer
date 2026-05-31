import { constants, brotliCompress } from "node:zlib";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const compress = promisify(brotliCompress);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(filePath)));
    } else if (entry.isFile() && !entry.name.endsWith(".br")) {
      files.push(filePath);
    }
  }

  return files;
}

async function main() {
  const distStats = await stat(distDir).catch(() => null);
  if (!distStats?.isDirectory()) {
    throw new Error(`Brotli input directory not found: ${distDir}`);
  }

  const files = await listFiles(distDir);
  await Promise.all(
    files.map(async (filePath) => {
      const input = await readFile(filePath);
      const output = await compress(input, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        },
      });
      await writeFile(`${filePath}.br`, output);
    }),
  );

  console.log(`Generated ${files.length} Brotli asset${files.length === 1 ? "" : "s"} in ${distDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
