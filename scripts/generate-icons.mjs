import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const assetsDir = resolve(projectRoot, "assets", "icons");
const outputDir = resolve(projectRoot, "public", "icons");
const templatePath = resolve(assetsDir, "icon-template.svg");

const sizes = [16, 48, 128, 300, 800];

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function generate(size) {
  const buffer = await sharp(templatePath)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const filename = `icon-${size}.png`;
  const filepath = resolve(outputDir, filename);
  await writeFile(filepath, buffer);
  return filename;
}

async function main() {
  await ensureDir(outputDir);
  const generated = [];
  for (const size of sizes) {
    const name = await generate(size);
    generated.push(name);
  }
  console.log(`Generated icons: ${generated.join(", ")}`);
}

main().catch(error => {
  console.error("Failed to generate icons", error);
  process.exitCode = 1;
});
