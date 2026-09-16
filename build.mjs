import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const extDir = path.resolve("game-warhammer40kdarktide");
const distDir = path.join(extDir, "dist");
const assetsDir = path.join(extDir, "assets");

// `tsc` has already emitted the compiled entry point into dist/; add the
// checked-in info.json and flatten the assets alongside it.
mkdirSync(distDir, { recursive: true });
cpSync(path.join(extDir, "info.json"), path.join(distDir, "info.json"));
for (const file of readdirSync(assetsDir)) {
  cpSync(path.join(assetsDir, file), path.join(distDir, file));
}

// Remove old archives so only the latest build remains.
for (const entry of readdirSync(".")) {
  if (entry.startsWith("game-warhammer40kdarktide-") && entry.endsWith(".zip")) {
    rmSync(entry, { force: true });
  }
}

// Zip the dist contents (files at the zip root).
const infoJson = JSON.parse(readFileSync(path.join(extDir, "info.json"), "utf8"));
const zipName = `game-warhammer40kdarktide-${infoJson.version}.zip`;
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${path.join(distDir, "*")}' -DestinationPath '${path.resolve(zipName)}' -Force`,
  ],
  { stdio: "inherit" },
);

console.log(`Built ${zipName} (v${infoJson.version})`);
