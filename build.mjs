import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const extDir = path.resolve("game-warhammer40kdarktide");
const distDir = path.join(extDir, "dist");
const assetsDir = path.join(extDir, "assets");

// Bump the version with a random build suffix so Vortex treats each build as a
// new version. Must be valid semver: pure "1.5.4.123456" is rejected, so the
// random part goes in the build metadata ("+<n>").
const infoJson = JSON.parse(readFileSync(path.join(extDir, "info.json"), "utf8"));
const baseVersion = infoJson.version.split(/[+-]/)[0].split(".").slice(0, 3).join(".");
const suffix = Math.floor(Math.random() * 1000000).toString().padStart(6, "0");
const version = `${baseVersion}+${suffix}`;
infoJson.version = version;

// `tsc` has already emitted the compiled entry point into dist/; add the
// bumped info.json and flatten the assets alongside it.
mkdirSync(distDir, { recursive: true });
writeFileSync(path.join(distDir, "info.json"), `${JSON.stringify(infoJson, null, 2)}\n`);
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
const zipName = `game-warhammer40kdarktide-${version}.zip`;
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${path.join(distDir, "*")}' -DestinationPath '${path.resolve(zipName)}' -Force`,
  ],
  { stdio: "inherit" },
);

console.log(`Built ${zipName} (v${version})`);
