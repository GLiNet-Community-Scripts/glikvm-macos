// macOS build: patched app dir -> "GLKVM (mod).app" (ad-hoc signed), install into ~/Applications,
// zip + dmg packaging. The runtime is the stock GLKVM.app out of the official .dmg when the
// source provides one (same Electron, same helpers, same Info.plist); otherwise a stock
// Electron.app of the matching version is downloaded and dressed up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadArtifact } from "@electron/get"; // not download(): that one ignores platform/arch and always takes the host's
import { log, warn, die, run, tryRun, rmrf, readJson, writeJson, fmtBytes } from "./util.mjs";

export const MAC_APP_NAME = "GLKVM (mod).app";
export const MAC_BUNDLE_ID = "com.glinet.kvmdesk.mod"; // stock is com.glinet.kvmdesk; distinct so LaunchServices/Dock/notifications keep the two apart
const MARKER = "glikvm-macos.json";

export const defaultMacInstallDir = () => path.join(os.homedir(), "Applications", MAC_APP_NAME);

/** where the build marker lives inside a bundle */
export const macMarkerPath = (app) => path.join(app, "Contents", "Resources", "app", MARKER);

function need(tool) {
  if (!tryRun("/usr/bin/which", [tool])) die(`${tool} is required (part of macOS / Xcode command line tools)`);
}

// --- Info.plist via plutil json round trip -------------------------------------------------
function readPlist(file) {
  return JSON.parse(run("plutil", ["-convert", "json", "-o", "-", file]));
}
function writePlist(file, obj) {
  const tmp = file + ".json";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  run("plutil", ["-convert", "xml1", "-o", file, tmp]);
  fs.rmSync(tmp, { force: true });
}

/** "universal" | "arm64" | "x64" from the main executable */
export function macArch(app) {
  const plist = readPlist(path.join(app, "Contents", "Info.plist"));
  const exe = path.join(app, "Contents", "MacOS", plist.CFBundleExecutable);
  const archs = (tryRun("lipo", ["-archs", exe]) || "").trim().split(/\s+/).filter(Boolean);
  if (archs.includes("x86_64") && archs.includes("arm64")) return "universal";
  if (archs.includes("arm64")) return "arm64";
  if (archs.includes("x86_64")) return "x64";
  return process.arch === "arm64" ? "arm64" : "x64";
}

/**
 * Electron locates its helper bundles as "<CFBundleName> Helper*.app", so renaming the app
 * means renaming the helpers too (dir, executable, plist), the way electron-builder does.
 */
function renameHelpers(contents, from, to, bundleId) {
  const fw = path.join(contents, "Frameworks");
  for (const entry of fs.readdirSync(fw)) {
    const m = new RegExp(`^${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Helper( \\([^)]+\\))?\\.app$`).exec(entry);
    if (!m) continue;
    const suffix = m[1] || "";
    const oldDir = path.join(fw, entry);
    const newName = `${to} Helper${suffix}`;
    const newDir = path.join(fw, `${newName}.app`);
    fs.renameSync(oldDir, newDir);
    const plistFile = path.join(newDir, "Contents", "Info.plist");
    const plist = readPlist(plistFile);
    fs.renameSync(path.join(newDir, "Contents", "MacOS", plist.CFBundleExecutable), path.join(newDir, "Contents", "MacOS", newName));
    plist.CFBundleExecutable = newName;
    plist.CFBundleName = newName;
    plist.CFBundleDisplayName = newName;
    plist.CFBundleIdentifier = `${bundleId}.helper${suffix ? "." + suffix.replace(/[^a-z]/gi, "").toLowerCase() : ""}`;
    writePlist(plistFile, plist);
  }
}

/** png -> icns with sips + iconutil (for the downloaded-Electron route; the stock bundle already has icon.icns) */
function makeIcns(png, out, work) {
  const set = path.join(work, "icon.iconset");
  rmrf(set);
  fs.mkdirSync(set, { recursive: true });
  for (const [name, size] of [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
  ]) {
    run("sips", ["-z", String(size), String(size), png, "--out", path.join(set, name)]);
  }
  run("iconutil", ["-c", "icns", set, "-o", out]);
  rmrf(set);
}

/** download (cached) + unpack Electron.app for darwin/<arch>, return the .app path */
async function fetchElectronApp(version, arch, cacheDir) {
  const dist = path.join(cacheDir, `electron-v${version}-darwin-${arch}`);
  const app = path.join(dist, "Electron.app");
  if (fs.existsSync(path.join(app, "Contents", "MacOS", "Electron"))) {
    log(`electron runtime cached at ${app}`);
    return app;
  }
  log(`downloading electron v${version} darwin-${arch} (mirror via ELECTRON_MIRROR if set)`);
  const zip = await downloadArtifact({ version, artifactName: "electron", platform: "darwin", arch, cacheRoot: path.join(cacheDir, "zips") });
  log(`unpacking ${path.basename(zip)} (${fmtBytes(fs.statSync(zip).size)})`);
  rmrf(dist);
  fs.mkdirSync(dist, { recursive: true });
  run("ditto", ["-x", "-k", zip, dist]); // ditto keeps the symlinks inside the frameworks
  if (!fs.existsSync(path.join(app, "Contents", "MacOS", "Electron"))) die(`Electron.app missing after unpacking ${zip}`);
  return app;
}

/**
 * patched app dir (+ stock .app or downloaded Electron.app) -> `${buildDir}/GLKVM (mod).app`, ad-hoc signed
 * @returns {string} the bundle path
 */
export async function assembleMac({ buildDir, electronVersion, arch, cacheDir, macApp }) {
  if (process.platform !== "darwin") die("macOS bundles can only be assembled on macOS (hdiutil, ditto, codesign)");
  for (const t of ["ditto", "plutil", "codesign", "lipo"]) need(t);
  const appDir = path.join(buildDir, "app");
  const marker = readJson(path.join(appDir, MARKER));
  const out = path.join(buildDir, MAC_APP_NAME);
  rmrf(out);
  const fromStock = !!macApp;
  if (fromStock) {
    log(`assembling ${out} from the stock bundle ${path.basename(macApp)} (its Electron ${electronVersion} runtime, helpers and Info.plist)`);
    run("ditto", [macApp, out]);
  } else {
    const src = await fetchElectronApp(electronVersion, arch === "universal" ? (process.arch === "arm64" ? "arm64" : "x64") : arch, cacheDir);
    log(`assembling ${out} from ${path.basename(src)} (no stock macOS bundle in the source)`);
    run("ditto", [src, out]);
  }
  const contents = path.join(out, "Contents");
  const res = path.join(contents, "Resources");
  // payload: unpacked app dir replaces app.asar (Electron prefers resources/app over app.asar; the
  // stock bundle's asar-integrity/only-asar fuses are off, checked with @electron/fuses)
  for (const f of ["app.asar", "app.asar.unpacked", "default_app.asar", "app"]) rmrf(path.join(res, f));
  fs.cpSync(appDir, path.join(res, "app"), { recursive: true });
  // Info.plist
  const plistFile = path.join(contents, "Info.plist");
  const plist = readPlist(plistFile);
  const exeName = plist.CFBundleExecutable;
  renameHelpers(contents, plist.CFBundleName, "GLKVM (mod)", MAC_BUNDLE_ID);
  if (!fromStock) {
    // dress the stock Electron.app up: name, icon, protocol, the permission strings the client relies on
    fs.renameSync(path.join(contents, "MacOS", exeName), path.join(contents, "MacOS", "GLKVM"));
    plist.CFBundleExecutable = "GLKVM";
    const png = ["icon-mac.png", "icon.png"].map((f) => path.join(appDir, "resources", f)).find((p) => fs.existsSync(p));
    if (png) {
      makeIcns(png, path.join(res, "icon.icns"), buildDir);
      fs.rmSync(path.join(res, "electron.icns"), { force: true });
      plist.CFBundleIconFile = "icon.icns";
    }
    Object.assign(plist, {
      CFBundleURLTypes: [{ CFBundleTypeRole: "Editor", CFBundleURLName: "GLKVM OAuth", CFBundleURLSchemes: ["glkvm"] }],
      LSApplicationCategoryType: "public.app-category.utilities",
      LSMinimumSystemVersion: "11.0",
      NSHighResolutionCapable: true,
      NSRequiresAquaSystemAppearance: false,
      NSCameraUsageDescription: "Application requests access to the device's camera.",
      NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
      NSHumanReadableCopyright: "GLKVM client © GL Technologies (HK) Ltd. - unofficial build with glikvm-mod",
    });
  }
  Object.assign(plist, {
    CFBundleName: "GLKVM (mod)",
    CFBundleDisplayName: "GLKVM (mod)",
    CFBundleIdentifier: MAC_BUNDLE_ID,
    CFBundleShortVersionString: marker.appVersion,
    CFBundleVersion: marker.appVersion,
  });
  delete plist.ElectronAsarIntegrity; // there is no app.asar any more
  writePlist(plistFile, plist);
  // the stock bundle's electron-updater feed (example.com placeholder) is inert; drop it so nothing even tries
  fs.rmSync(path.join(res, "app-update.yml"), { force: true });
  // marker: platform + arch (the updater and status read it from inside the bundle)
  const archLabel = macArch(out);
  writeJson(macMarkerPath(out), { ...marker, platform: "darwin", arch: archLabel, runtime: fromStock ? "stock-bundle" : "electron-download" });
  // sign: the stock signature is void once Resources/ changed. Ad-hoc, no hardened runtime (an
  // ad-hoc identity cannot be notarized anyway); clear xattrs first, they break sealing.
  log(`signing ${path.basename(out)} (ad-hoc)`);
  tryRun("xattr", ["-cr", out]);
  run("codesign", ["--force", "--deep", "--sign", "-", out]);
  const verify = tryRun("codesign", ["--verify", "--deep", "--strict", out]);
  if (verify === null) warn("codesign --verify failed on the assembled bundle; it may still run locally, but check `codesign -dv`");
  log(`bundle: ${out} (${archLabel}, ${fromStock ? "stock runtime" : "downloaded Electron"})`);
  return out;
}

export function readMacMarker(app) {
  const p = macMarkerPath(app);
  return fs.existsSync(p) ? readJson(p) : null;
}

export function installMac(out, dest) {
  if (!dest.endsWith(".app")) die(`--dest must be a .app path on macOS (got ${dest})`);
  if (fs.existsSync(dest)) {
    if (!readMacMarker(dest)) die(`${dest} exists but is not a glikvm-macos build (no ${MARKER} inside); refusing to overwrite - pick another --dest`);
    rmrf(dest);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`installing -> ${dest}`);
  run("ditto", [out, dest]);
  registerMac(dest);
}

/** tell LaunchServices about the bundle (Spotlight, glkvm:// handler candidates) */
export function registerMac(app) {
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (fs.existsSync(lsregister)) tryRun(lsregister, ["-f", app]);
}

export function uninstallMac(dest) {
  if (!fs.existsSync(dest)) {
    log(`nothing at ${dest}`);
    return;
  }
  if (!readMacMarker(dest)) die(`${dest} does not look like a glikvm-macos build (no ${MARKER} inside); not touching it`);
  rmrf(dest);
  log(`removed ${dest}`);
  const old = `${dest}.old`;
  if (fs.existsSync(old)) {
    rmrf(old);
    log(`removed ${old}`);
  }
}

/** launch a bundle through LaunchServices (Dock, activation, open-url all behave as for a normal app) */
export function runMac(app, args) {
  run("open", ["-n", app, ...(args.length ? ["--args", ...args] : [])]);
}

/** zip (what the in-app updater downloads) + dmg (for humans) into distDir; returns the produced files */
export function packageMac(out, distDir, base) {
  need("hdiutil");
  const produced = [];
  const zip = path.join(distDir, `${base}.zip`);
  fs.rmSync(zip, { force: true });
  log(`packing ${zip}`);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", out, zip]);
  log(`zip: ${zip} (${fmtBytes(fs.statSync(zip).size)})`);
  produced.push(zip);
  const dmg = path.join(distDir, `${base}.dmg`);
  fs.rmSync(dmg, { force: true });
  const stage = path.join(path.dirname(out), "dmg-stage");
  rmrf(stage);
  fs.mkdirSync(stage, { recursive: true });
  run("ditto", [out, path.join(stage, path.basename(out))]);
  fs.symlinkSync("/Applications", path.join(stage, "Applications"));
  log(`building ${dmg}`);
  try {
    run("hdiutil", ["create", "-volname", "GLKVM (mod)", "-srcfolder", stage, "-ov", "-format", "UDZO", "-quiet", dmg]);
    log(`dmg: ${dmg} (${fmtBytes(fs.statSync(dmg).size)})`);
    produced.push(dmg);
  } catch (e) {
    warn(`dmg build failed: ${e.message.split("\n").slice(-3).join(" ")}`);
  } finally {
    rmrf(stage);
  }
  return produced;
}
