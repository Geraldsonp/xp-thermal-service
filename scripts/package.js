#!/usr/bin/env node
// Assembles bundle/xp-thermal-service.zip — the exact archive that
// bundle/win/install.ps1 downloads and installs.
//
// Everything is staged flat into bundle/stage/ (gitignored) and zipped from
// there, so the zip root matches what the installer's entry checks expect:
//   xp-thermal-service.exe        pkg-built Windows service executable
//   xpthermalprintservice.exe     WinSW wrapper (renamed winsw.exe — WinSW
//                                 registers under its own exe name)
//   xpthermalprintservice.xml     WinSW descriptor (copy of the tracked
//                                 bundle/win/xpthermalprintservice.xml)
//   config.json                   ready-to-run first-install configuration
//   config.example.json           configuration reference
//   public/**                     dashboard assets
"use strict";

const fs = require("fs");
const path = require("path");
const yazl = require("yazl");

const root = path.resolve(__dirname, "..");
const stageDir = path.join(root, "bundle", "stage");
const zipPath = path.join(root, "bundle", "xp-thermal-service.zip");

// [source path relative to repo root, name inside the zip]
const FILES = [
  ["bundle/xp-thermal-service.exe", "xp-thermal-service.exe"],
  ["node_modules/node-windows/bin/winsw/winsw.exe", "xpthermalprintservice.exe"],
  ["bundle/win/xpthermalprintservice.xml", "xpthermalprintservice.xml"],
  ["config.example.json", "config.json"],
  ["config.example.json", "config.example.json"],
];

const missing = FILES
  .filter(([src]) => !fs.existsSync(path.join(root, src)))
  .map(([src]) => src);
if (!fs.existsSync(path.join(root, "public"))) missing.push("public/");
if (missing.length > 0) {
  console.error(
    "package: cannot build the release zip, missing input(s):\n" +
      missing.map((m) => "  - " + m).join("\n") +
      "\nBuild the exe with `npm run package:win` and install dependencies with `npm install`."
  );
  process.exit(1);
}

// Fresh staging dir so the zip never carries leftovers from a previous run.
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
for (const [src, name] of FILES) {
  fs.copyFileSync(path.join(root, src), path.join(stageDir, name));
}
fs.cpSync(path.join(root, "public"), path.join(stageDir, "public"), { recursive: true });

const zip = new yazl.ZipFile();
function addDir(dir, prefix) {
  // Sorted for a stable entry order run to run.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addDir(full, rel);
    else zip.addFile(full, rel);
  }
}
addDir(stageDir, "");
zip.outputStream
  .pipe(fs.createWriteStream(zipPath))
  .on("close", () => {
    const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
    console.log(`package: wrote ${path.relative(root, zipPath)} (${mb} MB)`);
  })
  .on("error", (err) => {
    console.error("package: failed to write the zip:", err.message);
    process.exit(1);
  });
zip.end();
