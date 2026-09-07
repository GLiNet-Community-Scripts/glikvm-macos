// macOS-specific patches (applied after glikvm-mod's), plus tolerant variants of mod
// patches whose anchors differ slightly in the macOS build of the client (the .dmg
// bundle is compiled separately from the Windows one; a few Vue render functions
// come out with different cache hoisting).
//
// Same rules as the mod: every patch anchors on a unique snippet and throws if the
// anchor is missing or ambiguous, so a client update never yields a half-patched app.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAC_VERSION = "0.1.0";
export const MAC_STAGE = "beta"; // shown as "v0.1.0 macos (beta)"
export const MAC_TAG = `v${MAC_VERSION}${MAC_STAGE ? `-${MAC_STAGE}` : ""}`; // git tag / GitHub release name, what the in-app updater compares
export const MAC_REPO = "emaspa/glikvm-macos";
export const MAC_DISPLAY_VERSION = `v${MAC_VERSION} macos${MAC_STAGE ? ` (${MAC_STAGE})` : ""}`;
export const MAC_REPO_URL = "https://github.com/emaspa/glikvm-macos";
const MOD_REPO_URL = "https://github.com/emaspa/glikvm-mod";

export function replaceOnce(src, anchor, replacement, label) {
  const first = src.indexOf(anchor);
  if (first === -1) throw new Error(`[${label}] anchor not found:\n${anchor.slice(0, 200)}`);
  if (src.indexOf(anchor, first + 1) !== -1) throw new Error(`[${label}] anchor is not unique:\n${anchor.slice(0, 200)}`);
  return src.slice(0, first) + replacement + src.slice(first + anchor.length);
}

export function replaceRegexOnce(src, re, replacement, label) {
  const matches = src.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!matches || matches.length !== 1) throw new Error(`[${label}] regex matched ${matches?.length ?? 0} times, expected 1`);
  return src.replace(re, replacement);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const inject = (name) => fs.readFileSync(path.join(here, "inject", name), "utf8");

function findBundle(dir, view, prefix) {
  const html = fs.readFileSync(path.join(dir, `out/renderer/view/${view}/index.html`), "utf8");
  const m = html.match(new RegExp(`src="\\.\\.\\/\\.\\.\\/assets\\/(${prefix}-[^"]+\\.js)"`));
  if (!m) throw new Error(`cannot find ${prefix} bundle name in view/${view}/index.html`);
  return "out/renderer/assets/" + m[1];
}

// ---------------------------------------------------------------------------
// Variants of glikvm-mod patches for the macOS-built bundle. Keyed by a regex on
// the mod patch's `what`; used only if the mod's own apply() throws.
// ---------------------------------------------------------------------------
export function modPatchVariants({ MOD_VERSION, REPO_URL }) {
  return [
    {
      match: /^home: About page shows the mod/,
      what: "home: About page shows the mod + link to the GitHub repo (mac-bundle variant)",
      apply: (src) =>
        replaceRegexOnce(
          src,
          // Windows build: createTextVNode(" Copyright ... ")\n ])),   mac build: createTextVNode(" Copyright ... ", -1)\n ])]),
          /(createTextVNode\(" Copyright \d{4} GL [^"]*"(?:, -1)?\)\n\s*\]\)\]?\),\n\s*_: 1\n\s*\}\)\n\s*\]\)\n\s*\]\),\n)/,
          "$1" +
            [
              '          createBaseVNode("div", { class: "h-[20px] mt-[12px] flex-start" }, [',
              '            createVNode(_component_BaseText, { type: "footnote-m", variant: "level2" }, {',
              `              default: withCtx(() => [createTextVNode("ui-mod ${MOD_VERSION} installed  ·")]),`,
              "              _: 1",
              "            }),",
              `            createVNode(_component_BaseText, { class: "text-primary pointer", variant: "level2", style: { marginLeft: "6px" }, onClick: () => window.open("${REPO_URL}") }, {`,
              `              default: withCtx(() => [createTextVNode("${REPO_URL.replace("https://", "")}")]),`,
              "              _: 1",
              "            })",
              "          ]),",
              "",
            ].join("\n"),
          "home.about.mac",
        ),
    },
  ];
}

// ---------------------------------------------------------------------------
// macOS patches proper
// ---------------------------------------------------------------------------
export function macPatches(dir, { MOD_VERSION }) {
  return [
    {
      file: "out/main/index.js",
      what: "main: single-instance conflict - offer to close the stock GLKVM.app and take over (the mod's PowerShell lookup is Windows-only)",
      apply: (src) =>
        replaceOnce(
          src,
          "function glHandleInstanceConflict() {\n  const app = require$$0$2.app;\n",
          [
            inject("mac-instance.js"),
            "function glHandleInstanceConflict() {\n  const app = require$$0$2.app;\n",
            '  if (process.platform === "darwin") {\n',
            "    glMacInstanceConflict();\n",
            "    return;\n",
            "  }\n",
          ].join(""),
          "mac.instanceConflict",
        ),
    },
    {
      file: "out/main/index.js",
      what: "main: hotfix glikvm-mod 0.1.5 - STRIP is not defined in glOnTabDragEnd (tearing a tab out by drag threw)",
      optional: true, // upstream fix makes this a no-op
      apply: (src) =>
        replaceOnce(
          src,
          "  if (x >= sb.x && x <= sb.x + sb.width && y >= sb.y && y <= sb.y + STRIP) return;\n  // lone tab -> just move the window to the drop point\n",
          "  if (x >= sb.x && x <= sb.x + sb.width && y >= sb.y && y <= sb.y + 44) return;\n  // lone tab -> just move the window to the drop point\n",
          "mac.hotfix.strip",
        ),
    },
    {
      file: "out/main/index.js",
      what: `main: in-app updater - checks GitHub Releases of ${MAC_REPO} (installed: ${MAC_TAG}), verifies SHA256SUMS, swaps the .app bundle, relaunches`,
      apply: (src) => {
        src = replaceOnce(
          src,
          "function closeRemoteWebtermByDeviceId(deviceId) {\n",
          inject("mac-updater.js").replaceAll("__GL_MAC_TAG__", MAC_TAG).replaceAll("__GL_MAC_REPO__", MAC_REPO) + "function closeRemoteWebtermByDeviceId(deviceId) {\n",
          "mac.updater.inject",
        );
        src = replaceOnce(
          src,
          '    initTray();\n    utils$2.electronApp.setAppUserModelId("com.gl.inet.kvm");\n',
          '    initTray();\n    glMacUpdaterInit();\n    utils$2.electronApp.setAppUserModelId("com.gl.inet.kvm");\n',
          "mac.updater.init",
        );
        src = replaceOnce(
          src,
          "    openDevTool: (event) => event.sender.openDevTools(),\n",
          "    openDevTool: (event) => event.sender.openDevTools(),\n    glMacCheckUpdate: () => glMacCheckForUpdates(true),\n",
          "mac.updater.ipc",
        );
        return src;
      },
    },
    {
      file: "out/preload/index.js",
      what: "preload: window.utils.glMacCheckUpdate() for the About page",
      apply: (src) =>
        replaceOnce(
          src,
          '  openDevTool: () => electron.ipcRenderer.send("openDevTool"),\n',
          '  openDevTool: () => electron.ipcRenderer.send("openDevTool"),\n  glMacCheckUpdate: () => electron.ipcRenderer.send("glMacCheckUpdate"),\n',
          "mac.updater.preload",
        ),
    },
    {
      file: findBundle(dir, "home", "home"),
      what: `home: version reads "${MAC_DISPLAY_VERSION}" (footer + About title; ui-mod is only stamped in About; the copy used by the update check is untouched)`,
      apply: (src) => {
        // footer: "V1.5.1 release1 · ui-mod x" -> "unofficial v0.1.0 macos (beta)" (the mod is stamped in About instead)
        src = replaceOnce(
          src,
          `toDisplayString(unref(CURRENT_VERSION) + " \\u00b7 ui-mod ${MOD_VERSION}")`,
          `toDisplayString(${JSON.stringify("unofficial " + MAC_DISPLAY_VERSION)})`,
          "mac.versionFooter",
        );
        // About title: "GLKVM V1.5.1 release1" -> "GLKVM v0.1.0 macos (beta)"
        src = replaceOnce(
          src,
          'createTextVNode("GLKVM " + toDisplayString(unref(VERSION)), 1)',
          `createTextVNode(${JSON.stringify("GLKVM " + MAC_DISPLAY_VERSION)}, 1)`,
          "mac.versionAbout",
        );
        return src;
      },
    },
    {
      file: findBundle(dir, "home", "home"),
      what: "home: About page - replace the mod's 'ui-mod installed' row with: what this build is made from (+ ui-mod), both repo links, not affiliated with GL-iNet",
      apply: (src) => {
        // the row the mod (or its mac-bundle variant above) inserted after the copyright line
        const startAnchor = '          createBaseVNode("div", { class: "h-[20px] mt-[12px] flex-start" }, [\n';
        const endAnchor = [
          `              default: withCtx(() => [createTextVNode("${MOD_REPO_URL.replace("https://", "")}")]),`,
          "              _: 1",
          "            })",
          "          ]),",
          "",
        ].join("\n");
        const a = src.indexOf(startAnchor);
        if (a === -1 || src.indexOf(startAnchor, a + 1) !== -1) throw new Error("[mac.about] start anchor missing/ambiguous");
        const b = src.indexOf(endAnchor, a);
        if (b === -1 || src.indexOf(endAnchor, b + 1) !== -1) throw new Error("[mac.about] end anchor missing/ambiguous");
        const text = (t, variant = "level2") =>
          [
            `            createVNode(_component_BaseText, { type: "footnote-m", variant: "${variant}" }, {`,
            `              default: withCtx(() => [${t}]),`,
            "              _: 1",
            "            })",
          ].join("\n");
        const link = (url) =>
          [
            `            createVNode(_component_BaseText, { class: "text-primary pointer", variant: "level2", onClick: () => window.open("${url}") }, {`,
            `              default: withCtx(() => [createTextVNode("${url.replace("https://", "")}")]),`,
            "              _: 1",
            "            })",
          ].join("\n");
        const block = [
          '          createBaseVNode("div", { class: "mt-[12px] flex-start" }, [',
          text(`createTextVNode("Unofficial build of the GLKVM " + unref(VERSION) + " macOS client with ui-mod ${MOD_VERSION}")`),
          "          ]),",
          '          createBaseVNode("div", { class: "mt-[6px] flex-start" }, [',
          link(MAC_REPO_URL),
          "          ]),",
          '          createBaseVNode("div", { class: "mt-[2px] flex-start" }, [',
          link(MOD_REPO_URL),
          "          ]),",
          '          createBaseVNode("div", { class: "mt-[6px] flex-start" }, [',
          '            createVNode(_component_BaseText, { class: "text-primary pointer", variant: "level2", onClick: () => window.utils.glMacCheckUpdate() }, {',
          '              default: withCtx(() => [createTextVNode("Check for updates")]),',
          "              _: 1",
          "            })",
          "          ]),",
          '          createBaseVNode("div", { class: "mt-[8px] flex-start" }, [',
          text('createTextVNode("Community project - not affiliated with, endorsed or supported by GL-iNet.")', "level3"),
          "          ]),",
          "",
        ].join("\n");
        return src.slice(0, a) + block + src.slice(b + endAnchor.length);
      },
    },
  ];
}
