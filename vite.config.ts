import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import zip from "vite-plugin-zip-pack";
import packageJson from "./package.json" with { type: "json" };
import manifest from "./src/manifest.ts";


const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    crx({ manifest }),
    zip({
      outDir: "release",
      outFileName: `crx-${packageJson.name}-${packageJson.version}.zip`,
      filter: (filePath) =>
        !filePath.endsWith(".map") && !filePath.includes(".vite"),
    }),
  ],
  build: {
    target: "es2021",
    rollupOptions: {
      input: {
        "popup/index": resolve(rootDir, "src/popup/index.html")
      },
    }
  }
});
