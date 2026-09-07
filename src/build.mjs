// build pipeline: stock package -> extracted app -> patched (glikvm-mod + macOS patches) -> "GLKVM (mod).app" (macapp.mjs)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractAll } from "@electron/asar";
import { log, warn, die, sha256, rmrf, readJson, writeJson } from "./util.mjs";
import { resolveSource, DEFAULT_ELECTRON } from "./source.mjs";
import { ensureMod, loadMod, modCommit } from "./mod.mjs";
import { macPatches, modPatchVariants, MAC_VERSION } from "./patches.mjs";

export const MARKER = "glikvm-macos.json";

/** node --check, honouring the module kind (renderer bundles are ESM, main/preload are CJS) */
function syntaxCheck(file, tmpDir) {
  const code = fs.readFileSync(file, "utf8");
  const esm = /^(import|export)\s/m.test(code.slice(0, 4000));
  const tmp = path.join(tmpDir, path.basename(file) + (esm ? ".mjs" : ".cjs"));
  fs.writeFileSync(tmp, code);
  const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) die(`syntax error in patched ${file}:\n${(r.stderr || "").split("\n").slice(0, 12).join("\n")}`);
}

function applyPatches(appDir, patches, { variants = [] } = {}) {
  const touched = new Set();
  for (const p of patches) {
    const file = path.join(appDir, p.file);
    const before = fs.readFileSync(file, "utf8");
    let after;
    let what = p.what;
    try {
      after = p.apply(before);
    } catch (e) {
      if (p.optional && /anchor not found/.test(String(e.message))) {
        log(`skipped (not applicable): ${p.what}`);
        continue;
      }
      const alt = variants.find((v) => v.match.test(p.what));
      if (!alt) die(`patch failed: ${p.what}\n  ${String(e.message).split("\n")[0]}`);
      try {
        after = alt.apply(before);
        what = alt.what;
      } catch (e2) {
        die(`patch failed (and its mac-bundle variant too): ${p.what}\n  ${String(e.message).split("\n")[0]}\n  ${String(e2.message).split("\n")[0]}`);
      }
    }
    if (after === before) die(`patch produced no change: ${what}`);
    fs.writeFileSync(file, after);
    touched.add(file);
    log(`patched: ${what}`);
  }
  return touched;
}

/**
 * Extract + patch the app into `${buildDir}/app`.
 * @returns the build marker plus `macApp` (the stock bundle to use as runtime, or null)
 */
export async function buildApp({ buildDir, src, modDir, electronOverride, noMod = false }) {
  const work = path.join(buildDir, "work");
  fs.mkdirSync(work, { recursive: true });
  const source = resolveSource(src, work);
  log(`stock package: ${source.describe}`);
  const appDir = path.join(buildDir, "app");
  rmrf(appDir);
  fs.mkdirSync(appDir, { recursive: true });
  let sourceSha256 = null;
  if (source.asar) {
    log(`extracting ${source.asar}`);
    extractAll(source.asar, appDir);
    sourceSha256 = sha256(source.asar);
  } else {
    log(`copying ${source.appDir}`);
    fs.cpSync(source.appDir, appDir, { recursive: true });
  }
  if (!fs.existsSync(path.join(appDir, "resources", "icon.png")))
    warn("resources/icon.png missing (app.asar.unpacked not next to the asar?) - window icon will be blank");
  const pkg = readJson(path.join(appDir, "package.json"));
  log(`stock client ${pkg.name} ${pkg.version}`);
  const electronVersion = electronOverride || source.electronVersion || DEFAULT_ELECTRON;
  log(`electron ${electronVersion}${source.electronVersion ? " (detected from package)" : electronOverride ? " (--electron)" : " (default)"}`);

  const patchedFiles = new Set();
  let modVersion = null;
  let modRev = null;
  if (!noMod) {
    const dir = ensureMod(modDir);
    const mod = await loadMod(dir);
    modVersion = mod.MOD_VERSION;
    modRev = modCommit(dir);
    log(`glikvm-mod ${modVersion}${modRev ? ` (${modRev})` : ""} from ${dir}`);
    const supported = mod.SUPPORTED_APP_VERSIONS;
    if (Array.isArray(supported) && !supported.includes(pkg.version))
      warn(`glikvm-mod ${modVersion} lists GLKVM ${supported.join(", ")} as supported, this package is ${pkg.version} - continuing (every patch is anchored and aborts loudly if the code moved); if it fails, update the mod ('node glikvm-macos.mjs update-mod') or use a matching package`);
    for (const f of applyPatches(appDir, mod.allPatches(appDir), { variants: modPatchVariants(mod) })) patchedFiles.add(f);
    for (const f of applyPatches(appDir, macPatches(appDir, { MOD_VERSION: modVersion }))) patchedFiles.add(f);
  } else {
    log("stock client only (--no-mod): no patches");
  }
  for (const f of patchedFiles) syntaxCheck(f, work);
  log(`syntax OK for ${patchedFiles.size} patched files`);

  const marker = {
    macosVersion: MAC_VERSION,
    modVersion,
    modCommit: modRev,
    appVersion: pkg.version,
    electronVersion,
    sourceSha256,
    source: source.describe,
    builtAt: new Date().toISOString(),
  };
  writeJson(path.join(appDir, MARKER), marker);
  // strip build leftovers that would only confuse
  for (const f of ["electron-builder.mac.yml"]) fs.rmSync(path.join(appDir, f), { force: true });
  return { ...marker, macApp: source.macApp };
}

/** read the marker of a built/installed bundle (or a bare app dir) */
export function readMarker(dir) {
  for (const p of [path.join(dir, "Contents", "Resources", "app", MARKER), path.join(dir, MARKER)]) {
    if (fs.existsSync(p)) return readJson(p);
  }
  return null;
}
