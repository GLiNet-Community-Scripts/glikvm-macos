// Locate the stock GLKVM client inside whatever the user has:
//   - the macOS .dmg            (hdiutil; the whole .app is kept, it becomes the runtime of the build)
//   - a .app bundle             (e.g. /Applications/GLKVM.app)
//   - the Windows NSIS .exe     (needs 7z; installer -> $PLUGINSDIR/app-64.7z -> resources/app.asar; a stock
//                                Electron.app of the matching version is downloaded as the runtime)
//   - an extracted app dir or an app.asar file directly
// and figure out which Electron version the stock client was built with.
import fs from "node:fs";
import path from "node:path";
import { log, warn, die, run, which, rmrf } from "./util.mjs";

export const DEFAULT_ELECTRON = "34.5.8"; // GLKVM 1.5.x

function need7z() {
  const bin = which("7z") || which("7zz") || which("7za");
  if (!bin) die("7z is required to open a Windows .exe (brew install sevenzip), or pass --src pointing at the .dmg / a .app / an app.asar");
  return bin;
}

function plistString(xml, key) {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
}

/** scan a (possibly large) binary for an "Electron/x.y.z" marker */
function scanElectronVersion(file) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let carry = "";
    for (let off = 0; off < size; off += chunk.length) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, off);
      const text = carry + chunk.subarray(0, n).toString("latin1");
      const m = text.match(/Electron\/(\d+\.\d+\.\d+)/);
      if (m) {
        fs.closeSync(fd);
        return m[1];
      }
      carry = text.slice(-32);
    }
    fs.closeSync(fd);
  } catch {
  }
  return null;
}

/** copy a .app bundle out of a mounted .dmg (ditto keeps symlinks, resource forks, signatures) */
function copyAppFromDmg(src, workDir) {
  const out = path.join(workDir, "dmg");
  rmrf(out);
  fs.mkdirSync(out, { recursive: true });
  const mnt = path.join(workDir, "mnt");
  rmrf(mnt);
  log(`mounting ${path.basename(src)} (hdiutil)`);
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, src]);
  try {
    const apps = fs.readdirSync(mnt).filter((f) => f.endsWith(".app"));
    if (!apps.length) die(`no .app bundle found inside ${src}`);
    log(`copying ${apps[0]} out of the image`);
    run("ditto", [path.join(mnt, apps[0]), path.join(out, apps[0])]);
    return path.join(out, apps[0]);
  } finally {
    run("hdiutil", ["detach", mnt, "-force"]);
    rmrf(mnt);
  }
}

function describeMacApp(app) {
  const asar = path.join(app, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(asar)) die(`app.asar not found inside ${app}`);
  const plist = path.join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "Info.plist");
  const electronVersion = fs.existsSync(plist) ? plistString(fs.readFileSync(plist, "utf8"), "CFBundleVersion") : null;
  return { asar, appDir: null, electronVersion, macApp: app };
}

/**
 * @returns {{ asar: string|null, appDir: string|null, electronVersion: string|null, macApp: string|null, describe: string }}
 *   exactly one of `asar` (path to app.asar, .unpacked sibling honoured) or `appDir` (extracted app) is set;
 *   `macApp` is the complete stock .app bundle when the source provides one (.dmg or .app)
 */
export function resolveSource(src, workDir) {
  if (!src) {
    // default: newest .dmg / .exe next to us
    const here = process.cwd();
    const cand = fs.readdirSync(here).filter((f) => /\.(dmg|exe)$/i.test(f)).sort().reverse();
    if (!cand.length) die("no --src given and no .dmg/.exe found in the current directory");
    src = path.join(here, cand[0]);
    log(`using ${src}`);
  }
  src = path.resolve(src);
  if (!fs.existsSync(src)) die(`source not found: ${src}`);
  const st = fs.statSync(src);

  if (st.isDirectory()) {
    if (fs.existsSync(path.join(src, "package.json")) && fs.existsSync(path.join(src, "out", "main", "index.js"))) {
      return { asar: null, appDir: src, electronVersion: null, macApp: null, describe: `extracted app dir ${src}` };
    }
    if (src.endsWith(".app") && fs.existsSync(path.join(src, "Contents", "MacOS"))) {
      return { ...describeMacApp(src), describe: `app bundle ${src}` };
    }
    const asar = ["resources/app.asar", "app.asar"].map((n) => path.join(src, n)).find((p) => fs.existsSync(p));
    if (!asar) die(`no app.asar found under ${src}`);
    const exe = ["GLKVM.exe", "electron.exe"].map((n) => path.join(src, n)).find((p) => fs.existsSync(p));
    return { asar, appDir: null, electronVersion: exe ? scanElectronVersion(exe) : null, macApp: null, describe: `directory ${src}` };
  }

  const ext = path.extname(src).toLowerCase();
  if (ext === ".asar") {
    return { asar: src, appDir: null, electronVersion: null, macApp: null, describe: `asar ${src}` };
  }

  if (ext === ".dmg") {
    if (process.platform !== "darwin") die("opening the .dmg needs macOS (hdiutil)");
    const app = copyAppFromDmg(src, workDir);
    return { ...describeMacApp(app), describe: `${path.basename(src)} (${path.basename(app)})` };
  }

  if (ext === ".exe") {
    const bin = need7z();
    const out = path.join(workDir, "exe");
    rmrf(out);
    fs.mkdirSync(out, { recursive: true });
    log(`extracting app payload from ${path.basename(src)} (7z, NSIS installer)`);
    // electron-builder NSIS: the app lives in $PLUGINSDIR/app-64.7z (or app-32 / app-arm64)
    run(bin, ["x", "-y", `-o${out}`, src, "-ir!$PLUGINSDIR/app-*.7z"]);
    const inner = fs.existsSync(path.join(out, "$PLUGINSDIR")) ? fs.readdirSync(path.join(out, "$PLUGINSDIR")).filter((f) => /^app-.*\.7z$/.test(f)) : [];
    if (!inner.length) {
      // maybe a plain (non-NSIS) layout: resources/app.asar directly inside
      const direct = path.join(out, "resources", "app.asar");
      if (fs.existsSync(direct)) return { asar: direct, appDir: null, electronVersion: scanElectronVersion(src), macApp: null, describe: path.basename(src) };
      die(`could not find app-*.7z inside ${src}`);
    }
    const inner7z = path.join(out, "$PLUGINSDIR", inner[0]);
    const app = path.join(out, "app");
    fs.mkdirSync(app, { recursive: true });
    run(bin, ["x", "-y", `-o${app}`, inner7z, "resources/app.asar", "resources/app.asar.unpacked", "GLKVM.exe"]);
    const asar = path.join(app, "resources", "app.asar");
    if (!fs.existsSync(asar)) die(`resources/app.asar not found inside ${inner[0]}`);
    const exe = path.join(app, "GLKVM.exe");
    const electronVersion = fs.existsSync(exe) ? scanElectronVersion(exe) : null;
    return { asar, appDir: null, electronVersion, macApp: null, describe: `${path.basename(src)} (${inner[0]})` };
  }

  warn(`unrecognised source type ${ext}; trying to treat it as an asar`);
  return { asar: src, appDir: null, electronVersion: null, macApp: null, describe: src };
}
