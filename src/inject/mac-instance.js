// ---------------------------------------------------------------------------
// glikvm-macos: single-instance conflict with the stock client.
// Both the stock GLKVM.app and this build share ~/Library/Application Support/gl-kvm,
// so only one can run at a time. Stock behaviour is to hand off to whichever is
// running and quit silently, which makes launching the mod while the stock client
// is open look like "the mod is not patched". The mod's own takeover dialog uses
// PowerShell to find the other process; this is the macOS equivalent (ps + kill).
// ---------------------------------------------------------------------------
function glMacListGlkvmMains() {
  try {
    const out = require$$0$3.execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 15e3 });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(\d+)\s+(.+)$/.exec(l);
        return m ? { pid: Number(m[1]), exe: m[2] } : null;
      })
      .filter((p) => p && p.pid !== process.pid && /\.app\/Contents\/MacOS\/[^/]+$/.test(p.exe) && !/ Helper( \([^)]*\))?$/.test(p.exe))
      .filter((p) => /GLKVM/i.test(p.exe) || /gl-kvm/i.test(p.exe));
  } catch (e) {
    logWarn("[glikvm-macos] process list failed", String(e));
    return [];
  }
}
function glMacInstanceConflict() {
  const app = require$$0$2.app;
  app.whenReady().then(() => {
    const me = process.execPath;
    const others = glMacListGlkvmMains().filter((p) => p.exe !== me);
    if (!others.length) {
      // same build already running: hand off (it raises its window via second-instance)
      app.quit();
      return;
    }
    const otherApp = others[0].exe.replace(/\/Contents\/MacOS\/[^/]+$/, "");
    const choice = require$$0$2.dialog.showMessageBoxSync({
      type: "question",
      title: "GLKVM ui-mod",
      message: "Another GLKVM is already running",
      detail: `${otherApp}\nis running (probably the stock client). Both share the same profile, so only one can run at a time.\n\nClose it and start GLKVM (mod) instead? Sessions open in the other client will be closed.`,
      buttons: ["Close it and start GLKVM (mod)", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice !== 0) {
      app.quit();
      return;
    }
    for (const p of others) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch (e) {
        logWarn("[glikvm-macos] could not stop process", p.pid, String(e));
      }
    }
    // wait for the other instance to release the lock, then start over
    const started = Date.now();
    const retry = () => {
      const still = glMacListGlkvmMains().some((p) => others.some((o) => o.pid === p.pid));
      if (still && Date.now() - started < 8e3) return setTimeout(retry, 300);
      if (still) {
        for (const p of others) {
          try {
            process.kill(p.pid, "SIGKILL");
          } catch {
          }
        }
      }
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 800);
    };
    setTimeout(retry, 500);
  });
}
