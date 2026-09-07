// ---------------------------------------------------------------------------
// glikvm-macos: in-app updater. Checks GitHub Releases of __GL_MAC_REPO__ for a
// newer build (tag v<version>[-stage]), downloads the .zip of the .app bundle,
// verifies it against the release's SHA256SUMS, swaps the bundle in place and
// relaunches. Everything is best-effort and logged under [glikvm-macos].
// ---------------------------------------------------------------------------
const GL_MAC_TAG = "__GL_MAC_TAG__";
const GL_MAC_REPO = "__GL_MAC_REPO__";
const GL_MAC_UPDATE_API = `https://api.github.com/repos/${GL_MAC_REPO}/releases?per_page=10`;
const GL_MAC_CHECK_INTERVAL = 6 * 60 * 60 * 1e3;
let glMacUpdateBusy = false;
let glMacUpdateTimer = null;
function glMacLog(...a) {
  logInfo("[glikvm-macos]", ...a);
}
function glMacWarn(...a) {
  logWarn("[glikvm-macos]", ...a);
}
function glMacParseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-.\s]?([a-z]+)\.?(\d*))?/i.exec(String(tag || "").trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], stage: (m[4] || "").toLowerCase(), stageNum: m[5] ? +m[5] : 0 };
}
// -1 / 0 / 1 like a comparator; a release without a stage is newer than the same number with one (0.1.0 > 0.1.0-beta)
function glMacCompareTags(a, b) {
  const x = glMacParseTag(a);
  const y = glMacParseTag(b);
  if (!x || !y) return 0;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!!x.stage !== !!y.stage) return x.stage ? -1 : 1;
  if (x.stage !== y.stage) return x.stage < y.stage ? -1 : 1;
  if (x.stageNum !== y.stageNum) return x.stageNum < y.stageNum ? -1 : 1;
  return 0;
}
function glMacArch() {
  return process.arch === "arm64" ? "arm64" : "x64";
}
function glMacWritable(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
// the .app bundle we run from, if we can replace it (not a mounted dmg, not root-owned)
function glMacInstallBundle() {
  if (process.platform !== "darwin") return null;
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath);
  if (!m) return null;
  const bundle = m[1];
  if (!fs.existsSync(require$$2.join(bundle, "Contents", "Resources", "app", "glikvm-macos.json"))) return null;
  if (!glMacWritable(require$$2.dirname(bundle)) || !glMacWritable(bundle)) return null;
  return bundle;
}
async function glMacFetchJson(url) {
  const res = await require$$0$2.net.fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": `glikvm-macos/${GL_MAC_TAG}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}
async function glMacFetchText(url) {
  const res = await require$$0$2.net.fetch(url, { headers: { "user-agent": `glikvm-macos/${GL_MAC_TAG}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}
async function glMacLatestRelease() {
  const list = await glMacFetchJson(GL_MAC_UPDATE_API);
  const rel = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft && glMacParseTag(r.tag_name)).sort((a, b) => glMacCompareTags(b.tag_name, a.tag_name))[0];
  if (!rel) return null;
  return {
    tag: rel.tag_name,
    name: rel.name || rel.tag_name,
    notes: rel.body || "",
    page: rel.html_url,
    assets: (rel.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
  };
}
// prefer the universal bundle, else the one for this cpu
function glMacPickAsset(rel) {
  return rel.assets.find((a) => /macos-universal\.zip$/.test(a.name)) || rel.assets.find((a) => new RegExp(`macos-${glMacArch()}\\.zip$`).test(a.name)) || null;
}
async function glMacDownload(url, dest, onProgress) {
  const res = await require$$0$2.net.fetch(url, { headers: { "user-agent": `glikvm-macos/${GL_MAC_TAG}` } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = require("crypto").createHash("sha256");
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let done = 0;
  let lastPct = -1;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    hash.update(value);
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", r));
    done += value.length;
    if (total && onProgress) {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        onProgress(pct, done, total);
      }
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  return hash.digest("hex");
}
async function glMacExpectedSha(rel, assetName) {
  const sums = rel.assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));
  if (!sums) return null;
  const text = await glMacFetchText(sums.url);
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && require$$2.basename(m[2]) === assetName) return m[1].toLowerCase();
  }
  return null;
}
function glMacNotify(body, title = "GLKVM (mod)") {
  glMacLog("notify:", body);
  try {
    new require$$0$2.Notification({ title, body, silent: true }).show();
  } catch (e) {
    glMacWarn("notification failed", String(e));
  }
}
// start the new copy after this process has released the single-instance lock
function glMacRelaunch(bundle) {
  const child = require$$0$3.spawn("/bin/sh", ["-c", 'sleep 1.5; exec /usr/bin/open -n "$0"', bundle], { detached: true, stdio: "ignore" });
  child.unref();
  require$$0$2.app.exit(0);
}
// unzip (ditto keeps symlinks, resource forks and the code signature intact) next to the bundle and swap
function glMacSwapBundle(bundle, zip) {
  const stage = `${bundle}.update`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  require$$0$3.execFileSync("/usr/bin/ditto", ["-x", "-k", zip, stage], { stdio: "ignore" });
  const inner = fs.readdirSync(stage).map((f) => require$$2.join(stage, f)).find((p) => p.endsWith(".app") && fs.existsSync(require$$2.join(p, "Contents", "MacOS")));
  if (!inner) throw new Error("zip does not contain an .app bundle");
  try {
    require$$0$3.execFileSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", inner], { stdio: "ignore" });
  } catch {
  }
  const backup = `${bundle}.old`;
  fs.rmSync(backup, { recursive: true, force: true });
  fs.renameSync(bundle, backup);
  try {
    fs.renameSync(inner, bundle);
  } catch (e) {
    fs.renameSync(backup, bundle);
    throw e;
  }
  fs.rmSync(stage, { recursive: true, force: true });
  return backup;
}
function glMacCleanupOld() {
  try {
    const bundle = glMacInstallBundle();
    if (!bundle) return;
    const old = `${bundle}.old`;
    if (fs.existsSync(old)) {
      fs.rmSync(old, { recursive: true, force: true });
      glMacLog("removed previous version", old);
    }
  } catch (e) {
    glMacWarn("cleanup failed", String(e));
  }
}
async function glMacApplyUpdate(rel, bundle) {
  const asset = glMacPickAsset(rel);
  if (!asset) throw new Error(`release ${rel.tag} has no macOS zip for ${glMacArch()}`);
  const tmpDir = require$$2.join(require$$0$2.app.getPath("temp"), "glikvm-macos-update");
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = require$$2.join(tmpDir, asset.name);
  glMacLog("downloading", asset.url, `${asset.size} bytes`);
  glMacNotify(`Downloading GLKVM ${rel.tag} (${Math.round(asset.size / 1048576)} MB)...`);
  const sha = await glMacDownload(asset.url, file, (pct) => glMacLog(`download ${pct}%`));
  const expected = await glMacExpectedSha(rel, asset.name);
  if (expected && expected !== sha) {
    fs.rmSync(file, { force: true });
    throw new Error(`checksum mismatch for ${asset.name}`);
  }
  if (!expected) glMacWarn("release has no SHA256SUMS entry for", asset.name, "- installing unverified");
  glMacLog("verified", asset.name, sha.slice(0, 12));
  const backup = glMacSwapBundle(bundle, file);
  fs.rmSync(file, { force: true });
  glMacLog("installed", rel.tag, "previous kept at", backup);
  const choice = require$$0$2.dialog.showMessageBoxSync({
    type: "info",
    title: "GLKVM (mod) updated",
    message: `GLKVM ${rel.tag} is installed`,
    detail: "Restart now to start using it? Open sessions will be closed.",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (choice === 0) glMacRelaunch(bundle);
}
// manual = triggered from About; then "up to date" and errors are shown too
async function glMacCheckForUpdates(manual) {
  if (glMacUpdateBusy) {
    if (manual) glMacNotify("An update check or download is already running.");
    return;
  }
  const bundle = glMacInstallBundle();
  glMacUpdateBusy = true;
  try {
    const rel = await glMacLatestRelease();
    if (!rel) {
      if (manual) glMacNotify("No releases found.");
      return;
    }
    const newer = glMacCompareTags(rel.tag, GL_MAC_TAG) > 0;
    glMacLog("update check", { installed: GL_MAC_TAG, latest: rel.tag, newer, bundle: bundle || "not replaceable" });
    if (!newer) {
      if (manual) glMacNotify(`You have the latest version (${GL_MAC_TAG}).`);
      return;
    }
    if (!manual && store.get("macosUpdateSkip") === rel.tag) return;
    if (!bundle) {
      // e.g. running from the mounted dmg or a root-owned /Applications: just point at the release page
      const c = require$$0$2.dialog.showMessageBoxSync({
        type: "info",
        title: "GLKVM (mod) update available",
        message: `GLKVM ${rel.tag} is available (you have ${GL_MAC_TAG})`,
        detail: "This copy cannot update itself. Download it from the releases page?",
        buttons: ["Open releases page", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (c === 0) require$$0$2.shell.openExternal(rel.page);
      return;
    }
    const notes = String(rel.notes || "").replace(/\r/g, "").trim().slice(0, 1200);
    const choice = require$$0$2.dialog.showMessageBoxSync({
      type: "question",
      title: "GLKVM (mod) update available",
      message: `${rel.name} is available (you have ${GL_MAC_TAG})`,
      detail: `${notes ? notes + "\n\n" : ""}Download and install it now? The app bundle is replaced in place; the previous version is kept next to it until the next start.`,
      buttons: ["Update", "Later", "Skip this version"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice === 2) {
      store.set("macosUpdateSkip", rel.tag);
      return;
    }
    if (choice !== 0) return;
    await glMacApplyUpdate(rel, bundle);
  } catch (e) {
    glMacWarn("update failed", String(e && e.stack || e));
    if (manual) glMacNotify(`Update check failed: ${e?.message || e}`);
  } finally {
    glMacUpdateBusy = false;
  }
}
function glMacUpdaterInit() {
  if (process.platform !== "darwin") return;
  glMacCleanupOld();
  if (process.env.GLKVM_MACOS_NO_UPDATE_CHECK) return;
  setTimeout(() => glMacCheckForUpdates(false), 8e3);
  glMacUpdateTimer = setInterval(() => glMacCheckForUpdates(false), GL_MAC_CHECK_INTERVAL);
}
