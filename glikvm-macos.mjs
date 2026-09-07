#!/usr/bin/env node
// glikvm-macos - unofficial macOS GLKVM desktop client build (GL-iNet Comet / RM1 / RM10)
// with glikvm-mod applied (sessions in separate windows, tab drag/tear-out, paste local
// clipboard, 1:1 resize, remembered passwords, ...).
//
//   node glikvm-macos.mjs build      [--src <pkg>]   extract + patch + assemble "./build/GLKVM (mod).app"
//   node glikvm-macos.mjs install    [--src <pkg>]   build + install to "~/Applications/GLKVM (mod).app"
//   node glikvm-macos.mjs run        [-- args]       launch the installed (or built) app
//   node glikvm-macos.mjs status                     what is built / installed
//   node glikvm-macos.mjs package                    build + zip + dmg + SHA256SUMS into ./dist
//   node glikvm-macos.mjs release [--draft|--prerelease] package + publish as GitHub release <tag> (needs gh); installed copies pick it up
//   node glikvm-macos.mjs uninstall                  remove the installed copy
//   node glikvm-macos.mjs update-mod                 git pull the vendored glikvm-mod
//
// Options:
//   --src <path>     GLKVM package: .dmg (macOS), .app bundle, Windows .exe installer, or app.asar
//                    (default: newest .dmg/.exe in the current directory)
//   --dest <app>     install path (default: "~/Applications/GLKVM (mod).app")
//   --mod <dir>      glikvm-mod checkout (default: ./vendor/glikvm-mod, cloned on first use)
//   --electron <v>   Electron version to download when the source has no macOS bundle (default: detected, else 34.5.8)
//   --arch <a>       arm64 | x64 for that download (default: this machine; the build from the stock .dmg is universal)
//   --no-mod         build the stock client only (rebundled, no patches)
//   --cache <dir>    download cache (default: ~/.cache/glikvm-macos)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log, die, run, tryRun, which, sha256 } from "./src/util.mjs";
import { buildApp, readMarker, MARKER } from "./src/build.mjs";
import { ensureMod, defaultModDir } from "./src/mod.mjs";
import { assembleMac, installMac, uninstallMac, runMac, packageMac, defaultMacInstallDir, MAC_APP_NAME } from "./src/macapp.mjs";
import { MAC_VERSION, MAC_TAG, MAC_REPO } from "./src/patches.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const cmd = own.find((a) => !a.startsWith("--")) ?? "help";
const flag = (name) => own.includes(`--${name}`);
const opt = (name, def) => {
  const i = own.indexOf(`--${name}`);
  return i !== -1 && own[i + 1] && !own[i + 1].startsWith("--") ? own[i + 1] : def;
};

const BUILD = path.join(HERE, "build");
const DIST = path.join(HERE, "dist");
const CACHE = opt("cache", path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "glikvm-macos"));
const DEST = path.resolve(opt("dest", defaultMacInstallDir()));
const MOD_DIR = path.resolve(opt("mod", defaultModDir(HERE)));
const ARCH = opt("arch", process.arch === "arm64" ? "arm64" : "x64");
const SRC = opt("src", null);
const BUILT_APP = path.join(BUILD, MAC_APP_NAME);

if (process.platform !== "darwin") die("this tool assembles a macOS app bundle and needs macOS (hdiutil, ditto, codesign)");

async function build() {
  const marker = await buildApp({ buildDir: BUILD, src: SRC, modDir: MOD_DIR, electronOverride: opt("electron", null), noMod: flag("no-mod") });
  const out = await assembleMac({ buildDir: BUILD, electronVersion: marker.electronVersion, arch: ARCH, cacheDir: CACHE, macApp: marker.macApp });
  const built = readMarker(out);
  log(`built GLKVM ${marker.appVersion}${marker.modVersion ? ` + ui-mod ${marker.modVersion}` : " (stock)"} on electron ${marker.electronVersion} macos-${built.arch}`);
  log(`bundle: ${out}   (run: open "${out}")`);
  return { marker: built, out };
}

async function install() {
  const { marker, out } = await build();
  installMac(out, DEST);
  log(`installed GLKVM ${marker.appVersion} + ui-mod ${marker.modVersion} + macos ${MAC_VERSION}`);
  log(`run it: node glikvm-macos.mjs run   (or open "${DEST}", or "GLKVM (mod)" in Launchpad)`);
  log(`settings/login live in ~/Library/Application Support/gl-kvm (shared with the official client)`);
}

function uninstall() {
  uninstallMac(DEST);
  log(`(your login/settings in ~/Library/Application Support/gl-kvm were left alone)`);
}

function runApp() {
  const app = [DEST, BUILT_APP].find((p) => fs.existsSync(path.join(p, "Contents", "MacOS")));
  if (!app) die(`nothing to run - do 'node glikvm-macos.mjs install' (or build) first`);
  runMac(app, passthrough);
  log(`launched ${app} ${passthrough.join(" ")}`.trim());
}

function status() {
  log(`glikvm-macos ${MAC_VERSION} (${MAC_TAG})   node ${process.version}   macOS ${(tryRun("sw_vers", ["-productVersion"]) || "?").trim()}   7z: ${which("7z") || which("7zz") || which("7za") || "not installed (only needed for a Windows .exe)"}`);
  const modOk = fs.existsSync(path.join(MOD_DIR, "src", "patches.ts"));
  log(`glikvm-mod: ${MOD_DIR} ${modOk ? "(present)" : "(not cloned yet)"}`);
  for (const [label, dir] of [
    ["build", BUILT_APP],
    ["installed", DEST],
  ]) {
    const m = readMarker(dir);
    if (!m) {
      log(`${label}: none (${dir})`);
      continue;
    }
    log(`${label}: GLKVM ${m.appVersion} + ui-mod ${m.modVersion ?? "-"}${m.modCommit ? `@${m.modCommit}` : ""} + macos ${m.macosVersion}, electron ${m.electronVersion} ${m.arch || ""}${m.runtime ? ` (${m.runtime})` : ""}, built ${m.builtAt} from ${m.source}`);
  }
}

async function pkg() {
  const { marker, out } = await build();
  fs.mkdirSync(DIST, { recursive: true });
  const base = `glkvm-mod-${MAC_TAG}-macos-${marker.arch || ARCH}`;
  const produced = packageMac(out, DIST, base);
  // SHA256SUMS next to the assets (the in-app updater verifies downloads against it)
  const sums = path.join(DIST, "SHA256SUMS");
  fs.writeFileSync(sums, produced.map((f) => `${sha256(f)}  ${path.basename(f)}\n`).join(""));
  produced.push(sums);
  log(`checksums: ${sums}`);
  return { marker, produced };
}

// publish ./dist as the GitHub release for MAC_TAG; the in-app updater looks at exactly this
async function release() {
  if (!which("gh")) die("gh (GitHub CLI) is required to publish releases");
  const { marker, produced } = await pkg();
  const title = `GLKVM ${MAC_TAG} - unofficial macOS build`;
  const notes = [
    `**Unofficial macOS GLKVM desktop client** ${MAC_TAG}: the GLKVM ${marker.appVersion} client + **ui-mod ${marker.modVersion}**, on Electron ${marker.electronVersion}, ${marker.arch}.`,
    "",
    "**dmg**: open it and drag *GLKVM (mod)* to Applications. **zip**: the same bundle (this is what the in-app updater fetches).",
    "",
    "The bundle is ad-hoc signed, not notarized: on first start macOS says it cannot verify the developer - right-click → Open, or *System Settings → Privacy & Security → Open Anyway*, or `xattr -dr com.apple.quarantine \"/Applications/GLKVM (mod).app\"`.",
    "",
    "Installed copies check this page on start and every 6 h and offer to update in place (About → Check for updates); downloads are verified against `SHA256SUMS`.",
    "",
    "Login/settings are shared with the official client (`~/Library/Application Support/gl-kvm`). Unofficial community project - not affiliated with, endorsed or supported by GL-iNet. Licensing: build tool + mod MIT; the GLKVM client inside is © GL Technologies (HK) Ltd., all rights reserved (see README → Licensing); Electron MIT, Chromium BSD.",
    opt("notes", "") ? "\n" + opt("notes", "") : "",
  ].join("\n");
  const notesFile = path.join(DIST, "RELEASE_NOTES.md");
  fs.writeFileSync(notesFile, notes);
  const exists = tryRun("gh", ["release", "view", MAC_TAG, "-R", MAC_REPO]) !== null;
  if (exists) {
    log(`release ${MAC_TAG} exists - uploading assets (clobber)`);
    run("gh", ["release", "upload", MAC_TAG, ...produced, "--clobber", "-R", MAC_REPO], { stdio: ["ignore", "inherit", "inherit"] });
  } else {
    log(`creating release ${MAC_TAG}`);
    const args = ["release", "create", MAC_TAG, ...produced, "-R", MAC_REPO, "--title", title, "--notes-file", notesFile];
    if (flag("prerelease")) args.push("--prerelease"); // betas are normal releases here (they are what users run); opt in explicitly
    else args.push("--latest");
    if (flag("draft")) args.push("--draft");
    run("gh", args, { stdio: ["ignore", "inherit", "inherit"] });
  }
  log(`published: https://github.com/${MAC_REPO}/releases/tag/${MAC_TAG}`);
}

function help() {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  console.log(src.slice(1, 23).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

try {
  switch (cmd) {
    case "build":
      await build();
      break;
    case "install":
      await install();
      break;
    case "uninstall":
      uninstall();
      break;
    case "run":
      runApp();
      break;
    case "status":
      status();
      break;
    case "package":
      await pkg();
      break;
    case "release":
      await release();
      break;
    case "update-mod":
      ensureMod(MOD_DIR, { update: true });
      break;
    default:
      help();
  }
} catch (e) {
  die(e?.stack || String(e));
}
