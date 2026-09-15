import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const extDir = path.resolve("game-warhammer40kdarktide");
const distDir = path.join(extDir, "dist");
const assetsDir = path.join(extDir, "assets");

// `tsc` has already emitted the compiled entry point into dist/; we just need
// to add the checked-in info.json and the assets alongside it.
mkdirSync(distDir, { recursive: true });

cpSync(path.join(extDir, "info.json"), path.join(distDir, "info.json"));

// Flatten assets into the extension root (matching how `logo` is resolved).
for (const file of readdirSync(assetsDir)) {
  cpSync(path.join(assetsDir, file), path.join(distDir, file));
}

console.log("Built extension into game-warhammer40kdarktide/dist");
