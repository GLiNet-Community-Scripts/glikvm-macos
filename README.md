# glikvm-macos

Unofficial macOS GLKVM desktop client build (GL-iNet Comet / RM1 / RM10) with [glikvm-mod](https://github.com/emaspa/glikvm-mod) applied: the official `GLKVM.app` from GL-iNet's `.dmg` with the mod patched in, shipped as `GLKVM (mod).app` (universal, macOS 11+) in a `.dmg` / `.zip` you can just run (with in-app updates), or built locally from your own downloaded package. It installs next to the stock client and shows up as **v0.1.0 macos (beta)**; About shows the ui-mod version and which GLKVM release it is made from (1.5.1 today). The Linux counterpart is [glikvm-linux](https://github.com/emaspa/glikvm-linux).

> **Not affiliated with GL-iNet.** This is a community build of their client; GLKVM, the client and its artwork are theirs, and this project is not endorsed or supported by them. The source repository contains only the build tool and patches; the release downloads are convenience builds of their client.

It has everything the mod adds on Windows:

| Feature | |
|---|---|
| **Sessions in separate windows** | `Shift`+click a device, or set *Open sessions in: A separate window per session* |
| **Tab management like a browser** | reorder tabs by dragging · tear a tab out into its own window · drop a tab on another window's tab strip · combine windows by dragging one onto another's strip · right-click a tab → *Move to its own window* / *Move into the main session window* |
| **"+" new-session button** | at the end of the tab strip: recent sessions, local-access devices, *Choose from device list...* |
| **Paste local clipboard into the remote machine** | `Ctrl+Alt+V` = `Control`+`Option`+`V` (configurable), or right-click a tab; optional *Slow* paste |
| **1:1 resize to KVM resolution** | button next to fullscreen in the session toolbar, tab menu, or *Always open sessions at 1:1* |
| **Start screen** | open on Remote Access or Local Access; Back from Settings returns to the last access page |
| **Remember session passwords** | opt-in: a *Remember my password* checkbox on the device login screen; stored encrypted in your Keychain, auto-filled and submitted next time; turning the setting off wipes them |
| Window titles = device name, geometry inheritance, settings UI under *Settings → General → Sessions (ui-mod)*, mod/build stamps in About | |

## Just run it

Grab the latest release from **[Releases](https://github.com/emaspa/glikvm-macos/releases)**:

* `glkvm-mod-<tag>-macos-universal.dmg` - open, drag *GLKVM (mod)* to Applications (or anywhere you like).
* `glkvm-mod-<tag>-macos-universal.zip` - the same bundle; this is what the in-app updater downloads.
* `SHA256SUMS` - checksums of both.

**First start.** The bundle is **ad-hoc signed, not notarized** (there is no Apple developer account behind this), so macOS says it cannot verify the developer. Right-click the app → *Open*, or *System Settings → Privacy & Security → Open Anyway*, or clear the quarantine flag:

```sh
xattr -dr com.apple.quarantine "/Applications/GLKVM (mod).app"
```

**Shared profile.** Login, device list and settings are the stock client's (`~/Library/Application Support/gl-kvm`), so it is a drop-in replacement. Only one of the two can run at a time: starting *GLKVM (mod)* while the stock client is open asks whether to close it and take over; starting the stock client while the mod runs makes the stock client quit silently after raising the mod's window (its own behaviour). The `glkvm://` Google/Apple sign-in callback goes to whichever of the two ran most recently.

**Keychain.** Remembered passwords are encrypted with the *gl-kvm Safe Storage* Keychain item. Every release is a new ad-hoc signature, so after an update the Keychain may ask once whether *GLKVM (mod)* may use that item - *Always Allow* is fine.

### Updates

The app checks this repo's releases 8 s after start and every 6 h (About → **Check for updates** does it on demand). When a newer tag exists it asks (*Update / Later / Skip this version*), downloads the `.zip`, verifies it against `SHA256SUMS`, swaps the `.app` bundle in place, keeps the previous version as `GLKVM (mod).app.old` until the next start, and offers to restart. This needs the bundle to be writable by you (it is in `~/Applications` or a drag-installed `/Applications`; not when running from the mounted dmg). Set `GLKVM_MACOS_NO_UPDATE_CHECK=1` to disable the automatic check.

## Build it yourself

### Requirements

* macOS 11+ with the Xcode command line tools (`xcode-select --install`, for `codesign`); `hdiutil`, `ditto`, `plutil` are part of macOS. No admin rights: the app goes to `~/Applications`.
* [Node.js](https://nodejs.org) **24** (≥ 23.6; it loads glikvm-mod's TypeScript patch definitions with Node's built-in type stripping - no bun, no tsc) and `git`.
* **The official GLKVM `.dmg`** (`gl-kvm-<version>.dmg`) from the [GL-iNet app page](https://www.gl-inet.com/en-de/pages/app-rm), placed in this directory (or given with `--src`). GL-iNet's own version feed, `https://static.gl-inet.com/app/kvm/app_version.json`, lists the current package URL under `macos` when the page lags behind. Tested with **1.5.1 release1** and 1.5.0 release1 (both Electron 34.5.8). A Windows `.exe` works too (needs `7z`: `brew install sevenzip`): its payload is the same JavaScript, and a stock Electron.app of the matching version is downloaded as the runtime - useful when GL-iNet ships a release for Windows first.

### Install from source

```sh
git clone https://github.com/emaspa/glikvm-macos.git
cd glikvm-macos
npm install
# put the GLKVM .dmg in this directory, then:
node glikvm-macos.mjs install        # extract + patch + assemble + install "~/Applications/GLKVM (mod).app"
node glikvm-macos.mjs run            # or open the app / Launchpad "GLKVM (mod)"
node glikvm-macos.mjs status
node glikvm-macos.mjs uninstall
```

Other commands: `build` (only produce `build/GLKVM (mod).app`), `package` (build + `dist/*.zip` + `dist/*.dmg` + `SHA256SUMS`), `release` (package + publish as the GitHub release `v<version>` with `gh`, marked latest; installed copies pick it up through the in-app updater; `--draft`, `--prerelease`, `--notes "<extra text>"`), `update-mod` (`git pull` the vendored glikvm-mod, then re-run `install`).

Options: `--src <pkg>` (`.dmg`, a `.app` bundle such as `/Applications/GLKVM.app`, a Windows `.exe`, or an `app.asar`), `--dest <app>` (install path), `--mod <dir>` (use your own glikvm-mod checkout instead of `vendor/glikvm-mod`), `--electron <ver>` / `--arch arm64|x64` (only for the downloaded-Electron route; the build from the `.dmg` is universal like the stock client), `--no-mod` (stock client rebundled, no patches), `--cache <dir>` (default `~/.cache/glikvm-macos`; Electron downloads honour `ELECTRON_MIRROR`).

**After a new GLKVM release**: download the new `.dmg`, run `install` again. Every patch (the mod's and this repo's) is anchored on unique snippets of the stock code and aborts loudly if an anchor moved, so a client update can't produce a silently half-patched app. **After updating glikvm-mod** (`update-mod`), re-run `install` too. To ship it to users: bump `MAC_VERSION`/`MAC_STAGE` in `src/patches.mjs`, commit, `node glikvm-macos.mjs release`.

## Where things live

| | |
|---|---|
| app | `~/Applications/GLKVM (mod).app` (`--dest`): the stock bundle with `Contents/Resources/app` (patched, unpacked) instead of `app.asar`, ad-hoc signed, bundle id `com.glinet.kvmdesk.mod` |
| login, device list, settings (incl. the mod's) | `~/Library/Application Support/gl-kvm/GLKVM.json` - the client's own electron-store, shared with the stock client |
| logs | `~/Library/Logs/gl-kvm/` |
| build marker (what was built from what) | `Contents/Resources/app/glikvm-macos.json` inside the bundle; `status` prints it |

## How it works

GLKVM is a thin Electron 34 wrapper (unminified `app.asar`, `nodeIntegration: true`, no native modules): a home window (Vue), one "remote" window whose tabs are `<iframe src="https://<device>">` showing the device's own web UI, and a preload with IPC helpers. The macOS build is the stock `.app` with that payload patched in place.

`glikvm-macos.mjs` does, in order:

1. **Extract**: `hdiutil` mounts the `.dmg`, `ditto` copies `GLKVM.app` out (keeps symlinks and signatures), `app.asar` (+ `app.asar.unpacked`) is unpacked and the Electron version read from the framework's plist. From a Windows `.exe`: 7z pulls `resources/app.asar` out of the NSIS installer.
2. **Apply glikvm-mod's patches verbatim** (`vendor/glikvm-mod/src/patches.ts` + `src/inject/*`), then this repo's (`src/patches.mjs`):
   * single-instance conflict: the mod's takeover dialog uses PowerShell to find the stock client; `src/inject/mac-instance.js` re-implements it with `ps`/`kill` - find the other GLKVM main process, ask, terminate it, wait for the lock, relaunch;
   * a variant of the mod's About-page patch for the macOS-built bundle (its Vue render cache differs from the Windows build in that one spot);
   * hotfix for glikvm-mod ≤ 0.1.5 (`STRIP` undefined in `glOnTabDragEnd`) - fixed upstream in 0.1.6; applied only while its anchor exists, so it is a no-op with a current mod;
   * version shown as `unofficial v<version> macos (beta)` in the footer and `GLKVM v<version> macos (beta)` as the About title, and the About page replaced by: what the build is made from + ui-mod version, links to this repo and glikvm-mod, *Check for updates*, and the non-affiliation note - display only, the update-check copy is untouched;
   * the in-app updater (`src/inject/mac-updater.js`, main process) + `window.utils.glMacCheckUpdate()` + the About link.
   Every patched file is syntax-checked.
3. **Assemble** (`src/macapp.mjs`): copy the stock bundle, replace `Resources/app.asar` (+ `.unpacked`) with the patched `Resources/app` directory (Electron prefers it; the stock bundle's asar-integrity and only-load-from-asar fuses are off, checked with `@electron/fuses`), rename the bundle and its four helper apps to `GLKVM (mod)` (Electron looks its helpers up by the app's `CFBundleName`), give it its own `CFBundleIdentifier` so LaunchServices, the Dock and notifications keep the two apps apart, drop the `ElectronAsarIntegrity` plist entry and the inert `app-update.yml`, then `codesign --force --deep --sign -` (ad-hoc; the stock Developer ID signature is void once Resources changed). Without a stock bundle (built from an `.exe`), a stock Electron.app of the matching version is downloaded and dressed up instead: executable and helper names, `icon.icns` made from the client's `icon-mac.png`, the `glkvm://` URL type, camera/microphone usage strings and the ATS exceptions the client needs.
4. **Install**: `ditto` the bundle to `--dest` and register it with `lsregister`.

Nothing else in the client is touched: login, cloud relay, local access, webterm, file transfer, screenshots, settings all run as in the stock client.

## Notes / honest limits

* **Gatekeeper**: ad-hoc signed, not notarized - see *First start* above. A locally built copy (`install`) has no quarantine flag and opens straight away.
* **No menu-bar icon**, same as the stock macOS client; closing the last window keeps the app in the Dock.
* **System keys**: the Windows build ships a helper that swallows `Win`/`Alt+Tab` while a session is focused; there is no macOS equivalent, `Cmd+Tab` still goes to macOS (same as the stock client).
* **GL-iNet's own auto-update** (electron-updater) is inert: the bundle's feed file points at a placeholder and is dropped from the build; updates come from this repo's releases.
* **Universal**: the build made from the stock `.dmg` runs natively on Apple silicon and Intel, like the stock client.
* Tested on macOS 26 (Apple silicon) with the mock device below against the client 1.5.1 `.dmg`: sessions in tabs and separate windows, clipboard paste, 1:1 fit, remembered passwords with auto-login, in-app update check, the takeover dialog against the stock 1.5.1 client. Real devices are reachable exactly like in the stock client since the session is the device's own web UI in an iframe.

## Testing without a KVM

`test/mockkvm.mjs` is a fake device: self-signed HTTPS, `/api/auth/check`, a JS-driven login page (password `kvm123` - exercises the remember-password flow; the client's iframe sandbox blocks native form submission, so it is button-driven like the real device UI), a page with a live `<video>` of a chosen resolution, the client handshake, and `/api/hid/print` recording what gets "typed". The 1.5.1 client accepts no port in the host field, so the mock must answer on 443; an unprivileged process may take a port below 1024 only on the wildcard address, which `MOCKKVM_HOST=""` selects. Two hostnames for the same mock give two "devices". `test/cdp.mjs` drives the running client over the DevTools protocol (screenshots, `window.utils.glFitWindow()`, `glPasteClipboard()`, `glMoveDevice(id, "window"|"tab")`, ...; a match like `https://127.0.0.1` targets the device iframe inside a session):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout test/key.pem -out test/cert.pem -subj /CN=localhost -days 30
MOCKKVM_HOST="" node test/mockkvm.mjs 443 MockKVM-A 1280 720 &
node glikvm-macos.mjs run -- --remote-debugging-port=9333
# Local Access -> Add Device -> 127.0.0.1 (and again with "localhost"), open them, then e.g.:
node test/cdp.mjs 9333 list
node test/cdp.mjs 9333 eval "require('electron').clipboard.writeText('hello'); window.utils.glPasteClipboard()" view/remote
grep PRINT test/mock-443.log
```

## Relationship to glikvm-mod and glikvm-linux

This repo contains no copy of the mod: it clones `emaspa/glikvm-mod` into `vendor/` on first use (or use `--mod` to point at your checkout) and imports its `src/patches.ts` directly. Anything platform-neutral belongs upstream in the mod; only macOS plumbing and the mac-bundle workarounds live here. [glikvm-linux](https://github.com/emaspa/glikvm-linux) is the same idea for Linux (payload + Linux Electron runtime); the two tools share their structure but release independently.

## Changelog

**0.1.0 beta** - first release: build/install/run/status/uninstall/package/release from the 1.5.1 `.dmg` (or an `.exe`); glikvm-mod 0.1.10 applied; macOS takeover dialog against the stock client; zip + dmg releases with SHA256SUMS and an in-app updater that swaps the bundle; mock device + CDP test helpers.

## Licensing

* **This repository** (build tool, patches, injected code, test helpers): MIT, see [LICENSE](LICENSE).
* **glikvm-mod**: MIT ([emaspa/glikvm-mod](https://github.com/emaspa/glikvm-mod)).
* **The GLKVM desktop client** the releases contain (payload and runtime): © GL Technologies (HK) Ltd., all rights reserved, no open-source license (the client's source is not published; it is distinct from GL-iNet's GPL-3.0 device firmware [gl-inet/glkvm](https://github.com/gl-inet/glkvm), none of which is included here). Its third-party components are MIT/BSD (ant-design-vue, marked, electron-store, ...). The release builds are provided as an unofficial convenience for macOS users; if GL-iNet asks for them to be taken down they will be, and building locally from your own downloaded package (above) needs nothing from this repo's releases.
* **Electron** 34 (MIT) and **Chromium** (BSD) - their notices ship inside the bundle as in the stock client.

Not affiliated with, endorsed or supported by GL-iNet.
