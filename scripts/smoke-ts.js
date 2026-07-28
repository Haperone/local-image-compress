"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const Module = require("module");
const assert = require("node:assert/strict");
const { resolveRepositoryLayout } = require("./repository-layout");
const { runEsbuildCli } = require("./run-esbuild-cli");
const { runSourceContractChecks } = require("./smoke/source-contracts");

const { isDevLayout, repositoryRoot, sourceRoot: root } = resolveRepositoryLayout();
const artifact = path.join(root, "dist-ts", "main.js");
const sourceTsRoot = path.join(root, "src-ts");

const MOCK_MD5 = "0123456789abcdef0123456789abcdef";
const MOCK_MD5_ALT = "fedcba9876543210fedcba9876543210";
const VALID_JPEG_EOI = Uint8Array.from([0xff, 0xd9]);
const VALID_JPEG_OUTPUT = Uint8Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMDAwMDAwQEBAQFBQUFBQcHBgYHBwsICQgJCAsRCwwLCwwLEQ8SDw4PEg8bFRMTFRsfGhkaHyYiIiYwLTA+PlQBAwMDAwMDBAQEBAUFBQUFBwcGBgcHCwgJCAkICxELDAsLDAsRDxIPDg8SDxsVExMVGx8aGRofJiIiJjAtMD4+VP/CABEIAAEAAQMBEQACEQEDEQH/xAAmAAEAAAAAAAAAAAAAAAAAAAAJAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAAqj//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Af//Z",
  "base64"
));
const VALID_PNG_OUTPUT = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
));

function cloneArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function neverSettlingPromise() {
  return new Promise(() => {});
}

function stringifyConsoleArg(arg) {
  if (arg instanceof Error) {
    return arg.message;
  }
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch (error) {
    void error;
    return String(arg);
  }
}

function captureConsoleWarn() {
  const originalWarn = console.warn;
  const messages = [];
  console.warn = (...args) => {
    messages.push(args.map((arg) => stringifyConsoleArg(arg)).join(" "));
  };
  return {
    messages,
    restore() {
      console.warn = originalWarn;
    }
  };
}

async function withTestTimeout(name, promise, timeoutMs = 5000) {
  let timeoutHandle = null;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = originalGlobals.setTimeout(() => reject(new Error(`Smoke test "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle !== null) {
      originalGlobals.clearTimeout(timeoutHandle);
    }
  }
}

function createValidJpegBytes(byteLength = null) {
  const targetLength = byteLength || VALID_JPEG_OUTPUT.byteLength;
  assert(targetLength >= VALID_JPEG_OUTPUT.byteLength, "JPEG fixture cannot be truncated and remain valid");
  const bytes = new Uint8Array(targetLength);
  bytes.set(VALID_JPEG_OUTPUT.subarray(0, VALID_JPEG_OUTPUT.byteLength - VALID_JPEG_EOI.byteLength), 0);
  bytes.set(VALID_JPEG_EOI, bytes.byteLength - VALID_JPEG_EOI.byteLength);
  return bytes;
}

function createValidJpegOutput(byteLength = VALID_JPEG_OUTPUT.byteLength) {
  return cloneArrayBuffer(createValidJpegBytes(byteLength));
}

function createValidEncodedOutput(format = "jpeg", byteLength = null) {
  if (format === "png") {
    return cloneArrayBuffer(VALID_PNG_OUTPUT);
  }
  return createValidJpegOutput(byteLength || VALID_JPEG_OUTPUT.byteLength);
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const dataBytes = Buffer.from(data);
  const chunk = Buffer.alloc(12 + dataBytes.length);
  chunk.writeUInt32BE(dataBytes.length, 0);
  typeBytes.copy(chunk, 4);
  dataBytes.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk.subarray(4, 8 + dataBytes.length)), 8 + dataBytes.length);
  return chunk;
}

function createPngWithoutIdat() {
  const signatureAndIhdr = VALID_PNG_OUTPUT.subarray(0, 33);
  const iend = VALID_PNG_OUTPUT.subarray(VALID_PNG_OUTPUT.byteLength - 12);
  const textChunk = createPngChunk("tEXt", Buffer.from("Comment\0missing-idat", "ascii"));
  const bytes = new Uint8Array(signatureAndIhdr.byteLength + textChunk.byteLength + iend.byteLength);
  bytes.set(signatureAndIhdr, 0);
  bytes.set(textChunk, signatureAndIhdr.byteLength);
  bytes.set(iend, signatureAndIhdr.byteLength + textChunk.byteLength);
  return cloneArrayBuffer(bytes);
}

function createTruncatedPngChunk() {
  const bytes = new Uint8Array(61);
  bytes.set(VALID_PNG_OUTPUT.subarray(0, 33), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(33, 32);
  bytes.set(Buffer.from("IDAT", "ascii"), 37);
  return cloneArrayBuffer(bytes);
}

function createZeroWidthPng() {
  const bytes = new Uint8Array(VALID_PNG_OUTPUT);
  bytes[16] = 0;
  bytes[17] = 0;
  bytes[18] = 0;
  bytes[19] = 0;
  return bytes;
}

function findJpegMarkerOffset(bytes, marker) {
  for (let offset = 0; offset < bytes.byteLength - 1; offset += 1) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === marker) {
      return offset;
    }
  }
  return -1;
}

function concatUint8Arrays(parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function createJpegWithoutSos() {
  const sosOffset = findJpegMarkerOffset(VALID_JPEG_OUTPUT, 0xda);
  assert(sosOffset > 0, "JPEG fixture must include an SOS marker");
  return cloneArrayBuffer(concatUint8Arrays([
    VALID_JPEG_OUTPUT.subarray(0, sosOffset),
    VALID_JPEG_EOI
  ]));
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function assertValidPngFixture(bytes) {
  assert(bytes.byteLength >= 57, "PNG fixture must be large enough for IHDR, IDAT, and IEND");
  assert(Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "PNG fixture has an invalid signature");
  assert(Buffer.from(bytes.subarray(12, 16)).toString("ascii") === "IHDR", "PNG fixture must start with IHDR");
  assert(readUint32BE(bytes, 16) > 0 && readUint32BE(bytes, 20) > 0, "PNG fixture must have non-zero dimensions");
  assert(Buffer.from(bytes).includes(Buffer.from("IDAT")), "PNG fixture must include IDAT");
  assert(Buffer.from(bytes.subarray(bytes.byteLength - 8, bytes.byteLength - 4)).toString("ascii") === "IEND", "PNG fixture must end with IEND");
}

function assertValidJpegFixture(bytes) {
  assert(bytes.byteLength > 100, "JPEG fixture must be more than an SOI/EOI envelope");
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, "JPEG fixture must start with SOI");
  assert(bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9, "JPEG fixture must end with EOI");
  assert(findJpegMarkerOffset(bytes, 0xc0) > 0 || findJpegMarkerOffset(bytes, 0xc2) > 0, "JPEG fixture must include an SOF marker");
  assert(findJpegMarkerOffset(bytes, 0xda) > 0, "JPEG fixture must include an SOS marker");
}

assertValidPngFixture(VALID_PNG_OUTPUT);
assertValidJpegFixture(VALID_JPEG_OUTPUT);

if (!fs.existsSync(artifact)) {
  throw new Error(`Missing TypeScript artifact: ${path.relative(root, artifact)}`);
}

const { englishLocale, bugResearchPath, removedTechnicalSettingKeys } = runSourceContractChecks({
  root,
  repositoryRoot,
  artifact,
  isDevLayout
});

const originalLoad = Module._load;
let cachedObsidianMock = null;
let mockObsidianLanguage = "en";
let desktopTrashItem = async (filePath) => await fs.promises.unlink(filePath);
// Mobile profile: when armed, any Node/Electron module load aborts the test —
// the bundle must be able to evaluate without them on mobile.
let mobileNodeModuleBan = false;
const MOBILE_BANNED_MODULES = new Set([
  "fs", "path", "os", "crypto", "util", "electron", "child_process",
  "worker_threads", "stream", "stream/promises", "stream/web", "buffer", "process",
  "timers", "timers/promises"
]);
Module._load = function patchedLoad(request, parent, isMain) {
  if (mobileNodeModuleBan && (MOBILE_BANNED_MODULES.has(request) || String(request).startsWith("node:"))) {
    throw new Error(`Mobile profile violation: Node module "${request}" was loaded`);
  }
  if (request === "obsidian") {
    if (cachedObsidianMock) {
      return cachedObsidianMock;
    }
    class Component {
      constructor() {
        this.registeredCallbacks = [];
      }
      register(callback) {
        this.registeredCallbacks.push(callback);
      }
      registerDomEvent(element, type, callback) {
        element.addEventListener(type, callback);
        this.register(() => element.removeEventListener(type, callback));
      }
      unload() {
        for (const callback of this.registeredCallbacks.splice(0).reverse()) {
          callback();
        }
      }
    }
    class Plugin {
      constructor() {
        this.manifest = {
          id: "local-image-compress",
          name: "Local Image Compress",
          dir: root
        };
        this.commands = [];
        this.events = [];
        this.registeredCallbacks = [];
        this.settingTabs = [];
        this.statusBarItem = null;
        this.children = [];
      }
      registerEvent(event) {
        this.events.push(event);
      }
      register(callback) {
        this.registeredCallbacks.push(callback);
      }
      registerDomEvent(element, type, callback) {
        element.addEventListener(type, callback);
        this.register(() => element.removeEventListener(type, callback));
      }
      addChild(component) {
        this.children.push(component);
        return component;
      }
      removeChild(component) {
        this.children = this.children.filter((child) => child !== component);
        component.unload?.();
      }
      addCommand(command) {
        this.commands.push(command);
      }
      addSettingTab(tab) {
        this.settingTabs.push(tab);
      }
      addStatusBarItem() {
        const item = createMockElement();
        item.setText = (text) => {
          item.text = text;
        };
        item.show = () => {
          item.visible = true;
        };
        item.hide = () => {
          item.visible = false;
        };
        this.statusBarItem = item;
        return item;
      }
      async loadData() {
        return {};
      }
      async saveData(data) {
        this.savedData = data;
      }
    }
    cachedObsidianMock = {
      apiVersion: "test-app",
      Component,
      Plugin,
      PluginSettingTab: class {
        constructor(app, plugin) {
          this.app = app;
          this.plugin = plugin;
          this.containerEl = createMockElement();
        }
        hide() {
          this.hidden = true;
        }
      },
      Modal: class {
        constructor(app) {
          this.app = app;
          this.modalEl = createMockElement();
          this.contentEl = createMockElement();
          this.titleEl = createMockElement();
          const closeButton = createMockElement();
          closeButton.addClass("modal-close-button");
          this.modalEl.appendChild(this.titleEl);
          this.modalEl.appendChild(this.contentEl);
          this.modalEl.appendChild(closeButton);
        }
        open() {
          if (typeof this.onOpen === "function") {
            this.onOpen();
          }
        }
        close() {
          if (typeof this.onClose === "function") {
            this.onClose();
          }
        }
      },
      Setting: class {
        constructor(containerEl) {
          this.containerEl = containerEl;
          this.settingEl = createMockElement();
          this.controlEl = createMockElement();
        }
        setName(value) { this.name = value; return this; }
        setDesc(value) { this.desc = value; return this; }
        setHeading() { return this; }
        setDisabled(value) { this.disabled = value; return this; }
        addText() { return this; }
        addSlider() { return this; }
        addToggle() { return this; }
        addButton() { return this; }
        addExtraButton() { return this; }
        addDropdown() { return this; }
      },
      Notice: class {},
      TFile: class {},
      TFolder: class {},
      FuzzySuggestModal: class {},
      getLanguage: () => mockObsidianLanguage,
      requireApiVersion: () => true,
      // Mirrors the real desktop Platform surface so shared code can read it
      // instead of Node process.platform.
      Platform: {
        isDesktopApp: true,
        isMobile: false,
        isMobileApp: false,
        isWin: process.platform === "win32",
        isMacOS: process.platform === "darwin",
        isLinux: process.platform === "linux",
        isIosApp: false,
        isAndroidApp: false
      }
    };
    return cachedObsidianMock;
  }
  if (request === "electron") {
    return {
      shell: {
        openPath: async () => "",
        trashItem: async (filePath) => await desktopTrashItem(filePath)
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Compiles one src-ts module to CJS via the esbuild CLI (the JS API service
// can hit EPERM on this environment) and loads it through the mocked module
// loader so unit-level helpers become directly testable.
function compileTsModuleForTest(relativeSourcePath) {
  const outFile = path.join(os.tmpdir(), `lic-smoke-${process.pid}-${relativeSourcePath.replace(/[\\/]/g, "-")}.cjs`);
  runEsbuildCli([
    path.join("src-ts", relativeSourcePath),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    "--external:obsidian",
    "--external:electron",
    `--outfile=${outFile}`,
    "--log-level=silent"
  ], { cwd: root, stdio: "pipe" });
  try {
    const compiledSource = fs.readFileSync(outFile, "utf8");
    const testModule = new Module(outFile, null);
    testModule.filename = outFile;
    testModule.paths = Module._nodeModulePaths(root);
    testModule._compile(compiledSource, outFile);
    return testModule.exports;
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch (cleanupError) {
      void cleanupError;
    }
  }
}

function compileTsModuleFileForIsolatedTest(relativeSourcePath) {
  const outFile = path.join(os.tmpdir(), `lic-smoke-isolated-${process.pid}-${crypto.randomBytes(8).toString("hex")}.cjs`);
  runEsbuildCli([
    path.join("src-ts", relativeSourcePath),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    "--external:obsidian",
    "--external:electron",
    `--outfile=${outFile}`,
    "--log-level=silent"
  ], { cwd: root, stdio: "pipe" });
  return outFile;
}

// Path-helper parity: the string-based replacements for Node path.relative /
// path.isAbsolute must keep win32/posix semantics for vault conversions.
{
  const obsidianMock = Module._load("obsidian", null, false);
  const originalPlatform = { ...obsidianMock.Platform };
  const loadUtilsWithPlatform = (platformPatch) => {
    Object.assign(obsidianMock.Platform, originalPlatform, platformPatch);
    return compileTsModuleForTest("utils.ts");
  };
  try {
    const winUtils = loadUtilsWithPlatform({ isWin: true, isMacOS: false, isIosApp: false });
    assert.equal(winUtils.toVaultRelativePath("C:\\v\\Images\\a.png", "C:\\v"), "Images/a.png", "win32 relative conversion changed");
    assert.equal(winUtils.toVaultRelativePath("C:\\V\\IMG\\a.png", "c:\\v"), "IMG/a.png", "win32 case-insensitive base match changed");
    assert.equal(winUtils.toVaultRelativePath("\\\\srv\\share\\v\\x.png", "\\\\srv\\share\\v"), "x.png", "UNC relative conversion changed");
    assert.equal(winUtils.toVaultRelativePath("\\\\?\\C:\\v\\a\\b.png", "C:\\v"), "a/b.png", "long-path prefix stripping changed");
    assert.equal(winUtils.toVaultRelativePath("a/b.png", "C:\\v"), "a/b.png", "relative passthrough changed");
    assert.equal(winUtils.isSafeVaultRelativePath(winUtils.toVaultRelativePath("D:\\x\\y.png", "C:\\v")), false, "cross-drive paths must stay rejected");
    assert.equal(winUtils.isSafeVaultRelativePath(winUtils.toVaultRelativePath("C:\\other\\y.png", "C:\\v")), false, "outside-base paths must stay rejected");
    assert.equal(winUtils.toVaultRelativePath("C:\\v", "C:\\v"), "", "identical base/target must yield empty remainder");
    for (const [candidate, expected] of [
      ["C:\\x\\y.png", true],
      ["\\\\srv\\share", true],
      ["\\\\?\\C:\\x", true],
      ["/posix/root", true],
      ["a/b.png", false],
      ["", false]
    ]) {
      assert.equal(winUtils.isAbsoluteFilesystemPath(candidate), expected, `isAbsoluteFilesystemPath(${JSON.stringify(candidate)}) changed`);
    }
    assert.equal(winUtils.vaultPathsEqual("Images/A.png", "images/a.png"), true, "win32 vault path comparison must stay case-insensitive");

    const posixUtils = loadUtilsWithPlatform({ isWin: false, isMacOS: false, isLinux: true, isIosApp: false });
    assert.equal(posixUtils.toVaultRelativePath("/home/u/v/a/b.png", "/home/u/v"), "a/b.png", "posix relative conversion changed");
    assert.equal(posixUtils.isSafeVaultRelativePath(posixUtils.toVaultRelativePath("/home/u/V/a.png", "/home/u/v")), false, "posix base matching must stay case-sensitive");
    assert.equal(posixUtils.vaultPathsEqual("Images/A.png", "images/a.png"), false, "posix vault path comparison must stay case-sensitive");

    const iosUtils = loadUtilsWithPlatform({ isWin: false, isMacOS: false, isIosApp: true });
    assert.equal(iosUtils.vaultPathsEqual("Images/A.png", "images/a.png"), true, "iOS vault path comparison must be case-insensitive");

    const androidUtils = loadUtilsWithPlatform({ isWin: false, isMacOS: false, isLinux: false, isIosApp: false, isAndroidApp: true });
    assert.equal(androidUtils.vaultPathsEqual("Images/A.png", "images/a.png"), false, "Android vault path comparison must stay case-sensitive");
  } finally {
    Object.assign(obsidianMock.Platform, originalPlatform);
  }
}

function createMockElement() {
  const classes = new Set();
  const listeners = {};
  const children = [];
  const styleState = {};
  const style = {};
  Object.defineProperty(style, "width", {
    get() {
      return styleState.width;
    },
    set(value) {
      styleState.width = value;
      if (Array.isArray(global.__progressWidthUpdates)) {
        global.__progressWidthUpdates.push(value);
      }
    }
  });
  style.setProperty = (name, value) => {
    styleState[name] = String(value);
    style[name] = String(value);
    if (name === "--local-image-compress-progress-width" && Array.isArray(global.__progressWidthUpdates)) {
      global.__progressWidthUpdates.push(value);
    }
  };
  style.getPropertyValue = (name) => styleState[name] || "";
  const element = {
    attributes: {},
    style,
    children,
    _listeners: listeners,
    classList: {
      add(...names) {
        for (const name of names) classes.add(name);
        element.className = Array.from(classes).join(" ");
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
        element.className = Array.from(classes).join(" ");
      },
      contains(name) {
        return classes.has(name);
      }
    },
    className: "",
    addClass(name) {
      this.classList.add(name);
    },
    removeClass(name) {
      this.classList.remove(name);
    },
    setCssProps(props) {
      for (const [name, value] of Object.entries(props)) {
        style.setProperty(name, value);
      }
    },
    empty() {},
    appendChild(child) {
      if (child.parentElement?.removeChild) {
        child.parentElement.removeChild(child);
      }
      children.push(child);
      child.parentElement = element;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index !== -1) {
        children.splice(index, 1);
      }
      child.parentElement = null;
    },
    contains(child) {
      return child === element || children.includes(child) || children.some((nested) => nested.contains && nested.contains(child));
    },
    createEl(tag, opts) {
      const child = Object.assign(createMockElement(), {
        tag,
        opts,
        textContent: opts && opts.text
      });
      if (opts && opts.cls) {
        child.addClass(opts.cls);
      }
      this.appendChild(child);
      return child;
    },
    createDiv(opts) {
      const child = Object.assign(createMockElement(), { opts });
      if (opts && opts.cls) {
        child.addClass(opts.cls);
      }
      this.appendChild(child);
      return child;
    },
    createSpan(opts) {
      return this.createEl("span", opts);
    },
    setText(text) {
      this.text = text;
    },
    getText() {
      return this.text || this.textContent || "";
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
    addEventListener(name, callback) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      if (!listeners[name]) return;
      listeners[name] = listeners[name].filter((listener) => listener !== callback);
    },
    dispatchEvent(name, event = {}) {
      for (const listener of listeners[name] || []) {
        listener(event);
      }
    },
    querySelectorAll(selector) {
      if (!String(selector || "").startsWith(".")) {
        return [];
      }
      const className = String(selector).slice(1);
      const result = [];
      const visit = (node) => {
        if (node.classList?.contains?.(className)) {
          result.push(node);
        }
        for (const child of node.children || []) {
          visit(child);
        }
      };
      visit(element);
      return result;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    toggle() {},
    focus() {
      this.focused = true;
    }
  };
  return element;
}

function createMockDocument() {
  const doc = {
    activeElement: null,
    body: createMockElement(),
    createElement(tag) {
      const element = Object.assign(createMockElement(), {
        tag,
        id: "",
        value: "",
        textContent: ""
      });
      element.focus = () => {
        doc.activeElement = element;
      };
      return element;
    }
  };
  return doc;
}

function createMockFile(filePath, size, mtime = 1) {
  const name = filePath.split("/").pop();
  return {
    path: filePath,
    name,
    extension: name.split(".").pop(),
    stat: {
      size,
      mtime
    }
  };
}

function createCompressionSuccess(file, operation, savings = 25, outputPath = null) {
  const sourcePath = operation?.sourcePath || file?.path || "Images/mock.png";
  const sourceMtime = operation?.sourceMtime ?? file?.stat?.mtime ?? 1;
  const sourceSize = file?.stat?.size ?? 100000;
  return {
    success: true,
    savings,
    artifact: Object.freeze({
      sourcePath,
      sourceMtime,
      sourceSize,
      sourceMd5: MOCK_MD5,
      sourceSha256: "a".repeat(64),
      outputPath: outputPath || `Compressed/${sourcePath}`,
      outputSize: Math.max(1, sourceSize - savings),
      outputSha256: "b".repeat(64),
      compressionSettingsKey: "mock:settings"
    })
  };
}

function seedPendingMoveArtifact(plugin, sourcePath, outputPath, sourceFile, outputFile) {
  const sourceStats = fs.statSync(sourceFile);
  const outputStats = fs.statSync(outputFile);
  const sourceBytes = fs.readFileSync(sourceFile);
  const outputBytes = fs.readFileSync(outputFile);
  const sourceMd5 = crypto.createHash("md5").update(sourceBytes).digest("hex");
  const cacheKey = plugin.cache.buildCacheKey(sourcePath, sourceMd5, sourceStats.mtimeMs);
  plugin.cache.cacheData.entries[cacheKey] = {
    path: sourcePath,
    md5: sourceMd5,
    mtime: sourceStats.mtimeMs,
    timestamp: Date.now(),
    sourceMtime: sourceStats.mtimeMs,
    sourceSize: sourceStats.size,
    sourceSha256: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
    state: "pending_move",
    outputPath,
    outputMtime: outputStats.mtimeMs,
    outputSize: outputStats.size,
    outputSha256: crypto.createHash("sha256").update(outputBytes).digest("hex")
  };
  return cacheKey;
}

function createMockApp() {
  const files = [
    createMockFile("Images/a.png", 100000),
    createMockFile("Images/b.jpg", 100000),
    createMockFile("Compressed/Images/c.png", 100000),
    createMockFile("Images/project/Compressed/d.png", 100000)
  ];
  const setting = {
    activeTab: null,
    openTabByIdCalls: 0,
    openTabById() {
      this.openTabByIdCalls += 1;
      return null;
    }
  };
  const vaultHandlers = {};
  const workspaceHandlers = {};
  const layoutReadyCallbacks = [];
  let layoutReady = false;
  let getFilesCalls = 0;
  const app = {
    _files: files,
    _vaultHandlers: vaultHandlers,
    _workspaceHandlers: workspaceHandlers,
    _layoutReadyCallbacks: layoutReadyCallbacks,
    _getFilesCalls: 0,
    vault: {
      configDir: ".obsidian",
      adapter: {
        basePath: root,
        path: {
          absolute: root
        },
        getBasePath() {
          return this.basePath || this.path?.absolute || root;
        },
        // Adapter surface used by peripheral (non-fs) plugin code; resolves through
        // getBasePath() at call time so tests that re-point basePath stay coherent.
        _resolve(vaultPath) {
          return path.join(this.getBasePath(), ...String(vaultPath || "").split("/").filter(Boolean));
        },
        async exists(vaultPath) {
          return fs.existsSync(this._resolve(vaultPath));
        },
        async read(vaultPath) {
          return fs.readFileSync(this._resolve(vaultPath), "utf8");
        },
        async stat(vaultPath) {
          try {
            const stats = fs.statSync(this._resolve(vaultPath));
            return { type: stats.isDirectory() ? "folder" : "file", ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size };
          } catch {
            return null;
          }
        },
        async list(vaultPath) {
          const prefix = String(vaultPath || "").replace(/\/+$/, "");
          const files = [];
          const folders = [];
          for (const entry of fs.readdirSync(this._resolve(vaultPath), { withFileTypes: true })) {
            (entry.isDirectory() ? folders : files).push(prefix ? `${prefix}/${entry.name}` : entry.name);
          }
          return { files, folders };
        },
        async mkdir(vaultPath) {
          fs.mkdirSync(this._resolve(vaultPath), { recursive: true });
        },
        async remove(vaultPath) {
          fs.rmSync(this._resolve(vaultPath), { force: true });
        },
        async rmdir(vaultPath, recursive) {
          fs.rmSync(this._resolve(vaultPath), { recursive: !!recursive, force: true });
        }
      },
      getFiles: () => {
        getFilesCalls += 1;
        app._getFilesCalls = getFilesCalls;
        return app._files;
      },
      getAllLoadedFiles: () => [],
      on: (name, callback) => {
        vaultHandlers[name] = callback;
        return { scope: "vault", name };
      },
      getFileByPath: (filePath) => app._files.find((file) => file.path === filePath) || null,
      getAbstractFileByPath: (filePath) => app._files.find((file) => file.path === filePath) || null,
      readBinary: async (file) => Buffer.from(file.path),
      cachedRead: async () => "![[Images/a.png]]"
    },
    workspace: {
      activeWindow: {
        document: global.document,
        innerWidth: 1200,
        addEventListener() {},
        removeEventListener() {},
        requestAnimationFrame: (callback) => callback(),
        setTimeout: (...args) => global.setTimeout(...args),
        clearTimeout: (...args) => global.clearTimeout(...args)
      },
      onLayoutReady: (callback) => {
        if (layoutReady) {
          callback();
          return;
        }
        layoutReadyCallbacks.push(callback);
      },
      on: (name, callback) => {
        workspaceHandlers[name] = callback;
        return { scope: "workspace", name };
      },
      iterateAllLeaves() {},
      getActiveFile: () => null
    },
    setting,
    plugins: {
      enabledPlugins: new Set(),
      disablePlugin: async () => {},
      enablePlugin: async () => {}
    }
  };
  Object.defineProperty(app, "_resetGetFilesCalls", {
    value() {
      getFilesCalls = 0;
      app._getFilesCalls = 0;
    }
  });
  Object.defineProperty(app, "_triggerLayoutReady", {
    value() {
      layoutReady = true;
      for (const callback of layoutReadyCallbacks.splice(0)) {
        callback();
      }
    }
  });
  return app;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function installImageDataPolyfill() {
  if (typeof global.ImageData === "undefined") {
    global.ImageData = class ImageData {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
}

let fixtureCodecsPromise = null;
async function getFixtureCodecs() {
  if (!fixtureCodecsPromise) {
    fixtureCodecsPromise = (async () => {
      installImageDataPolyfill();
      const [jpegEncodeModule, pngEncodeModule] = await Promise.all([
        import("@jsquash/jpeg/encode.js"),
        import("@jsquash/png/encode.js")
      ]);
      const jpegEncodeWasm = new WebAssembly.Module(fs.readFileSync(path.join(root, "node_modules", "@jsquash", "jpeg", "codec", "enc", "mozjpeg_enc.wasm")));
      const pngWasm = fs.readFileSync(path.join(root, "node_modules", "@jsquash", "png", "codec", "pkg", "squoosh_png_bg.wasm"));
      await jpegEncodeModule.init(jpegEncodeWasm, { locateFile: (fileName) => fileName });
      await pngEncodeModule.init(pngWasm);
      return {
        jpegEncode: jpegEncodeModule.default,
        pngEncode: pngEncodeModule.default
      };
    })();
  }
  return fixtureCodecsPromise;
}

function createPatternImageData(width, height, mode = "gradient") {
  installImageDataPolyfill();
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (mode === "blocks") {
        const band = Math.floor(y / 12) % 2;
        const cell = Math.floor(x / 12) % 8;
        data[offset] = band ? 230 : 35;
        data[offset + 1] = cell * 28;
        data[offset + 2] = band ? 80 : 210;
      } else {
        data[offset] = (x * 3 + y) & 255;
        data[offset + 1] = (y * 5 + x) & 255;
        data[offset + 2] = (x * 7 + y * 11) & 255;
      }
      data[offset + 3] = 255;
    }
  }
  return new global.ImageData(data, width, height);
}

async function runImagequantHeapStress() {
  const imagequantBindings = await import("imagequant/imagequant_bg.js");
  const wasmBytes = fs.readFileSync(path.join(root, "node_modules", "imagequant", "imagequant_bg.wasm"));
  const imagequantWasmInstance = await WebAssembly.instantiate(wasmBytes, {
    "./imagequant_bg.js": imagequantBindings
  });
  const imagequantExports = imagequantWasmInstance.instance?.exports || imagequantWasmInstance.exports;
  for (const exportName of [
    "__wbg_imagequant_free",
    "__wbg_imagequantimage_free",
    "__wbindgen_add_to_stack_pointer",
    "__wbindgen_free",
    "__wbindgen_malloc",
    "imagequant_new",
    "imagequant_new_image",
    "imagequant_process",
    "imagequant_set_quality",
    "imagequant_set_speed",
    "imagequantimage_new"
  ]) {
    assert(typeof imagequantExports[exportName] === "function", `Imagequant WASM fixture is missing required export: ${exportName}`);
  }
  assert(imagequantExports.memory instanceof WebAssembly.Memory, "Imagequant WASM fixture is missing a memory export");
  imagequantBindings.__wbg_set_wasm(imagequantExports);
  assert(imagequantExports.memory?.buffer, "Imagequant heap stress could not inspect WASM memory");

  const width = 128;
  const height = 128;
  const imageBytes = width * height * 4;
  const warmupIterations = 20;
  const totalIterations = 200;
  const rgba = new Uint8Array(imageBytes);
  for (let i = 0; i < imageBytes; i += 4) {
    const pixel = i / 4;
    rgba[i] = pixel & 255;
    rgba[i + 1] = (pixel >> 8) & 255;
    rgba[i + 2] = (pixel * 17) & 255;
    rgba[i + 3] = 255;
  }

  let memoryAfterWarmup = 0;
  let peakMemoryAfterWarmup = 0;
	  for (let iteration = 0; iteration < totalIterations; iteration++) {
	    const quantizer = new imagequantBindings.Imagequant();
	    try {
	      quantizer.set_quality(45, 70);
	      quantizer.set_speed(6);
	      const image = new imagequantBindings.ImagequantImage(new Uint8Array(rgba), width, height, 0);
	      const output = quantizer.process(image);
	      assert(output.byteLength > 0, "Imagequant heap stress produced empty output");
	    } finally {
	      try {
        quantizer.free();
      } catch (_) {
      }
    }

    const memoryBytes = imagequantExports.memory.buffer.byteLength;
    if (iteration === warmupIterations - 1) {
      memoryAfterWarmup = memoryBytes;
      peakMemoryAfterWarmup = memoryBytes;
    } else if (iteration >= warmupIterations) {
      peakMemoryAfterWarmup = Math.max(peakMemoryAfterWarmup, memoryBytes);
    }
  }

  const growthAfterWarmup = peakMemoryAfterWarmup - memoryAfterWarmup;
  const allowedGrowth = Math.max(imageBytes * 8, 2 * 1024 * 1024);
  assert(
    growthAfterWarmup <= allowedGrowth,
    `Imagequant WASM heap grew after warmup: ${growthAfterWarmup} bytes > ${allowedGrowth} bytes`
  );
}

function writeVaultBinary(app, basePath, filePath, bytes, mtime = Date.now()) {
  const fullPath = path.join(basePath, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, Buffer.from(bytes));
  const file = createMockFile(filePath, Buffer.from(bytes).byteLength, mtime);
  file.vault = app.vault;
  return file;
}

function prepareVerifiedMoveRecord(record, originalPath = record.originalPath, vaultBasePath = null) {
  if (!originalPath || !vaultBasePath) {
    throw new Error(`Move smoke record has no original path: ${record.name}`);
  }
  const toNativePath = (filePath) => path.isAbsolute(filePath)
    ? filePath
    : path.join(vaultBasePath, ...String(filePath).split("/").filter(Boolean));
  const toVaultPath = (filePath) => {
    const relativePath = path.relative(vaultBasePath, filePath).replace(/\\/g, "/");
    if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
      throw new Error(`Move smoke path is outside the fixture vault: ${filePath}`);
    }
    return relativePath;
  };
  const originalNativePath = toNativePath(originalPath);
  const compressedNativePath = toNativePath(record.compressedPath);
  const backupPath = `${originalNativePath}.verified-backup-${crypto.randomBytes(8).toString("hex")}`;
  fs.copyFileSync(originalNativePath, backupPath);
  const originalStats = fs.statSync(originalNativePath);
  record.originalPath = toVaultPath(originalNativePath);
  record.originalBackupPath = toVaultPath(backupPath);
  record.compressedPath = toVaultPath(compressedNativePath);
  record.originalSizeBeforeMove = originalStats.size;
  record.originalMtimeMsBeforeMove = originalStats.mtimeMs;
  record.originalSha256BeforeMove = crypto.createHash("sha256").update(fs.readFileSync(originalNativePath)).digest("hex");
  record.compressedSha256 = crypto.createHash("sha256").update(fs.readFileSync(compressedNativePath)).digest("hex");
  return record;
}

function pointMockVaultAtPath(app, basePath) {
  // Resolve through getBasePath() at call time so later basePath restores stay coherent.
  const resolveVaultPath = (vaultPath) => path.join(app.vault.adapter.getBasePath(), ...String(vaultPath || "").split("/").filter(Boolean));
  app.vault.adapter.basePath = basePath;
  app.vault.adapter.path.absolute = basePath;
  app.vault.adapter.exists = async (vaultPath) => fs.existsSync(resolveVaultPath(vaultPath));
  app.vault.adapter.mkdir = async (vaultPath) => {
    fs.mkdirSync(resolveVaultPath(vaultPath), { recursive: true });
  };
  app.vault.adapter.writeBinary = async (vaultPath, data) => {
    const fullPath = resolveVaultPath(vaultPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(data));
  };
  app.vault.adapter.rename = async (oldPath, newPath) => {
    const oldFullPath = resolveVaultPath(oldPath);
    const newFullPath = resolveVaultPath(newPath);
    fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
    fs.renameSync(oldFullPath, newFullPath);
  };
  app.vault.adapter.remove = async (vaultPath) => {
    fs.rmSync(resolveVaultPath(vaultPath), { recursive: true, force: true });
  };
  app.vault.readBinary = async (file) => toArrayBuffer(fs.readFileSync(resolveVaultPath(file.path)));
}

function createMockWorkerFactory(scenarios, createdWorkers = []) {
  return () => {
    const scenario = scenarios.shift() || {};
    const schedule = (callback, delay = 0) => setTimeout(callback, delay);
    const worker = {
      onmessage: null,
      onerror: null,
      terminated: false,
      messages: [],
      transfers: [],
      terminateCalls: 0,
      postMessage(message, transfer) {
        this.messages.push(message);
        this.transfers.push(transfer || []);
        if (typeof scenario.onPostMessage === "function") {
          scenario.onPostMessage(message, this, transfer || []);
        }
        if (message.type === "init") {
          if (scenario.noInitResponse) {
            return;
          }
          const initMessage = scenario.initError
            ? { id: message.id, type: "init-failed", error: { message: scenario.initError } }
            : { id: message.id, type: "ready" };
          schedule(() => this.onmessage?.({ data: initMessage }), scenario.initDelayMs || 0);
          return;
        }
        if (message.type === "compress") {
          if (scenario.throwOnCompressPost) {
            throw new Error(scenario.throwOnCompressPost);
          }
          if (scenario.noCompressResponse) {
            return;
          }
          if (scenario.crashOnCompress) {
            schedule(() => this.onerror?.({ message: scenario.crashOnCompress }), scenario.crashDelayMs || 0);
            return;
          }
          const response = (scenario.compressResponses || []).shift() || {};
          if (response.error) {
            schedule(() => this.onmessage?.({
              data: {
                id: message.id,
                type: "result",
                ok: false,
                error: response.error
              }
            }), response.delayMs || scenario.compressDelayMs || 0);
            return;
          }
          const output = response.output || createValidEncodedOutput(message.format);
          schedule(() => this.onmessage?.({
            data: {
              id: message.id,
              type: "result",
              ok: true,
              output
            }
          }), response.delayMs || scenario.compressDelayMs || 0);
        }
      },
      terminate() {
        this.terminated = true;
        this.terminateCalls += 1;
        if (typeof scenario.onTerminate === "function") {
          scenario.onTerminate(this);
        }
      }
    };
    createdWorkers.push(worker);
    return worker;
  };
}

async function replaceCompressorWorkerPool(plugin, workerFactory, size) {
  await plugin.compressor.workerPool.drainInFlight();
  plugin.compressor.workerPool.destroy(new Error("Compressor worker pool was replaced by the smoke harness"));
  plugin.compressor.workerFactory = workerFactory;
  plugin.compressor.activeWorkerCount = size;
  plugin.compressor.workerPool = plugin.compressor.createWorkerPool(size);
}

async function resetCompressorWorker(plugin, workerFactory) {
  await replaceCompressorWorkerPool(plugin, workerFactory, 1);
  await plugin.compressor.ensureWasmReady();
}

async function resetCompressorPool(plugin, workerFactory, size) {
  await replaceCompressorWorkerPool(plugin, workerFactory, size);
  await plugin.compressor.ensureWasmReady();
}

function getCompressorSlots(plugin) {
  return plugin.compressor.workerPool?.slots || [];
}

async function waitForReadySlots(plugin, expectedReady, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const readyCount = getCompressorSlots(plugin).filter((slot) => slot.isReady()).length;
    if (readyCount >= expectedReady) {
      return readyCount;
    }
    await new Promise((resolve) => originalGlobals.setTimeout(resolve, 10));
  }
  return getCompressorSlots(plugin).filter((slot) => slot.isReady()).length;
}

async function withRealGlobalTimers(task) {
  const mockedSetTimeout = global.setTimeout;
  const mockedClearTimeout = global.clearTimeout;
  try {
    global.setTimeout = originalGlobals.setTimeout;
    global.clearTimeout = originalGlobals.clearTimeout;
    return await task();
  } finally {
    global.setTimeout = mockedSetTimeout;
    global.clearTimeout = mockedClearTimeout;
  }
}

async function setMockFiles(plugin, files) {
  plugin.app._files = files;
  if (typeof plugin.rebuildImageIndex === "function") {
    await withRealGlobalTimers(() => plugin.rebuildImageIndex("smoke"));
  }
}

async function setCacheEntries(plugin, entries) {
  const normalized = plugin.cache.normalizeCacheData({
    version: "1.0.0",
    entries
  }).data;
  plugin.cache.migrateLegacyProcessedEntries(normalized);
  plugin.cache.cacheData.entries = normalized.entries;
  if (typeof plugin.rebuildImageIndex === "function") {
    await withRealGlobalTimers(() => plugin.rebuildImageIndex("smoke-cache"));
  }
}

const originalGlobals = {
  document: global.document,
  window: global.window,
  requestAnimationFrame: global.requestAnimationFrame,
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout
};
let smokeBackupStorageTemp = null;
const cleanupSmokeBackupStorageTemp = () => {
  const tempPath = smokeBackupStorageTemp;
  smokeBackupStorageTemp = null;
  if (tempPath) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
};
process.once("exit", cleanupSmokeBackupStorageTemp);

withTestTimeout("full TypeScript artifact smoke", (async () => {
try {
  await runImagequantHeapStress();

  global.document = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return createMockElement();
    }
  };
  const mockLocalStorage = new Map();
  mockLocalStorage.set("local-image-compress:desktop-device-owner-v1", "d".repeat(32));
  global.window = {
    document: global.document,
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (...args) => global.setTimeout(...args),
    clearTimeout: (...args) => global.clearTimeout(...args),
    // Shared code reads window.crypto (Web Crypto) instead of Node crypto.
    crypto: crypto.webcrypto,
    localStorage: {
      getItem: (key) => mockLocalStorage.get(key) ?? null,
      setItem: (key, value) => mockLocalStorage.set(key, String(value)),
      removeItem: (key) => mockLocalStorage.delete(key)
    }
  };
  global.requestAnimationFrame = (callback) => callback();
  global.setTimeout = (callback, delay) => ({ callback, delay });
  global.clearTimeout = () => {};

  const mod = require(artifact);
  const PluginClass = mod && (mod.default || mod);
  assert(typeof PluginClass === "function", "TypeScript artifact does not expose a default plugin class");
  const loadFreshPluginClass = () => {
    const artifactPath = require.resolve(artifact);
    const cachedArtifact = require.cache[artifactPath];
    delete require.cache[artifactPath];
    try {
      const freshModule = require(artifact);
      return freshModule?.default || freshModule;
    } finally {
      delete require.cache[artifactPath];
      if (cachedArtifact) {
        require.cache[artifactPath] = cachedArtifact;
      }
    }
  };
  assert(
    typeof PluginClass.prototype.setupThemeAdaptation === "undefined",
    "TypeScript plugin class still exposes dead setupThemeAdaptation()"
  );

  {
    const failedInitPlugin = new PluginClass();
    failedInitPlugin.app = createMockApp();
    failedInitPlugin.manifest = {
      id: "local-image-compress",
      name: "Local Image Compress",
      dir: root
    };
    const InitFailureObsidianMock = require("obsidian");
    const originalNoticeForInitFailure = InitFailureObsidianMock.Notice;
    const originalConsoleErrorForInitFailure = console.error;
    const initFailureNotices = [];
    try {
      InitFailureObsidianMock.Notice = class {
        constructor(message, duration) {
          initFailureNotices.push({ message, duration });
        }
      };
      console.error = () => {};
      failedInitPlugin.initializePlugin = async () => {
        throw new Error("settings corrupt");
      };
      failedInitPlugin.onload();
      assert(failedInitPlugin.initializationPromise === null, "Plugin started initialization before layout readiness");
      failedInitPlugin.app._triggerLayoutReady();
      await failedInitPlugin.initializationPromise;
      assert(failedInitPlugin.isInitialized === false, "Plugin marked failed startup as initialized");
      assert(failedInitPlugin.isUnloading === true, "Plugin did not fence operations after failed startup");
      assert(failedInitPlugin.initializationError instanceof Error, "Plugin did not retain the startup failure");
      assert(failedInitPlugin.commands.length === 0, "Plugin registered commands after initialization failed");
      assert(failedInitPlugin.settingTabs.length === 0, "Plugin registered settings tab after initialization failed");
      assert(failedInitPlugin.events.length === 0, "Plugin registered events before initialization succeeded");
      assert(!failedInitPlugin.statusBarItem || failedInitPlugin.statusBarItem.visible === false, "Plugin left a partial status bar visible after startup failure");
      assert(initFailureNotices.some((notice) => String(notice.message).includes("initialization failed") && notice.duration === 10000), "Plugin did not show a user-visible startup failure notice");
      failedInitPlugin.onunload();
    } finally {
      InitFailureObsidianMock.Notice = originalNoticeForInitFailure;
      console.error = originalConsoleErrorForInitFailure;
    }
  }

  const plugin = new PluginClass();
  plugin.app = createMockApp();
  plugin.manifest = {
    id: "local-image-compress",
    name: "Local Image Compress",
    dir: root
  };

  plugin.onload();
  assert(plugin.initializationPromise === null, "Plugin started initialization before layout readiness");
  assert(plugin.commands.length === 0 && plugin.settingTabs.length === 0 && plugin.events.length === 0, "Plugin registered runtime resources before layout readiness");
  assert(plugin.app._getFilesCalls === 0, "Plugin scanned vault files before layout readiness");
  const preLayoutCreateFile = Object.assign(new (require("obsidian").TFile)(), createMockFile("Images/startup-create.png", 100000, 1));
  await plugin.handleVaultCreate(preLayoutCreateFile);
  assert(plugin.app._getFilesCalls === 0, "Vault create handling processed startup enumeration before initialization");
  plugin.app._triggerLayoutReady();
  await plugin.initializationPromise;
  assert(!path.isAbsolute(plugin.cache.cacheFile), `Cache constructor stored a native path: ${plugin.cache.cacheFile}`);
  assert.deepEqual(plugin.getBackupStoragePaths(), {
    root: ".local-image-compress",
    backupsRoot: ".local-image-compress/backups",
    cacheBackups: ".local-image-compress/backups/cache",
    originalFilesBackups: ".local-image-compress/backups/originals"
  }, "Shared backup storage paths are not vault-relative");
  smokeBackupStorageTemp = fs.mkdtempSync(path.join(root, ".local-image-compress-smoke-backup-storage-"));
  assert(process.listeners("exit").includes(cleanupSmokeBackupStorageTemp), "Smoke backup fixture lacks process-exit cleanup");
  plugin.cache.cacheBackupsDir = `${path.basename(smokeBackupStorageTemp)}/cache`;
  assert(plugin.app.setting.openTabByIdCalls === 0, "Plugin force-opened its settings tab during onload");
  assert(plugin.isInitialized === true, "Plugin did not finish initialization before startup image indexing");
  assert(plugin.commands.length === 4 && plugin.settingTabs.length === 1, "Plugin did not register commands/settings before startup image indexing completed");
  assert(plugin.imageIndex?.isReady?.() === false, "Startup image index rebuild still completed synchronously during onload");
  assert(plugin.app._getFilesCalls === 0, "Plugin onload still scanned vault files before the startup image index timer fired");
  const startupImageIndexTimer = plugin.indexRefreshTimers.get("startup-image-index");
  assert(startupImageIndexTimer && startupImageIndexTimer.delay === 0, "Startup image index rebuild was not scheduled as a deferred timer");
  const mockedSetTimeoutDuringStartupIndex = global.setTimeout;
  const mockedClearTimeoutDuringStartupIndex = global.clearTimeout;
  try {
    global.setTimeout = originalGlobals.setTimeout;
    global.clearTimeout = originalGlobals.clearTimeout;
    await startupImageIndexTimer.callback();
  } finally {
    global.setTimeout = mockedSetTimeoutDuringStartupIndex;
    global.clearTimeout = mockedClearTimeoutDuringStartupIndex;
  }
  assert(plugin.imageIndex?.isReady?.() === true, "Deferred startup image index rebuild did not make the index ready");
  assert(plugin.app._getFilesCalls > 0, "Deferred startup image index rebuild did not scan vault files after onload");
  const localeTitleExpectations = {};
  for (const fileName of fs.readdirSync(path.join(sourceTsRoot, "locales")).filter((fileName) => fileName.endsWith(".json"))) {
    localeTitleExpectations[path.basename(fileName, ".json")] = JSON.parse(fs.readFileSync(path.join(sourceTsRoot, "locales", fileName), "utf8"))["settings.title"];
  }
  for (const [locale, expectedTitle] of Object.entries(localeTitleExpectations)) {
    mockObsidianLanguage = locale;
    assert(plugin.moveService.getMoveText("settings.title") === expectedTitle, `Module-level Obsidian language detection did not select ${locale}`);
  }
  for (const [localeAlias, canonicalLocale] of [["pt_BR", "pt-br"], ["zh", "zh-cn"], ["zh_Hant", "zh-tw"], ["be", "ru"], ["ua", "uk"]]) {
    mockObsidianLanguage = localeAlias;
    assert(plugin.moveService.getMoveText("settings.title") === localeTitleExpectations[canonicalLocale], `Language alias ${localeAlias} did not select ${canonicalLocale}`);
  }
  mockObsidianLanguage = "en";

  const originalBasePathForPathSmoke = plugin.app.vault.adapter.basePath;
  const originalAbsolutePathForPathSmoke = plugin.app.vault.adapter.path.absolute;
  try {
    plugin.app.vault.adapter.basePath = "C:\\Users\\Tiny\\Vault";
    plugin.app.vault.adapter.path.absolute = "C:\\Users\\Tiny\\Vault";
    assert(plugin.cache.normalizeVaultPath("\\\\?\\C:\\Users\\Tiny\\Vault\\Images\\long.png") === "", "Shared cache path normalization accepted a native Windows path");
    assert(plugin.getPlatformPorts().fs.toVaultRelativePath("\\\\?\\C:\\Users\\Tiny\\Vault\\Images\\long.png") === "Images/long.png", "Explicit desktop path ingress did not strip the Windows long-path drive prefix");
    plugin.app.vault.adapter.basePath = "\\\\server\\share\\Vault";
    plugin.app.vault.adapter.path.absolute = "\\\\server\\share\\Vault";
    assert(plugin.cache.normalizeVaultPath("\\\\?\\UNC\\server\\share\\Vault\\Images\\unc.png") === "", "Shared cache path normalization accepted a native UNC path");
    assert(plugin.getPlatformPorts().fs.toVaultRelativePath("\\\\?\\UNC\\server\\share\\Vault\\Images\\unc.png") === "Images/unc.png", "Explicit desktop path ingress did not strip the Windows long-path UNC prefix");
    assert(plugin.cache.normalizeVaultPath("Images/relative.png") === "Images/relative.png", "Relative vault path normalization changed its path domain");
  } finally {
    plugin.app.vault.adapter.basePath = originalBasePathForPathSmoke;
    plugin.app.vault.adapter.path.absolute = originalAbsolutePathForPathSmoke;
  }

  const originalGetBasePathForPolicySmoke = plugin.app.vault.adapter.getBasePath;
  try {
    plugin.app.vault.adapter.getBasePath = undefined;
    assert(plugin.cache.normalizeVaultPath("C:\\Users\\Tiny\\Vault\\Images\\missing-base.png") === "", "Shared cache normalization accepted a native path without an explicit ingress conversion");
    let missingBasePathRejected = false;
    try {
      plugin.getPlatformPorts().fs.toVaultRelativePath("C:\\Users\\Tiny\\Vault\\Images\\missing-base.png");
    } catch (error) {
      missingBasePathRejected = String(error?.message || error).includes("refusing filesystem access outside the vault");
    }
    assert(missingBasePathRejected, "Missing vault getBasePath() did not fail closed");
  } finally {
    plugin.app.vault.adapter.getBasePath = originalGetBasePathForPolicySmoke;
  }

  const outsideCachePath = path.resolve(root, "..", "outside-cache-output.png");
  for (const invalidPortPath of [path.join(root, "Images", "absolute-inside-vault.png"), outsideCachePath, "../outside-cache-output.png"]) {
    await assert.rejects(
      () => plugin.getPlatformPorts().fs.readText(invalidPortPath),
      /requires a vault-relative path/,
      `Desktop FsPort accepted a non-vault-relative path: ${invalidPortPath}`
    );
    await assert.rejects(
      () => plugin.getPlatformPorts().fs.exists(invalidPortPath),
      /requires a vault-relative path/,
      `Desktop FsPort.exists hid a non-vault-relative path: ${invalidPortPath}`
    );
  }
  assert(plugin.cache.normalizeVaultPath(outsideCachePath) === "", "Outside-vault absolute cache path was normalized into the vault");
  assert(plugin.cache.normalizeVaultPath("../outside-cache-output.png") === "", "Traversal cache path was accepted");
  const originalStatForOutsideCache = fs.promises.stat;
  let outsideCacheStatCalls = 0;
  try {
    fs.promises.stat = async (...args) => {
      outsideCacheStatCalls += 1;
      return await originalStatForOutsideCache.apply(fs.promises, args);
    };
    assert(await plugin.cache.getOutputMetadata(outsideCachePath) === null, "Outside-vault cache metadata path returned filesystem metadata");
  } finally {
    fs.promises.stat = originalStatForOutsideCache;
  }
  assert(outsideCacheStatCalls === 0, "Outside-vault cache metadata path reached fs.stat");

  const desktopReplacementRecoveryTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-desktop-replacement-recovery-"));
  try {
    plugin.app.vault.adapter.basePath = desktopReplacementRecoveryTemp;
    plugin.app.vault.adapter.path.absolute = desktopReplacementRecoveryTemp;
    const recoveryDirectory = path.join(desktopReplacementRecoveryTemp, ".local-image-compress", "recovery");
    const ownerId = "d".repeat(32);
    const oldBytes = Buffer.from("complete-old-payload");
    const newBytes = Buffer.from("complete-new-payload");
    const advancedTargetBytes = Buffer.from("newer-third-party-payload");
    const oldSha256 = crypto.createHash("sha256").update(oldBytes).digest("hex");
    const newSha256 = crypto.createHash("sha256").update(newBytes).digest("hex");
    const toDesktopReplacementRelative = (filePath) => path.relative(desktopReplacementRecoveryTemp, filePath).replaceAll("\\", "/");
    const writeDesktopReplacementFixture = (name, transactionId, phase, options = {}) => {
      const targetPath = path.join(desktopReplacementRecoveryTemp, "Replacement", `${name}.bin`);
      const stagedPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tinylocal-1700000000000-${transactionId}.tmp`);
      const rollbackPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tinylocal-rollback-1700000000000-${transactionId}.tmp`);
      const rollbackBytes = options.rollbackBytes || oldBytes;
      const rollbackReferenced = options.rollbackReferenced !== false;
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (phase === "prepared") {
        fs.writeFileSync(targetPath, oldBytes);
        fs.writeFileSync(stagedPath, newBytes);
      } else if (phase === "detached") {
        if (options.stagedPresent !== false) {
          fs.writeFileSync(stagedPath, newBytes);
        }
        if (rollbackReferenced) {
          fs.writeFileSync(rollbackPath, rollbackBytes);
        }
      } else {
        fs.writeFileSync(targetPath, newBytes);
        if (rollbackReferenced) {
          fs.writeFileSync(rollbackPath, rollbackBytes);
        }
      }
      const payload = {
        version: 1,
        ownerId,
        transactionId,
        stagedPath: toDesktopReplacementRelative(stagedPath),
        targetPath: toDesktopReplacementRelative(targetPath),
        rollbackPath: rollbackReferenced ? toDesktopReplacementRelative(rollbackPath) : null,
        stagedSha256: newSha256,
        expectedTargetSha256: options.expectedTargetAbsent === true ? null : oldSha256,
        rollbackSha256: phase === "prepared" || !rollbackReferenced ? null : crypto.createHash("sha256").update(rollbackBytes).digest("hex"),
        phase
      };
      const journal = {
        ...payload,
        checksum: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      };
      fs.mkdirSync(recoveryDirectory, { recursive: true });
      const journalPath = path.join(recoveryDirectory, `desktop-replacement-journal-v1-${ownerId}-${transactionId}.json`);
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      return { targetPath, stagedPath, rollbackPath, journalPath };
    };
    const preparedFixture = writeDesktopReplacementFixture("prepared", "1".repeat(32), "prepared");
    const detachedFixture = writeDesktopReplacementFixture("detached", "2".repeat(32), "detached");
    const installedFixture = writeDesktopReplacementFixture("installed", "3".repeat(32), "installed");
    const capturedConcurrentBytes = Buffer.from("captured-concurrent-payload");
    const capturedConcurrentFixture = writeDesktopReplacementFixture("captured-concurrent", "4".repeat(32), "detached", {
      rollbackBytes: capturedConcurrentBytes,
      stagedPresent: false
    });
    const advancedTargetFixture = writeDesktopReplacementFixture("advanced-target", "5".repeat(32), "detached", {
      stagedPresent: false
    });
    fs.writeFileSync(advancedTargetFixture.targetPath, advancedTargetBytes);
    const restoredExpectedFixture = writeDesktopReplacementFixture("restored-expected", "6".repeat(32), "detached", {
      stagedPresent: false
    });
    fs.writeFileSync(restoredExpectedFixture.targetPath, oldBytes);
    const concurrentCreateBytes = Buffer.from("concurrent-create-winner");
    const concurrentCreateFixture = writeDesktopReplacementFixture("concurrent-create", "7".repeat(32), "detached", {
      expectedTargetAbsent: true,
      rollbackReferenced: false
    });
    fs.writeFileSync(concurrentCreateFixture.targetPath, concurrentCreateBytes);
    const preparedAfterDetachFixture = writeDesktopReplacementFixture("prepared-after-detach", "b".repeat(32), "prepared");
    fs.renameSync(preparedAfterDetachFixture.targetPath, preparedAfterDetachFixture.rollbackPath);
    const foreignStagedBytes = Buffer.from("foreign-staged-payload");
    const foreignRollbackBytes = Buffer.from("foreign-rollback-payload");
    const installedForeignSidesFixture = writeDesktopReplacementFixture("installed-foreign-sides", "c".repeat(32), "installed");
    fs.writeFileSync(installedForeignSidesFixture.stagedPath, foreignStagedBytes);
    fs.writeFileSync(installedForeignSidesFixture.rollbackPath, foreignRollbackBytes);
    const desktopRecoveryFs = plugin.getPlatformPorts().fs;
    const originalDesktopUnlinkForStaleJournal = fs.promises.unlink;
    let staleJournalCleanupFailures = 0;
    fs.promises.unlink = async (filePath) => {
      if (path.basename(String(filePath)).startsWith(`${path.basename(advancedTargetFixture.journalPath)}.delete-`)) {
        staleJournalCleanupFailures += 1;
        throw new Error("Injected stale desktop journal cleanup failure");
      }
      await originalDesktopUnlinkForStaleJournal(filePath);
    };
    try {
      await desktopRecoveryFs.recoverInterruptedReplacement();
    } finally {
      fs.promises.unlink = originalDesktopUnlinkForStaleJournal;
    }
    assert(fs.readFileSync(preparedFixture.targetPath).equals(oldBytes), "Prepared desktop replacement recovery did not preserve the complete old payload");
    assert(fs.readFileSync(detachedFixture.targetPath).equals(oldBytes), "Detached desktop replacement recovery did not restore the complete old payload");
    assert(fs.readFileSync(installedFixture.targetPath).equals(newBytes), "Installed desktop replacement recovery did not preserve the complete new payload");
    assert(fs.readFileSync(capturedConcurrentFixture.targetPath).equals(capturedConcurrentBytes), "Desktop recovery did not restore the exact concurrently captured rollback when the target and staged file were absent");
    assert(!fs.existsSync(preparedFixture.stagedPath) && !fs.existsSync(preparedFixture.journalPath), "Prepared desktop recovery retained consumed transaction metadata");
    for (const fixture of [detachedFixture, installedFixture]) {
      assert(!fs.existsSync(fixture.stagedPath) && !fs.existsSync(fixture.journalPath), "Desktop replacement recovery retained consumed staged or journal metadata");
      assert(fs.existsSync(fixture.rollbackPath) && fs.readFileSync(fixture.rollbackPath).equals(oldBytes), "Desktop replacement recovery did not retain its exact old-revision safety copy");
    }
    assert(!fs.existsSync(capturedConcurrentFixture.stagedPath) && !fs.existsSync(capturedConcurrentFixture.journalPath), "Desktop captured-concurrent recovery retained consumed staged or journal metadata");
    assert(fs.existsSync(capturedConcurrentFixture.rollbackPath) && fs.readFileSync(capturedConcurrentFixture.rollbackPath).equals(capturedConcurrentBytes), "Desktop captured-concurrent recovery did not retain its exact rollback safety copy");
    assert(fs.readFileSync(advancedTargetFixture.targetPath).equals(advancedTargetBytes), "Desktop stale-journal recovery overwrote the newer target");
    assert(fs.existsSync(advancedTargetFixture.rollbackPath) && fs.readFileSync(advancedTargetFixture.rollbackPath).equals(oldBytes), "Desktop stale-journal recovery discarded the exact rollback safety copy");
    assert(!fs.existsSync(advancedTargetFixture.journalPath), "Desktop stale journal remained in the active recovery namespace");
    assert(fs.readFileSync(restoredExpectedFixture.targetPath).equals(oldBytes), "Desktop terminal recovery changed an already restored expected target");
    assert(fs.existsSync(restoredExpectedFixture.rollbackPath) && fs.readFileSync(restoredExpectedFixture.rollbackPath).equals(oldBytes), "Desktop terminal recovery discarded the restored target's exact rollback safety copy");
    assert(!fs.existsSync(restoredExpectedFixture.journalPath), "Desktop restored-target journal remained in the active recovery namespace");
    assert(fs.readFileSync(concurrentCreateFixture.targetPath).equals(concurrentCreateBytes), "Desktop create-race recovery overwrote the concurrent target");
    assert(fs.existsSync(concurrentCreateFixture.stagedPath) && fs.readFileSync(concurrentCreateFixture.stagedPath).equals(newBytes), "Desktop create-race recovery discarded its staged safety evidence");
    assert(!fs.existsSync(concurrentCreateFixture.journalPath), "Desktop create-race journal remained in the active recovery namespace");
    assert(fs.readFileSync(preparedAfterDetachFixture.targetPath).equals(oldBytes), "Prepared-after-detach desktop recovery left the canonical target missing");
    assert(!fs.existsSync(preparedAfterDetachFixture.stagedPath) && !fs.existsSync(preparedAfterDetachFixture.journalPath), "Prepared-after-detach desktop recovery retained owned active metadata");
    assert(fs.readFileSync(preparedAfterDetachFixture.rollbackPath).equals(oldBytes), "Prepared-after-detach desktop recovery lost the exact rollback safety copy");
    assert(fs.readFileSync(installedForeignSidesFixture.targetPath).equals(newBytes), "Installed desktop terminal recovery changed the verified target");
    assert(fs.readFileSync(installedForeignSidesFixture.stagedPath).equals(foreignStagedBytes) && fs.readFileSync(installedForeignSidesFixture.rollbackPath).equals(foreignRollbackBytes), "Installed desktop terminal recovery mutated foreign side artifacts");
    assert(!fs.existsSync(installedForeignSidesFixture.journalPath), "Installed desktop terminal recovery retained its active journal");
    const countDetachedStaleDesktopJournals = () => fs.readdirSync(recoveryDirectory)
      .filter((fileName) => fileName.startsWith(`${path.basename(advancedTargetFixture.journalPath)}.delete-`)).length;
    assert(staleJournalCleanupFailures === 1 && countDetachedStaleDesktopJournals() === 1, "Desktop stale-journal cleanup failure did not retain exactly one detached terminal journal");
    await desktopRecoveryFs.recoverInterruptedReplacement();
    await desktopRecoveryFs.recoverInterruptedReplacement();
    assert(countDetachedStaleDesktopJournals() === 1, "Repeated desktop recovery amplified a detached stale journal");
    assert(fs.readFileSync(installedForeignSidesFixture.stagedPath).equals(foreignStagedBytes) && fs.readFileSync(installedForeignSidesFixture.rollbackPath).equals(foreignRollbackBytes), "Repeated desktop recovery mutated foreign side artifacts");

    const replaceRecoveredDesktopTarget = async (label, fixture, currentBytes, nextBytes, transactionId, existingStagePath = null) => {
      const stagedPath = existingStagePath || path.join(
        path.dirname(fixture.targetPath),
        `.${path.basename(fixture.targetPath)}.tinylocal-1800000000000-${transactionId}.tmp`
      );
      if (!fs.existsSync(stagedPath)) {
        fs.writeFileSync(stagedPath, nextBytes);
      }
      await desktopRecoveryFs.replaceFile(
        toDesktopReplacementRelative(stagedPath),
        toDesktopReplacementRelative(fixture.targetPath),
        {
          expectedTargetSha256: crypto.createHash("sha256").update(currentBytes).digest("hex"),
          expectedStagedSha256: crypto.createHash("sha256").update(nextBytes).digest("hex")
        }
      );
      assert(fs.readFileSync(fixture.targetPath).equals(nextBytes), `${label} still blocked a later desktop replacement`);
    };
    const replacementAfterStaleJournalBytes = Buffer.from("replacement-after-stale-journal");
    await replaceRecoveredDesktopTarget("Stale third-party target", advancedTargetFixture, advancedTargetBytes, replacementAfterStaleJournalBytes, "8".repeat(32));
    await replaceRecoveredDesktopTarget("Restored expected target", restoredExpectedFixture, oldBytes, Buffer.from("replacement-after-restored-target"), "9".repeat(32));
    await replaceRecoveredDesktopTarget("Concurrent create winner", concurrentCreateFixture, concurrentCreateBytes, newBytes, "a".repeat(32), concurrentCreateFixture.stagedPath);
    await replaceRecoveredDesktopTarget("Prepared-after-detach target", preparedAfterDetachFixture, oldBytes, Buffer.from("after-prepared-detach"), "d".repeat(32));
    await replaceRecoveredDesktopTarget("Installed target with foreign sides", installedForeignSidesFixture, newBytes, Buffer.from("after-installed-foreign-sides"), "e".repeat(32));
    assert(fs.existsSync(advancedTargetFixture.rollbackPath) && fs.readFileSync(advancedTargetFixture.rollbackPath).equals(oldBytes), "Later desktop replacement removed the retained old safety copy");
    assert(fs.existsSync(restoredExpectedFixture.rollbackPath) && fs.readFileSync(restoredExpectedFixture.rollbackPath).equals(oldBytes), "Later desktop replacement removed the restored target's retained safety copy");
    assert(fs.readFileSync(installedForeignSidesFixture.stagedPath).equals(foreignStagedBytes) && fs.readFileSync(installedForeignSidesFixture.rollbackPath).equals(foreignRollbackBytes), "Later desktop replacement removed foreign side artifacts retained by terminal recovery");
  } finally {
    plugin.app.vault.adapter.basePath = originalBasePathForPathSmoke;
    plugin.app.vault.adapter.path.absolute = originalAbsolutePathForPathSmoke;
    fs.rmSync(desktopReplacementRecoveryTemp, { recursive: true, force: true });
  }

  const legacyMigrationTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-legacy-migration-"));
  const originalConsoleDebugForMigration = console.debug;
  try {
    plugin.app.vault.adapter.basePath = legacyMigrationTemp;
    plugin.app.vault.adapter.path.absolute = legacyMigrationTemp;
    const oldPluginDir = path.join(legacyMigrationTemp, ".obsidian", "plugins", "tiny-local");
    const newPluginDir = path.join(legacyMigrationTemp, ".obsidian", "plugins", "local-image-compress");
    const cacheBackupsDir = path.join(legacyMigrationTemp, ".local-image-compress", "backups", "cache");
    const originalFilesBackupsDir = path.join(legacyMigrationTemp, ".local-image-compress", "backups", "originals");
    fs.mkdirSync(path.join(oldPluginDir, "cache-backups", "nested"), { recursive: true });
    fs.mkdirSync(path.join(newPluginDir, "original-files-backups", "backup-current"), { recursive: true });
    fs.mkdirSync(cacheBackupsDir, { recursive: true });
    fs.writeFileSync(path.join(oldPluginDir, "tinyLocal-cache.json"), "{\"version\":\"legacy\"}");
    fs.writeFileSync(path.join(oldPluginDir, "cache-backups", "nested", "backup.json"), "{}");
    fs.writeFileSync(path.join(newPluginDir, "original-files-backups", "backup-current", "image.jpg"), "image");
    fs.writeFileSync(path.join(cacheBackupsDir, "existing.json"), "{}");
    console.debug = () => {};
    await plugin.migrateLegacyPluginData();
    assert(fs.existsSync(path.join(newPluginDir, "tinyLocal-cache.json")), "Legacy migration copy fallback did not create cache file in new plugin dir");
    assert(fs.existsSync(path.join(cacheBackupsDir, "nested", "backup.json")), "Legacy migration copy fallback did not move cache backups to vault-level storage");
    assert(fs.existsSync(path.join(cacheBackupsDir, "existing.json")), "Backup migration removed an existing destination file while merging");
    assert(fs.existsSync(path.join(originalFilesBackupsDir, "backup-current", "image.jpg")), "Current plugin image backups were not moved to vault-level storage");
    assert(!fs.existsSync(path.join(oldPluginDir, "tinyLocal-cache.json")), "Legacy migration copy fallback left duplicate cache file in old plugin dir");
    const findMigrationQuarantineDirectories = (directory) => {
      if (!fs.existsSync(directory)) return [];
      const found = [];
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (!entry.isDirectory()) continue;
        if (/^\.tinylocal-quarantine-\d+-[a-f0-9]{32}\.tmp$/i.test(entry.name)) {
          found.push(entryPath);
        } else {
          found.push(...findMigrationQuarantineDirectories(entryPath));
        }
      }
      return found;
    };
    const retainedMigrationQuarantines = [
      ...findMigrationQuarantineDirectories(oldPluginDir),
      ...findMigrationQuarantineDirectories(path.join(newPluginDir, "original-files-backups"))
    ];
    assert(retainedMigrationQuarantines.length >= 3, "Migration removed its transaction-owned safety copies");
    const migrationErrorsOnRetry = [];
    const originalConsoleErrorForMigrationRetry = console.error;
    try {
      console.error = (...args) => {
        if (String(args[1] || "").includes("Migration item error")) migrationErrorsOnRetry.push(args);
      };
      await plugin.migrateLegacyPluginData();
    } finally {
      console.error = originalConsoleErrorForMigrationRetry;
    }
    assert(migrationErrorsOnRetry.length === 0, "A repeated migration treated its retained recovery tree as user data or a partial failure");
    assert(
      findMigrationQuarantineDirectories(cacheBackupsDir).length === 0
        && findMigrationQuarantineDirectories(originalFilesBackupsDir).length === 0,
      "A repeated migration copied its own retained quarantine into destination storage"
    );

    const desktopMigrationSource = path.join(legacyMigrationTemp, "migration-race-source.bin");
    const desktopMigrationDest = path.join(legacyMigrationTemp, "migration-race-dest.bin");
    const desktopMigrationSourceRelative = "migration-race-source.bin";
    const desktopMigrationDestRelative = "migration-race-dest.bin";
    fs.writeFileSync(desktopMigrationSource, "desktop-same");
    fs.writeFileSync(desktopMigrationDest, "desktop-same");
    const desktopFsPort = plugin.getPlatformPorts().fs;
    const originalDesktopMoveFileToUniqueSibling = desktopFsPort.moveFileToUniqueSibling;
    let desktopMigrationQuarantine = null;
    desktopFsPort.moveFileToUniqueSibling = async (sourcePath, options) => {
      desktopMigrationQuarantine = await originalDesktopMoveFileToUniqueSibling.call(desktopFsPort, sourcePath, options);
      if (sourcePath === desktopMigrationSourceRelative) {
        fs.writeFileSync(desktopMigrationSource, "desktop-new-sync-version");
      }
      return desktopMigrationQuarantine;
    };
    try {
      await plugin.migrationRunner.mergeMigrationItem(desktopMigrationSourceRelative, desktopMigrationDestRelative);
    } finally {
      desktopFsPort.moveFileToUniqueSibling = originalDesktopMoveFileToUniqueSibling;
    }
    assert(fs.readFileSync(desktopMigrationSource, "utf8") === "desktop-new-sync-version", "Desktop migration deleted a source version written after quarantine");
    const desktopMigrationQuarantineAbsolute = desktopMigrationQuarantine && path.join(legacyMigrationTemp, ...desktopMigrationQuarantine.split("/"));
    assert(desktopMigrationQuarantineAbsolute && fs.readFileSync(desktopMigrationQuarantineAbsolute, "utf8") === "desktop-same", "Desktop migration did not retain the isolated old source revision");
    const desktopMigrationTransactionId = path.basename(path.dirname(desktopMigrationQuarantineAbsolute)).match(/[a-f0-9]{32}(?=\.tmp$)/i)?.[0];
    assert(desktopMigrationTransactionId && fs.existsSync(path.join(legacyMigrationTemp, ".local-image-compress", "recovery", `migration-quarantine-v1-${desktopMigrationTransactionId}.json`)), "Desktop migration did not retain the journal owning its safety copy");

    const migrationRecoveryDir = path.join(legacyMigrationTemp, ".local-image-compress", "recovery");
    const writeMigrationRecoveryJournal = (transactionId, sourcePath, destinationPath, quarantinePath, bytes) => {
      const payload = {
        version: 1,
        transactionId,
        sourcePath,
        destinationPath,
        quarantinePath,
        sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex")
      };
      const journal = {
        ...payload,
        checksum: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      };
      fs.mkdirSync(migrationRecoveryDir, { recursive: true });
      const journalPath = path.join(migrationRecoveryDir, `migration-quarantine-v1-${transactionId}.json`);
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      return journalPath;
    };

    const beforeRenameBytes = Buffer.from("journal-before-rename");
    const beforeRenameSource = path.join(legacyMigrationTemp, "Migration", "before-rename.bin");
    const beforeRenameDest = path.join(legacyMigrationTemp, "Migration", "before-rename-dest.bin");
    fs.mkdirSync(path.dirname(beforeRenameSource), { recursive: true });
    fs.writeFileSync(beforeRenameSource, beforeRenameBytes);
    const beforeRenameJournal = writeMigrationRecoveryJournal(
      "11111111111111111111111111111111",
      "Migration/before-rename.bin",
      "Migration/before-rename-dest.bin",
      "Migration/.tinylocal-quarantine-1700000000000-11111111111111111111111111111111.tmp/before-rename.bin",
      beforeRenameBytes
    );
    await plugin.migrationRunner.recoverMigrationQuarantineJournals();
    assert(fs.readFileSync(beforeRenameSource).equals(beforeRenameBytes) && !fs.existsSync(beforeRenameJournal), "Pre-rename migration journal did not resolve without touching its source");

    const landedBytes = Buffer.from("journal-after-rename");
    const landedSource = path.join(legacyMigrationTemp, "Migration", "after-rename.bin");
    const landedDest = path.join(legacyMigrationTemp, "Migration", "after-rename-dest.bin");
    const landedQuarantine = path.join(legacyMigrationTemp, "Migration", ".tinylocal-quarantine-1700000000001-22222222222222222222222222222222.tmp", "after-rename.bin");
    fs.mkdirSync(path.dirname(landedQuarantine), { recursive: true });
    fs.writeFileSync(landedQuarantine, landedBytes);
    fs.writeFileSync(landedDest, landedBytes);
    const landedJournal = writeMigrationRecoveryJournal(
      "22222222222222222222222222222222",
      "Migration/after-rename.bin",
      "Migration/after-rename-dest.bin",
      "Migration/.tinylocal-quarantine-1700000000001-22222222222222222222222222222222.tmp/after-rename.bin",
      landedBytes
    );
    await plugin.migrationRunner.recoverMigrationQuarantineJournals();
    assert(!fs.existsSync(landedSource) && fs.readFileSync(landedQuarantine).equals(landedBytes) && fs.existsSync(landedJournal), "Landed migration recovery discarded its transaction-owned safety copy or journal");

    const restoreBytes = Buffer.from("journal-restore-source");
    const restoreSource = path.join(legacyMigrationTemp, "Migration", "restore-source.bin");
    const restoreDest = path.join(legacyMigrationTemp, "Migration", "restore-dest.bin");
    const restoreQuarantine = path.join(legacyMigrationTemp, "Migration", ".tinylocal-quarantine-1700000000002-33333333333333333333333333333333.tmp", "restore-source.bin");
    fs.mkdirSync(path.dirname(restoreQuarantine), { recursive: true });
    fs.writeFileSync(restoreQuarantine, restoreBytes);
    fs.writeFileSync(restoreDest, "different-destination");
    const restoreJournal = writeMigrationRecoveryJournal(
      "33333333333333333333333333333333",
      "Migration/restore-source.bin",
      "Migration/restore-dest.bin",
      "Migration/.tinylocal-quarantine-1700000000002-33333333333333333333333333333333.tmp/restore-source.bin",
      restoreBytes
    );
    await plugin.migrationRunner.recoverMigrationQuarantineJournals();
    assert(fs.readFileSync(restoreSource).equals(restoreBytes) && fs.readFileSync(restoreQuarantine).equals(restoreBytes) && fs.existsSync(restoreJournal), "Mismatched destination recovery did not restore the canonical source while retaining its verified fallback and journal");
    fs.unlinkSync(restoreQuarantine);
    fs.rmdirSync(path.dirname(restoreQuarantine));
    fs.unlinkSync(restoreJournal);

    const ambiguousBytes = Buffer.from("journal-ambiguous-old");
    const ambiguousSource = path.join(legacyMigrationTemp, "Migration", "ambiguous-source.bin");
    const ambiguousDest = path.join(legacyMigrationTemp, "Migration", "ambiguous-dest.bin");
    const ambiguousQuarantine = path.join(legacyMigrationTemp, "Migration", ".tinylocal-quarantine-1700000000003-44444444444444444444444444444444.tmp", "ambiguous-source.bin");
    fs.mkdirSync(path.dirname(ambiguousQuarantine), { recursive: true });
    fs.writeFileSync(ambiguousQuarantine, ambiguousBytes);
    fs.writeFileSync(ambiguousSource, "new-sync-version");
    fs.writeFileSync(ambiguousDest, "different-destination");
    const ambiguousJournal = writeMigrationRecoveryJournal(
      "44444444444444444444444444444444",
      "Migration/ambiguous-source.bin",
      "Migration/ambiguous-dest.bin",
      "Migration/.tinylocal-quarantine-1700000000003-44444444444444444444444444444444.tmp/ambiguous-source.bin",
      ambiguousBytes
    );
    await plugin.migrationRunner.recoverMigrationQuarantineJournals();
    assert(fs.existsSync(ambiguousQuarantine) && fs.existsSync(ambiguousJournal) && fs.readFileSync(ambiguousSource, "utf8") === "new-sync-version", "Ambiguous migration recovery did not preserve both source versions and its journal");
    fs.unlinkSync(ambiguousQuarantine);
    fs.rmdirSync(path.dirname(ambiguousQuarantine));
    fs.unlinkSync(ambiguousJournal);

    const invalidJournalPath = path.join(migrationRecoveryDir, "migration-quarantine-v1-55555555555555555555555555555555.json");
    fs.writeFileSync(invalidJournalPath, JSON.stringify({ version: 1, checksum: "0".repeat(64) }));
    await plugin.migrationRunner.recoverMigrationQuarantineJournals();
    assert(fs.existsSync(invalidJournalPath), "Invalid migration recovery journal was executed or deleted");
    fs.unlinkSync(invalidJournalPath);

    const craftedVictimBytes = Buffer.from("crafted-journal-victim");
    const craftedVictimPath = path.join(legacyMigrationTemp, "Migration", "crafted-victim.bin");
    fs.writeFileSync(craftedVictimPath, craftedVictimBytes);
    const craftedJournalPath = writeMigrationRecoveryJournal(
      "66666666666666666666666666666666",
      "Migration/crafted-source.bin",
      "Migration/crafted-destination.bin",
      "Migration/crafted-victim.bin",
      craftedVictimBytes
    );
    await plugin.migrationRunner.recoverMigrationQuarantineJournals();
    assert(fs.readFileSync(craftedVictimPath).equals(craftedVictimBytes), "Correctly checksummed crafted migration journal mutated a non-quarantine victim");
    assert(fs.existsSync(craftedJournalPath), "Correctly checksummed crafted migration journal was executed or deleted");
    fs.unlinkSync(craftedJournalPath);
  } finally {
    console.debug = originalConsoleDebugForMigration;
    plugin.app.vault.adapter.basePath = originalBasePathForPathSmoke;
    plugin.app.vault.adapter.path.absolute = originalAbsolutePathForPathSmoke;
    fs.rmSync(legacyMigrationTemp, { recursive: true, force: true });
  }

  // ponytail: one result object keeps the approved full-audit reproductions deterministic.
  const fullAuditBugReproducerObserved = {
    legacyMovedCacheInvalidated: false,
    regionalExternalLanguageWins: false,
    externalLanguageReloadedOnSwitch: false
  };
  const i18nCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-i18n-cache-"));
  const originalBugReproducerLanguage = mockObsidianLanguage;
  try {
    const vaultA = path.join(i18nCacheTemp, "vault-a");
    const vaultB = path.join(i18nCacheTemp, "vault-b");
    const regionalVault = path.join(i18nCacheTemp, "vault-regional");
    const switchVault = path.join(i18nCacheTemp, "vault-switch");
    const langA = path.join(vaultA, ".obsidian", "plugins", "local-image-compress", "lang");
    const langB = path.join(vaultB, ".obsidian", "plugins", "local-image-compress", "lang");
    const regionalLang = path.join(regionalVault, ".obsidian", "plugins", "local-image-compress", "lang");
    const switchLang = path.join(switchVault, ".obsidian", "plugins", "local-image-compress", "lang");
    fs.mkdirSync(langA, { recursive: true });
    fs.mkdirSync(langB, { recursive: true });
    fs.mkdirSync(regionalLang, { recursive: true });
    fs.mkdirSync(switchLang, { recursive: true });
    fs.writeFileSync(path.join(langA, "en.json"), JSON.stringify({ "settings.title": "Vault A Settings" }));
    fs.writeFileSync(path.join(langB, "en.json"), JSON.stringify({ "settings.title": "Vault B Settings" }));
    fs.writeFileSync(path.join(regionalLang, "pt.json"), JSON.stringify({ "settings.title": "Generic Portuguese" }));
    fs.writeFileSync(path.join(regionalLang, "pt-br.json"), JSON.stringify({ "settings.title": "Brazilian Portuguese" }));
    fs.writeFileSync(path.join(switchLang, "en.json"), JSON.stringify({ "settings.title": "External English" }));
    fs.writeFileSync(path.join(switchLang, "de.json"), JSON.stringify({ "settings.title": "External German" }));
    plugin.app.vault.adapter.basePath = vaultA;
    plugin.app.vault.adapter.path.absolute = vaultA;
    await plugin.preloadExternalLanguageFiles();
    assert(plugin.moveService.getMoveText("settings.title") === "Vault A Settings", "External i18n file for vault A was not loaded");
    plugin.app.vault.adapter.basePath = vaultB;
    plugin.app.vault.adapter.path.absolute = vaultB;
    await plugin.preloadExternalLanguageFiles();
    assert(plugin.moveService.getMoveText("settings.title") === "Vault B Settings", "External i18n cache leaked across plugin directories");

    mockObsidianLanguage = "pt-BR";
    plugin.app.vault.adapter.basePath = regionalVault;
    plugin.app.vault.adapter.path.absolute = regionalVault;
    await plugin.preloadExternalLanguageFiles();
    fullAuditBugReproducerObserved.regionalExternalLanguageWins =
      plugin.moveService.getMoveText("settings.title") === "Brazilian Portuguese";

    mockObsidianLanguage = "en";
    plugin.app.vault.adapter.basePath = switchVault;
    plugin.app.vault.adapter.path.absolute = switchVault;
    await plugin.preloadExternalLanguageFiles();
    mockObsidianLanguage = "de";
    await plugin.handleLocaleConfigChanged();
    fullAuditBugReproducerObserved.externalLanguageReloadedOnSwitch =
      plugin.moveService.getMoveText("settings.title") === "External German";
  } finally {
    mockObsidianLanguage = originalBugReproducerLanguage;
    plugin.app.vault.adapter.basePath = originalBasePathForPathSmoke;
    plugin.app.vault.adapter.path.absolute = originalAbsolutePathForPathSmoke;
    fs.rmSync(i18nCacheTemp, { recursive: true, force: true });
  }

  const commandIds = plugin.commands.map((command) => command.id).sort();
  assert(
    JSON.stringify(commandIds) === JSON.stringify([
      "compress-all-images",
      "compress-images-in-folder",
      "compress-images-in-note",
      "move-compressed-to-files"
    ]),
    `Unexpected command ids after onload: ${commandIds.join(", ")}`
  );
  assert(plugin.settingTabs.length === 1, "Plugin did not register exactly one settings tab");
  assert(plugin.statusBarItem, "Plugin did not create a status bar item");
  assert(plugin.statusBarItem.attributes.role === "button", "Status bar item is missing role=button");
  assert(plugin.statusBarItem.attributes.tabindex === "0", "Status bar item is missing tabindex=0");
  assert(plugin.statusBarItem.attributes["aria-haspopup"] === "menu", "Status bar item is missing aria-haspopup=menu");
  assert(plugin.statusBarItem.attributes["aria-expanded"] === "false", "Status bar item should start collapsed");
  assert((plugin.statusBarItem._listeners.click || []).length === 1, "Status bar click handler was not registered exactly once");
  assert((plugin.statusBarItem._listeners.keydown || []).length === 1, "Status bar keydown handler was not registered exactly once");
  const originalShowStatusMenuForClick = plugin.statusBarController.showMenu;
  let statusMenuClickCount = 0;
  const statusMenuOpenEvents = [];
  try {
    plugin.statusBarController.showMenu = async (event) => {
      statusMenuClickCount += 1;
      statusMenuOpenEvents.push(event);
    };
    await plugin.statusBarController.update();
    await plugin.statusBarController.update();
    assert((plugin.statusBarItem._listeners.click || []).length === 1, "Status bar update registered duplicate click handlers");
    assert((plugin.statusBarItem._listeners.keydown || []).length === 1, "Status bar update registered duplicate keydown handlers");
    plugin.statusBarItem.dispatchEvent("click", { preventDefault() {} });
    assert(statusMenuClickCount === 1, "Status bar registered click handler did not open the menu once");
    plugin.statusBarItem.dispatchEvent("keydown", { key: "Tab", preventDefault() { throw new Error("Tab should not open status menu"); } });
    assert(statusMenuClickCount === 1, "Non-activation status bar key opened the menu");
    let enterPrevented = false;
    plugin.statusBarItem.dispatchEvent("keydown", {
      key: "Enter",
      preventDefault() {
        enterPrevented = true;
      }
    });
    assert(statusMenuClickCount === 2 && enterPrevented, "Status bar Enter key did not open the menu with preventDefault");
    assert(statusMenuOpenEvents[1]?.keyboard === true && statusMenuOpenEvents[1]?.target === plugin.statusBarItem, "Status bar Enter key did not use keyboard menu open context");
    let spacePrevented = false;
    plugin.statusBarItem.dispatchEvent("keydown", {
      key: " ",
      preventDefault() {
        spacePrevented = true;
      }
    });
    assert(statusMenuClickCount === 3 && spacePrevented, "Status bar Space key did not open the menu with preventDefault");
    assert(statusMenuOpenEvents[2]?.keyboard === true && statusMenuOpenEvents[2]?.returnFocusTo === plugin.statusBarItem, "Status bar Space key did not preserve focus return target");
  } finally {
    plugin.statusBarController.showMenu = originalShowStatusMenuForClick;
  }
  const LifecycleObsidianMock = require("obsidian");
  const originalNoticeForGuardedMenu = LifecycleObsidianMock.Notice;
  const originalConsoleErrorForGuardedMenu = console.error;
  const guardedMenuNotices = [];
  let guardedMenuUnhandledRejection = null;
  const guardedMenuRejectionListener = (error) => {
    guardedMenuUnhandledRejection = error;
  };
  try {
    LifecycleObsidianMock.Notice = class {
      constructor(message) {
        guardedMenuNotices.push(String(message));
      }
    };
    console.error = () => {};
    process.on("unhandledRejection", guardedMenuRejectionListener);
    plugin.statusBarController.showMenu = async () => {
      throw new Error("simulated status menu statistics failure");
    };
    plugin.statusBarItem.setAttribute("aria-expanded", "true");
    plugin.statusBarItem.dispatchEvent("click", { preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert(guardedMenuUnhandledRejection === null, "Status/ribbon menu callback leaked a rejected promise");
    assert(plugin.statusBarItem.attributes["aria-expanded"] === "false", "Failed status menu open left aria-expanded stuck");
    assert(guardedMenuNotices.length === 1, "Failed status menu open did not show one actionable Notice");
    let guardedMenuRetryCalls = 0;
    plugin.statusBarController.showMenu = async () => {
      guardedMenuRetryCalls += 1;
    };
    plugin.statusBarItem.dispatchEvent("click", { preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert(guardedMenuRetryCalls === 1, "Status menu could not open after a guarded failure");
  } finally {
    process.removeListener("unhandledRejection", guardedMenuRejectionListener);
    plugin.statusBarController.showMenu = originalShowStatusMenuForClick;
    LifecycleObsidianMock.Notice = originalNoticeForGuardedMenu;
    console.error = originalConsoleErrorForGuardedMenu;
  }

  const originalUpdateIndexForLifecycle = plugin.updateImageIndexForFile;
  const originalRenameIndexForLifecycle = plugin.renameImageIndexFile;
  const originalRenameCacheForLifecycle = plugin.cache.renameCacheEntries;
  const originalCompactDeletedForLifecycle = plugin.cache.compactDeletedPath;
  const originalScheduleIndexForLifecycle = plugin.scheduleImageIndexRefresh;
  const originalScheduleProcessedForLifecycle = plugin.scheduleImageIndexProcessedRefresh;
  const originalScheduleStatusForLifecycle = plugin.scheduleStatusBarUpdate;
  const originalHandleNewFileForLifecycle = plugin.handleNewFile;
  const originalLifecycleInitialized = plugin.isInitialized;
  try {
    const lifecycleFile = Object.assign(new LifecycleObsidianMock.TFile(), createMockFile("Images/lifecycle-fence.png", 100, 1));
    let downstreamLifecycleCalls = 0;
    plugin.isInitialized = true;
    plugin.scheduleImageIndexRefresh = () => { downstreamLifecycleCalls += 1; };
    plugin.scheduleImageIndexProcessedRefresh = () => { downstreamLifecycleCalls += 1; };
    plugin.scheduleStatusBarUpdate = () => { downstreamLifecycleCalls += 1; };
    plugin.renameImageIndexFile = async () => { downstreamLifecycleCalls += 1; };
    plugin.handleNewFile = async () => { downstreamLifecycleCalls += 1; };

    const runLifecycleBarrier = async (installBarrier, startHandler, label) => {
      let releaseBarrier = null;
      let markBarrierStarted = null;
      const barrierStarted = new Promise((resolve) => { markBarrierStarted = resolve; });
      installBarrier(async () => {
        markBarrierStarted();
        await new Promise((resolve) => { releaseBarrier = resolve; });
      });
      plugin.isUnloading = false;
      downstreamLifecycleCalls = 0;
      const handlerPromise = startHandler();
      await barrierStarted;
      plugin.isUnloading = true;
      releaseBarrier();
      await handlerPromise;
      assert(downstreamLifecycleCalls === 0, `${label} handler scheduled or mutated downstream state after unload`);
    };

    await runLifecycleBarrier(
      (barrier) => { plugin.updateImageIndexForFile = barrier; },
      () => plugin.handleVaultCreate(lifecycleFile),
      "create"
    );
    await runLifecycleBarrier(
      (barrier) => { plugin.cache.renameCacheEntries = barrier; },
      () => plugin.handleVaultRename(lifecycleFile, "Images/lifecycle-old.png"),
      "rename"
    );
    await runLifecycleBarrier(
      (barrier) => { plugin.cache.compactDeletedPath = barrier; },
      () => plugin.handleVaultDelete(lifecycleFile),
      "delete"
    );
    await runLifecycleBarrier(
      (barrier) => { plugin.updateImageIndexForFile = barrier; },
      () => plugin.handleVaultModify(lifecycleFile),
      "modify"
    );
  } finally {
    plugin.isUnloading = false;
    plugin.isInitialized = originalLifecycleInitialized;
    plugin.updateImageIndexForFile = originalUpdateIndexForLifecycle;
    plugin.renameImageIndexFile = originalRenameIndexForLifecycle;
    plugin.cache.renameCacheEntries = originalRenameCacheForLifecycle;
    plugin.cache.compactDeletedPath = originalCompactDeletedForLifecycle;
    plugin.scheduleImageIndexRefresh = originalScheduleIndexForLifecycle;
    plugin.scheduleImageIndexProcessedRefresh = originalScheduleProcessedForLifecycle;
    plugin.scheduleStatusBarUpdate = originalScheduleStatusForLifecycle;
    plugin.handleNewFile = originalHandleNewFileForLifecycle;
  }
  assert(plugin.cache && String(plugin.cache.cacheFile).includes("tinyLocal-cache.json"), "Plugin cache was not initialized");

  const ConcurrencyLimiterClass = plugin.compressionLimiter.constructor;
  for (const invalidLimit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    let rejectedInvalidLimit = false;
    try {
      new ConcurrencyLimiterClass(invalidLimit);
    } catch (error) {
      rejectedInvalidLimit = error instanceof RangeError;
    }
    assert(rejectedInvalidLimit, `ConcurrencyLimiter accepted invalid limit: ${invalidLimit}`);
  }

  const limiterSleep = (delayMs) => new Promise((resolve) => originalGlobals.setTimeout(resolve, delayMs));
  const withLimiterTimeout = (promise, message) => Promise.race([
    promise,
    new Promise((_, reject) => originalGlobals.setTimeout(() => reject(new Error(message)), 500))
  ]);
  const concurrencyLimiter = new ConcurrencyLimiterClass(2);
  let runningLimiterTasks = 0;
  let maxRunningLimiterTasks = 0;
  const limiterResults = await Promise.all(Array.from({ length: 10 }, (_, index) => concurrencyLimiter.run(async () => {
    runningLimiterTasks += 1;
    maxRunningLimiterTasks = Math.max(maxRunningLimiterTasks, runningLimiterTasks);
    assert(concurrencyLimiter.active <= concurrencyLimiter.getLimit(), "ConcurrencyLimiter active count exceeded its limit");
    await limiterSleep(2);
    runningLimiterTasks -= 1;
    return index;
  })));
  assert(maxRunningLimiterTasks <= 2, `ConcurrencyLimiter allowed ${maxRunningLimiterTasks} concurrent tasks for limit=2`);
  assert(limiterResults.length === 10 && limiterResults[9] === 9, "ConcurrencyLimiter did not resolve all queued tasks");
  assert(concurrencyLimiter.active === 0 && concurrencyLimiter.queue.length === 0, "ConcurrencyLimiter leaked active or queued task state");

  const corruptQueueLimiter = new ConcurrencyLimiterClass(1);
  let releaseBlockingLimiterTask = null;
  const blockingLimiterTask = corruptQueueLimiter.run(async () => {
    await new Promise((resolve) => {
      releaseBlockingLimiterTask = resolve;
    });
  });
  const queuedLimiterTask = corruptQueueLimiter.run(async () => "queued-ok");
  assert(corruptQueueLimiter.active === 1 && corruptQueueLimiter.queue.length === 1, "ConcurrencyLimiter queued task state is wrong");
  corruptQueueLimiter.queue.unshift(() => {
    throw new Error("corrupted queued waiter");
  });
  releaseBlockingLimiterTask();
  await withLimiterTimeout(blockingLimiterTask, "ConcurrencyLimiter blocking task did not settle");
  assert(await withLimiterTimeout(queuedLimiterTask, "ConcurrencyLimiter did not recover after a corrupted queued waiter") === "queued-ok", "ConcurrencyLimiter recovered waiter returned the wrong value");
  assert(corruptQueueLimiter.active === 0 && corruptQueueLimiter.queue.length === 0, "ConcurrencyLimiter kept stale state after corrupted waiter recovery");

  const transferLimiter = new ConcurrencyLimiterClass(1);
  const transferOrder = [];
  let releaseTransferredPermit = null;
  let bargingTask = null;
  let maxTransferActive = 0;
  const heldPermitTask = transferLimiter.run(async () => {
    transferOrder.push("A");
    await new Promise((resolve) => {
      releaseTransferredPermit = resolve;
    });
  });
  const queuedPermitTask = transferLimiter.run(async () => {
    maxTransferActive = Math.max(maxTransferActive, transferLimiter.active);
    transferOrder.push("B");
  });
  assert(transferLimiter.queue.length === 1, "ConcurrencyLimiter transfer test did not queue B");
  const resolveQueuedPermit = transferLimiter.queue[0];
  transferLimiter.queue[0] = () => {
    bargingTask = transferLimiter.run(async () => {
      maxTransferActive = Math.max(maxTransferActive, transferLimiter.active);
      transferOrder.push("C");
    });
    resolveQueuedPermit();
  };
  releaseTransferredPermit();
  await Promise.all([heldPermitTask, queuedPermitTask]);
  await bargingTask;
  assert(transferOrder.join(",") === "A,B,C", `ConcurrencyLimiter allowed a newcomer to barge: ${transferOrder.join(",")}`);
  assert(maxTransferActive === 1 && transferLimiter.active === 0, `ConcurrencyLimiter permit transfer exceeded limit: ${maxTransferActive}`);

  const MemoryBudgetLimiterClass = plugin.compressor.memoryLimiter.constructor;
  const memoryBudgetLimiter = new MemoryBudgetLimiterClass(10);
  const admittedMemoryWeights = [];
  let releaseLargeMemoryJob = null;
  const largeMemoryJob = memoryBudgetLimiter.run(7, async () => {
    admittedMemoryWeights.push(7);
    await new Promise((resolve) => {
      releaseLargeMemoryJob = resolve;
    });
  });
  await Promise.resolve();
  const queuedFourMemoryJob = memoryBudgetLimiter.run(4, async () => {
    admittedMemoryWeights.push(4);
  });
  const queuedThreeMemoryJob = memoryBudgetLimiter.run(3, async () => {
    admittedMemoryWeights.push(3);
  });
  await Promise.resolve();
  assert(admittedMemoryWeights.join(",") === "7", "Memory budget admitted queued jobs beyond the aggregate weight limit");
  releaseLargeMemoryJob();
  await Promise.all([largeMemoryJob, queuedFourMemoryJob, queuedThreeMemoryJob]);
  assert(admittedMemoryWeights.join(",") === "7,4,3", "Memory budget did not preserve FIFO admission while using remaining capacity");

  const resizableMemoryLimiter = new MemoryBudgetLimiterClass(10);
  const shrinkingReservation = await resizableMemoryLimiter.reserve(7);
  let queuedReservationAdmitted = false;
  const queuedReservationPromise = resizableMemoryLimiter.reserve(4).then((reservation) => {
    queuedReservationAdmitted = true;
    return reservation;
  });
  await Promise.resolve();
  assert(queuedReservationAdmitted === false, "Memory reservation admitted queued weight before capacity was released");
  await shrinkingReservation.resize(6);
  const queuedReservation = await withLimiterTimeout(queuedReservationPromise, "Shrinking a memory reservation did not release queued capacity");
  assert(queuedReservationAdmitted === true, "Shrinking a memory reservation did not admit the FIFO waiter");
  queuedReservation.release();
  shrinkingReservation.release();

  const growingMemoryLimiter = new MemoryBudgetLimiterClass(10);
  const growingReservation = await growingMemoryLimiter.reserve(4);
  const competingReservation = await growingMemoryLimiter.reserve(6);
  let growthSettled = false;
  const growthPromise = growingReservation.resize(7).then(() => {
    growthSettled = true;
  });
  await Promise.resolve();
  assert(growthSettled === false, "Memory reservation growth bypassed the aggregate budget");
  competingReservation.release();
  await withLimiterTimeout(growthPromise, "Memory reservation growth did not resume after capacity was released");
  growingReservation.release();

  const clampedPixels = new Uint8ClampedArray([1, 2, 3, 4]);
  const pixelView = plugin.compressor.toUint8Array(clampedPixels);
  assert(pixelView.buffer === clampedPixels.buffer && pixelView.byteOffset === clampedPixels.byteOffset, "Compressor copied a clamped pixel view instead of sharing its buffer");

  const originalLoadDataForNormalize = plugin.loadData;
  const originalSettingsForNormalize = plugin.settings;
  try {
    plugin.loadData = async () => ({
      pngQuality: { min: 0 },
      jpegQuality: 999,
      allowedRoots: "Images",
      outputFolder: "../outside",
      pngquantPath: "C:\\legacy\\pngquant.exe",
      mozjpegPath: "C:\\legacy\\mozjpeg.exe",
      workerPoolSize: 99,
      compressionTimeoutSeconds: 9999,
      wasmInitTimeoutSeconds: 1,
      maxInputSizeMB: 0,
      maxImagePixelsMillions: 2000,
      autoBackgroundThreshold: -1,
      inactivityThresholdMinutes: 99,
      cacheRetentionMonths: 999,
      autoCleanupGhostsOnStart: true,
      pluginGuardTimeoutMs: 999999,
      autoBackupsRetentionDays: 9999,
      autoMoveCompressedThreshold: 0
    });
    await plugin.loadSettings();
    assert(plugin.settings.pngQuality.min === 1 && plugin.settings.pngQuality.max === 80, "loadSettings() did not deep-normalize partial PNG quality");
    assert(plugin.settings.jpegQuality === 95, "loadSettings() did not clamp JPEG quality");
    assert(Array.isArray(plugin.settings.allowedRoots) && plugin.settings.allowedRoots.length === 0, "loadSettings() did not normalize malformed allowedRoots");
    assert(plugin.settings.outputFolder === "Compressed", "loadSettings() did not reject unsafe outputFolder");
    for (const technicalKey of removedTechnicalSettingKeys) {
      assert(!(technicalKey in plugin.settings), `normalizeSettings kept removed technical key: ${technicalKey}`);
    }
    assert(plugin.compressor.processTimeoutMs === 120000, "loadSettings() did not apply internal compression timeout to Compressor");
    assert(plugin.compressor.initTimeoutMs === 60000, "loadSettings() did not apply internal WASM init timeout to Compressor");
    assert(plugin.compressor.maxInputBytes === 100 * 1024 * 1024, "loadSettings() did not apply internal input size limit to Compressor");
    assert(plugin.compressor.maxImagePixels === 100 * 1000000, "loadSettings() did not apply internal image pixel limit to Compressor");
    assert(plugin.settings.autoBackgroundThreshold === 10, "normalizeSettings did not clamp autoBackgroundThreshold");
    assert(plugin.settings.inactivityThresholdMinutes === 60, "normalizeSettings did not clamp inactivityThresholdMinutes");
    assert(plugin.backgroundCompressionService.USER_INACTIVITY_THRESHOLD === 60 * 60 * 1000, "loadSettings() did not apply runtime inactivity threshold");
    assert(!("cacheRetentionMonths" in plugin.settings) && !("autoCleanupGhostsOnStart" in plugin.settings), "normalizeSettings kept removed cache-maintenance settings");
    assert(plugin.pluginGuardService.operationTimeoutMs === 8000, "loadSettings() did not apply internal plugin guard timeout");
    assert(plugin.settings.autoBackupsRetentionDays === 365, "normalizeSettings did not clamp autoBackupsRetentionDays");
    assert(plugin.settings.autoMoveCompressedThreshold === 1, "normalizeSettings did not clamp autoMoveCompressedThreshold");
    for (const malformedOutputFolder of [{}, [], 42, "   "]) {
      plugin.loadData = async () => ({ outputFolder: malformedOutputFolder });
      await plugin.loadSettings();
      assert(plugin.settings.outputFolder === "Compressed", `loadSettings() accepted malformed outputFolder: ${JSON.stringify(malformedOutputFolder)}`);
    }
    const LoadSettingsObsidianMock = require("obsidian");
    const originalNoticeForLoadSettings = LoadSettingsObsidianMock.Notice;
    const originalConsoleErrorForLoadSettings = console.error;
    const loadSettingsNotices = [];
    try {
      LoadSettingsObsidianMock.Notice = class {
        constructor(message, duration) {
          loadSettingsNotices.push({ message, duration });
        }
      };
      console.error = () => {};
      plugin.loadData = async () => {
        throw new SyntaxError("corrupt data.json");
      };
      await plugin.loadSettings();
      assert(plugin.settings.outputFolder === "Compressed", "loadSettings() did not fall back to defaults after loadData failure");
      assert(plugin.settings.inactivityThresholdMinutes === 2 && plugin.backgroundCompressionService.USER_INACTIVITY_THRESHOLD === 2 * 60 * 1000, "loadSettings() did not restore default inactivity threshold after loadData failure");
      assert(plugin.pluginGuardService.operationTimeoutMs === 8000, "loadSettings() did not restore internal plugin guard timeout after loadData failure");
      assert(plugin.compressor.processTimeoutMs === 120000, "loadSettings() did not restore internal compression timeout after loadData failure");
      assert(plugin.compressor.initTimeoutMs === 60000, "loadSettings() did not restore internal WASM init timeout after loadData failure");
      assert(plugin.compressor.maxInputBytes === 100 * 1024 * 1024, "loadSettings() did not restore internal input size limit after loadData failure");
      assert(plugin.compressor.maxImagePixels === 100 * 1000000, "loadSettings() did not restore internal image pixel limit after loadData failure");
      assert(loadSettingsNotices.some((notice) => String(notice.message).includes("Settings") && notice.duration === 10000), "loadSettings() failure did not notify the user");
    } finally {
      LoadSettingsObsidianMock.Notice = originalNoticeForLoadSettings;
      console.error = originalConsoleErrorForLoadSettings;
    }
  } finally {
    plugin.loadData = originalLoadDataForNormalize;
    plugin.settings = originalSettingsForNormalize;
  }

  const originalSettingsForSaveConfig = plugin.settings;
  const originalSaveDataForSaveConfig = plugin.saveData;
  const originalRebuildImageIndexForSaveConfig = plugin.rebuildImageIndex;
  const originalImageIndexConfigKeyForSaveConfig = plugin.imageIndexConfigKey;
  try {
    const SaveConfigObsidianMock = require("obsidian");
    const rebuildReasons = [];
    plugin.saveData = async () => {};
    plugin.rebuildImageIndex = async (reason) => {
      rebuildReasons.push(reason);
    };
    plugin.settings = { ...plugin.settings, outputFolder: "Compressed", allowedRoots: ["Alpha", "Beta"] };
    plugin.imageIndexConfigKey = plugin.getImageIndexConfigKey();
    plugin.settings = { ...plugin.settings, outputFolder: "Compressed", allowedRoots: ["Beta", "Alpha"] };
    await plugin.saveSettings();
    assert(rebuildReasons.length === 0, "saveSettings() rebuilt the image index for allowedRoots reorder only");
    plugin.settings = { ...plugin.settings, outputFolder: "Compressed", allowedRoots: ["Alpha", "Gamma"] };
    await plugin.saveSettings();
    assert(rebuildReasons.length === 1, "saveSettings() did not rebuild the image index for allowedRoots content changes");
    const folderLikeImage = new SaveConfigObsidianMock.TFolder();
    folderLikeImage.path = "Images/folder.png";
    folderLikeImage.name = "folder.png";
    assert(plugin.isImageFile(folderLikeImage) === false, "isImageFile() accepted a folder-like object without extension");
    assert(plugin.isImageFile({ path: "Images/no-extension", name: "no-extension" }) === false, "isImageFile() threw or accepted an object without extension");
    assert(plugin.isImageFile({ path: "Images/caps.PNG", name: "caps.PNG", extension: "PNG" }) === true, "isImageFile() did not handle uppercase extensions");
    const invalidValidationResult = await plugin.validateFileForCompression({ path: "Images/no-extension", name: "no-extension" });
    assert(invalidValidationResult.valid === false && String(invalidValidationResult.error).includes("Unsupported"), "validateFileForCompression() did not reject missing-extension files safely");
  } finally {
    plugin.settings = originalSettingsForSaveConfig;
    plugin.saveData = originalSaveDataForSaveConfig;
    plugin.rebuildImageIndex = originalRebuildImageIndexForSaveConfig;
    plugin.imageIndexConfigKey = originalImageIndexConfigKeyForSaveConfig;
  }

  const SettingsQueuePluginClass = plugin.constructor;
  const ReloadedSettingsQueuePluginClass = loadFreshPluginClass();
  const settingsQueuePluginA = new SettingsQueuePluginClass();
  const settingsQueuePluginB = new ReloadedSettingsQueuePluginClass();
  settingsQueuePluginA.app = plugin.app;
  settingsQueuePluginB.app = plugin.app;
  settingsQueuePluginA.manifest = { ...plugin.manifest };
  settingsQueuePluginB.manifest = { ...plugin.manifest };
  const persistedSettingsOrder = [];
  let releaseSettingsWriteA = null;
  let settingsWriteAStarted = null;
  const settingsWriteAStartedPromise = new Promise((resolve) => {
    settingsWriteAStarted = resolve;
  });
  settingsQueuePluginA.saveData = async (snapshot) => {
    persistedSettingsOrder.push(`start-${snapshot.marker}`);
    settingsWriteAStarted();
    await new Promise((resolve) => {
      releaseSettingsWriteA = resolve;
    });
    persistedSettingsOrder.push(`finish-${snapshot.marker}`);
  };
  settingsQueuePluginB.saveData = async (snapshot) => {
    persistedSettingsOrder.push(`start-${snapshot.marker}`);
    persistedSettingsOrder.push(`finish-${snapshot.marker}`);
  };
  settingsQueuePluginA.claimSettingsPersistenceOwnership();
  const settingsWriteA = settingsQueuePluginA.persistSettingsSnapshot({ marker: "A" });
  await settingsWriteAStartedPromise;
  settingsQueuePluginB.claimSettingsPersistenceOwnership();
  const settingsWriteB = settingsQueuePluginB.persistSettingsSnapshot({ marker: "B" });
  const rejectedLateSettingsWriteA = await settingsQueuePluginA.persistSettingsSnapshot({ marker: "A-late" });
  assert(rejectedLateSettingsWriteA === false, "An old plugin module accepted a settings save after ownership moved to the re-evaluated reload module");
  await Promise.resolve();
  assert(!persistedSettingsOrder.includes("start-B"), "Reload settings write bypassed the accepted old-instance snapshot");
  releaseSettingsWriteA();
  assert(await settingsWriteA === true, "Accepted old-instance settings snapshot was not persisted");
  assert(await settingsWriteB === true, "Reload settings snapshot was not persisted");
  assert(persistedSettingsOrder.join(",") === "start-A,finish-A,start-B,finish-B", `Settings persistence queue completed out of logical order: ${persistedSettingsOrder.join(",")}`);
  plugin.claimSettingsPersistenceOwnership();

  const originalGetActiveDocumentForFolderSelector = plugin.getActiveDocument;
  const originalSetWindowTimeoutForFolderSelector = plugin.setWindowTimeout;
  try {
    plugin.setWindowTimeout = (callback) => {
      callback();
      return 1;
    };
    const selectedFolderPromise = plugin.showFolderSelector(["/", "Images"]);
    const modal = Array.from(plugin.managedModals).find((candidate) => candidate?.contentEl?.classList?.contains("tiny-local-folder-select-modal"));
    assert(modal, "Folder selector modal was not tracked as a managed modal");
    const select = modal.contentEl.children[0];
    const footer = modal.contentEl.children[1];
    const okButton = footer.children[0];
    const cancelButton = footer.children[1];
    assert(modal.titleEl.id === "tiny-local-folder-select-title", "Folder selector title is missing a stable id");
    assert(modal.contentEl.attributes["aria-labelledby"] === "tiny-local-folder-select-title", "Folder selector content is missing aria-labelledby");
    assert(select.attributes["aria-label"] === "Folder", "Folder selector select is missing an accessible label");
    assert(select.className === "tiny-local-folder-select-control", "Folder selector select is missing its CSS class");
    assert(select.children[0].textContent === "Root folder", `Folder selector used wrong root label: ${select.children[0].textContent}`);
    assert(okButton.attributes["aria-label"] === "Select", "Folder selector OK button is missing an accessible label");
    assert(cancelButton.attributes["aria-label"] === "Cancel", "Folder selector cancel button is missing an accessible label");
    assert(select.focused === true, "Folder selector did not focus the select control on open");
    select.value = "Images";
    okButton.dispatchEvent("click");
    const selectedFolder = await selectedFolderPromise;
    assert(selectedFolder === "Images", `Folder selector returned wrong path: ${selectedFolder}`);
    assert(!plugin.managedModals.has(modal), "Folder selector modal was not untracked after selection");

    const closedFolderPromise = plugin.showFolderSelector(["/", "Images"]);
    const closeModal = Array.from(plugin.managedModals).find((candidate) => candidate?.contentEl?.classList?.contains("tiny-local-folder-select-modal"));
    assert(closeModal, "Folder selector close test did not track the modal");
    plugin.closeManagedModals();
    const closedFolder = await closedFolderPromise;
    assert(closedFolder === null, "Folder selector did not resolve null when closed through managed modal cleanup");
    assert(!plugin.managedModals.has(closeModal), "Folder selector modal was not untracked after managed close");
  } finally {
    plugin.getActiveDocument = originalGetActiveDocumentForFolderSelector;
    plugin.setWindowTimeout = originalSetWindowTimeoutForFolderSelector;
  }

  const basePathOnlyTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-getbasepath-"));
  const originalAdapterBasePath = plugin.app.vault.adapter.basePath;
  const originalAdapterPath = plugin.app.vault.adapter.path;
  const originalAdapterGetBasePath = plugin.app.vault.adapter.getBasePath;
  try {
    plugin.app.vault.adapter.basePath = undefined;
    plugin.app.vault.adapter.path = {};
    plugin.app.vault.adapter.getBasePath = () => basePathOnlyTemp;
    plugin.settings.outputFolder = "Compressed";
    const colonRelativeOutput = plugin.savingsCalculator.getCompressedFilePath("Images/photo:edited.jpg");
    assert(
      colonRelativeOutput === "Compressed/Images/photo:edited.jpg",
      `Shared savings path left the vault-relative domain: ${colonRelativeOutput}`
    );
    for (const invalidSavingsPath of [
      path.join(basePathOnlyTemp, "Images", "native-inside-vault.jpg"),
      "/tmp/native-posix.jpg",
      "\\\\server\\share\\native-unc.jpg"
    ]) {
      assert(plugin.savingsCalculator.getCompressedFilePath(invalidSavingsPath) === null, `Savings path reinterpreted a native path as vault-relative: ${invalidSavingsPath}`);
      assert(await plugin.savingsCalculator.getCompressedFileSize(invalidSavingsPath) === null, `Savings stat reinterpreted a native path as vault-relative: ${invalidSavingsPath}`);
    }
    assert(plugin.getPlatformPorts().fs.resolvePath("Images") === path.join(basePathOnlyTemp, "Images"), "Plugin-owned desktop port did not resolve getBasePath()-only adapter");
    assert(plugin.cache.ports === plugin.getPlatformPorts(), "Cache did not reuse the plugin-owned PlatformPorts instance");
    const originalPath = path.join(basePathOnlyTemp, "Images", "basepath-only.jpg");
    const compressedPath = path.join(basePathOnlyTemp, "Compressed", "Images", "basepath-only.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    await setMockFiles(plugin, [
      Object.assign(new (require("obsidian").TFile)(), createMockFile("Images/basepath-only.jpg", 100, 1))
    ]);
    const getBasePathOnlyCandidates = await plugin.moveService.getCompressedMoveCandidates();
    assert(
      getBasePathOnlyCandidates.some((candidate) => candidate.compressedPath === "Compressed/Images/basepath-only.jpg"),
      `MoveService stored a native compressed path: ${getBasePathOnlyCandidates.map((candidate) => candidate.compressedPath).join(", ")}`
    );
    const getBasePathOnlyMoveCount = await plugin.moveService.getCompressedFilesCount();
    assert(getBasePathOnlyMoveCount === 1, `MoveService getBasePath()-only count was wrong: ${getBasePathOnlyMoveCount}`);
  } finally {
    plugin.app.vault.adapter.basePath = originalAdapterBasePath;
    plugin.app.vault.adapter.path = originalAdapterPath;
    plugin.app.vault.adapter.getBasePath = originalAdapterGetBasePath;
    fs.rmSync(basePathOnlyTemp, { recursive: true, force: true });
    await setMockFiles(plugin, []);
  }

  const ObsidianMock = require("obsidian");
  const originalSetWindowTimeoutForNewFile = plugin.setWindowTimeout;
  const originalClearWindowTimeoutForNewFile = plugin.clearWindowTimeout;
  const originalAutoCompressNewFile = plugin.autoCompressNewFile;
  const delayedNewFileTimers = [];
  let delayedNewFileCompressCalls = 0;
  try {
    plugin.settings.autoCompressNewFiles = true;
    plugin.isUnloading = false;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      delayedNewFileTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    plugin.autoCompressNewFile = async () => {
      delayedNewFileCompressCalls += 1;
    };
    const newImageFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/delayed-new.png", 100000, 1));
    await plugin.handleNewFile(newImageFile);
    assert(delayedNewFileTimers.length === 1, "handleNewFile() did not schedule delayed auto-compression");
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 1, "Delayed new-file timer was not tracked for unload cleanup");
    const outputImageFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Compressed/Images/delayed-output.png", 100000, 2));
    await plugin.handleNewFile(outputImageFile);
    assert(delayedNewFileTimers.length === 1, "handleNewFile() scheduled recursive compression for an output-folder file");
    const outputValidation = await plugin.validateFileForCompression(outputImageFile);
    assert(outputValidation.valid === false, "validateFileForCompression() allowed an output-folder file");
    let outputContextItems = 0;
    plugin.addContextMenu({
      addItem(itemBuilder) {
        outputContextItems += 1;
        itemBuilder({
          setTitle() { return this; },
          setIcon() { return this; },
          onClick() { return this; }
        });
      }
    }, outputImageFile);
    assert(outputContextItems === 0, "Context menu exposed single-file compression for an output-folder file");
    plugin.onunload();
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 0, "onunload() did not clear delayed new-file timers");
    assert(delayedNewFileTimers[0].cleared === true, "onunload() did not clear the scheduled new-file timer handle");
    await delayedNewFileTimers[0].callback();
    assert(delayedNewFileCompressCalls === 0, "Delayed new-file compression ran after plugin unload");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFile;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForNewFile;
    plugin.autoCompressNewFile = originalAutoCompressNewFile;
    plugin.settings.autoCompressNewFiles = false;
    plugin.isUnloading = false;
    plugin.cache.acceptingWrites = true;
    plugin.pluginGuardService = new plugin.pluginGuardService.constructor(plugin);
    plugin.compressor = new plugin.compressor.constructor(
      plugin.settings,
      plugin.app,
      null,
      plugin.getPlatformPorts().fs,
      plugin.getPlatformPorts().hash
    );
    plugin.newFileQueue.newFileCompressionTimers.clear();
  }

  const originalSetWindowTimeoutForNewFileBatch = plugin.setWindowTimeout;
  const originalClearWindowTimeoutForNewFileBatch = plugin.clearWindowTimeout;
  const originalProcessBatchCompressionBackground = plugin.processBatchCompressionBackground;
  const originalGetFileByPathForNewFileBatch = plugin.app.vault.getFileByPath;
  const batchTimers = [];
  let batchCompressionCalls = 0;
  let batchCompressionSize = 0;
  try {
    plugin.settings.autoCompressNewFiles = true;
    plugin.isUnloading = false;
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    const batchFiles = new Map(Array.from({ length: 6 }, (_, index) => {
      const file = Object.assign(new ObsidianMock.TFile(), createMockFile(`Images/batch-${index}.png`, 100000, index + 10));
      return [file.path, file];
    }));
    plugin.app.vault.getFileByPath = (filePath) => batchFiles.get(filePath) || null;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      batchTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    plugin.processBatchCompressionBackground = async (files) => {
      batchCompressionCalls += 1;
      batchCompressionSize = files.length;
    };
    for (const file of batchFiles.values()) {
      await plugin.handleNewFile(file);
    }
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 6, "Rapid create events were not tracked per path");
    for (const timer of batchTimers.slice(0, 6)) {
      await timer.callback();
    }
    assert(batchTimers.length === 7, `New-file batch drain should use one coalesced timer, got ${batchTimers.length - 6}`);
    await batchTimers[6].callback();
    assert(batchCompressionCalls === 1, `New-file compression was not coalesced into one batch: ${batchCompressionCalls}`);
    assert(batchCompressionSize === 6, `New-file batch size was wrong: ${batchCompressionSize}`);

    const duplicateFile = batchFiles.values().next().value;
    await plugin.handleNewFile(duplicateFile);
    const firstDuplicateTimer = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    await plugin.handleNewFile(duplicateFile);
    assert(firstDuplicateTimer.cleared === true, "Duplicate create event did not cancel the older timer");
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 1, "Duplicate create event left more than one timer for the same path");
    const timerBeforeModify = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    await plugin.app._vaultHandlers.modify(duplicateFile);
    const timerAfterModify = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    assert(timerBeforeModify.cleared === true, "Modify event did not cancel a pending new-file compression timer");
    assert(timerAfterModify && timerAfterModify !== timerBeforeModify, "Modify event did not re-arm pending new-file compression");
    await timerAfterModify.callback();
    const drainTimerBeforePendingModify = plugin.newFileQueue.newFileBatchFlushTimer;
    assert(plugin.newFileQueue.newFileCompressionPending.has(duplicateFile.path), "New-file timer did not move path into pending batch");
    await plugin.app._vaultHandlers.modify(duplicateFile);
    const timerAfterPendingModify = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    assert(drainTimerBeforePendingModify.cleared === true, "Modify event did not cancel the pending-drain timer");
    assert(!plugin.newFileQueue.newFileCompressionPending.has(duplicateFile.path), "Modify event left a stale pending new-file path");
    assert(timerAfterPendingModify && timerAfterPendingModify !== timerAfterModify, "Modify event did not re-arm from the pending-drain window");
    await drainTimerBeforePendingModify.callback();
    assert(batchCompressionCalls === 1, "Cleared pending-drain timer still compressed a modified new file");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFileBatch;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForNewFileBatch;
    plugin.processBatchCompressionBackground = originalProcessBatchCompressionBackground;
    plugin.app.vault.getFileByPath = originalGetFileByPathForNewFileBatch;
    plugin.settings.autoCompressNewFiles = false;
    plugin.isUnloading = false;
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    plugin.newFileQueue.newFileBatchFlushTimer = null;
    plugin.newFileQueue.newFileBatchDrainInProgress = false;
    plugin.newFileQueue.newFileBatchDrainRescheduleRequested = false;
    plugin.newFileQueue.newFileBatchFirstQueuedAt = null;
  }

  const originalSetWindowTimeoutForDrainOverlap = plugin.setWindowTimeout;
  const originalProcessBatchForDrainOverlap = plugin.processBatchCompressionBackground;
  const originalGetFileByPathForDrainOverlap = plugin.app.vault.getFileByPath;
  const drainOverlapTimers = [];
  let activeDrainBatches = 0;
  let maxActiveDrainBatches = 0;
  let drainBatchCalls = 0;
  let releaseFirstDrain = null;
  let firstDrainStarted = null;
  const firstDrainStartedPromise = new Promise((resolve) => {
    firstDrainStarted = resolve;
  });
  try {
    const firstDrainFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/drain-overlap-a.png", 100000, 30));
    const secondDrainFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/drain-overlap-b.png", 100000, 31));
    const drainFiles = new Map([
      [firstDrainFile.path, firstDrainFile],
      [secondDrainFile.path, secondDrainFile]
    ]);
    plugin.app.vault.getFileByPath = (filePath) => drainFiles.get(filePath) || null;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      drainOverlapTimers.push(timer);
      return timer;
    };
    plugin.processBatchCompressionBackground = async () => {
      drainBatchCalls += 1;
      activeDrainBatches += 1;
      maxActiveDrainBatches = Math.max(maxActiveDrainBatches, activeDrainBatches);
      if (drainBatchCalls === 1) {
        firstDrainStarted();
        await new Promise((resolve) => {
          releaseFirstDrain = resolve;
        });
      }
      activeDrainBatches -= 1;
    };
    plugin.newFileQueue.newFileCompressionPending.add(firstDrainFile.path);
    const firstDrain = plugin.drainNewFileCompressionBatch();
    await firstDrainStartedPromise;
    plugin.newFileQueue.newFileCompressionPending.add(secondDrainFile.path);
    plugin.scheduleNewFileBatchDrain();
    assert(drainOverlapTimers.length === 0, "scheduleNewFileBatchDrain() scheduled an overlapping drain while one was active");
    releaseFirstDrain();
    await firstDrain;
    assert(drainOverlapTimers.length === 1, "Completed drain did not schedule the pending follow-up batch");
    drainOverlapTimers[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    assert(drainBatchCalls === 2, `Expected serialized follow-up drain, got ${drainBatchCalls} batch calls`);
    assert(maxActiveDrainBatches === 1, "New-file batch drains overlapped");
  } finally {
    releaseFirstDrain?.();
    plugin.setWindowTimeout = originalSetWindowTimeoutForDrainOverlap;
    plugin.processBatchCompressionBackground = originalProcessBatchForDrainOverlap;
    plugin.app.vault.getFileByPath = originalGetFileByPathForDrainOverlap;
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    plugin.newFileQueue.newFileBatchFlushTimer = null;
    plugin.newFileQueue.newFileBatchDrainInProgress = false;
    plugin.newFileQueue.newFileBatchDrainRescheduleRequested = false;
    plugin.newFileQueue.newFileBatchFirstQueuedAt = null;
  }

  const originalSetWindowTimeoutForQueueCap = plugin.setWindowTimeout;
  const originalGetFileByPathForQueueCap = plugin.app.vault.getFileByPath;
  const originalNoticeForQueueCap = ObsidianMock.Notice;
  const originalProcessBatchForQueueCap = plugin.processBatchCompressionBackground;
  const originalQueueCap = plugin.newFileQueue.NEW_FILE_PENDING_MAX;
  const queueCapTimers = [];
  const queueCapNotices = [];
  try {
    plugin.settings.autoCompressNewFiles = true;
    plugin.newFileQueue.NEW_FILE_PENDING_MAX = 2;
    plugin.newFileQueue.newFilePendingOverflowWarned = false;
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    const capFiles = new Map(Array.from({ length: 3 }, (_, index) => {
      const file = Object.assign(new ObsidianMock.TFile(), createMockFile(`Images/queue-cap-${index}.png`, 100000, index + 40));
      return [file.path, file];
    }));
    plugin.app.vault.getFileByPath = (filePath) => capFiles.get(filePath) || null;
    plugin.processBatchCompressionBackground = async () => {};
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      queueCapTimers.push(timer);
      return timer;
    };
    ObsidianMock.Notice = class {
      constructor(message, duration) {
        queueCapNotices.push({ message, duration });
      }
    };
    for (const file of capFiles.values()) {
      await plugin.handleNewFile(file);
    }
    for (const timer of queueCapTimers.slice(0, 3)) {
      await timer.callback();
    }
    assert(plugin.newFileQueue.newFileCompressionPending.size === 2, "New-file pending queue exceeded its cap");
    assert(plugin.newFileQueue.newFilePendingOverflowWarned === true, "New-file queue cap did not set overflow warning state");
    assert(queueCapNotices.some((notice) => String(notice.message).includes("2") && notice.duration === 10000), "New-file queue overflow did not show a user Notice");
    plugin.newFileQueue.newFileBatchFlushTimer = null;
    await plugin.drainNewFileCompressionBatch();
    assert(plugin.newFileQueue.newFileCompressionPending.size === 0, "New-file queue cap drain did not clear pending paths");
    assert(plugin.newFileQueue.newFilePendingOverflowWarned === false, "New-file queue cap warning state did not reset after drain");
    const noticeCountAfterFirstOverflow = queueCapNotices.length;
    const nextTimerStart = queueCapTimers.length;
    for (const file of capFiles.values()) {
      await plugin.handleNewFile(file);
    }
    for (const timer of queueCapTimers.slice(nextTimerStart)) {
      await timer.callback();
    }
    assert(queueCapNotices.length > noticeCountAfterFirstOverflow, "New-file queue cap did not notify again after a completed drain cycle");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForQueueCap;
    plugin.app.vault.getFileByPath = originalGetFileByPathForQueueCap;
    ObsidianMock.Notice = originalNoticeForQueueCap;
    plugin.processBatchCompressionBackground = originalProcessBatchForQueueCap;
    plugin.newFileQueue.NEW_FILE_PENDING_MAX = originalQueueCap;
    plugin.settings.autoCompressNewFiles = false;
    plugin.newFileQueue.newFilePendingOverflowWarned = false;
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    plugin.newFileQueue.newFileBatchFlushTimer = null;
  }

  const originalRunCompressionBatchForBackgroundNotice = plugin.runCompressionBatch;
  const originalMaybeAutoMoveForBackgroundNotice = plugin.maybeAutoMoveCompressed;
  const originalNoticeForBackgroundNotice = ObsidianMock.Notice;
  const backgroundNotices = [];
  try {
    ObsidianMock.Notice = class {
      constructor(message, duration) {
        backgroundNotices.push({ message, duration });
      }
    };
    plugin.runCompressionBatch = async () => ({ compressed: 2 });
    plugin.maybeAutoMoveCompressed = async () => {};
    plugin.backgroundCompressionNoticeAt = 0;
    await plugin.processBatchCompressionBackground(Array.from({ length: 5 }, (_, index) => createMockFile(`Images/background-${index}.jpg`, 100000, index + 50)));
    assert(backgroundNotices.some((notice) => String(notice.message).includes("5") && notice.duration === 3000), "Background compression did not show a start Notice");
    assert(backgroundNotices.some((notice) => String(notice.message).includes("2") && notice.duration === 5000), "Background compression did not show a finish Notice");
    const noticesAfterFirstBackgroundRun = backgroundNotices.length;
    await plugin.processBatchCompressionBackground(Array.from({ length: 5 }, (_, index) => createMockFile(`Images/background-again-${index}.jpg`, 100000, index + 70)));
    assert(backgroundNotices.length === noticesAfterFirstBackgroundRun, "Background compression notices were not rate-limited for a repeated threshold trigger");
  } finally {
    plugin.runCompressionBatch = originalRunCompressionBatchForBackgroundNotice;
    plugin.maybeAutoMoveCompressed = originalMaybeAutoMoveForBackgroundNotice;
    plugin.backgroundCompressionNoticeAt = 0;
    ObsidianMock.Notice = originalNoticeForBackgroundNotice;
  }

  const originalRunLimitedForUnload = plugin.runLimitedCompression;
  const originalAddToCacheForUnload = plugin.cache.addToCache;
  const originalIsProcessedForUnload = plugin.cache.isFileAlreadyProcessed;
  const originalUpdateStatusBarForUnload = plugin.updateStatusBar;
  let unloadBatchCacheWrites = 0;
  try {
    plugin.isUnloading = false;
    plugin.settings.allowedRoots = [];
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.addToCache = async () => {
      unloadBatchCacheWrites += 1;
    };
    plugin.updateStatusBar = async () => {};
    plugin.runLimitedCompression = async () => {
      plugin.isUnloading = true;
      return { success: true, savings: 50 };
    };
    await plugin.processBatchCompression([createMockFile("Images/unload-batch.png", 100000, 1)], "Unload smoke");
    assert(unloadBatchCacheWrites === 0, "Batch compression wrote cache after plugin unload");
  } finally {
    plugin.runLimitedCompression = originalRunLimitedForUnload;
    plugin.cache.addToCache = originalAddToCacheForUnload;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForUnload;
    plugin.updateStatusBar = originalUpdateStatusBarForUnload;
    plugin.isUnloading = false;
  }

  const originalEnsureWasmReadyForBatch = plugin.compressor.ensureWasmReady;
  const originalRunLimitedForInitFailure = plugin.runLimitedCompression;
  const originalCompressorCompressForInitFailure = plugin.compressor.compress;
  const originalHandleSkippedCompressionForInitFailure = plugin.handleSkippedCompression;
  const originalIsProcessedForInitFailure = plugin.cache.isFileAlreadyProcessed;
  const originalVaultReadBinaryForInitFailure = plugin.app.vault.readBinary;
  const originalFilesForInitFailure = plugin.app._files;
  const originalSaveCacheForInitFailure = plugin.cache.saveCache;
  const originalAddSkippedEntryForInitFailure = plugin.cache.addSkippedEntry;
  try {
    let fatalInitCalls = 0;
    let compressionCallsBeforeInitFailure = 0;
    let initFailureCacheChecks = 0;
    plugin.compressor.compress = async () => ({
      success: false,
      error: "simulated wasm init failure",
      skipReason: "wasm_init_failed"
    });
    plugin.cache.isFileAlreadyProcessed = async () => {
      initFailureCacheChecks += 1;
      if (initFailureCacheChecks > 1) {
        await new Promise((resolve) => originalGlobals.setTimeout(resolve, 10));
      }
      return false;
    };
    plugin.runLimitedCompression = async (task) => {
      compressionCallsBeforeInitFailure += 1;
      return await task();
    };
    const initFailureResult = await plugin.runCompressionBatch([
      createMockFile("Images/init-a.png", 100000, 1),
      createMockFile("Images/init-b.png", 100000, 2),
      createMockFile("Images/init-c.png", 100000, 3),
      createMockFile("Images/init-d.png", 100000, 4)
    ], {
      onFatalError: async () => {
        fatalInitCalls += 1;
      }
    });
    assert(fatalInitCalls === 1, "WASM init failure was not reported exactly once for the batch");
    assert(compressionCallsBeforeInitFailure === 1, `Fatal init failure did not stop later compression attempts: ${compressionCallsBeforeInitFailure}`);
    assert(initFailureResult.processed === 0, "Batch compression advanced progress after WASM init failure");
    assert(initFailureResult.skippedErrors === 4, "Batch init failure did not account for all skipped errors");

    let ensureCallsForTooLarge = 0;
    let compressionCallsForTooLarge = 0;
    plugin.compressor.compress = originalCompressorCompressForInitFailure;
    plugin.compressor.ensureWasmReady = async () => {
      ensureCallsForTooLarge += 1;
      throw new Error("too-large file should not initialize wasm");
    };
    plugin.runLimitedCompression = async (task) => {
      compressionCallsForTooLarge += 1;
      return await task();
    };
	    plugin.handleSkippedCompression = originalHandleSkippedCompressionForInitFailure;
	    plugin.cache.saveCache = async () => true;
	    plugin.cache.addSkippedEntry = async () => true;
	    const tooLargeFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/init-too-large.png", plugin.compressor.maxInputBytes + 1, 3));
	    await setMockFiles(plugin, [tooLargeFile]);
	    let tooLargeBookkeepingReads = 0;
	    plugin.app.vault.readBinary = async () => {
	      tooLargeBookkeepingReads += 1;
	      throw new Error("too_large workflow must not read binary content");
	    };
	    const tooLargeResult = await plugin.runCompressionBatch([tooLargeFile]);
	    assert(compressionCallsForTooLarge === 1, "Too-large file did not exercise compressor preflight");
	    assert(ensureCallsForTooLarge === 0, "Too-large batch item initialized WASM before compressor preflight skipped it");
	    assert(tooLargeResult.skippedValidation === 1 && tooLargeResult.skippedErrors === 0, "Too-large batch item was not handled as validation skip");
	    plugin.cache.cacheData.entries = {};
	    await plugin.compressFile(tooLargeFile);
	    plugin.cache.cacheData.entries = {};
	    await plugin.autoCompressNewFile(tooLargeFile);
	    assert(compressionCallsForTooLarge === 3, `Too-large manual/auto/batch paths did not all reach compressor preflight: ${compressionCallsForTooLarge}`);
	    assert(tooLargeBookkeepingReads === 0 && ensureCallsForTooLarge === 0, "too_large manual/auto/batch path read bytes or initialized WASM");
	    plugin.cache.addSkippedEntry = async () => false;
	    const failedTooLargeCommit = await plugin.runCompressionBatch([tooLargeFile]);
	    assert(failedTooLargeCommit.skippedValidation === 0 && failedTooLargeCommit.skippedErrors === 1, "Failed too_large cache commit was still counted as a durable validation skip");
  } finally {
    plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForBatch;
    plugin.runLimitedCompression = originalRunLimitedForInitFailure;
    plugin.compressor.compress = originalCompressorCompressForInitFailure;
	    plugin.handleSkippedCompression = originalHandleSkippedCompressionForInitFailure;
	    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForInitFailure;
	    plugin.app.vault.readBinary = originalVaultReadBinaryForInitFailure;
	    plugin.app._files = originalFilesForInitFailure;
	    plugin.cache.saveCache = originalSaveCacheForInitFailure;
	    plugin.cache.addSkippedEntry = originalAddSkippedEntryForInitFailure;
  }

  const originalRunLimitedForProgress = plugin.runLimitedCompression;
  const originalCompressorCompressForProgress = plugin.compressor.compress;
  const originalIsProcessedForProgress = plugin.cache.isFileAlreadyProcessed;
  const originalAddCompressionArtifactForProgress = plugin.cache.addCompressionArtifact;
  const originalUpdateImageIndexForProgress = plugin.updateImageIndexForFile;
  const originalStatusBarUpdateForProgress = plugin.statusBarController.update;
  const originalMaybeAutoMoveForProgress = plugin.maybeAutoMoveCompressed;
  const originalCacheCreateBackupForProgress = plugin.cache.createBackup;
  const originalUpdateSavingsForProgress = plugin.updateSavingsIndicatorInSettings;
  try {
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.addCompressionArtifact = async () => true;
    plugin.updateImageIndexForFile = async () => {};
    plugin.statusBarController.update = async () => {};
    plugin.maybeAutoMoveCompressed = async () => {};
    plugin.runLimitedCompression = async (task) => task();
    plugin.compressor.compress = async (file, _settings, operation) => {
      const delay = file.name.includes("slow") ? 40 : 0;
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, delay));
      return createCompressionSuccess(file, operation);
    };
    const progressUpdates = [];
    await plugin.runCompressionBatch([
      createMockFile("Images/slow-progress.jpg", 100000, 1),
      createMockFile("Images/fast-progress-a.jpg", 100000, 2),
      createMockFile("Images/fast-progress-b.jpg", 100000, 3)
    ], {
      onCompressed: async (_file, processed) => {
        progressUpdates.push(processed);
      },
      onCacheUpdated: async (_file, processed) => {
        progressUpdates.push(processed);
      }
    });
    assert(
      JSON.stringify(progressUpdates) === JSON.stringify([1, 1, 2, 2, 3, 3]),
      `Parallel batch progress was not completion-based and monotonic: ${progressUpdates.join(",")}`
    );

    let failedSuccessCallbacks = 0;
    let unexpectedErrorCallbacks = 0;
    plugin.compressor.compress = async (file, _settings, operation) => createCompressionSuccess(file, operation);
    plugin.updateImageIndexForFile = async () => {
      throw new Error("post-commit index failure");
    };
    plugin.cache.createBackup = async () => {
      throw new Error("post-commit backup failure");
    };
    plugin.updateSavingsIndicatorInSettings = async () => {
      throw new Error("post-commit savings failure");
    };
    const reportingFailureResult = await plugin.runCompressionBatch([
      createMockFile("Images/reporting-failure.jpg", 100000, 4)
    ], {
      onCompressed: async () => {
        failedSuccessCallbacks += 1;
        throw new Error("post-commit success callback failure");
      },
      onCacheUpdated: async () => {
        failedSuccessCallbacks += 1;
        throw new Error("post-commit cache callback failure");
      },
      onError: async () => {
        unexpectedErrorCallbacks += 1;
        throw new Error("unexpected error callback failure");
      }
    });
    assert(
      reportingFailureResult.compressed === 1
        && reportingFailureResult.processed === 1
        && reportingFailureResult.skippedErrors === 0,
      `Post-commit reporting failure changed terminal batch counters: ${JSON.stringify(reportingFailureResult)}`
    );
    assert(failedSuccessCallbacks === 2 && unexpectedErrorCallbacks === 0, "Post-commit reporting callbacks did not remain isolated");
    plugin.updateImageIndexForFile = async () => {};
    plugin.cache.createBackup = originalCacheCreateBackupForProgress;
    plugin.updateSavingsIndicatorInSettings = originalUpdateSavingsForProgress;

    global.__progressWidthUpdates = [];
    await plugin.processBatchCompression([
      createMockFile("Images/slow-modal-progress.jpg", 100000, 1),
      createMockFile("Images/fast-modal-progress-a.jpg", 100000, 2),
      createMockFile("Images/fast-modal-progress-b.jpg", 100000, 3)
    ], "Modal progress smoke");
    const modalWidthPercentages = global.__progressWidthUpdates
      .map((value) => Number.parseFloat(String(value)))
      .filter((value) => Number.isFinite(value));
    for (let index = 1; index < modalWidthPercentages.length; index++) {
      assert(
        modalWidthPercentages[index] >= modalWidthPercentages[index - 1],
        `Modal progress width moved backward under parallel compression: ${modalWidthPercentages.join(",")}`
      );
    }
    assert(
      modalWidthPercentages.length > 0 && modalWidthPercentages[modalWidthPercentages.length - 1] === 100,
      `Modal progress did not complete at 100%: ${modalWidthPercentages.join(",")}`
    );

    let modalAutoMoveAfterStatusFailure = 0;
    plugin.statusBarController.update = async () => {
      throw new Error("post-batch status failure");
    };
    plugin.maybeAutoMoveCompressed = async () => {
      modalAutoMoveAfterStatusFailure += 1;
    };
    await plugin.processBatchCompression([
      createMockFile("Images/modal-post-commit-failure.jpg", 100000, 5)
    ], "Modal post-commit failure smoke");
    assert(modalAutoMoveAfterStatusFailure === 1, "Post-batch status failure suppressed auto-move");
    plugin.statusBarController.update = async () => {};
    plugin.maybeAutoMoveCompressed = async () => {};

    const cancellationController = new AbortController();
    let cancellationCompressionCalls = 0;
    let cancellationLimiterTail = Promise.resolve();
    plugin.runLimitedCompression = async (task) => {
      const previous = cancellationLimiterTail;
      let releaseCurrent = null;
      cancellationLimiterTail = new Promise((resolve) => {
        releaseCurrent = resolve;
      });
      await previous;
      try {
        return await task();
      } finally {
        releaseCurrent();
      }
    };
    plugin.compressor.compress = async (file, _settings, operation) => {
      cancellationCompressionCalls += 1;
      cancellationController.abort();
      return createCompressionSuccess(file, operation);
    };
    const cancellationResult = await plugin.runCompressionBatch([
      createMockFile("Images/cancel-a.jpg", 100000, 10),
      createMockFile("Images/cancel-b.jpg", 100000, 11),
      createMockFile("Images/cancel-c.jpg", 100000, 12),
      createMockFile("Images/cancel-d.jpg", 100000, 13)
    ], {
      signal: cancellationController.signal
    });
    assert(cancellationResult.cancelled === true, "Batch cancellation did not mark the result as cancelled");
    assert(cancellationCompressionCalls === 1, `Batch cancellation allowed ${cancellationCompressionCalls} compression calls`);
    assert(cancellationResult.compressed === 1, `Batch cancellation did not preserve the completed in-flight item: ${cancellationResult.compressed}`);
    assert(cancellationResult.processed === 1, `Batch cancellation advanced progress after cancellation: ${cancellationResult.processed}`);
    assert(cancellationResult.skippedErrors === 0, "Batch cancellation was counted as an error");

    plugin.runLimitedCompression = async (task) => await task();
    plugin.compressor.compress = async (file, _settings, operation) => createCompressionSuccess(file, operation);
    plugin.cache.addCompressionArtifact = async () => false;
    let artifactCommitErrors = 0;
    let artifactCommitSuccessCallbacks = 0;
    const artifactCommitFailureResult = await plugin.runCompressionBatch([
      createMockFile("Images/artifact-commit-failure.jpg", 100000, 14)
    ], {
      onCompressed: async () => {
        artifactCommitSuccessCallbacks += 1;
      },
      onError: async (_file, _processed, _total, error) => {
        if (String(error?.message || error).includes("Compression artifact could not be committed")) {
          artifactCommitErrors += 1;
        }
      }
    });
    assert(artifactCommitFailureResult.compressed === 0 && artifactCommitFailureResult.skippedErrors === 1, "Failed artifact commit was counted as compressed");
    assert(artifactCommitErrors === 1 && artifactCommitSuccessCallbacks === 0, "Failed artifact commit did not surface exactly once or still ran success callbacks");
  } finally {
    delete global.__progressWidthUpdates;
    plugin.runLimitedCompression = originalRunLimitedForProgress;
    plugin.compressor.compress = originalCompressorCompressForProgress;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForProgress;
    plugin.cache.addCompressionArtifact = originalAddCompressionArtifactForProgress;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForProgress;
    plugin.statusBarController.update = originalStatusBarUpdateForProgress;
    plugin.maybeAutoMoveCompressed = originalMaybeAutoMoveForProgress;
    plugin.cache.createBackup = originalCacheCreateBackupForProgress;
    plugin.updateSavingsIndicatorInSettings = originalUpdateSavingsForProgress;
  }

  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = originalGlobals.setTimeout;
  global.clearTimeout = originalGlobals.clearTimeout;
  const wasmCompressionTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-wasm-"));
  const preWasmVaultReadBinary = plugin.app.vault.readBinary;
  const originalVaultBasePath = plugin.app.vault.adapter.basePath;
  const originalVaultAbsolutePath = plugin.app.vault.adapter.path.absolute;
  const originalWorkerFactory = plugin.compressor.workerFactory;
  const originalWorkerPool = plugin.compressor.workerPool;
  const originalActiveWorkerCount = plugin.compressor.activeWorkerCount;
  const originalProcessTimeoutMs = plugin.compressor.processTimeoutMs;
  const originalInitTimeoutMs = plugin.compressor.initTimeoutMs;
  const originalMaxInputBytes = plugin.compressor.maxInputBytes;
  const originalMaxImagePixels = plugin.compressor.maxImagePixels;
  const originalPngQuality = plugin.settings.pngQuality;
  const originalJpegQuality = plugin.settings.jpegQuality;
  const originalOutputFolder = plugin.settings.outputFolder;
  try {
    pointMockVaultAtPath(plugin.app, wasmCompressionTemp);
    const originalVaultReadBinary = plugin.app.vault.readBinary;
    plugin.settings.outputFolder = "Compressed";

    const previousBlob = global.Blob;
    const previousWorker = global.Worker;
    const previousCreateObjectURL = global.URL?.createObjectURL;
    const previousRevokeObjectURL = global.URL?.revokeObjectURL;
    try {
      const blobWorkerEvents = {
        blobParts: null,
        blobType: "",
        workerUrl: "",
        createdUrl: "",
        revokedUrl: ""
      };
      global.Blob = class {
        constructor(parts, options = {}) {
          blobWorkerEvents.blobParts = parts;
          blobWorkerEvents.blobType = options.type || "";
        }
      };
      global.URL.createObjectURL = (blob) => {
        assert(blob, "Blob worker smoke did not receive a Blob");
        blobWorkerEvents.createdUrl = "blob:local-image-compress-smoke";
        return blobWorkerEvents.createdUrl;
      };
      global.URL.revokeObjectURL = (url) => {
        blobWorkerEvents.revokedUrl = url;
      };
      global.Worker = class {
        constructor(url) {
          blobWorkerEvents.workerUrl = url;
          this.messages = [];
          this.terminateCalls = 0;
        }
        postMessage(message) {
          this.messages.push(message);
          if (message?.type === "init") {
            setImmediate(() => this.onmessage?.({ data: { id: message.id, type: "ready" } }));
          }
        }
        terminate() {
          this.terminateCalls += 1;
        }
      };
      await replaceCompressorWorkerPool(plugin, null, 1);
      await plugin.compressor.ensureWasmReady();
      assert(blobWorkerEvents.blobType === "text/javascript", "Blob worker smoke used the wrong MIME type");
      assert(Array.isArray(blobWorkerEvents.blobParts) && String(blobWorkerEvents.blobParts[0] || "").includes("onmessage"), "Blob worker smoke did not wrap the worker source in a Blob");
      assert(blobWorkerEvents.workerUrl === blobWorkerEvents.createdUrl, "Blob worker smoke did not construct Worker from the object URL");
      assert(blobWorkerEvents.revokedUrl === blobWorkerEvents.createdUrl, "Blob worker smoke did not revoke the object URL after initialization");
    } finally {
      if (previousBlob === undefined) {
        delete global.Blob;
      } else {
        global.Blob = previousBlob;
      }
      if (previousWorker === undefined) {
        delete global.Worker;
      } else {
        global.Worker = previousWorker;
      }
      if (previousCreateObjectURL === undefined) {
        delete global.URL.createObjectURL;
      } else {
        global.URL.createObjectURL = previousCreateObjectURL;
      }
      if (previousRevokeObjectURL === undefined) {
        delete global.URL.revokeObjectURL;
      } else {
        global.URL.revokeObjectURL = previousRevokeObjectURL;
      }
    }

    const initFailedWorkers = [];
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([{ initError: "simulated init failure" }], initFailedWorkers), 1);
    let initFailed = false;
    try {
      await plugin.compressor.ensureWasmReady();
    } catch (error) {
      initFailed = String(error?.message || error).includes("simulated init failure");
    }
    assert(initFailed, "Worker init-failed smoke did not surface the init error");
    assert(initFailedWorkers[0].terminateCalls === 1, "Worker init-failed smoke did not terminate the failed worker");

    const initTimeoutWorkers = [];
    plugin.compressor.initTimeoutMs = 10;
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([{ noInitResponse: true }], initTimeoutWorkers), 1);
    const initTimeoutStartedAt = Date.now();
    await plugin.compressor.ensureWasmReady();
    const initTimeoutElapsedMs = Date.now() - initTimeoutStartedAt;
    assert(initTimeoutElapsedMs < 500, `Worker init timeout took too long: ${initTimeoutElapsedMs}ms`);
    assert(initTimeoutWorkers[0].terminateCalls === 1, "Worker init timeout did not terminate the hung worker");
    assert(initTimeoutWorkers.length === 2, "Worker init timeout did not lazily recreate a replacement worker");
    assert(getCompressorSlots(plugin)[0].isReady(), "Worker init timeout replacement worker did not become ready");
    plugin.compressor.initTimeoutMs = originalInitTimeoutMs;

    const transferValidationWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([{
      compressResponses: [
        { output: createValidEncodedOutput("jpeg") }
      ]
    }], transferValidationWorkers));
    const transferSlot = getCompressorSlots(plugin)[0];
    const transferSource = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const transferView = transferSource.subarray(2, 5);
    await transferSlot.runCompression("jpeg", transferView, plugin.settings);
    const postedTransferMessage = transferValidationWorkers[0].messages.find((message) => message.type === "compress");
    assert(postedTransferMessage, "WorkerSlot did not post a compression message for typed-array input");
    const postedTransferList = transferValidationWorkers[0].transfers.find((transfer) => transfer[0] === postedTransferMessage.buffer);
    assert(postedTransferMessage.buffer instanceof ArrayBuffer, "WorkerSlot did not convert a typed-array view to ArrayBuffer before postMessage");
    assert(postedTransferMessage.buffer.byteLength === transferView.byteLength, "WorkerSlot transferred the typed-array backing buffer instead of the view range");
    assert(postedTransferMessage.buffer !== transferSource.buffer, "WorkerSlot reused the caller's typed-array backing buffer");
    assert(postedTransferList && postedTransferList.length === 1, "WorkerSlot did not transfer the normalized ArrayBuffer");
    for (const invalidInput of ["not-buffer", null, new ArrayBuffer(0)]) {
      let rejectedInvalidInput = false;
      try {
        await transferSlot.runCompression("png", invalidInput, plugin.settings);
      } catch (error) {
        rejectedInvalidInput = error instanceof TypeError && /Expected/.test(String(error.message));
      }
      assert(rejectedInvalidInput, `WorkerSlot accepted invalid compression buffer: ${invalidInput}`);
      assert(transferSlot.isBusy() === false, "WorkerSlot leaked reservation after invalid compression buffer");
    }
    if (typeof structuredClone === "function") {
      const detachedBuffer = new ArrayBuffer(8);
      structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
      let rejectedDetachedBuffer = false;
      try {
        await transferSlot.runCompression("png", detachedBuffer, plugin.settings);
      } catch (error) {
        rejectedDetachedBuffer = error instanceof TypeError && /detached/.test(String(error.message));
      }
      assert(rejectedDetachedBuffer, "WorkerSlot accepted a detached compression buffer");
      assert(transferSlot.isBusy() === false, "WorkerSlot leaked reservation after detached compression buffer");
    }

    const compressionWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([{
      compressResponses: [
        { output: createValidEncodedOutput("jpeg") },
        { output: createValidEncodedOutput("png") },
        { error: { kind: "quality_failed", message: "QUALITY_TOO_LOW", skipReason: "pngquant_quality_failed" } },
        { output: createValidEncodedOutput("jpeg", 512) }
      ]
    }], compressionWorkers));
    assert(compressionWorkers.length === 1, "Worker smoke did not create an initial compression worker");
    assert(compressionWorkers[0].messages.some((message) => message.type === "init"), "Worker smoke did not send init message");
    const originalConsoleDebugForUnhandledWorkerMessage = console.debug;
    let unhandledWorkerMessageLog = null;
    try {
      console.debug = (...args) => {
        if (String(args[1] || "").includes("Unhandled worker message")) {
          unhandledWorkerMessageLog = args;
        }
      };
      getCompressorSlots(plugin)[0].handleWorkerMessage({ type: "compress-reply", id: 999 });
      assert(unhandledWorkerMessageLog, "WorkerSlot did not log an unhandled worker message");
      assert(unhandledWorkerMessageLog[2]?.type === "compress-reply", "Unhandled worker message log omitted the message type");
      assert(unhandledWorkerMessageLog[2]?.expecting?.init === null && unhandledWorkerMessageLog[2]?.expecting?.job === null, "Unhandled worker message log omitted expected ids");
    } finally {
      console.debug = originalConsoleDebugForUnhandledWorkerMessage;
    }

    const previousWindowExists = Object.prototype.hasOwnProperty.call(global, "window");
    const previousGlobalWindow = global.window;
    const previousActiveWindow = plugin.app.workspace.activeWindow;
    // The fallback host captures the module-load globals; the artifact loaded
    // under stubbed timers, so re-point the stub at real timers for this test.
    const stubbedSetTimeoutForFallback = global.setTimeout;
    const stubbedClearTimeoutForFallback = global.clearTimeout;
    try {
      delete global.window;
      plugin.app.workspace.activeWindow = undefined;
      global.setTimeout = originalGlobals.setTimeout;
      global.clearTimeout = originalGlobals.clearTimeout;
      let fallbackTimerFired = false;
      await new Promise((resolve) => {
        getCompressorSlots(plugin)[0].setWorkerTimeout(() => {
          fallbackTimerFired = true;
          resolve();
        }, 0);
      });
      assert(fallbackTimerFired, "Worker timer fallback did not use global timers when window was unavailable");
    } finally {
      global.setTimeout = stubbedSetTimeoutForFallback;
      global.clearTimeout = stubbedClearTimeoutForFallback;
      if (previousWindowExists) {
        global.window = previousGlobalWindow;
      } else {
        delete global.window;
      }
      plugin.app.workspace.activeWindow = previousActiveWindow;
    }

    const fixtureCodecs = await getFixtureCodecs();
    const jpegInput = await fixtureCodecs.jpegEncode(createPatternImageData(96, 96, "gradient"), { quality: 95 });
    plugin.settings.jpegQuality = 35;
    const jpegFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/wasm-smoke.jpg", new Uint8Array(jpegInput), 100);
    const jpegResult = await plugin.compressor.compress(jpegFile, plugin.settings);
    const jpegOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", "wasm-smoke.jpg");
    assert(jpegResult.success === true, `JPEG WASM compression failed: ${jpegResult.error}`);
    assert(jpegResult.savings > 0, `JPEG WASM compression did not report savings: ${jpegResult.savings}`);
    assert(fs.statSync(jpegOutputPath).size < fs.statSync(path.join(wasmCompressionTemp, "Images", "wasm-smoke.jpg")).size, "JPEG WASM output is not smaller than original");

    const pngInput = Buffer.from(await fixtureCodecs.pngEncode(createPatternImageData(480, 320, "blocks")));
    plugin.settings.pngQuality = { min: 45, max: 70 };
    const pngFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/wasm-smoke.png", pngInput, 101);
    const pngResult = await plugin.compressor.compress(pngFile, plugin.settings);
    const pngOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", "wasm-smoke.png");
    assert(pngResult.success === true, `PNG WASM compression failed: ${pngResult.error}`);
    assert(pngResult.savings > 0, `PNG WASM compression did not report savings: ${pngResult.savings}`);
    assert(fs.statSync(pngOutputPath).size < fs.statSync(path.join(wasmCompressionTemp, "Images", "wasm-smoke.png")).size, "PNG WASM output is not smaller than original");

    const complexPng = await fixtureCodecs.pngEncode(createPatternImageData(256, 256, "gradient"));
    plugin.settings.pngQuality = { min: 99, max: 99 };
    const qualityFailFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/quality-fail.png", new Uint8Array(complexPng), 102);
    const qualityFailResult = await plugin.compressor.compress(qualityFailFile, plugin.settings);
    assert(qualityFailResult.success === false, "PNG quality-fail smoke unexpectedly succeeded");
    assert(qualityFailResult.skipReason === "pngquant_quality_failed", `PNG quality-fail smoke used wrong skipReason: ${qualityFailResult.skipReason}`);

    const notSmallerFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/not-smaller.jpg", Buffer.alloc(128, 1), 103);
    const notSmallerResult = await plugin.compressor.compress(notSmallerFile, plugin.settings);
    assert(notSmallerResult.success === false, "Not-smaller smoke unexpectedly succeeded");
    assert(notSmallerResult.skipReason === "compressed_not_smaller", `Not-smaller smoke used wrong skipReason: ${notSmallerResult.skipReason}`);

    const zeroWidthPngFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/zero-width.png", createZeroWidthPng(), 116);
    const zeroWidthPngResult = await plugin.compressor.compress(zeroWidthPngFile, plugin.settings);
    assert(zeroWidthPngResult.success === false, "Zero-width PNG smoke unexpectedly succeeded");
    assert(zeroWidthPngResult.skipReason === "invalid_image_dimensions", `Zero-width PNG smoke used wrong skipReason: ${zeroWidthPngResult.skipReason}`);

    let tooLargeReadCalls = 0;
    plugin.compressor.maxInputBytes = 64;
    plugin.app.vault.readBinary = async () => {
      tooLargeReadCalls += 1;
      throw new Error("too-large input should be skipped before readBinary");
    };
    const tooLargeFile = createMockFile("Images/too-large.png", 65, 104);
    tooLargeFile.vault = plugin.app.vault;
    const tooLargeResult = await plugin.compressor.compress(tooLargeFile, plugin.settings);
    assert(tooLargeResult.success === false, "Too-large smoke unexpectedly succeeded");
    assert(tooLargeResult.skipReason === "too_large", `Too-large smoke used wrong skipReason: ${tooLargeResult.skipReason}`);
    assert(tooLargeReadCalls === 0, "Too-large smoke still read file contents before skipping");

    const originalEnsureWasmReadyForActualSize = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForActualSize = plugin.compressor.compressBuffer;
    const originalWriteStagedOutputForActualSize = plugin.compressor.writeStagedOutput;
    const originalToArrayBufferForActualSize = plugin.compressor.toArrayBuffer;
    const originalMd5HexForActualSize = plugin.compressor.hashPort.md5Hex;
    const originalSha256HexForActualSize = plugin.compressor.hashPort.sha256Hex;
    try {
      let actualSizeReadValue = new ArrayBuffer(plugin.compressor.maxInputBytes + 1);
      let actualSizeReadCalls = 0;
      let actualSizeConversionCalls = 0;
      let actualSizeHashCalls = 0;
      let actualSizeCompressCalls = 0;
      let actualSizeWriteCalls = 0;
      plugin.compressor.ensureWasmReady = async () => {};
      plugin.app.vault.readBinary = async () => {
        actualSizeReadCalls += 1;
        return actualSizeReadValue;
      };
      plugin.compressor.toArrayBuffer = function(input) {
        actualSizeConversionCalls += 1;
        return originalToArrayBufferForActualSize.call(this, input);
      };
      plugin.compressor.hashPort.md5Hex = () => {
        actualSizeHashCalls += 1;
        return MOCK_MD5;
      };
      plugin.compressor.hashPort.sha256Hex = () => {
        actualSizeHashCalls += 1;
        return "a".repeat(64);
      };
      plugin.compressor.compressBuffer = async () => {
        actualSizeCompressCalls += 1;
        return createValidEncodedOutput("jpeg");
      };
      plugin.compressor.writeStagedOutput = async () => {
        actualSizeWriteCalls += 1;
      };

      const staleArrayBufferFile = createMockFile("Images/stale-size-array-buffer.jpg", 32, 104);
      staleArrayBufferFile.vault = plugin.app.vault;
      const staleArrayBufferResult = await plugin.compressor.compress(staleArrayBufferFile, plugin.settings);
      assert(staleArrayBufferResult.success === false && staleArrayBufferResult.skipReason === "too_large", "Stale stat accepted an oversized ArrayBuffer input");

      const oversizedBacking = new Uint8Array(plugin.compressor.maxInputBytes + 1);
      actualSizeReadValue = oversizedBacking.subarray(8, 40);
      const stalePartialViewFile = createMockFile("Images/stale-size-partial-view.jpg", actualSizeReadValue.byteLength, 105);
      stalePartialViewFile.vault = plugin.app.vault;
      const stalePartialViewResult = await plugin.compressor.compress(stalePartialViewFile, plugin.settings);
      assert(stalePartialViewResult.success === false && stalePartialViewResult.skipReason === "too_large", "Stale stat accepted a partial view with an oversized retained backing buffer");
      assert(actualSizeReadCalls === 2, `Actual-size smoke performed an unexpected number of reads: ${actualSizeReadCalls}`);
      assert(actualSizeConversionCalls === 0 && actualSizeHashCalls === 0 && actualSizeCompressCalls === 0 && actualSizeWriteCalls === 0, "Actual-size rejection copied, hashed, compressed, or wrote oversized input bytes");
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForActualSize;
      plugin.compressor.compressBuffer = originalCompressBufferForActualSize;
      plugin.compressor.writeStagedOutput = originalWriteStagedOutputForActualSize;
      plugin.compressor.toArrayBuffer = originalToArrayBufferForActualSize;
      plugin.compressor.hashPort.md5Hex = originalMd5HexForActualSize;
      plugin.compressor.hashPort.sha256Hex = originalSha256HexForActualSize;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    plugin.app.vault.readBinary = originalVaultReadBinary;
    plugin.compressor.maxInputBytes = originalMaxInputBytes;
    plugin.compressor.maxImagePixels = originalMaxImagePixels;

    const originalEnsureWasmReadyForReadOrder = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForReadOrder = plugin.compressor.compressBuffer;
    const originalWriteStagedOutputForReadOrder = plugin.compressor.writeStagedOutput;
    try {
      let releaseWasmReady = null;
      let readBeforeReadyCalls = 0;
      plugin.compressor.ensureWasmReady = async () => await new Promise((resolve) => {
        releaseWasmReady = resolve;
      });
      plugin.app.vault.readBinary = async () => {
        readBeforeReadyCalls += 1;
        return toArrayBuffer(new Uint8Array(jpegInput));
      };
      plugin.compressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      plugin.compressor.writeStagedOutput = async () => {};
      const readOrderFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/read-order.jpg", new Uint8Array(jpegInput), 130);
      const readOrderPromise = plugin.compressor.compress(readOrderFile, plugin.settings);
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 0));
      assert(readBeforeReadyCalls === 0, "Compressor read file bytes before WASM readiness resolved");
      releaseWasmReady();
      const readOrderResult = await readOrderPromise;
      assert(readOrderResult.success === true, `Read-order smoke failed after WASM readiness: ${readOrderResult.error}`);
      assert(readBeforeReadyCalls === 1, "Compressor did not read file bytes after WASM readiness resolved");
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForReadOrder;
      plugin.compressor.compressBuffer = originalCompressBufferForReadOrder;
      plugin.compressor.writeStagedOutput = originalWriteStagedOutputForReadOrder;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const originalEnsureWasmReadyForReadAdmission = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForReadAdmission = plugin.compressor.compressBuffer;
    const originalWriteStagedOutputForReadAdmission = plugin.compressor.writeStagedOutput;
    try {
      plugin.compressor.ensureWasmReady = async () => {};
      plugin.compressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      plugin.compressor.writeStagedOutput = async () => {};
      let releaseFirstAdmittedRead = null;
      let admittedReadCalls = 0;
      const firstAdmittedRead = new Promise((resolve) => {
        releaseFirstAdmittedRead = resolve;
      });
      plugin.app.vault.readBinary = async () => {
        admittedReadCalls += 1;
        if (admittedReadCalls === 1) {
          return await firstAdmittedRead;
        }
        return toArrayBuffer(new Uint8Array(jpegInput));
      };
      const firstAdmissionFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/read-admission-a.jpg", new Uint8Array(jpegInput), 131);
      const secondAdmissionFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/read-admission-b.jpg", new Uint8Array(jpegInput), 132);
      const firstAdmissionPromise = plugin.compressor.compress(firstAdmissionFile, plugin.settings);
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 0));
      const expectedPreReadReservation = Math.min(plugin.compressor.memoryBudgetBytes, plugin.compressor.maxInputBytes);
      assert(plugin.compressor.memoryLimiter.activeWeight === expectedPreReadReservation, `Compressor did not reserve input memory before readBinary: ${plugin.compressor.memoryLimiter.activeWeight}`);
      const secondAdmissionPromise = plugin.compressor.compress(secondAdmissionFile, plugin.settings);
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 0));
      assert(admittedReadCalls === 1, "Compressor admitted a second full-buffer read before the first read released its reservation");
      releaseFirstAdmittedRead(toArrayBuffer(new Uint8Array(jpegInput)));
      const admissionResults = await withTestTimeout("pre-read memory admission", Promise.all([firstAdmissionPromise, secondAdmissionPromise]), 1000);
      assert(admissionResults.every((result) => result.success === true), `Pre-read admission smoke failed: ${admissionResults.map((result) => result.error).join(", ")}`);
      assert(admittedReadCalls === 2, `Pre-read admission smoke performed an unexpected number of reads: ${admittedReadCalls}`);
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForReadAdmission;
      plugin.compressor.compressBuffer = originalCompressBufferForReadAdmission;
      plugin.compressor.writeStagedOutput = originalWriteStagedOutputForReadAdmission;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const originalEnsureWasmReadyForPartialView = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForPartialView = plugin.compressor.compressBuffer;
    const originalWriteStagedOutputForPartialView = plugin.compressor.writeStagedOutput;
    const originalToArrayBufferForPartialView = plugin.compressor.toArrayBuffer;
    const originalMaxInputBytesForPartialView = plugin.compressor.maxInputBytes;
    try {
      plugin.compressor.ensureWasmReady = async () => {};
      plugin.compressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      plugin.compressor.writeStagedOutput = async () => {};
      const partialBacking = new Uint8Array(jpegInput.byteLength + 4096);
      plugin.compressor.maxInputBytes = partialBacking.byteLength;
      const partialInput = partialBacking.subarray(4, 4 + jpegInput.byteLength);
      partialInput.set(new Uint8Array(jpegInput));
      let partialCopyObserved = false;
      plugin.app.vault.readBinary = async () => partialInput;
      plugin.compressor.toArrayBuffer = function(input) {
        if (input === partialInput) {
          partialCopyObserved = true;
          const expectedCopyReservation = Math.min(
            this.memoryBudgetBytes,
            Math.max(this.maxInputBytes, partialInput.buffer.byteLength) + partialInput.byteLength
          );
          assert(this.memoryLimiter.activeWeight === expectedCopyReservation, `Partial-view copy started with ${this.memoryLimiter.activeWeight} reserved bytes instead of ${expectedCopyReservation}`);
        }
        return originalToArrayBufferForPartialView.call(this, input);
      };
      const partialViewFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/partial-view.jpg", new Uint8Array(jpegInput), 132);
      const partialViewResult = await plugin.compressor.compress(partialViewFile, plugin.settings);
      assert(partialViewResult.success === true, `Partial typed-array compression failed: ${partialViewResult.error}`);
      assert(partialCopyObserved, "Partial typed-array compression did not exercise the owned ArrayBuffer copy path");
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForPartialView;
      plugin.compressor.compressBuffer = originalCompressBufferForPartialView;
      plugin.compressor.writeStagedOutput = originalWriteStagedOutputForPartialView;
      plugin.compressor.toArrayBuffer = originalToArrayBufferForPartialView;
      plugin.compressor.maxInputBytes = originalMaxInputBytesForPartialView;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const originalEnsureWasmReadyForReadTimeout = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForReadTimeout = plugin.compressor.compressBuffer;
    const originalWriteStagedOutputForReadTimeout = plugin.compressor.writeStagedOutput;
    try {
      plugin.compressor.processTimeoutMs = 10;
      plugin.compressor.ensureWasmReady = async () => {};
      plugin.compressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      plugin.compressor.writeStagedOutput = async () => {};
      let releaseLateRead = null;
      let readTimeoutCalls = 0;
      const lateReadPromise = new Promise((resolve) => {
        releaseLateRead = resolve;
      });
      plugin.app.vault.readBinary = async () => {
        readTimeoutCalls += 1;
        if (readTimeoutCalls === 1) {
          return await lateReadPromise;
        }
        return toArrayBuffer(new Uint8Array(jpegInput));
      };
      const readTimeoutFile = createMockFile("Images/read-timeout.jpg", 1000, 131);
      readTimeoutFile.vault = plugin.app.vault;
      const readTimeoutResult = await plugin.compressor.compress(readTimeoutFile, plugin.settings);
      assert(readTimeoutResult.success === false, "Read-timeout smoke unexpectedly succeeded");
      assert(String(readTimeoutResult.error || "").includes("File read timed out after 10ms"), `Read-timeout smoke returned wrong error: ${readTimeoutResult.error}`);
      const queuedAfterTimeoutFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/read-after-timeout.jpg", new Uint8Array(jpegInput), 132);
      const queuedAfterTimeoutPromise = plugin.compressor.compress(queuedAfterTimeoutFile, plugin.settings);
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 0));
      assert(readTimeoutCalls === 1, "A timed-out native read released buffered read admission before the native promise settled");
      releaseLateRead(toArrayBuffer(new Uint8Array(jpegInput)));
      const queuedAfterTimeoutResult = await withTestTimeout("read admission after late timeout settlement", queuedAfterTimeoutPromise, 1000);
      assert(queuedAfterTimeoutResult.success === true, `Compression queued behind a timed-out read did not resume: ${queuedAfterTimeoutResult.error}`);
      assert(readTimeoutCalls === 2, `Queued compression performed an unexpected number of reads: ${readTimeoutCalls}`);
    } finally {
      plugin.compressor.processTimeoutMs = originalProcessTimeoutMs;
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForReadTimeout;
      plugin.compressor.compressBuffer = originalCompressBufferForReadTimeout;
      plugin.compressor.writeStagedOutput = originalWriteStagedOutputForReadTimeout;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const originalEnsureWasmReadyForSourceCas = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForSourceCas = plugin.compressor.compressBuffer;
    const originalWriteStagedOutputForSourceCas = plugin.compressor.writeStagedOutput;
    try {
      plugin.compressor.ensureWasmReady = async () => {};
      let releaseSourceCasEncode = null;
      let sourceCasEncodeStarted = null;
      const sourceCasEncodeStartedPromise = new Promise((resolve) => {
        sourceCasEncodeStarted = resolve;
      });
      plugin.compressor.compressBuffer = async () => {
        sourceCasEncodeStarted();
        return await new Promise((resolve) => {
          releaseSourceCasEncode = resolve;
        });
      };
      let sourceCasWriteCalled = false;
      plugin.compressor.writeStagedOutput = async () => {
        sourceCasWriteCalled = true;
      };
      const sourceCasFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/source-cas.jpg", new Uint8Array(jpegInput), 133);
      const sourceCasPromise = plugin.compressor.compress(sourceCasFile, plugin.settings);
      await sourceCasEncodeStartedPromise;
      fs.writeFileSync(path.join(wasmCompressionTemp, "Images", "source-cas.jpg"), Buffer.from(new Uint8Array(jpegInput).map((byte, index) => index === 0 ? byte : byte ^ 0x01)));
      releaseSourceCasEncode(createValidEncodedOutput("jpeg"));
      const sourceCasResult = await sourceCasPromise;
      assert(sourceCasResult.success === false, "Compression published output after the source content changed during encode");
      assert(String(sourceCasResult.error || "").includes("source content changed during encode"), `Source CAS returned wrong error: ${sourceCasResult.error}`);
      assert(sourceCasWriteCalled === false, "Compression entered staged publication after source CAS failed");
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForSourceCas;
      plugin.compressor.compressBuffer = originalCompressBufferForSourceCas;
      plugin.compressor.writeStagedOutput = originalWriteStagedOutputForSourceCas;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const stagedSourceFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/source-cas-staged.jpg", new Uint8Array(jpegInput), 133);
    const stagedSourcePath = path.join(wasmCompressionTemp, "Images", "source-cas-staged.jpg");
    const stagedSourceOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", "source-cas-staged.jpg");
    const stagedSourceFs = new Proxy(plugin.compressor.fsPort, {
      get(target, property, receiver) {
        if (property === "writeBinary") {
          return async (...args) => {
            await target.writeBinary(...args);
            fs.writeFileSync(stagedSourcePath, Buffer.from(new Uint8Array(jpegInput).map((byte, index) => index === 0 ? byte : byte ^ 0x02)));
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const StagedSourceCompressorClass = plugin.compressor.constructor;
    const stagedSourceCompressor = new StagedSourceCompressorClass(
      plugin.settings,
      plugin.app,
      createMockWorkerFactory([{}]),
      stagedSourceFs,
      plugin.compressor.hashPort
    );
    try {
      stagedSourceCompressor.ensureWasmReady = async () => {};
      stagedSourceCompressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      fs.rmSync(stagedSourceOutputPath, { force: true });
      const stagedSourceResult = await stagedSourceCompressor.compress(stagedSourceFile, plugin.settings);
      assert(stagedSourceResult.success === false, "Compression published output after the source changed during staged publication");
      assert(String(stagedSourceResult.error || "").includes("source content changed before publication"), `Late source CAS returned wrong error: ${stagedSourceResult.error}`);
      assert(!fs.existsSync(stagedSourceOutputPath), "Late source CAS left a stale compressed output published");
    } finally {
      stagedSourceCompressor.destroy();
    }

    const originalEnsureWasmReadyForOutputCas = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForOutputCas = plugin.compressor.compressBuffer;
    try {
      plugin.compressor.ensureWasmReady = async () => {};
      let releaseOutputCasEncode = null;
      let outputCasEncodeStarted = null;
      const outputCasEncodeStartedPromise = new Promise((resolve) => {
        outputCasEncodeStarted = resolve;
      });
      plugin.compressor.compressBuffer = async () => {
        outputCasEncodeStarted();
        return await new Promise((resolve) => {
          releaseOutputCasEncode = resolve;
        });
      };
      const outputCasFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/output-cas.jpg", new Uint8Array(jpegInput), 134);
      const outputCasPath = path.join(wasmCompressionTemp, "Compressed", "Images", "output-cas.jpg");
      fs.rmSync(outputCasPath, { force: true });
      const outputCasPromise = plugin.compressor.compress(outputCasFile, plugin.settings);
      await outputCasEncodeStartedPromise;
      const competingOutput = Buffer.from("sync competitor output");
      fs.mkdirSync(path.dirname(outputCasPath), { recursive: true });
      fs.writeFileSync(outputCasPath, competingOutput);
      releaseOutputCasEncode(createValidEncodedOutput("jpeg"));
      const outputCasResult = await outputCasPromise;
      assert(outputCasResult.success === false, "Compression overwrote an output created after its target snapshot");
      assert(fs.readFileSync(outputCasPath).equals(competingOutput), "Output target CAS did not preserve the competing revision");
      const outputCasTempNames = fs.readdirSync(path.dirname(outputCasPath)).filter((name) => name.includes("output-cas.jpg.tinylocal-") && name.endsWith(".tmp"));
      assert(outputCasTempNames.length === 0, `Output target CAS leaked staged files: ${outputCasTempNames.join(",")}`);
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForOutputCas;
      plugin.compressor.compressBuffer = originalCompressBufferForOutputCas;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const StaleCompressorClass = plugin.compressor.constructor;
    const staleCompressor = new StaleCompressorClass(
      plugin.settings,
      plugin.app,
      createMockWorkerFactory([{}]),
      plugin.compressor.fsPort,
      plugin.compressor.hashPort
    );
    let staleEncodeStarted = null;
    let releaseStaleEncode = null;
    let staleWriteCalled = false;
    staleCompressor.ensureWasmReady = async () => {};
    const staleEncodeStartedPromise = new Promise((resolve) => {
      staleEncodeStarted = resolve;
    });
    staleCompressor.compressBuffer = async () => {
      staleEncodeStarted();
      return await new Promise((resolve) => {
        releaseStaleEncode = resolve;
      });
    };
    staleCompressor.writeStagedOutput = async () => {
      staleWriteCalled = true;
    };
    const staleCompressorFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/stale-compressor.jpg", new Uint8Array(jpegInput), 135);
    const staleCompressorPromise = staleCompressor.compress(staleCompressorFile, plugin.settings);
    await staleEncodeStartedPromise;
    staleCompressor.destroy();
    releaseStaleEncode(createValidEncodedOutput("jpeg"));
    const staleCompressorResult = await staleCompressorPromise;
    assert(staleCompressorResult.success === false, "An unloaded Compressor instance published its completed worker result");
    assert(String(staleCompressorResult.error || "").includes("plugin was unloaded"), `Stale Compressor lifecycle fence returned wrong error: ${staleCompressorResult.error}`);
    assert(staleWriteCalled === false, "An unloaded Compressor instance entered staged publication");

    const commitFenceFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/commit-fence.jpg", new Uint8Array(jpegInput), 135);
    const commitFenceOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", "commit-fence.jpg");
    let commitFenceReplaceStarted = null;
    let releaseCommitFenceReplace = null;
    const commitFenceReplaceStartedPromise = new Promise((resolve) => {
      commitFenceReplaceStarted = resolve;
    });
    const commitFenceFs = new Proxy(plugin.compressor.fsPort, {
      get(target, property, receiver) {
        if (property === "replaceFile") {
          return async (...args) => {
            commitFenceReplaceStarted();
            await new Promise((resolve) => {
              releaseCommitFenceReplace = resolve;
            });
            return await target.replaceFile(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const commitFenceCompressor = new StaleCompressorClass(
      plugin.settings,
      plugin.app,
      createMockWorkerFactory([{}]),
      commitFenceFs,
      plugin.compressor.hashPort
    );
    try {
      commitFenceCompressor.ensureWasmReady = async () => {};
      commitFenceCompressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      fs.rmSync(commitFenceOutputPath, { force: true });
      const commitFenceCompression = commitFenceCompressor.compress(commitFenceFile, plugin.settings);
      await commitFenceReplaceStartedPromise;
      commitFenceCompressor.destroy();
      releaseCommitFenceReplace();
      const commitFenceResult = await commitFenceCompression;
      assert(commitFenceResult.success === false, "Destroyed Compressor committed a replacement that was already queued at the platform boundary");
      assert(!fs.existsSync(commitFenceOutputPath), "Destroyed Compressor left output published after its final platform commit fence");
    } finally {
      releaseCommitFenceReplace?.();
      commitFenceCompressor.destroy();
    }

    const reloadOutputFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/reload-publication.jpg", new Uint8Array(jpegInput), 136);
    const reloadOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", "reload-publication.jpg");
    fs.rmSync(reloadOutputPath, { force: true });
    const realCompressorFs = plugin.compressor.fsPort;
    let oldPublicationMkdirStarted = null;
    let releaseOldPublicationMkdir = null;
    const oldPublicationMkdirStartedPromise = new Promise((resolve) => {
      oldPublicationMkdirStarted = resolve;
    });
    let oldPublicationWriteCalls = 0;
    let oldPublicationPaused = false;
    const oldCompressorFs = new Proxy(realCompressorFs, {
      get(target, property, receiver) {
        if (property === "mkdir") {
          return async (dirPath) => {
            await target.mkdir(dirPath);
            if (!oldPublicationPaused && String(dirPath).includes("Compressed")) {
              oldPublicationPaused = true;
              oldPublicationMkdirStarted();
              await new Promise((resolve) => {
                releaseOldPublicationMkdir = resolve;
              });
            }
          };
        }
        if (property === "writeBinary") {
          return async (...args) => {
            oldPublicationWriteCalls += 1;
            return await target.writeBinary(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const oldReloadCompressor = new StaleCompressorClass(
      plugin.settings,
      plugin.app,
      createMockWorkerFactory([{}]),
      oldCompressorFs,
      plugin.compressor.hashPort
    );
    const newReloadCompressor = new StaleCompressorClass(
      plugin.settings,
      plugin.app,
      createMockWorkerFactory([{}]),
      realCompressorFs,
      plugin.compressor.hashPort
    );
    const newReloadOutput = new Uint8Array(createValidJpegOutput(VALID_JPEG_OUTPUT.byteLength + 16));
    try {
      oldReloadCompressor.ensureWasmReady = async () => {};
      oldReloadCompressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      newReloadCompressor.ensureWasmReady = async () => {};
      newReloadCompressor.compressBuffer = async () => newReloadOutput.buffer.slice(newReloadOutput.byteOffset, newReloadOutput.byteOffset + newReloadOutput.byteLength);
      const oldReloadCompression = oldReloadCompressor.compress(reloadOutputFile, plugin.settings);
      await oldPublicationMkdirStartedPromise;
      oldReloadCompressor.destroy();
      const newReloadResult = await newReloadCompressor.compress(reloadOutputFile, plugin.settings);
      assert(newReloadResult.success === true, `Reloaded Compressor did not publish its output: ${newReloadResult.error}`);
      assert(fs.readFileSync(reloadOutputPath).equals(Buffer.from(newReloadOutput)), "Reloaded Compressor published unexpected output bytes");
      releaseOldPublicationMkdir();
      const oldReloadResult = await oldReloadCompression;
      assert(oldReloadResult.success === false && String(oldReloadResult.error || "").includes("plugin was unloaded"), `Old Compressor did not stop after reload publication: ${oldReloadResult.error}`);
      assert(oldPublicationWriteCalls === 0, "Old Compressor wrote staged bytes after unload/reload");
      assert(fs.readFileSync(reloadOutputPath).equals(Buffer.from(newReloadOutput)), "Old Compressor replaced the newer instance's published output");
    } finally {
      releaseOldPublicationMkdir?.();
      oldReloadCompressor.destroy();
      newReloadCompressor.destroy();
    }

    const originalEnsureWasmReadyForJpegFailure = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForJpegFailure = plugin.compressor.compressBuffer;
    try {
      plugin.compressor.ensureWasmReady = async () => {};
      plugin.compressor.compressBuffer = async () => {
        throw new Error("mozjpeg encode failed");
      };
      const jpegFailureFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/jpeg-failure.jpg", new Uint8Array(jpegInput), 132);
      const jpegFailureResult = await plugin.compressor.compress(jpegFailureFile, plugin.settings);
      assert(jpegFailureResult.success === false, "JPEG encode failure smoke unexpectedly succeeded");
      assert(jpegFailureResult.skipReason === "mozjpeg_failed", `JPEG encode failure used wrong skipReason: ${jpegFailureResult.skipReason}`);
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForJpegFailure;
      plugin.compressor.compressBuffer = originalCompressBufferForJpegFailure;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    plugin.compressor.maxInputBytes = originalMaxInputBytes;
    plugin.app.vault.readBinary = originalVaultReadBinary;
    pointMockVaultAtPath(plugin.app, wasmCompressionTemp);

    for (const invalidCase of [
      { name: "empty", extension: "jpg", input: new Uint8Array(jpegInput), output: new Uint8Array(0).buffer, expected: "empty" },
      { name: "bad-magic", extension: "jpg", input: new Uint8Array(jpegInput), output: Uint8Array.from([0x00, 0x01, 0x02, 0x03]).buffer, expected: "JPEG bad-SOI" },
      { name: "missing-sos", extension: "jpg", input: new Uint8Array(jpegInput), output: createJpegWithoutSos(), expected: "JPEG missing-SOS" },
      { name: "png-missing-idat", extension: "png", input: pngInput, output: createPngWithoutIdat(), expected: "PNG missing-or-empty-IDAT" },
      { name: "png-truncated", extension: "png", input: pngInput, output: createTruncatedPngChunk(), expected: "PNG truncated-chunk" }
    ]) {
      const invalidWorkers = [];
      const originalWriteBinaryForInvalidOutput = plugin.app.vault.adapter.writeBinary;
      let invalidOutputWrites = 0;
      try {
        plugin.app.vault.adapter.writeBinary = async (...args) => {
          invalidOutputWrites += 1;
          return originalWriteBinaryForInvalidOutput(...args);
        };
        await resetCompressorWorker(plugin, createMockWorkerFactory([
          { compressResponses: [{ output: invalidCase.output }] }
        ], invalidWorkers));
        const invalidOutputFile = writeVaultBinary(plugin.app, wasmCompressionTemp, `Images/invalid-output-${invalidCase.name}.${invalidCase.extension}`, invalidCase.input, 120);
        const invalidOutputResult = await plugin.compressor.compress(invalidOutputFile, plugin.settings);
        const invalidOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", `invalid-output-${invalidCase.name}.${invalidCase.extension}`);
        assert(invalidOutputResult.success === false, `Invalid ${invalidCase.name} worker output unexpectedly succeeded`);
        assert(String(invalidOutputResult.error || "").includes(invalidCase.expected), `Invalid ${invalidCase.name} worker output returned wrong error: ${invalidOutputResult.error}`);
        assert(invalidOutputResult.skipReason === "corrupt_encoder_output", `Invalid ${invalidCase.name} worker output used wrong skipReason: ${invalidOutputResult.skipReason}`);
        assert(invalidOutputWrites === 0, `Invalid ${invalidCase.name} worker output wrote staged bytes`);
        assert(!fs.existsSync(invalidOutputPath), `Invalid ${invalidCase.name} worker output created a compressed file`);
      } finally {
        plugin.app.vault.adapter.writeBinary = originalWriteBinaryForInvalidOutput;
      }
    }

    const postFailureWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      { throwOnCompressPost: "simulated postMessage failure" }
    ], postFailureWorkers));
    plugin.compressor.processTimeoutMs = 1000;
    const postFailureFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/post-failure.jpg", new Uint8Array(jpegInput), 105);
    const postFailureStartedAt = Date.now();
    const postFailureResult = await plugin.compressor.compress(postFailureFile, plugin.settings);
    const postFailureElapsedMs = Date.now() - postFailureStartedAt;
    assert(postFailureResult.success === false, "Worker postMessage failure smoke unexpectedly succeeded");
    assert(String(postFailureResult.error || "").includes("simulated postMessage failure"), `Worker postMessage failure smoke returned wrong error: ${postFailureResult.error}`);
    assert(postFailureElapsedMs <= 500, `Worker postMessage failure waited for timeout: ${postFailureElapsedMs}ms`);
    assert(getCompressorSlots(plugin)[0].activeJob === null, "Worker postMessage failure left an active job behind");

    const timeoutWorkers = [];
    let timeoutCompressPosted = null;
    const timeoutCompressPostedPromise = new Promise((resolve) => {
      timeoutCompressPosted = resolve;
    });
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            timeoutCompressPosted();
          }
        }
      },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], timeoutWorkers));
    plugin.compressor.processTimeoutMs = 10;
    const timeoutFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/timeout.jpg", new Uint8Array(jpegInput), 106);
    const timeoutStartedAt = Date.now();
    const timeoutPromise = plugin.compressor.compress(timeoutFile, plugin.settings);
    await timeoutCompressPostedPromise;
    plugin.compressor.processTimeoutMs = 9999;
    const timeoutResult = await timeoutPromise;
    const timeoutElapsedMs = Date.now() - timeoutStartedAt;
    assert(timeoutResult.success === false, "Worker timeout smoke unexpectedly succeeded");
    assert(String(timeoutResult.error || "").includes("timed out"), `Worker timeout smoke did not return timeout error: ${timeoutResult.error}`);
    assert(String(timeoutResult.error || "").includes("10ms"), `Worker timeout smoke did not report the scheduled timeout: ${timeoutResult.error}`);
    assert(timeoutElapsedMs <= 1000, `Worker timeout smoke took too long: ${timeoutElapsedMs}ms`);
    assert(timeoutWorkers[0].terminateCalls === 1, "Worker timeout did not terminate the stuck worker");
    assert(getCompressorSlots(plugin)[0].worker === null, "Worker timeout kept a live worker before lazy recovery");
    assert(getCompressorSlots(plugin)[0].objectUrl === null, "Worker timeout left an object URL before lazy recovery");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Worker timeout did not mark lazy recreate pending");
    assert(getCompressorSlots(plugin)[0].wasmInitError === null, "Worker timeout left a stale init error before lazy recovery");
    assert(timeoutWorkers.length === 1, "Worker timeout eagerly recreated the worker");
    await new Promise((resolve) => originalGlobals.setTimeout(resolve, 100));
    assert(getCompressorSlots(plugin)[0].worker === null, "Lazy idle timeout recovery created a worker while idle");
    assert(getCompressorSlots(plugin)[0].objectUrl === null, "Lazy idle timeout recovery left an object URL while idle");
    assert(timeoutWorkers.length === 1, "Lazy idle timeout recovery invoked the worker factory while idle");
    const timeoutRecoveryFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/timeout-recovery.jpg", new Uint8Array(jpegInput), 107);
    const timeoutRecoveryPromise = plugin.compressor.compress(timeoutRecoveryFile, plugin.settings);
    assert(timeoutWorkers.length === 2, "Lazy timeout recovery did not create a worker on demand");
    assert(getCompressorSlots(plugin)[0].worker === timeoutWorkers[1], "Lazy timeout recovery did not install the new worker");
    const timeoutRecoveryResult = await timeoutRecoveryPromise;
    assert(timeoutRecoveryResult.success === true, `Worker timeout recovery failed: ${timeoutRecoveryResult.error}`);
    assert(timeoutWorkers[1].messages.some((message) => message.type === "init"), "Recreated timeout worker did not receive init");

    const crashWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      { crashOnCompress: "simulated worker crash" },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], crashWorkers));
    const crashFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/crash.jpg", new Uint8Array(jpegInput), 108);
    const crashResult = await plugin.compressor.compress(crashFile, plugin.settings);
    assert(crashResult.success === false, "Worker crash smoke unexpectedly succeeded");
    assert(String(crashResult.error || "").includes("Worker crashed"), `Worker crash smoke returned wrong error: ${crashResult.error}`);
    assert(crashWorkers[0].terminateCalls === 1, "Worker crash did not terminate the crashed worker");
    assert(getCompressorSlots(plugin)[0].worker === null, "Worker crash kept a live worker before lazy recovery");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Worker crash did not mark lazy recreate pending");
    assert(crashWorkers.length === 1, "Worker crash eagerly recreated the worker");
    const crashRecoveryFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/crash-recovery.jpg", new Uint8Array(jpegInput), 109);
    const crashRecoveryPromise = plugin.compressor.compress(crashRecoveryFile, plugin.settings);
    assert(crashWorkers.length === 2, "Lazy crash recovery did not create a worker on demand");
    const crashRecoveryResult = await crashRecoveryPromise;
    assert(crashRecoveryResult.success === true, `Worker crash recovery failed: ${crashRecoveryResult.error}`);

    const ensureReadyWorkers = [];
    let ensureReadyCompressPosted = null;
    const ensureReadyCompressPostedPromise = new Promise((resolve) => {
      ensureReadyCompressPosted = resolve;
    });
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            ensureReadyCompressPosted();
          }
        }
      },
      {}
    ], ensureReadyWorkers));
    plugin.compressor.processTimeoutMs = 10;
    const ensureReadyTimeoutFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/ensure-ready-timeout.jpg", new Uint8Array(jpegInput), 110);
    const ensureReadyTimeoutPromise = plugin.compressor.compress(ensureReadyTimeoutFile, plugin.settings);
    await ensureReadyCompressPostedPromise;
    plugin.compressor.processTimeoutMs = 9999;
    const ensureReadyTimeoutResult = await ensureReadyTimeoutPromise;
    assert(ensureReadyTimeoutResult.success === false, "Parallel ensureWasmReady timeout unexpectedly succeeded");
    assert(ensureReadyWorkers.length === 1, "Parallel ensureWasmReady setup eagerly recreated the worker");
    const ensureReadyOnce = plugin.compressor.ensureWasmReady();
    const ensureReadyTwice = plugin.compressor.ensureWasmReady();
    assert(ensureReadyWorkers.length === 2, "Parallel ensureWasmReady did not create the lazy worker");
    await Promise.all([ensureReadyOnce, ensureReadyTwice]);
    assert(ensureReadyWorkers.length === 2, "Parallel ensureWasmReady created more than one lazy worker");
    assert(getCompressorSlots(plugin)[0].needsRecreate === false, "Parallel ensureWasmReady left lazy recreate pending");

    const idleDestroyWorkers = [];
    let idleDestroyCompressPosted = null;
    const idleDestroyCompressPostedPromise = new Promise((resolve) => {
      idleDestroyCompressPosted = resolve;
    });
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            idleDestroyCompressPosted();
          }
        }
      },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], idleDestroyWorkers));
    plugin.compressor.processTimeoutMs = 10;
    const idleDestroyTimeoutFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/idle-destroy-timeout.jpg", new Uint8Array(jpegInput), 111);
    const idleDestroyTimeoutPromise = plugin.compressor.compress(idleDestroyTimeoutFile, plugin.settings);
    await idleDestroyCompressPostedPromise;
    plugin.compressor.processTimeoutMs = 9999;
    const idleDestroyTimeoutResult = await idleDestroyTimeoutPromise;
    assert(idleDestroyTimeoutResult.success === false, "Lazy idle destroy timeout unexpectedly succeeded");
    assert(getCompressorSlots(plugin)[0].worker === null, "Lazy idle destroy setup kept a live worker");
    assert(idleDestroyWorkers.length === 1, "Lazy idle destroy setup eagerly recreated the worker");
    plugin.compressor.destroy();
    assert(getCompressorSlots(plugin)[0].worker === null, "Destroy during lazy idle left a worker behind");
    assert(idleDestroyWorkers.length === 1, "Destroy during lazy idle created a worker");
    assert(idleDestroyWorkers[0].terminateCalls === 1, "Destroy during lazy idle re-terminated the already stopped worker");
    const idleDestroyAfterFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/idle-destroy-after.jpg", new Uint8Array(jpegInput), 112);
    const idleDestroyAfterResult = await plugin.compressor.compress(idleDestroyAfterFile, plugin.settings);
    assert(idleDestroyAfterResult.success === false, "Compress after lazy idle destroy unexpectedly succeeded");
    assert(String(idleDestroyAfterResult.error || "").includes("plugin was unloaded"), `Compress after lazy idle destroy returned wrong error: ${idleDestroyAfterResult.error}`);
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([{ compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }]), 1);

    const destroyWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([{ noCompressResponse: true }], destroyWorkers));
    const destroyFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/destroy.jpg", new Uint8Array(jpegInput), 113);
    const destroyPromise = plugin.compressor.compress(destroyFile, plugin.settings);
    await new Promise((resolve) => originalGlobals.setTimeout(resolve, 0));
    plugin.compressor.destroy();
    const destroyResult = await destroyPromise;
    assert(destroyResult.success === false, "Worker destroy smoke unexpectedly succeeded");
    assert(String(destroyResult.error || "").includes("plugin was unloaded"), `Worker destroy smoke returned wrong error: ${destroyResult.error}`);
    assert(destroyWorkers[0].terminateCalls === 1, "Compressor.destroy() did not terminate the active worker");

    const staggeredInitWorkers = [];
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([
      { initDelayMs: 25 },
      { initDelayMs: 25 },
      { initDelayMs: 25 },
      { initDelayMs: 25 }
    ], staggeredInitWorkers), 4);
    const staggeredReadyPromise = plugin.compressor.ensureWasmReady();
    assert(staggeredInitWorkers.length === 1, `Worker pool did not start with a single eager slot: ${staggeredInitWorkers.length}`);
    await new Promise((resolve) => originalGlobals.setTimeout(resolve, 5));
    assert(staggeredInitWorkers.length === 1, `Worker pool initialized extra slots before the first slot settled: ${staggeredInitWorkers.length}`);
    await staggeredReadyPromise;
    for (let attempt = 0; attempt < 30 && staggeredInitWorkers.length < 4; attempt++) {
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 10));
    }
    assert(staggeredInitWorkers.length === 4, `Worker pool did not finish staggered slot init: ${staggeredInitWorkers.length}`);

    const parallelWorkers = [];
    const parallelDispatchTimes = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } },
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } },
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } },
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } }
    ], parallelWorkers), 4);
    assert(await waitForReadySlots(plugin, 4) === 4, "Parallel pool setup did not warm all slots");
    const parallelStartedAt = Date.now();
    const parallelResults = await Promise.all([10, 11, 12, 13].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    const parallelElapsedMs = Date.now() - parallelStartedAt;
    assert(parallelResults.length === 4 && parallelResults.every((output) => output.byteLength === VALID_JPEG_OUTPUT.byteLength), "Parallel pool dispatch did not complete all jobs");
    assert(parallelDispatchTimes.length === 4, `Parallel pool did not dispatch all jobs immediately: ${parallelDispatchTimes.length}`);
    assert(Math.max(...parallelDispatchTimes) - Math.min(...parallelDispatchTimes) <= 35, "Parallel pool dispatch was not simultaneous enough");
    assert(parallelElapsedMs < 170, `Parallel pool wall-clock looked serial: ${parallelElapsedMs}ms`);

    const backpressureWorkers = [];
    const backpressureOrder = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      {
        compressDelayMs: 20,
        onPostMessage: (message) => { if (message.type === "compress") backpressureOrder.push(message.buffer.byteLength); },
        compressResponses: [{}, {}, {}]
      },
      {
        compressDelayMs: 20,
        onPostMessage: (message) => { if (message.type === "compress") backpressureOrder.push(message.buffer.byteLength); },
        compressResponses: [{}, {}]
      }
    ], backpressureWorkers), 2);
    assert(await waitForReadySlots(plugin, 2) === 2, "Backpressure pool setup did not warm all slots");
    const backpressurePromises = [20, 21, 22, 23, 24].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    );
    await new Promise((resolve) => originalGlobals.setTimeout(resolve, 0));
    assert(JSON.stringify(backpressureOrder) === JSON.stringify([20, 21]), `Backpressure did not dispatch the first two jobs immediately: ${backpressureOrder.join(",")}`);
    await Promise.all(backpressurePromises);
    assert(JSON.stringify(backpressureOrder) === JSON.stringify([20, 21, 22, 23, 24]), `Backpressure queue did not drain FIFO: ${backpressureOrder.join(",")}`);

    const waiterCapWorkers = [];
    let waiterCapJobPosted = null;
    const waiterCapJobPostedPromise = new Promise((resolve) => {
      waiterCapJobPosted = resolve;
    });
    await resetCompressorPool(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            waiterCapJobPosted();
          }
        }
      }
    ], waiterCapWorkers), 1);
    plugin.compressor.workerPool.MAX_WAITERS = 2;
    const waiterCapActive = plugin.compressor.compressBuffer(new Uint8Array(25).buffer, ".jpg", plugin.settings).catch((error) => error);
    await waiterCapJobPostedPromise;
    const waiterCapQueuedA = plugin.compressor.compressBuffer(new Uint8Array(26).buffer, ".jpg", plugin.settings).catch((error) => error);
    const waiterCapQueuedB = plugin.compressor.compressBuffer(new Uint8Array(27).buffer, ".jpg", plugin.settings).catch((error) => error);
    await Promise.resolve();
    assert(plugin.compressor.workerPool.waiters.length === 2, `WorkerPool waiter cap setup queued ${plugin.compressor.workerPool.waiters.length} jobs instead of 2`);
    const waiterCapOverflow = await plugin.compressor.compressBuffer(new Uint8Array(28).buffer, ".jpg", plugin.settings).catch((error) => error);
    assert(String(waiterCapOverflow?.message || waiterCapOverflow).includes("waiters queue full"), `WorkerPool waiter overflow returned wrong error: ${waiterCapOverflow}`);
    plugin.compressor.destroy();
    await Promise.all([waiterCapActive, waiterCapQueuedA, waiterCapQueuedB]);

    const timeoutPoolWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { noCompressResponse: true },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], timeoutPoolWorkers), 3);
    assert(await waitForReadySlots(plugin, 3) === 3, "Timeout pool setup did not warm all slots");
    plugin.compressor.processTimeoutMs = 10;
    const timeoutPoolResults = await Promise.allSettled([30, 31, 32].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    assert(timeoutPoolResults[0].status === "rejected" && String(timeoutPoolResults[0].reason?.message || timeoutPoolResults[0].reason).includes("timed out"), "Pool timeout did not reject only the timed-out job");
    assert(timeoutPoolResults[1].status === "fulfilled" && timeoutPoolResults[2].status === "fulfilled", "Pool timeout affected healthy slots");
    assert(timeoutPoolWorkers[0].terminateCalls === 1, "Pool timeout did not terminate the timed-out slot");
    assert(timeoutPoolWorkers[1].terminateCalls === 0 && timeoutPoolWorkers[2].terminateCalls === 0, "Pool timeout terminated healthy slots");
    assert(timeoutPoolWorkers.length === 3, "Pool timeout eagerly recreated the failed slot");
    plugin.compressor.processTimeoutMs = 9999;
    await plugin.compressor.compressBuffer(new Uint8Array(33).buffer, ".jpg", plugin.settings);
    assert(timeoutPoolWorkers.length === 3, "Pool timeout recreated a failed slot while a ready slot was idle");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Pool timeout cleared lazy recreate before the failed slot was used again");

    const readyPriorityWorkers = [];
    const readyPriorityDispatches = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { noCompressResponse: true },
      {
        compressResponses: [
          { output: createValidEncodedOutput("jpeg") },
          { output: createValidEncodedOutput("jpeg") }
        ],
        onPostMessage: (message) => {
          if (message.type === "compress") readyPriorityDispatches.push(message.buffer.byteLength);
        }
      },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], readyPriorityWorkers), 2);
    assert(await waitForReadySlots(plugin, 2) === 2, "Ready-slot priority setup did not warm all slots");
    plugin.compressor.processTimeoutMs = 10;
    const readyPriorityResults = await Promise.allSettled([70, 71].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    assert(readyPriorityResults[0].status === "rejected" && readyPriorityResults[1].status === "fulfilled", "Ready-slot priority setup did not leave one failed and one ready slot");
    assert(readyPriorityWorkers.length === 2, "Ready-slot priority setup recreated the failed slot too early");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Ready-slot priority setup did not mark the failed slot for lazy recreate");
    plugin.compressor.processTimeoutMs = 9999;
    const readyPriorityOutput = await plugin.compressor.compressBuffer(new Uint8Array(72).buffer, ".jpg", plugin.settings);
    assert(readyPriorityOutput.byteLength === VALID_JPEG_OUTPUT.byteLength, "Ready-slot priority recovery job did not complete");
    assert(readyPriorityWorkers.length === 2, "Worker pool did not prefer an already-ready slot over lazy recreate");
    assert(JSON.stringify(readyPriorityDispatches) === JSON.stringify([71, 72]), `Ready-slot priority dispatched to the wrong worker: ${readyPriorityDispatches.join(",")}`);

    const crashPoolWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { crashOnCompress: "pool slot crash" },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], crashPoolWorkers), 3);
    assert(await waitForReadySlots(plugin, 3) === 3, "Crash pool setup did not warm all slots");
    const crashPoolResults = await Promise.allSettled([40, 41, 42].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    assert(crashPoolResults[0].status === "rejected" && String(crashPoolResults[0].reason?.message || crashPoolResults[0].reason).includes("Worker crashed"), "Pool crash did not reject only the crashed job");
    assert(crashPoolResults[1].status === "fulfilled" && crashPoolResults[2].status === "fulfilled", "Pool crash affected healthy slots");
    assert(crashPoolWorkers[0].terminateCalls === 1, "Pool crash did not terminate the crashed slot");
    assert(crashPoolWorkers[1].terminateCalls === 0 && crashPoolWorkers[2].terminateCalls === 0, "Pool crash terminated healthy slots");
    await plugin.compressor.compressBuffer(new Uint8Array(43).buffer, ".jpg", plugin.settings);
    assert(crashPoolWorkers.length === 3, "Pool crash recreated a failed slot while a ready slot was idle");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Pool crash cleared lazy recreate before the failed slot was used again");

    const allInitFailureWorkers = [];
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([
      { initError: "slot 1 init failed" },
      { initError: "slot 2 init failed" },
      { initError: "slot 3 init failed" }
    ], allInitFailureWorkers), 3);
    const allInitFailureFile = createMockFile("Images/all-init-failed.jpg", 100000, 114);
    allInitFailureFile.vault = plugin.app.vault;
    const allInitFailureResult = await plugin.compressor.compress(allInitFailureFile, plugin.settings);
    assert(allInitFailureResult.success === false, "All-slots init failure unexpectedly allowed compression");
    assert(String(allInitFailureResult.error || "").includes("init failed"), `All-slots init failure returned wrong error: ${allInitFailureResult.error}`);
    assert(allInitFailureWorkers.every((worker) => worker.terminateCalls === 1), "All-slots init failure did not terminate failed workers");

    const partialInitWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { initError: "partial slot 1 failed" },
      { initError: "partial slot 2 failed" },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], partialInitWorkers), 4);
    assert(plugin.compressor.checkBinaries().pngquant === true, "Partial init success did not mark pool usable");
    assert(await waitForReadySlots(plugin, 2) >= 2, "Partial init priority test did not get two ready slots");
    const partialInitWorkersBeforeJobs = partialInitWorkers.length;
    const [partialA, partialB] = await Promise.all([
      plugin.compressor.compressBuffer(new Uint8Array(50).buffer, ".jpg", plugin.settings),
      plugin.compressor.compressBuffer(new Uint8Array(51).buffer, ".jpg", plugin.settings)
    ]);
    assert(partialA.byteLength === VALID_JPEG_OUTPUT.byteLength && partialB.byteLength === VALID_JPEG_OUTPUT.byteLength, "Partial init success did not run jobs on healthy slots");
    assert(partialInitWorkers.length === partialInitWorkersBeforeJobs, "Partial init success retried failed slots while ready slots were idle");

    const destroyPoolWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { noCompressResponse: true },
      { noCompressResponse: true },
      { noCompressResponse: true }
    ], destroyPoolWorkers), 3);
    assert(await waitForReadySlots(plugin, 3) === 3, "Destroy pool setup did not warm all slots");
    const destroyPoolPromises = [60, 61, 62, 63, 64, 65].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    );
    await new Promise((resolve) => originalGlobals.setTimeout(resolve, 0));
    plugin.compressor.destroy();
    const destroyPoolResults = await Promise.allSettled(destroyPoolPromises);
    assert(destroyPoolResults.every((result) => result.status === "rejected"), "Destroy mid-batch did not reject every active and queued pool job");
    assert(destroyPoolWorkers.every((worker) => worker.terminateCalls === 1), "Destroy mid-batch did not terminate every pool worker");
    const afterDestroyFile = createMockFile("Images/after-pool-destroy.jpg", 100000, 115);
    afterDestroyFile.vault = plugin.app.vault;
    const afterDestroyResult = await plugin.compressor.compress(afterDestroyFile, plugin.settings);
    assert(afterDestroyResult.success === false && String(afterDestroyResult.error || "").includes("plugin was unloaded"), "Compress after pool destroy did not return sticky destroy error");
  } finally {
    try {
      plugin.compressor.workerPool?.destroy?.(new Error("smoke cleanup"));
    } catch (_) {
    }
    plugin.compressor.workerFactory = originalWorkerFactory;
    plugin.compressor.workerPool = originalWorkerPool;
    plugin.compressor.activeWorkerCount = originalActiveWorkerCount;
    plugin.compressor.processTimeoutMs = originalProcessTimeoutMs;
    plugin.compressor.initTimeoutMs = originalInitTimeoutMs;
    plugin.compressor.maxInputBytes = originalMaxInputBytes;
    plugin.settings.pngQuality = originalPngQuality;
    plugin.settings.jpegQuality = originalJpegQuality;
    plugin.settings.outputFolder = originalOutputFolder;
    plugin.app.vault.readBinary = preWasmVaultReadBinary;
    plugin.app.vault.adapter.basePath = originalVaultBasePath;
    plugin.app.vault.adapter.path.absolute = originalVaultAbsolutePath;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    fs.rmSync(wasmCompressionTemp, { recursive: true, force: true });
  }

  const originalCachedRead = plugin.app.vault.cachedRead;
  await setMockFiles(plugin, [
    createMockFile("Images/a.png", 100000),
    createMockFile("Images/b.jpg", 100000),
    createMockFile("Images/space image.jpeg", 100000),
    createMockFile("Images/with(foo).png", 100000),
    createMockFile("Images/pipe|name.png", 100000),
    createMockFile("Images/code-block.png", 100000),
    createMockFile("Other/b.jpg", 100000),
    createMockFile("Images/ignored.gif", 100000)
  ]);
  plugin.app.vault.cachedRead = async () => [
    "![[Images/a.png|400]]",
    "![[Images/pipe\\|name.png|400]]",
    "![markdown jpg](Images/b.jpg)",
    "![markdown space](Images/space image.jpeg)",
    "![markdown paren](Images/with(foo).png)",
    "![ambiguous basename](b.jpg)",
    "![remote](https://example.com/remote.png)",
    "```",
    "![[Images/code-block.png]]",
    "![code markdown](Images/code-block.png)",
    "```",
    "`![[Images/code-block.png]]`",
    "![[Images/ignored.gif]]",
    "![[Images/a.png]]"
  ].join("\n");
  const noteImages = await plugin.imageScanner.getImagesInNote(createMockFile("Notes/note.md", 1000));
  const noteImagePaths = noteImages.map((file) => file.path).sort();
  assert(
    JSON.stringify(noteImagePaths) === JSON.stringify(["Images/a.png", "Images/b.jpg", "Images/pipe|name.png", "Images/space image.jpeg", "Images/with(foo).png"]),
    `getImagesInNote() did not resolve markdown/wiki image embeds correctly: ${noteImagePaths.join(", ")}`
  );
  assert(!noteImagePaths.includes("Other/b.jpg"), "getImagesInNote() chose an arbitrary duplicate basename image");
  assert(!noteImagePaths.includes("Images/code-block.png"), "getImagesInNote() extracted image embeds from markdown code blocks");
  const cachedLookupA = plugin.imageScanner.buildImageLookup(plugin.app._files);
  const cachedLookupB = plugin.imageScanner.buildImageLookup(plugin.app._files);
  assert(cachedLookupA === cachedLookupB, "ImageScanner did not reuse the cached image lookup for the same file list");
  plugin.imageScanner.invalidateImageLookupCache();
  const cachedLookupC = plugin.imageScanner.buildImageLookup(plugin.app._files);
  assert(cachedLookupC !== cachedLookupA, "ImageScanner did not invalidate the cached image lookup");
  await setMockFiles(plugin, [
    createMockFile("Notes/Sub/local.png", 100000),
    createMockFile("Notes/Images/parent.png", 100000),
    createMockFile("Images/root.png", 100000),
    createMockFile("Other/local.png", 100000)
  ]);
  plugin.app.vault.cachedRead = async () => [
    "![same-folder](local.png)",
    "![parent](../Images/parent.png)",
    "![root](../../Images/root.png)"
  ].join("\n");
  const relativeNoteImages = await plugin.imageScanner.getImagesInNote(createMockFile("Notes/Sub/note.md", 1000));
  const relativeNotePaths = relativeNoteImages.map((file) => file.path).sort();
  assert(
    JSON.stringify(relativeNotePaths) === JSON.stringify(["Images/root.png", "Notes/Images/parent.png", "Notes/Sub/local.png"]),
    `getImagesInNote() did not resolve note-relative markdown links: ${relativeNotePaths.join(", ")}`
  );
  const pathologicalMarkdown = `![](${"(".repeat(10000)}Images/a.png${")".repeat(10000)})`;
  const markdownParseStart = Date.now();
  const pathologicalTargets = plugin.imageScanner.extractMarkdownImageTargets(pathologicalMarkdown);
  const markdownParseElapsed = Date.now() - markdownParseStart;
  assert(pathologicalTargets.length === 0, "Pathological markdown image target was accepted instead of aborted");
  assert(markdownParseElapsed < 500, `Pathological markdown image target parsing was too slow: ${markdownParseElapsed}ms`);
  const overlongMarkdownTarget = plugin.imageScanner.extractMarkdownImageTargets(`![](${"a".repeat(5000)}.png)`);
  assert(overlongMarkdownTarget.length === 0, "Overlong markdown image target was accepted instead of capped");
  plugin.app.vault.cachedRead = originalCachedRead;

  const originalFsStatSyncForI18n = fs.statSync;
  let i18nStatCalls = 0;
  try {
    fs.statSync = function patchedStatSync(filePath, ...args) {
      if (String(filePath).includes(`${path.sep}lang${path.sep}`)) {
        i18nStatCalls += 1;
      }
      return originalFsStatSyncForI18n.call(this, filePath, ...args);
    };
    plugin.registerCommands();
    const statCallsAfterFirstRegister = i18nStatCalls;
    plugin.registerCommands();
    assert(i18nStatCalls === statCallsAfterFirstRegister, "i18n language cache repeated statSync calls within the TTL window");
  } finally {
    fs.statSync = originalFsStatSyncForI18n;
  }

  const settingsTab = plugin.settingTabs[0];
  const originalGetStatsSnapshot = plugin.getStatsSnapshot;
  let displayFailedAsExpected = false;
  try {
    settingsTab._isDisposed = false;
    plugin.getStatsSnapshot = async () => {
      throw new Error("simulated stats failure");
    };
    await settingsTab.renderSettings();
  } catch (_) {
    displayFailedAsExpected = true;
  } finally {
    plugin.getStatsSnapshot = originalGetStatsSnapshot;
  }
  assert(displayFailedAsExpected, "SettingsTab.renderSettings() did not surface the simulated stats failure");
  assert(settingsTab._isRendering === false, "SettingsTab.renderSettings() left its rendering state active after a failed await");

  const SettingsTabClass = settingsTab.constructor;
  const renderFenceStats = await originalGetStatsSnapshot.call(plugin);
  const renderFenceTab = new SettingsTabClass(plugin.app, plugin);
  let resolveRenderFenceStats = null;
  let renderFenceStatsStarted = null;
  const renderFenceStatsStartedPromise = new Promise((resolve) => {
    renderFenceStatsStarted = resolve;
  });
  try {
    plugin.getStatsSnapshot = async () => {
      renderFenceStatsStarted();
      return await new Promise((resolve) => {
        resolveRenderFenceStats = resolve;
      });
    };
    const fencedRender = renderFenceTab.renderSettings();
    await renderFenceStatsStartedPromise;
    renderFenceTab.hide();
    const childrenAtStatsDispose = renderFenceTab.containerEl.children.length;
    resolveRenderFenceStats(renderFenceStats);
    await fencedRender;
    assert(renderFenceTab.containerEl.children.length === childrenAtStatsDispose, "Disposed settings render created DOM after getStatsSnapshot resolved");
    assert(renderFenceTab._renderRootsCleanups.length === 0 && renderFenceTab._savingsTooltipCleanups.length === 0, "Disposed settings render retained render-scoped listeners after stats resolution");
  } finally {
    plugin.getStatsSnapshot = originalGetStatsSnapshot;
  }

  const backupRenderFenceTab = new SettingsTabClass(plugin.app, plugin);
  const originalGetAvailableBackupsForRenderFence = plugin.cache.getAvailableBackups;
  let resolveAvailableBackups = null;
  let availableBackupsStarted = null;
  const availableBackupsStartedPromise = new Promise((resolve) => {
    availableBackupsStarted = resolve;
  });
  try {
    plugin.getStatsSnapshot = async () => renderFenceStats;
    plugin.cache.getAvailableBackups = async () => {
      availableBackupsStarted();
      return await new Promise((resolve) => {
        resolveAvailableBackups = resolve;
      });
    };
    const fencedBackupRender = backupRenderFenceTab.renderSettings();
    await availableBackupsStartedPromise;
    backupRenderFenceTab.hide();
    const childrenAtBackupDispose = backupRenderFenceTab.containerEl.children.length;
    resolveAvailableBackups([]);
    await fencedBackupRender;
    assert(backupRenderFenceTab.containerEl.children.length === childrenAtBackupDispose, "Disposed settings render created DOM after backup discovery resolved");
    assert(backupRenderFenceTab._renderRootsCleanups.length === 0 && backupRenderFenceTab._savingsTooltipCleanups.length === 0, "Disposed backup render retained render-scoped listeners");
  } finally {
    plugin.getStatsSnapshot = originalGetStatsSnapshot;
    plugin.cache.getAvailableBackups = originalGetAvailableBackupsForRenderFence;
  }

  const automationFenceTab = new SettingsTabClass(plugin.app, plugin);
  const originalSettingForAutomationFence = ObsidianMock.Setting;
  const originalSaveSettingsForAutomationFence = plugin.saveSettings;
  const originalBackgroundSettingForAutomationFence = plugin.settings.autoBackgroundCompression;
  const automationToggleCallbacks = [];
  const automationVisibilityCalls = [];
  let resolveAutomationSave = null;
  let automationSaveStarted = null;
  const automationSaveStartedPromise = new Promise((resolve) => {
    automationSaveStarted = resolve;
  });
  try {
    ObsidianMock.Setting = class {
      constructor(containerEl) {
        this.containerEl = containerEl;
        this.settingEl = createMockElement();
        this.controlEl = createMockElement();
      }
      setName() { return this; }
      setDesc() { return this; }
      setHeading() { return this; }
      addToggle(builder) {
        const component = {
          setValue() { return this; },
          onChange(callback) { automationToggleCallbacks.push(callback); return this; }
        };
        builder(component);
        return this;
      }
      addSlider(builder) {
        const component = {
          setLimits() { return this; },
          setValue() { return this; },
          setDynamicTooltip() { return this; },
          onChange() { return this; }
        };
        builder(component);
        return this;
      }
    };
    automationFenceTab.applySubsettingVisibility = (...args) => {
      automationVisibilityCalls.push(args);
    };
    plugin.saveSettings = async () => {
      automationSaveStarted();
      return await new Promise((resolve) => {
        resolveAutomationSave = resolve;
      });
    };
    automationFenceTab.renderAutomationSection(automationFenceTab.containerEl, automationFenceTab._renderGeneration);
    assert(automationToggleCallbacks.length >= 2, "Automation render did not expose the background-compression toggle callback");
    const visibilityCallsBeforeAsyncSave = automationVisibilityCalls.length;
    const staleAutomationSave = automationToggleCallbacks[1](true);
    await automationSaveStartedPromise;
    automationFenceTab.hide();
    resolveAutomationSave();
    await staleAutomationSave;
    assert(automationVisibilityCalls.length === visibilityCallsBeforeAsyncSave, "An automation toggle mutated detached settings DOM after its save resolved");
  } finally {
    resolveAutomationSave?.();
    ObsidianMock.Setting = originalSettingForAutomationFence;
    plugin.saveSettings = originalSaveSettingsForAutomationFence;
    plugin.settings.autoBackgroundCompression = originalBackgroundSettingForAutomationFence;
  }

  const animationFrameFenceTab = new SettingsTabClass(plugin.app, plugin);
  let ownedFrameCallbackRan = false;
  const cancelledOwnedFrames = [];
  animationFrameFenceTab.containerEl.win = {
    requestAnimationFrame() {
      return 73;
    },
    cancelAnimationFrame(handle) {
      cancelledOwnedFrames.push(handle);
    },
    setTimeout: originalGlobals.setTimeout,
    clearTimeout: originalGlobals.clearTimeout,
    performance: { now: () => 0 }
  };
  animationFrameFenceTab.requestWindowAnimationFrame(() => {
    ownedFrameCallbackRan = true;
  });
  animationFrameFenceTab.hide();
  assert(cancelledOwnedFrames.includes(73), "SettingsTab.hide() did not cancel its owned animation frame");
  assert(animationFrameFenceTab._ownedAnimationFrames.size === 0 && ownedFrameCallbackRan === false, "Disposed SettingsTab retained or executed an owned animation frame");

  const generationFrameFenceTab = new SettingsTabClass(plugin.app, plugin);
  let generationFrameCallback = null;
  let staleGenerationFrameRan = false;
  generationFrameFenceTab.containerEl.win = {
    requestAnimationFrame(callback) {
      generationFrameCallback = callback;
      return 74;
    },
    cancelAnimationFrame() {},
    setTimeout: originalGlobals.setTimeout,
    clearTimeout: originalGlobals.clearTimeout,
    performance: { now: () => 0 }
  };
  generationFrameFenceTab.requestWindowAnimationFrame(() => {
    staleGenerationFrameRan = true;
  });
  generationFrameFenceTab._renderGeneration += 1;
  generationFrameCallback(0);
  assert(staleGenerationFrameRan === false && generationFrameFenceTab._ownedAnimationFrames.size === 0, "A stale settings animation frame crossed a render generation");

  const postHideFrameTab = new SettingsTabClass(plugin.app, plugin);
  const postHideFrames = [];
  let resolvePostHideStats = null;
  let markPostHideStatsStarted = null;
  let postHideFocusCalls = 0;
  const postHideStatsStarted = new Promise((resolve) => {
    markPostHideStatsStarted = resolve;
  });
  const originalGetStatsSnapshotForPostHideFrame = plugin.getStatsSnapshot;
  postHideFrameTab.containerEl.win = {
    requestAnimationFrame(callback) {
      const frame = { callback, handle: 80 + postHideFrames.length, cancelled: false };
      postHideFrames.push(frame);
      return frame.handle;
    },
    cancelAnimationFrame(handle) {
      const frame = postHideFrames.find((candidate) => candidate.handle === handle);
      if (frame) frame.cancelled = true;
    },
    setTimeout: originalGlobals.setTimeout,
    clearTimeout: originalGlobals.clearTimeout,
    performance: { now: () => 0 }
  };
  postHideFrameTab.getActiveDocument = () => ({
    activeElement: {
      focus() {
        postHideFocusCalls += 1;
      }
    }
  });
  try {
    plugin.getStatsSnapshot = async () => {
      markPostHideStatsStarted();
      return await new Promise((resolve) => {
        resolvePostHideStats = resolve;
      });
    };
    postHideFrameTab.rerenderPreservingScroll();
    assert(postHideFrames.length === 1, "Settings rerender did not schedule its initial animation frame");
    postHideFrames[0].callback(0);
    await postHideStatsStarted;
    postHideFrameTab.hide();
    resolvePostHideStats(renderFenceStats);
    await withTestTimeout("post-hide settings frame settlement", (async () => {
      while (postHideFrameTab._isRendering) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    })(), 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert(postHideFrames.length === 1, "A completed stale settings render scheduled a new animation frame after hide()");
    assert(postHideFocusCalls === 0, "A completed stale settings render focused detached UI after hide()");
  } finally {
    resolvePostHideStats?.(renderFenceStats);
    plugin.getStatsSnapshot = originalGetStatsSnapshotForPostHideFrame;
  }

  const originalSettingsTabRenderForRerender = settingsTab.renderSettings;
  const originalSettingsTabRaf = settingsTab.requestWindowAnimationFrame;
  const originalConsoleErrorForRerender = console.error;
  const rerenderCallbacks = [];
  let rerenderErrorsLogged = 0;
  try {
    settingsTab.containerEl.scrollTop = 42;
    settingsTab.requestWindowAnimationFrame = (callback) => {
      rerenderCallbacks.push(callback);
      return rerenderCallbacks.length;
    };
    settingsTab.renderSettings = async () => {
      throw new Error("simulated rerender failure");
    };
    console.error = () => {
      rerenderErrorsLogged += 1;
    };
    settingsTab.rerenderPreservingScroll();
    rerenderCallbacks[0]();
    await Promise.resolve();
    await Promise.resolve();
    assert(rerenderErrorsLogged >= 1, "rerenderPreservingScroll() did not log renderSettings() rejection");
    assert(rerenderCallbacks.length >= 2, "rerenderPreservingScroll() did not schedule restore after renderSettings() rejection");
  } finally {
    settingsTab.renderSettings = originalSettingsTabRenderForRerender;
    settingsTab.requestWindowAnimationFrame = originalSettingsTabRaf;
    console.error = originalConsoleErrorForRerender;
  }

  const originalSettingsTabRenderForFocus = settingsTab.renderSettings;
  const originalSettingsTabRafForFocus = settingsTab.requestWindowAnimationFrame;
  const originalSettingsTabGetActiveDocumentForFocus = settingsTab.getActiveDocument;
  const focusCallbacks = [];
  let focusRestoredForNonHtmlElement = false;
  try {
    settingsTab.containerEl.scrollTop = 84;
    settingsTab.getActiveDocument = () => ({
      activeElement: {
        focus() {
          focusRestoredForNonHtmlElement = true;
        }
      }
    });
    settingsTab.requestWindowAnimationFrame = (callback) => {
      focusCallbacks.push(callback);
      return focusCallbacks.length;
    };
    settingsTab.renderSettings = async () => {};
    settingsTab.rerenderPreservingScroll();
    focusCallbacks[0]();
    await Promise.resolve();
    focusCallbacks[1]();
    assert(focusRestoredForNonHtmlElement, "rerenderPreservingScroll() did not restore focus for non-HTMLElement focusable active elements");
  } finally {
    settingsTab.renderSettings = originalSettingsTabRenderForFocus;
    settingsTab.requestWindowAnimationFrame = originalSettingsTabRafForFocus;
    settingsTab.getActiveDocument = originalSettingsTabGetActiveDocumentForFocus;
  }

  const originalSettingsTabSetTimeout = settingsTab.setWindowTimeout;
  const originalSettingsTabClearTimeout = settingsTab.clearWindowTimeout;
  const originalPluginSaveSettingsForDebounce = plugin.saveSettings;
  const settingsSaveTimers = [];
  let debouncedSaveCalls = 0;
  try {
    settingsTab.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      settingsSaveTimers.push(timer);
      return timer;
    };
    settingsTab.clearWindowTimeout = (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    };
    plugin.saveSettings = async () => {
      debouncedSaveCalls += 1;
    };
    settingsTab.debouncedSaveSettings();
    settingsTab.debouncedSaveSettings();
    settingsTab.debouncedSaveSettings();
    assert(settingsSaveTimers.length === 3, `Debounced settings save expected 3 scheduled timers, got ${settingsSaveTimers.length}`);
    assert(settingsSaveTimers[0].cleared && settingsSaveTimers[1].cleared, "Debounced settings save did not clear previous timers");
    settingsSaveTimers[2].callback();
    await Promise.resolve();
    assert(debouncedSaveCalls === 1, `Debounced settings save wrote ${debouncedSaveCalls} times instead of once`);
  } finally {
    settingsTab.setWindowTimeout = originalSettingsTabSetTimeout;
    settingsTab.clearWindowTimeout = originalSettingsTabClearTimeout;
    plugin.saveSettings = originalPluginSaveSettingsForDebounce;
    settingsTab.saveSettingsDebounceTimer = null;
  }
  settingsTab._isDisposed = false;
  settingsTab._isVisible = true;

  const originalSettingsContainerWindow = settingsTab.containerEl.win;
  const originalPluginSaveSettingsForWindowOwnership = plugin.saveSettings;
  const popoutTimerCallbacks = new Map();
  const popoutClearedTimers = [];
  let nextPopoutTimer = 40;
  const popoutTimerWindow = {
    setTimeout(callback, delay) {
      const timer = nextPopoutTimer;
      nextPopoutTimer += 1;
      popoutTimerCallbacks.set(timer, { callback, delay });
      return timer;
    },
    clearTimeout(timer) {
      popoutClearedTimers.push(timer);
      popoutTimerCallbacks.delete(timer);
    }
  };
  let popoutFlushSaveCalls = 0;
  try {
    settingsTab.containerEl.win = popoutTimerWindow;
    plugin.saveSettings = async () => {
      popoutFlushSaveCalls += 1;
    };
    settingsTab.debouncedSaveSettings(275);
    const [popoutTimer] = popoutTimerCallbacks.keys();
    assert(popoutTimerCallbacks.get(popoutTimer)?.delay === 275, "Settings debounce timer was not scheduled on the owning popout window");
    settingsTab.flushPendingSaveSettings();
    await Promise.resolve();
    assert(popoutClearedTimers.includes(popoutTimer), "Settings debounce timer was not cleared through the same popout window");
    assert(popoutFlushSaveCalls === 1, `Settings popout timer flush saved ${popoutFlushSaveCalls} times instead of once`);
    assert(settingsTab.saveSettingsDebounceWindow === null, "Settings debounce retained a stale owning window after flush");
  } finally {
    settingsTab.containerEl.win = originalSettingsContainerWindow;
    plugin.saveSettings = originalPluginSaveSettingsForWindowOwnership;
    settingsTab.saveSettingsDebounceTimer = null;
    settingsTab.saveSettingsDebounceWindow = null;
  }

  const createCollidingTimerWindow = () => {
    const callbacks = [];
    return {
      callbacks,
      setTimeout(callback) {
        callbacks.push(callback);
        return 1;
      },
      clearTimeout() {}
    };
  };
  const firstFocusWindow = createCollidingTimerWindow();
  const secondFocusWindow = createCollidingTimerWindow();
  const firstFocusTarget = {
    ownerDocument: { defaultView: firstFocusWindow },
    isConnected: true,
    focus() {}
  };
  const secondFocusTarget = {
    ownerDocument: { defaultView: secondFocusWindow },
    isConnected: true,
    focus() {}
  };
  plugin.modalFocusTimers.clear();
  plugin.scheduleElementFocus(firstFocusTarget);
  plugin.scheduleElementFocus(secondFocusTarget);
  assert(plugin.modalFocusTimers.size === 2, "Equal timer IDs from two windows collided in modal focus tracking");
  assert(plugin.modalFocusTimers.get(firstFocusWindow)?.has(1) && plugin.modalFocusTimers.get(secondFocusWindow)?.has(1), "Modal focus timer ownership was not retained per window");
  firstFocusWindow.callbacks[0]();
  assert(plugin.modalFocusTimers.size === 1 && plugin.modalFocusTimers.has(secondFocusWindow), "Completing one popout focus timer removed another window's equal timer ID");
  secondFocusWindow.callbacks[0]();
  assert(plugin.modalFocusTimers.size === 0, "Completed popout focus timers were not removed from ownership tracking");

  const settingsHideTimers = [];
  let saveCallsOnSettingsHide = 0;
  try {
    settingsTab.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      settingsHideTimers.push(timer);
      return timer;
    };
    settingsTab.clearWindowTimeout = (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    };
    plugin.saveSettings = async () => {
      saveCallsOnSettingsHide += 1;
    };
    settingsTab.debouncedSaveSettings();
    settingsTab.hide();
    await Promise.resolve();
    assert(settingsHideTimers.length === 1 && settingsHideTimers[0].cleared, "SettingsTab.hide() did not clear a pending debounced save timer");
    assert(settingsTab.saveSettingsDebounceTimer === null, "SettingsTab.hide() left a pending save timer reference");
    assert(saveCallsOnSettingsHide === 1, `SettingsTab.hide() flushed ${saveCallsOnSettingsHide} saves instead of one`);
  } finally {
    settingsTab.setWindowTimeout = originalSettingsTabSetTimeout;
    settingsTab.clearWindowTimeout = originalSettingsTabClearTimeout;
    plugin.saveSettings = originalPluginSaveSettingsForDebounce;
    settingsTab.saveSettingsDebounceTimer = null;
  }
  settingsTab._isDisposed = false;
  settingsTab._isVisible = true;

  assert(settingsTab.normalizeAllowedRootSelection("") === null, "Allowed roots should reject the empty vault root selection");
  assert(settingsTab.normalizeAllowedRootSelection("/") === null, "Allowed roots should reject the slash vault root selection");
  assert(settingsTab.normalizeAllowedRootSelection("Images") === "Images/", "Allowed roots should normalize folder selections with a trailing slash");

  const loadingButtonCalls = [];
  const loadingButton = {
    setDisabled(value) {
      loadingButtonCalls.push(["disabled", value]);
      return this;
    },
    setButtonText(value) {
      loadingButtonCalls.push(["text", value]);
      return this;
    }
  };
  let loadingTaskRan = false;
  await settingsTab.runButtonTask(loadingButton, "common.refresh", "common.refreshing", async () => {
    loadingTaskRan = true;
  });
  assert(loadingTaskRan, "runButtonTask() did not run the async button task");
  assert(JSON.stringify(loadingButtonCalls) === JSON.stringify([
    ["disabled", true],
    ["text", "Refreshing..."],
    ["text", "Refresh"],
    ["disabled", false]
  ]), `runButtonTask() did not restore loading state correctly: ${JSON.stringify(loadingButtonCalls)}`);

  const ObsidianMockForButtonFailure = require("obsidian");
  const originalNoticeForButtonFailure = ObsidianMockForButtonFailure.Notice;
  const originalConsoleErrorForButtonFailure = console.error;
  const failedButtonNotices = [];
  const failedButtonCalls = [];
  try {
    ObsidianMockForButtonFailure.Notice = class {
      constructor(message) {
        failedButtonNotices.push(String(message));
      }
    };
    console.error = () => {};
    await settingsTab.runButtonTask({
      setDisabled(value) {
        failedButtonCalls.push(["disabled", value]);
        return this;
      },
      setButtonText(value) {
        failedButtonCalls.push(["text", value]);
        return this;
      }
    }, "common.clear", "common.clearing", async () => {
      throw new Error("simulated settings action failure");
    });
    assert(failedButtonNotices.some((message) => message.includes("Operation failed")), "runButtonTask() did not show a Notice after a failed async settings action");
    assert(JSON.stringify(failedButtonCalls.slice(-2)) === JSON.stringify([["text", "Clear"], ["disabled", false]]), "runButtonTask() did not restore button state after failure");
  } finally {
    ObsidianMockForButtonFailure.Notice = originalNoticeForButtonFailure;
    console.error = originalConsoleErrorForButtonFailure;
  }

  const staleButtonTab = new SettingsTabClass(plugin.app, plugin);
  const staleButtonCalls = [];
  let finishStaleButtonTask;
  const staleButtonTask = new Promise((resolve) => {
    finishStaleButtonTask = resolve;
  });
  const staleButtonRun = staleButtonTab.runButtonTask({
    setDisabled(value) {
      staleButtonCalls.push(["disabled", value]);
      return this;
    },
    setButtonText(value) {
      staleButtonCalls.push(["text", value]);
      return this;
    }
  }, "common.refresh", "common.refreshing", async () => staleButtonTask);
  staleButtonTab.hide();
  finishStaleButtonTask();
  await staleButtonRun;
  assert(JSON.stringify(staleButtonCalls) === JSON.stringify([
    ["disabled", true],
    ["text", "Refreshing..."]
  ]), `A settings task mutated its stale button after hide(): ${JSON.stringify(staleButtonCalls)}`);

  const subsettingRow = { settingEl: createMockElement() };
  let subsettingVisible = null;
  subsettingRow.settingEl.toggle = (value) => {
    subsettingVisible = value;
  };
  settingsTab.applySubsettingVisibility(false, subsettingRow);
  assert(subsettingVisible === false && subsettingRow.settingEl.classList.contains("tiny-local-subsetting"), "applySubsettingVisibility() did not toggle and classify conditional settings rows");
  const invalidSavingsWidths = settingsTab.getSavingsBarWidths({
    originalSize: 100,
    currentSize: 100,
    savedSize: Number.NaN,
    savedPercentage: Number.NaN,
    processedFiles: 1,
    totalFiles: 1
  });
  assert(invalidSavingsWidths.savedWidth === 0 && invalidSavingsWidths.currentWidth === 100, `Savings bar finite guard returned wrong widths: ${JSON.stringify(invalidSavingsWidths)}`);

  const activeDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const element = createMockElement();
      element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, bottom: 40 });
      return element;
    }
  };
  const tooltipContainer = createMockElement();
  const pluginLifecycleCallbacksBeforeTooltip = plugin.registeredCallbacks.length;
  tooltipContainer.getBoundingClientRect = () => ({ left: 20, top: 60, width: 160, height: 20, bottom: 80 });
  settingsTab.getActiveDocument = () => activeDocument;
  settingsTab.getActiveWindow = () => ({
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    clearTimeout() {}
  });
  settingsTab.setWindowTimeout = (callback) => callback();
  settingsTab.createSavingsTooltip(tooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  tooltipContainer.dispatchEvent("mouseenter", {});
  assert(activeDocument.body.children.length === 1, "Savings tooltip did not render on hover");
  assert(activeDocument.body.children[0].style.getPropertyValue("--local-image-compress-savings-tooltip-left"), "Savings tooltip did not calculate left position");
  assert(activeDocument.body.children[0].style.getPropertyValue("--local-image-compress-savings-tooltip-top"), "Savings tooltip did not calculate top position");
  assert(activeDocument.body.children[0].style.getPropertyValue("--local-image-compress-savings-tooltip-arrow-x"), "Savings tooltip did not calculate arrow position");
  assert(activeDocument.body.children[0].children[0].classList.contains("tiny-local-savings-tooltip-placement-above"), "Savings tooltip did not mark above-target placement");
  tooltipContainer.dispatchEvent("mouseleave", {});
  settingsTab.cleanupSavingsTooltips();
  assert(activeDocument.body.children.length === 0, "Savings tooltip cleanup left tooltip DOM behind");
  assert((tooltipContainer._listeners.mouseenter || []).length === 0, "Savings tooltip cleanup left mouseenter listener behind");
  assert((tooltipContainer._listeners.mouseleave || []).length === 0, "Savings tooltip cleanup left mouseleave listener behind");
  assert(plugin.registeredCallbacks.length === pluginLifecycleCallbacksBeforeTooltip, "Render-scoped savings tooltip accumulated plugin-lifetime cleanup callbacks");

  const scopedTooltipFrameTab = new SettingsTabClass(plugin.app, plugin);
  const cancelledTooltipFrames = [];
  let nextTooltipFrameHandle = 90;
  let nextTooltipTimerHandle = 1;
  const tooltipFrameWindow = {
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame() {
      return nextTooltipFrameHandle++;
    },
    cancelAnimationFrame(handle) {
      cancelledTooltipFrames.push(handle);
    },
    setTimeout(callback) {
      callback();
      return nextTooltipTimerHandle++;
    },
    clearTimeout() {},
    performance: { now: () => 0 },
    document: activeDocument
  };
  scopedTooltipFrameTab.containerEl.win = tooltipFrameWindow;
  scopedTooltipFrameTab.getActiveDocument = () => activeDocument;
  scopedTooltipFrameTab.getActiveWindow = () => tooltipFrameWindow;
  for (let iteration = 0; iteration < 3; iteration++) {
    const scopedTooltipContainer = createMockElement();
    scopedTooltipContainer.win = tooltipFrameWindow;
    scopedTooltipContainer.doc = activeDocument;
    scopedTooltipContainer.getBoundingClientRect = () => ({ left: 20, top: 60, width: 160, height: 20, bottom: 80 });
    scopedTooltipFrameTab.createSavingsTooltip(scopedTooltipContainer, {
      originalSize: 1000,
      currentSize: 700,
      savedSize: 300,
      savedPercentage: 30,
      processedFiles: 1,
      totalFiles: 2,
      estimatedFiles: 0
    });
    scopedTooltipContainer.dispatchEvent("mouseenter", {});
    assert(scopedTooltipFrameTab._ownedAnimationFrames.size === 1, "Savings tooltip did not own its pending position frame");
    scopedTooltipContainer.dispatchEvent("mouseleave", {});
    assert(scopedTooltipFrameTab._ownedAnimationFrames.size === 0, "Hidden savings tooltip retained its pending position frame");
    scopedTooltipContainer.dispatchEvent("mouseenter", {});
    assert(scopedTooltipFrameTab._ownedAnimationFrames.size === 1, "Savings tooltip did not own its replacement position frame");
    scopedTooltipFrameTab.cleanupSavingsTooltips();
    assert(scopedTooltipFrameTab._ownedAnimationFrames.size === 0, "Savings tooltip rerender retained its pending position frame");
    assert((scopedTooltipContainer._listeners.mouseenter || []).length === 0, "Savings tooltip rerender retained its old container listener");
  }
  assert(cancelledTooltipFrames.length === 6, `Savings tooltip cleanup cancelled ${cancelledTooltipFrames.length} of 6 render-scoped frames`);
  assert(plugin.registeredCallbacks.length === pluginLifecycleCallbacksBeforeTooltip, "Repeated savings tooltip renders accumulated plugin-lifetime callbacks");

  const tooltipTimers = [];
  const tooltipTimerWindow = {
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      tooltipTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    }
  };
  const raceTooltipContainer = createMockElement();
  settingsTab.getActiveDocument = () => activeDocument;
  settingsTab.getActiveWindow = () => tooltipTimerWindow;
  settingsTab.setWindowTimeout = (callback, delay) => tooltipTimerWindow.setTimeout(callback, delay);
  settingsTab.createSavingsTooltip(raceTooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  raceTooltipContainer.dispatchEvent("mouseenter", {});
  raceTooltipContainer.dispatchEvent("mouseleave", {});
  raceTooltipContainer.dispatchEvent("mouseenter", {});
  assert(tooltipTimers.length === 3, `Tooltip timer race test expected 3 timers, got ${tooltipTimers.length}`);
  assert(tooltipTimers[0].cleared === true, "Tooltip mouseleave did not clear the pending show timer");
  assert(tooltipTimers[1].cleared === true, "Tooltip re-enter did not clear the pending hide timer");
  settingsTab.cleanupSavingsTooltips();

  const hideTooltipContainer = createMockElement();
  const hideTooltipDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const element = createMockElement();
      element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, bottom: 40 });
      return element;
    },
    querySelectorAll(selector) {
      return this.body.querySelectorAll(selector);
    }
  };
  hideTooltipContainer.getBoundingClientRect = () => ({ left: 20, top: 60, width: 160, height: 20, bottom: 80 });
  settingsTab.getActiveDocument = () => hideTooltipDocument;
  settingsTab.getActiveWindow = () => ({
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    clearTimeout() {}
  });
  settingsTab.setWindowTimeout = (callback) => callback();
  settingsTab.createSavingsTooltip(hideTooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  hideTooltipContainer.dispatchEvent("mouseenter", {});
  assert(hideTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 1, "Savings tooltip did not render before hide()");
  settingsTab.hide();
  assert(hideTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 0, "SettingsTab.hide() left savings tooltip DOM behind");
  assert((hideTooltipContainer._listeners.mouseenter || []).length === 0, "SettingsTab.hide() left mouseenter listener behind");
  assert((hideTooltipContainer._listeners.mouseleave || []).length === 0, "SettingsTab.hide() left mouseleave listener behind");
  assert(settingsTab.hidden === true, "SettingsTab.hide() did not delegate to the base hide()");

  const popoutTooltipContainer = createMockElement();
  const popoutTooltipDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const element = createMockElement();
      element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, bottom: 40 });
      return element;
    },
    querySelectorAll(selector) {
      return this.body.querySelectorAll(selector);
    }
  };
  const mainTooltipDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return createMockElement();
    },
    querySelectorAll(selector) {
      return this.body.querySelectorAll(selector);
    }
  };
  popoutTooltipContainer.getBoundingClientRect = () => ({ left: 20, top: 60, width: 160, height: 20, bottom: 80 });
  settingsTab.getActiveDocument = () => popoutTooltipDocument;
  settingsTab.getActiveWindow = () => ({
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    clearTimeout() {}
  });
  settingsTab.setWindowTimeout = (callback) => callback();
  settingsTab.createSavingsTooltip(popoutTooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  popoutTooltipContainer.dispatchEvent("mouseenter", {});
  assert(popoutTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 1, "Popout savings tooltip did not render");
  settingsTab.getActiveDocument = () => mainTooltipDocument;
  settingsTab.cleanupSavingsTooltips();
  assert(popoutTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 0, "Savings tooltip cleanup missed a tooltip created in a previous document");
  assert((popoutTooltipContainer._listeners.mouseenter || []).length === 0, "Cross-document tooltip cleanup left mouseenter listener behind");

  let settingsDisplayCount = 0;
  const originalSettingsTabUpdateStats = settingsTab.updateStats;
  settingsTab._isDisposed = false;
  settingsTab._isVisible = true;
  settingsTab.updateStats = async () => {
    settingsDisplayCount += 1;
  };
  await plugin.updateSavingsIndicatorInSettings();
  assert(settingsDisplayCount === 1, "Plugin did not refresh an already-open active settings tab");
  settingsTab._isVisible = false;
  await plugin.updateSavingsIndicatorInSettings();
  assert(settingsDisplayCount === 1, "Plugin refreshed settings while its settings tab was hidden");
  const ownedSettingsTab = plugin.settingsTab;
  plugin.settingsTab = null;
  await plugin.updateSavingsIndicatorInSettings();
  plugin.settingsTab = ownedSettingsTab;
  assert(settingsDisplayCount === 1, "Plugin settings indicator refresh did not tolerate a missing owned settings tab");

  let settingsPendingRerenderRequested = false;
  let settingsUpdateStatsWhileRendering = false;
  settingsTab._isVisible = true;
  settingsTab._isRendering = true;
  settingsTab._pendingRerender = false;
  settingsTab.updateStats = async () => {
    settingsUpdateStatsWhileRendering = true;
  };
  await plugin.updateSavingsIndicatorInSettings();
  settingsPendingRerenderRequested = settingsTab._pendingRerender;
  assert(settingsPendingRerenderRequested, "Plugin did not ask SettingsTab to defer a stats refresh while rendering");
  assert(!settingsUpdateStatsWhileRendering, "Plugin refreshed settings stats while SettingsTab reported an active render");
  settingsTab._isRendering = false;
  settingsTab._pendingRerender = false;
  settingsTab._isVisible = false;
  settingsTab.updateStats = originalSettingsTabUpdateStats;

  plugin.cache.cacheData.entries = {};
  plugin.settings.autoBackgroundThreshold = 1;
  await plugin.statusBarController.update();
  assert(plugin.statusBarItem.getText().startsWith("\u25CF "), "Status bar backlog state is missing its attention indicator");
  assert(String(plugin.statusBarItem.attributes["aria-label"] || "").includes(plugin.statusBarItem.getText()), "Status bar aria-label did not match the visible backlog status text");
  assert(plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar backlog class is missing");
  assert(!plugin.statusBarItem.classList.contains("tiny-local-compressing"), "Status bar backlog state should not use running class");

  plugin.backgroundCompressionService.isBackgroundCompressionRunning = true;
  await plugin.statusBarController.update();
  assert(plugin.statusBarItem.getText().startsWith("\u27F3 "), "Status bar running state is missing its running indicator");
  assert(plugin.statusBarItem.classList.contains("tiny-local-compressing"), "Status bar running class is missing");
  assert(!plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar running state should not use backlog class");

  plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
  plugin.settings.autoBackgroundThreshold = 999;
  await plugin.statusBarController.update();
  assert(!plugin.statusBarItem.classList.contains("tiny-local-compressing"), "Status bar idle state should not use running class");
  assert(!plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar idle state should not use backlog class");

  const originalLastUserActivity = plugin.backgroundCompressionService.lastUserActivity;
  const originalLastUserActivityPerfTime = plugin.backgroundCompressionService.lastUserActivityPerfTime;
  try {
    plugin.backgroundCompressionService.lastUserActivity = Date.now() + 60 * 60 * 1000;
    plugin.backgroundCompressionService.lastUserActivityPerfTime = plugin.getMonotonicTime() - plugin.backgroundCompressionService.USER_INACTIVITY_THRESHOLD - 1;
    assert(plugin.backgroundCompressionService.isUserInactive(), "Background inactivity used wall-clock time instead of monotonic time");
  } finally {
    plugin.backgroundCompressionService.lastUserActivity = originalLastUserActivity;
    plugin.backgroundCompressionService.lastUserActivityPerfTime = originalLastUserActivityPerfTime;
  }

  const popoutActivityListeners = new Map();
  const popoutActivityDocument = {
    addEventListener(name, callback) {
      const callbacks = popoutActivityListeners.get(name) || [];
      callbacks.push(callback);
      popoutActivityListeners.set(name, callbacks);
    },
    removeEventListener(name, callback) {
      const callbacks = popoutActivityListeners.get(name) || [];
      popoutActivityListeners.set(name, callbacks.filter((candidate) => candidate !== callback));
    }
  };
  const windowOpenHandler = plugin.app._workspaceHandlers["window-open"];
  const windowCloseHandler = plugin.app._workspaceHandlers["window-close"];
  assert(typeof windowOpenHandler === "function" && typeof windowCloseHandler === "function", "Popout activity lifecycle handlers were not registered");
  windowOpenHandler({}, { document: popoutActivityDocument });
  windowOpenHandler({}, { document: popoutActivityDocument });
  assert(plugin.backgroundCompressionService.activityDocuments.has(popoutActivityDocument), "Future popout document was not tracked");
  assert((popoutActivityListeners.get("keydown") || []).length === 1, "Popout activity document registered duplicate listeners");
  plugin.backgroundCompressionService.lastUserActivityPerfTime = 0;
  for (const callback of popoutActivityListeners.get("keydown") || []) {
    callback({});
  }
  assert(plugin.backgroundCompressionService.lastUserActivityPerfTime > 0, "Popout keyboard activity did not reset the inactivity clock");
  windowCloseHandler({}, { document: popoutActivityDocument });
  assert(!plugin.backgroundCompressionService.activityDocuments.has(popoutActivityDocument), "Closed popout document stayed tracked");
  assert((popoutActivityListeners.get("keydown") || []).length === 0, "Closed popout document kept activity listeners");

  const originalIsUserInactiveForThreshold = plugin.backgroundCompressionService.isUserInactive;
  const originalStartBackgroundCompression = plugin.backgroundCompressionService.startBackgroundCompression;
  let backgroundStartsAtThreshold = 0;
  plugin.backgroundCompressionService.isUserInactive = () => true;
  plugin.backgroundCompressionService.startBackgroundCompression = async () => {
    backgroundStartsAtThreshold += 1;
  };
  await setMockFiles(plugin, [
    createMockFile("Threshold/a.png", 100000, 1),
    createMockFile("Threshold/b.png", 100000, 1)
  ]);
  plugin.cache.cacheData.entries = {};
  plugin.settings.autoBackgroundCompression = true;
  plugin.settings.autoBackgroundThreshold = 2;
  plugin.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD = 2;
  await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
  assert(backgroundStartsAtThreshold === 1, "Background compression did not start at exactly the configured threshold");
  const originalImageIndexForBackgroundGuard = plugin.imageIndex;
  try {
    plugin.imageIndex = {
      isReady: () => false,
      getSnapshot() {
        throw new Error("stale snapshot should not be read while image index is rebuilding");
      }
    };
    backgroundStartsAtThreshold = 0;
    await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
    assert(backgroundStartsAtThreshold === 0, "Background compression used an image-index snapshot while rebuild was in flight");
  } finally {
    plugin.imageIndex = originalImageIndexForBackgroundGuard;
  }
  let inactiveChecksDuringBackgroundStart = 0;
  plugin.backgroundCompressionService.isUserInactive = () => {
    inactiveChecksDuringBackgroundStart += 1;
    return inactiveChecksDuringBackgroundStart === 1;
  };
  backgroundStartsAtThreshold = 0;
  await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
  assert(backgroundStartsAtThreshold === 0, "Background compression ignored user activity between threshold check and trigger");
  plugin.backgroundCompressionService.isUserInactive = () => true;
  const originalAutoBackgroundCompressionForThreshold = plugin.settings.autoBackgroundCompression;
  let autoBackgroundReads = 0;
  try {
    Object.defineProperty(plugin.settings, "autoBackgroundCompression", {
      configurable: true,
      get() {
        autoBackgroundReads += 1;
        return autoBackgroundReads === 1;
      },
      set(value) {
        autoBackgroundReads = value ? 0 : 2;
      }
    });
    backgroundStartsAtThreshold = 0;
    await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
    assert(backgroundStartsAtThreshold === 0, "Background compression ignored a settings toggle between threshold check and trigger");
  } finally {
    Object.defineProperty(plugin.settings, "autoBackgroundCompression", {
      configurable: true,
      writable: true,
      value: originalAutoBackgroundCompressionForThreshold
    });
  }
  await plugin.statusBarController.update();
  assert(plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar did not show backlog at exactly the configured threshold");
  plugin.backgroundCompressionService.isUserInactive = originalIsUserInactiveForThreshold;
  plugin.backgroundCompressionService.startBackgroundCompression = originalStartBackgroundCompression;

  const originalGetImageFilesForBackgroundFilter = plugin.getImageFiles;
  const originalGetAllImageFilesForBackgroundFilter = plugin.getAllImageFiles;
  const originalImageIndexForBackgroundFilter = plugin.imageIndex;
  const originalIsProcessedForBackgroundFilter = plugin.cache.isFileAlreadyProcessed;
  const originalProcessBackgroundFilter = plugin.processBatchCompressionBackground;
  const originalIsUserInactiveForBackgroundFilter = plugin.backgroundCompressionService.isUserInactive;
  const originalAllowedRootsForBackgroundFilter = plugin.settings.allowedRoots;
  const originalStatusBarUpdateForBackgroundFilter = plugin.statusBarController.update;
  try {
    plugin.settings.allowedRoots = [];
    plugin.statusBarController.update = async () => {};
    const readyBackgroundFiles = [
      createMockFile("Background/ready-a.png", 100000, 1),
      createMockFile("Background/ready-b.jpg", 100000, 2)
    ];
    plugin.imageIndex = {
      isReady: () => true,
      getSnapshot: () => ({ uncompressedImages: readyBackgroundFiles.length, totalImages: readyBackgroundFiles.length })
    };
    plugin.getImageFiles = async () => readyBackgroundFiles;
    plugin.cache.isFileAlreadyProcessed = async () => {
      throw new Error("ready image index should avoid sequential processed checks");
    };
    let backgroundBatchFiles = null;
    plugin.processBatchCompressionBackground = async (files) => {
      backgroundBatchFiles = files;
    };
    plugin.backgroundCompressionService.isUserInactive = () => true;
    plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
    plugin.settings.autoBackgroundCompression = true;
    await plugin.backgroundCompressionService.startBackgroundCompression();
    assert(backgroundBatchFiles?.length === readyBackgroundFiles.length, "Background compression did not trust the ready image-index uncompressed file list");

    const fallbackBackgroundFiles = [
      createMockFile("Background/fallback-a.png", 100000, 3),
      createMockFile("Background/fallback-processed.jpg", 100000, 4)
    ];
    plugin.app._files = fallbackBackgroundFiles;
    plugin.imageIndex = {
      isReady: () => false,
      getSnapshot: () => ({ uncompressedImages: fallbackBackgroundFiles.length, totalImages: fallbackBackgroundFiles.length })
    };
    plugin.getAllImageFiles = () => fallbackBackgroundFiles;
    plugin.getImageFiles = async () => {
      throw new Error("not-ready background should use getAllImageFiles instead of sequential getImageFiles fallback");
    };
    let fallbackProcessedChecks = 0;
    plugin.cache.isFileAlreadyProcessed = async (file) => {
      fallbackProcessedChecks += 1;
      return file.path.includes("processed");
    };
    backgroundBatchFiles = null;
    plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
    await plugin.backgroundCompressionService.startBackgroundCompression();
    assert(fallbackProcessedChecks === fallbackBackgroundFiles.length, `Background fallback checked ${fallbackProcessedChecks} files instead of ${fallbackBackgroundFiles.length}`);
    assert(backgroundBatchFiles?.length === 1 && backgroundBatchFiles[0].path === "Background/fallback-a.png", "Background fallback did not pass only unprocessed files to batch compression");
  } finally {
    plugin.getImageFiles = originalGetImageFilesForBackgroundFilter;
    plugin.getAllImageFiles = originalGetAllImageFilesForBackgroundFilter;
    plugin.imageIndex = originalImageIndexForBackgroundFilter;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForBackgroundFilter;
    plugin.processBatchCompressionBackground = originalProcessBackgroundFilter;
    plugin.backgroundCompressionService.isUserInactive = originalIsUserInactiveForBackgroundFilter;
    plugin.settings.allowedRoots = originalAllowedRootsForBackgroundFilter;
    plugin.statusBarController.update = originalStatusBarUpdateForBackgroundFilter;
    plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
  }

  const originalGetActiveDocumentForMenu = plugin.getActiveDocument;
  const originalGetActiveWindowForMenu = plugin.getActiveWindow;
  const originalGetCompressedFilesCountForMenu = plugin.moveService.getCompressedFilesCount;
  const originalMoveCompressedToFilesForMenu = plugin.moveService.moveCompressedToFiles;
  const menuDocument = {
    body: createMockElement(),
    _listeners: {},
    createElement: () => createMockElement(),
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  const menuWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    _listeners: {},
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  let statusMenuMoveCalls = 0;
  const createVisibleStatusMenuTarget = () => {
    const target = createMockElement();
    target.getBoundingClientRect = () => ({ left: 25, top: 120, width: 80, height: 20, bottom: 140 });
    return target;
  };
  try {
    plugin.getActiveDocument = () => menuDocument;
    plugin.getActiveWindow = () => menuWindow;
    plugin.setWindowTimeout = (callback) => {
      callback();
      return null;
    };
    plugin.moveService.getCompressedFilesCount = async () => 1;
    plugin.moveService.moveCompressedToFiles = async () => {
      statusMenuMoveCalls += 1;
    };
    const hiddenStatusMenuTarget = createMockElement();
    const hiddenStatusMenuWarnings = captureConsoleWarn();
    try {
      await plugin.statusBarController.showMenu({ target: hiddenStatusMenuTarget, preventDefault() {} });
    } finally {
      hiddenStatusMenuWarnings.restore();
    }
    assert(hiddenStatusMenuWarnings.messages.some((message) => message.includes("Status menu skipped because the status bar item is not visible")), "Hidden status menu did not emit the expected warning");
    assert(menuDocument.body.children.length === 0, "Status menu rendered for a hidden zero-size status bar item");
    await plugin.statusBarController.showMenu({ target: createVisibleStatusMenuTarget(), preventDefault() {} });
    const menu = menuDocument.body.children[0];
    assert(menu.attributes.role === "menu", "Status menu is missing role=menu");
    const moveItem = menu.children[menu.children.length - 1];
    assert(moveItem.tag === "button", "Status menu action is not rendered as a button");
    assert(moveItem.type === "button", "Status menu action button is missing type=button");
    assert(moveItem.attributes.role === "menuitem", "Status menu action button is missing role=menuitem");
    assert(plugin.statusBarItem.attributes["aria-expanded"] === "true", "Status bar aria-expanded did not change when menu opened");
    moveItem.dispatchEvent("click");
    assert(statusMenuMoveCalls === 1, "Status menu item did not run its action");
    assert(!menuDocument.body.contains(menu), "Status menu click did not remove the menu");
    assert(plugin.statusBarItem.attributes["aria-expanded"] === "false", "Status bar aria-expanded did not reset after menu action");
    assert((menuDocument._listeners.click || []).length === 0, "Status menu click left document click listeners behind");
    assert((menuDocument._listeners.keydown || []).length === 0, "Status menu click left document keydown listeners behind");
    assert((menuWindow._listeners.blur || []).length === 0, "Status menu click left window blur listeners behind");

    await plugin.statusBarController.showMenu({ keyboard: true, returnFocusTo: plugin.statusBarItem, target: createVisibleStatusMenuTarget() });
    const keyboardMenu = menuDocument.body.children[0];
    const firstKeyboardItem = keyboardMenu.children[1];
    const keyboardMoveItem = keyboardMenu.children[keyboardMenu.children.length - 1];
    assert(firstKeyboardItem.focused === true, "Keyboard-opened status menu did not focus the first menu item");
    let enterPreventedForMenuItem = false;
    keyboardMoveItem.dispatchEvent("keydown", {
      key: "Enter",
      preventDefault() {
        enterPreventedForMenuItem = true;
      }
    });
    assert(enterPreventedForMenuItem && statusMenuMoveCalls === 2, "Status menu Enter key did not run item action");
    assert(!menuDocument.body.contains(keyboardMenu), "Status menu Enter action did not close the menu");

    await plugin.statusBarController.showMenu({ keyboard: true, returnFocusTo: plugin.statusBarItem, target: createVisibleStatusMenuTarget() });
    const escapeMenu = menuDocument.body.children[0];
    plugin.statusBarItem.focused = false;
    let escapePreventedForMenu = false;
    menuDocument._listeners.keydown[0]?.({
      key: "Escape",
      preventDefault() {
        escapePreventedForMenu = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    assert(escapePreventedForMenu, "Status menu Escape key did not prevent default");
    assert(!menuDocument.body.contains(escapeMenu), "Status menu Escape key did not close the menu");
    assert(plugin.statusBarItem.focused === true, "Status menu Escape key did not restore focus");
    assert(plugin.statusBarItem.attributes["aria-expanded"] === "false", "Status bar aria-expanded did not reset after Escape");

    menuWindow.innerWidth = 800;
    menuWindow.innerHeight = 600;
    const edgeStatusMenuTarget = createMockElement();
    edgeStatusMenuTarget.getBoundingClientRect = () => ({ left: 790, top: 580, width: 20, height: 20, bottom: 600 });
    await plugin.statusBarController.showMenu({ target: edgeStatusMenuTarget, preventDefault() {} });
    const edgeMenu = menuDocument.body.children[0];
    const edgeLeft = Number.parseInt(edgeMenu.style.getPropertyValue("--local-image-compress-status-menu-left"), 10);
    const edgeTop = Number.parseInt(edgeMenu.style.getPropertyValue("--local-image-compress-status-menu-top"), 10);
    assert(edgeLeft === 430, `Right-edge status menu left was not clamped to the viewport: ${edgeLeft}`);
    assert(edgeTop >= 10 && edgeTop <= 430, `Bottom-edge status menu top was not clamped to the viewport: ${edgeTop}`);
    plugin.statusBarController.closeMenu();

    const capturedMenuDocument = {
      body: createMockElement(),
      _listeners: {},
      createElement() {
        const element = createMockElement();
        element.ownerDocumentName = "captured";
        return element;
      },
      addEventListener(name, callback) {
        this._listeners[name] = this._listeners[name] || [];
        this._listeners[name].push(callback);
      },
      removeEventListener(name, callback) {
        this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
      }
    };
    const switchedMenuDocument = {
      body: createMockElement(),
      createElement() {
        const element = createMockElement();
        element.ownerDocumentName = "switched";
        return element;
      },
      addEventListener() {},
      removeEventListener() {}
    };
    let activeDocumentReadsDuringMenuOpen = 0;
    plugin.getActiveDocument = () => {
      activeDocumentReadsDuringMenuOpen += 1;
      return activeDocumentReadsDuringMenuOpen <= 2 ? capturedMenuDocument : switchedMenuDocument;
    };
    await plugin.statusBarController.showMenu({ target: createVisibleStatusMenuTarget(), preventDefault() {} });
    assert(activeDocumentReadsDuringMenuOpen === 2, "Status menu re-read activeDocument after async count lookup");
    assert(capturedMenuDocument.body.children.length === 1 && switchedMenuDocument.body.children.length === 0, "Status menu was created in a different document than the one captured at open");
    plugin.statusBarController.closeMenu();
  } finally {
    plugin.getActiveDocument = originalGetActiveDocumentForMenu;
    plugin.getActiveWindow = originalGetActiveWindowForMenu;
    plugin.moveService.getCompressedFilesCount = originalGetCompressedFilesCountForMenu;
    plugin.moveService.moveCompressedToFiles = originalMoveCompressedToFilesForMenu;
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFile;
  }

  const deferredMenuDocument = {
    body: createMockElement(),
    _listeners: {},
    createElement: () => createMockElement(),
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  const deferredMenuWindow = {
    innerWidth: 1200,
    _listeners: {},
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  const deferredMenuTimers = [];
  try {
    plugin.getActiveDocument = () => deferredMenuDocument;
    plugin.getActiveWindow = () => deferredMenuWindow;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      deferredMenuTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    plugin.getCompressedFilesCount = async () => 0;
    await plugin.statusBarController.showMenu({ target: createVisibleStatusMenuTarget(), preventDefault() {} });
    assert(deferredMenuTimers.length === 1, `Status menu did not schedule exactly one deferred click listener: ${deferredMenuTimers.length}`);
    plugin.statusBarController.closeMenu();
    assert(deferredMenuTimers[0].cleared === true, "closeMenu() did not cancel the deferred status-menu click listener");
    assert(deferredMenuDocument.body.children.length === 0, "closeMenu() left the status menu DOM behind");
    assert((deferredMenuDocument._listeners.click || []).length === 0, "closeMenu() left document click listeners behind");
    assert((deferredMenuDocument._listeners.keydown || []).length === 0, "closeMenu() left document keydown listeners behind");
    assert((deferredMenuWindow._listeners.blur || []).length === 0, "closeMenu() left window blur listeners behind");
  } finally {
    plugin.getActiveDocument = originalGetActiveDocumentForMenu;
    plugin.getActiveWindow = originalGetActiveWindowForMenu;
    plugin.getCompressedFilesCount = originalGetCompressedFilesCountForMenu;
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFile;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForNewFile;
    plugin.statusBarController.closeMenu();
  }

  let counts;
  plugin.settings.outputFolder = "Compressed";
  await setMockFiles(plugin, [
    createMockFile("Compressed/root.png", 100000),
    createMockFile("Images/project/Compressed/nested.png", 100000)
  ]);
  let visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(
    JSON.stringify(visibleImagePaths) === JSON.stringify(["Images/project/Compressed/nested.png"]),
    `Output folder filtering excluded the wrong files for root output folder: ${visibleImagePaths.join(", ")}`
  );
  plugin.settings.outputFolder = "files/Compressed";
  await setMockFiles(plugin, [
    createMockFile("Compressed/root.png", 100000),
    createMockFile("files/Compressed/output.png", 100000),
    createMockFile("files/project/Compressed/ordinary.png", 100000)
  ]);
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(
    JSON.stringify(visibleImagePaths) === JSON.stringify(["Compressed/root.png", "files/project/Compressed/ordinary.png"]),
    `Output folder filtering excluded the wrong files for nested output folder: ${visibleImagePaths.join(", ")}`
  );
  for (const invalidOutputFolder of ["../outside", "/tmp/outside", "C:\\outside", "\\\\server\\share"]) {
    plugin.settings.outputFolder = invalidOutputFolder;
    await plugin.saveSettings();
    assert(plugin.getOutputFolder() === "Compressed", `Unsafe output folder was not normalized to Compressed: ${invalidOutputFolder}`);
    assert(plugin.savedData.outputFolder === "Compressed", `Unsafe output folder was persisted: ${invalidOutputFolder}`);
  }
  plugin.settings.outputFolder = "files/Compressed";
  await withRealGlobalTimers(() => plugin.saveSettings());
  assert(plugin.getOutputFolder() === "files/Compressed", "Safe nested output folder was not preserved");

  plugin.settings.outputFolder = "Compressed";
  plugin.settings.allowedRoots = ["Allowed", "foo"];
  await setMockFiles(plugin, [
    createMockFile("Allowed/a.png", 100000),
    createMockFile("Disallowed/b.png", 100000),
    createMockFile("foo/c.jpg", 100000),
    createMockFile("foobar/d.jpg", 100000)
  ]);
  counts = await plugin.getImageCompressionCounts();
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(
    JSON.stringify(visibleImagePaths) === JSON.stringify(["Allowed/a.png", "foo/c.jpg"]),
    `Allowed roots filtering included wrong files: ${visibleImagePaths.join(", ")}`
  );
  assert(counts.totalImages === 2 && counts.uncompressedImages === 2, `Allowed roots snapshot counted wrong files: ${JSON.stringify(counts)}`);
  plugin.settings.allowedRoots = [];

  const originalProcessBatchCompression = plugin.processBatchCompression;
  const originalIsImageFileAndNotCompressed = plugin.isImageFileAndNotCompressed;
  let folderBatchPaths = [];
  plugin.processBatchCompression = async (files) => {
    folderBatchPaths = files.map((file) => file.path).sort();
  };
  plugin.isImageFileAndNotCompressed = async (file) => plugin.isImageFile(file);
  await setMockFiles(plugin, [
    createMockFile("foo/a.png", 100000, 1),
    createMockFile("foo/sub/c.jpg", 100000, 1),
    createMockFile("foobar/b.png", 100000, 1)
  ]);
  await plugin.compressImagesInFolderPath("foo", true);
  assert(
    JSON.stringify(folderBatchPaths) === JSON.stringify(["foo/a.png", "foo/sub/c.jpg"]),
    `Recursive folder match captured wrong files: ${folderBatchPaths.join(", ")}`
  );
  await setMockFiles(plugin, [
    createMockFile("root.png", 100000, 1),
    createMockFile("images/nested.png", 100000, 1)
  ]);
  await plugin.compressImagesInFolderPath("", false);
  assert(
    JSON.stringify(folderBatchPaths) === JSON.stringify(["root.png"]),
    `Root non-recursive folder match captured wrong files: ${folderBatchPaths.join(", ")}`
  );
  plugin.processBatchCompression = originalProcessBatchCompression;
  plugin.isImageFileAndNotCompressed = originalIsImageFileAndNotCompressed;

  const originalFsReaddir = fs.promises.readdir;
  const originalFsRealpath = fs.promises.realpath;
  const originalFsStat = fs.promises.stat;
  const originalConsoleErrorForCompressedScan = console.error;
  let compressedScanRealpathErrors = 0;
  let compressedScanCycleReaddirCalls = 0;
  try {
    const compressedScanVaultRealPath = await originalFsRealpath(plugin.app.vault.adapter.getBasePath());
    fs.promises.realpath = async (dirPath) => {
      if (String(dirPath).includes(`${path.sep}bad`) || String(dirPath).includes("/bad")) {
        throw new Error("simulated realpath failure");
      }
      if (String(dirPath).includes("cycle")) {
        return path.join(compressedScanVaultRealPath, "Cafe\u0301");
      }
      if (String(dirPath).includes("virtual-compressed")) {
        return path.join(compressedScanVaultRealPath, "Caf\u00e9");
      }
      return originalFsRealpath(dirPath);
    };
    fs.promises.readdir = async (dirPath) => {
      if (String(dirPath).includes("virtual-compressed")) {
        if (String(dirPath).includes("cycle")) {
          compressedScanCycleReaddirCalls += 1;
        }
        return [
          { name: "cycle", isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
          { name: "linked", isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false },
          { name: "bad", isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
          { name: "image.png", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }
        ];
      }
      return originalFsReaddir(dirPath, { withFileTypes: true });
    };
    fs.promises.stat = async (filePath) => {
      if (String(filePath).includes("virtual-compressed")) {
        return { size: 12345, mtimeMs: 0, isDirectory: () => false };
      }
      return originalFsStat(filePath);
    };
    console.error = (...args) => {
      if (String(args[1] || "").includes("Failed to resolve directory")) {
        compressedScanRealpathErrors += 1;
      }
    };
    const compressedScanFiles = await plugin.moveService.getCompressedFilesAsync("virtual-compressed");
    assert(compressedScanFiles.length === 1, `Compressed scan did not skip symlink/cycle entries: ${compressedScanFiles.length}`);
    assert(compressedScanFiles[0].name === "image.png", "Compressed scan missed the ordinary image file");
    assert(compressedScanCycleReaddirCalls === 0, "Compressed scan did not normalize Unicode/case-equivalent realpaths before cycle detection");
    assert(compressedScanRealpathErrors === 1, "Compressed scan did not log realpath failures");
  } finally {
    fs.promises.readdir = originalFsReaddir;
    fs.promises.realpath = originalFsRealpath;
    fs.promises.stat = originalFsStat;
    console.error = originalConsoleErrorForCompressedScan;
  }

  const moveCountTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-count-"));
  try {
    plugin.settings.outputFolder = "Compressed";
    plugin.app.vault.adapter.basePath = moveCountTemp;
    plugin.app.vault.adapter.path.absolute = moveCountTemp;
    fs.mkdirSync(path.join(moveCountTemp, "Compressed", "lost"), { recursive: true });
    fs.writeFileSync(path.join(moveCountTemp, "Compressed", "lost", "a.png"), Buffer.alloc(50));
    fs.writeFileSync(path.join(moveCountTemp, "Compressed", "lost", "b.jpg"), Buffer.alloc(50));
    await setMockFiles(plugin, [
      createMockFile("Images/a.png", 100, 1),
      createMockFile("Images/b.jpg", 100, 1)
    ]);
    plugin.app._resetGetFilesCalls();
    const movableCount = await plugin.moveService.getCompressedFilesCount();
    assert(movableCount === 2, `Move count did not find basename fallback originals: ${movableCount}`);
    assert(plugin.app._getFilesCalls === 1, `Move count rebuilt original lookup too many times: ${plugin.app._getFilesCalls}`);
  } finally {
    fs.rmSync(moveCountTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const originalStatusBarControllerUpdate = plugin.statusBarController.update;
  const originalSetTimeoutForStatusDebounce = global.setTimeout;
  const originalClearTimeoutForStatusDebounce = global.clearTimeout;
  const originalStatusUpdateTimer = plugin.statusUpdateTimer;
  const originalStatusUpdateFirstQueuedAt = plugin.statusUpdateFirstQueuedAt;
  const scheduledTimers = [];
  let clearTimerCalls = 0;
  let statusRefreshCalls = 0;
  try {
    global.setTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      scheduledTimers.push(timer);
      return timer;
    };
    global.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
      clearTimerCalls += 1;
    };
    plugin.statusBarController.update = async () => {
      statusRefreshCalls += 1;
    };
    plugin.statusUpdateTimer = null;
    plugin.statusUpdateFirstQueuedAt = 0;
    plugin.scheduleStatusBarUpdate("debounce-a");
    plugin.scheduleStatusBarUpdate("debounce-b");
    plugin.scheduleStatusBarUpdate("debounce-c");
    assert(scheduledTimers.length === 1, `Status update debounce thrashed timers under rapid calls: ${scheduledTimers.length}`);
    assert(clearTimerCalls === 0, `Status update debounce cleared timers under rapid calls: ${clearTimerCalls}`);
    assert(scheduledTimers.filter((timer) => !timer.cleared).length === 1, "Debounce left more than one active status timer");
    await scheduledTimers[0].callback();
    assert(statusRefreshCalls === 1, `Debounced status refresh ran ${statusRefreshCalls} times instead of once`);
    plugin.statusUpdateFirstQueuedAt = Date.now() - plugin.statusUpdateMaxWaitMs - 1;
    plugin.scheduleStatusBarUpdate("debounce-max-wait");
    assert(scheduledTimers[scheduledTimers.length - 1].delay === 0, "Status bar max-wait did not force an immediate refresh under event storm");
  } finally {
    global.setTimeout = originalSetTimeoutForStatusDebounce;
    global.clearTimeout = originalClearTimeoutForStatusDebounce;
    plugin.statusBarController.update = originalStatusBarControllerUpdate;
    plugin.statusUpdateTimer = originalStatusUpdateTimer;
    plugin.statusUpdateFirstQueuedAt = originalStatusUpdateFirstQueuedAt;
  }

  const originalHandleNewFile = plugin.handleNewFile;
  plugin.handleNewFile = async () => {};
  plugin.app._resetGetFilesCalls();
  await plugin.app._vaultHandlers.create(createMockFile("Images/incremental.png", 100000, 20));
  counts = await plugin.getImageCompressionCounts();
  assert(plugin.app._getFilesCalls === 0, "Image create event triggered a full vault scan");
  assert(counts.totalImages === 3, `Image create event did not update index incrementally, total=${counts.totalImages}`);
  await plugin.app._vaultHandlers.create(createMockFile("Notes/not-image.md", 1000, 20));
  counts = await plugin.getImageCompressionCounts();
  assert(counts.totalImages === 3, "Non-image create event changed the image index");
  await plugin.app._vaultHandlers.rename(createMockFile("Images/renamed.png", 100000, 20), "Images/incremental.png");
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(visibleImagePaths.includes("Images/renamed.png"), "Image rename event did not update index path");
  assert(!visibleImagePaths.includes("Images/incremental.png"), "Image rename event left the old path in index");
  await plugin.app._vaultHandlers.delete({ path: "Images/renamed.png" });
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(!visibleImagePaths.includes("Images/renamed.png"), "Image delete event did not remove index path");
  plugin.handleNewFile = originalHandleNewFile;

  let readBinaryCalls = 0;
  const originalReadBinary = plugin.app.vault.readBinary;
  plugin.app.vault.readBinary = async () => {
    readBinaryCalls += 1;
    throw new Error("status path should not hash binary files");
  };
  await plugin.statusBarController.update();
  assert(readBinaryCalls === 0, "Status bar update read binary file contents");
  plugin.app.vault.readBinary = originalReadBinary;

  plugin.cache.cacheData.entries = {};
  const manyFiles = Array.from({ length: 401 }, (_, index) => createMockFile(`Batch/file-${index}.png`, 20000 + index, index + 1));
  plugin.app._files = manyFiles;
  let yieldCalls = 0;
  const originalYieldToUi = plugin.yieldToUi;
  plugin.yieldToUi = async () => {
    yieldCalls += 1;
  };
  await plugin.rebuildImageIndex("smoke-batch-yield");
  assert(yieldCalls >= 2, `Batch image index scan did not yield across chunks, yields=${yieldCalls}`);
  counts = await plugin.getImageCompressionCounts();
  assert(counts.totalImages === manyFiles.length, `Batch image index scan missed files: ${counts.totalImages}/${manyFiles.length}`);
  plugin.yieldToUi = originalYieldToUi;

  const originalFilesForReadyRace = plugin.app._files;
  const originalYieldForReadyRace = plugin.yieldToUi;
  try {
    const readyRaceFiles = Array.from({ length: 301 }, (_, index) => createMockFile(`Race/file-${index}.png`, 20000 + index, index + 1));
    plugin.app._files = readyRaceFiles;
    let releaseRebuildYield = null;
    let rebuildYieldReached = null;
    let readyRaceYieldCount = 0;
    const rebuildYieldReachedPromise = new Promise((resolve) => {
      rebuildYieldReached = resolve;
    });
    plugin.yieldToUi = async () => {
      readyRaceYieldCount += 1;
      if (readyRaceYieldCount > 1) {
        return;
      }
      rebuildYieldReached();
      await new Promise((resolve) => {
        releaseRebuildYield = resolve;
      });
    };
    const rebuildPromise = plugin.rebuildImageIndex("ready-race");
    await rebuildYieldReachedPromise;
    assert(plugin.imageIndex.isReady() === false, "ImageIndex rebuild did not mark index as not ready");
    await plugin.imageIndex.upsert(createMockFile("Race/new-during-rebuild.png", 25000, 999), plugin.cache);
    assert(plugin.imageIndex.isReady() === false, "ImageIndex upsert during rebuild flipped ready=true");
    releaseRebuildYield();
    await rebuildPromise;
    assert(plugin.imageIndex.isReady() === true, "ImageIndex rebuild did not restore ready=true after completion");
    const readyRacePaths = plugin.imageIndex.getAllFiles().map((file) => file.path).sort();
    assert(readyRacePaths.includes("Race/new-during-rebuild.png"), "ImageIndex rebuild lost an upsert that happened during rebuild");
    plugin.imageIndex.ready = false;
    await plugin.imageIndex.upsert(createMockFile("Race/fresh-delta-before-rebuild.png", 25000, 1000), plugin.cache);
    assert(plugin.imageIndex.isReady() === false, "ImageIndex upsert marked a fresh index ready without a rebuild");

    const recordsBeforeCancelledRebuild = plugin.imageIndex.getAllFiles().map((file) => file.path).sort();
    let cancelledRebuildYieldReached = null;
    let releaseCancelledRebuild = null;
    const cancelledRebuildYieldPromise = new Promise((resolve) => {
      cancelledRebuildYieldReached = resolve;
    });
    plugin.yieldToUi = async () => {
      cancelledRebuildYieldReached();
      await new Promise((resolve) => {
        releaseCancelledRebuild = resolve;
      });
    };
    const cancelledRebuild = plugin.imageIndex.rebuild(plugin.cache);
    await cancelledRebuildYieldPromise;
    plugin.imageIndex.cancelPendingWork();
    releaseCancelledRebuild();
    await cancelledRebuild;
    assert(plugin.imageIndex.isReady() === false, "Cancelled ImageIndex rebuild published ready state after unload fence");
    assert.deepEqual(
      plugin.imageIndex.getAllFiles().map((file) => file.path).sort(),
      recordsBeforeCancelledRebuild,
      "Cancelled ImageIndex rebuild published a new records snapshot"
    );
  } finally {
    plugin.yieldToUi = originalYieldForReadyRace;
    plugin.app._files = originalFilesForReadyRace;
    await withRealGlobalTimers(() => plugin.rebuildImageIndex("ready-race-restore"));
  }

  const originalYieldForSavingsUnload = plugin.yieldToUi;
  const originalGetFreshForSavingsUnload = plugin.cache.getFreshEntryForFileFromEntries;
  try {
    const savingsUnloadFiles = Array.from({ length: 60 }, (_, index) => createMockFile(`Savings/unload-${index}.png`, 20000 + index, index + 1));
    let savingsCacheLookups = 0;
    plugin.isUnloading = false;
    plugin.cache.getFreshEntryForFileFromEntries = async () => {
      savingsCacheLookups += 1;
      return null;
    };
    plugin.yieldToUi = async () => {
      plugin.isUnloading = true;
    };
    const interruptedSavings = await plugin.savingsCalculator.collectImageStats(savingsUnloadFiles);
    assert(savingsCacheLookups === 50, `Savings calculator continued scanning after unload: ${savingsCacheLookups}`);
    assert(interruptedSavings.totalImages === 60 && interruptedSavings.savings.totalFiles === 60, "Savings calculator did not return a stable interrupted result after unload");
  } finally {
    plugin.yieldToUi = originalYieldForSavingsUnload;
    plugin.cache.getFreshEntryForFileFromEntries = originalGetFreshForSavingsUnload;
    plugin.isUnloading = false;
  }

  let runningTasks = 0;
  let maxRunningTasks = 0;
  await Promise.all(Array.from({ length: 5 }, () => plugin.runLimitedCompression(async () => {
    runningTasks += 1;
    maxRunningTasks = Math.max(maxRunningTasks, runningTasks);
    await new Promise((resolve) => setImmediate(resolve));
    runningTasks -= 1;
  })));
  assert(maxRunningTasks === plugin.compressor.activeWorkerCount, `Compression concurrency did not match internal worker count: ${maxRunningTasks}/${plugin.compressor.activeWorkerCount}`);

  const originalPlugins = plugin.app.plugins;
  try {
    const guardedPluginId = "obsidian-paste-image-rename";
    let disableCalls = 0;
    let enableCalls = 0;
    plugin.app.plugins = {
      enabledPlugins: new Set([guardedPluginId]),
      disablePlugin: async (id) => {
        disableCalls += 1;
        plugin.app.plugins.enabledPlugins.delete(id);
      },
      enablePlugin: async (id) => {
        enableCalls += 1;
        plugin.app.plugins.enabledPlugins.add(id);
      }
    };

    const originalNoticeForPluginGuard = ObsidianMock.Notice;
    try {
      const guardNotices = [];
      ObsidianMock.Notice = class {
        constructor(message, duration) {
          guardNotices.push({ message, duration });
        }
      };
      await plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {});
      assert(disableCalls === 1, `Plugin guard notice test disabled plugin ${disableCalls} times`);
      assert(enableCalls === 1, `Plugin guard notice test restored plugin ${enableCalls} times`);
      assert(
        guardNotices.some((notice) => String(notice.message).includes(englishLocale["guard.disabled"].replace("{id}", guardedPluginId)) && notice.duration === 5000),
        `Plugin guard did not notify about disable: ${guardNotices.map((notice) => notice.message).join(" | ")}`
      );
      assert(
        guardNotices.some((notice) => String(notice.message).includes(englishLocale["guard.restored"].replace("{id}", guardedPluginId)) && notice.duration === 5000),
        `Plugin guard did not notify about restore: ${guardNotices.map((notice) => notice.message).join(" | ")}`
      );
    } finally {
      ObsidianMock.Notice = originalNoticeForPluginGuard;
    }
    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);

    let releaseFirstGuard;
    let resolveFirstEntered;
    const firstEntered = new Promise((resolve) => {
      resolveFirstEntered = resolve;
    });
    const firstGuard = plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {
      resolveFirstEntered();
      await new Promise((resolve) => {
        releaseFirstGuard = resolve;
      });
    });
    await firstEntered;
    assert(disableCalls === 1, `Overlapping guard disabled plugin ${disableCalls} times before second entry`);
    let secondRan = false;
    await plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {
      secondRan = true;
    });
    assert(secondRan, "Second overlapping guard task did not run");
    assert(disableCalls === 1, `Overlapping guard disabled plugin more than once: ${disableCalls}`);
    assert(enableCalls === 0, "Overlapping guard re-enabled plugin before the first guard exited");
    releaseFirstGuard();
    await firstGuard;
    assert(enableCalls === 1, `Overlapping guard did not re-enable exactly once: ${enableCalls}`);

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set();
    await plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {});
    assert(disableCalls === 0, "Pre-disabled plugin was disabled again");
    assert(enableCalls === 0, "Pre-disabled plugin was enabled after guard exit");

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    await plugin.pluginGuardService.acquire(guardedPluginId);
    const userToggledGuard = plugin.pluginGuardService.guards.get(guardedPluginId);
    assert(userToggledGuard, "Plugin guard user-toggle setup did not create a guard");
    userToggledGuard.observedEnabledAfterGuardDisable = true;
    plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
    await plugin.pluginGuardService.release(guardedPluginId);
    assert(enableCalls === 0, "Plugin guard re-enabled a plugin after user/external toggle left it disabled");
    assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Plugin guard ignored user/external disabled state on release");

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    plugin.settings.disablePasteImageRenameDuringCompression = false;
    try {
      await withTestTimeout("mandatory paste rename guard", plugin.withCompressionGuards(async () => {}), 1000);
      assert(disableCalls === 1, "Legacy Paste Image Rename opt-out prevented the mandatory guard from disabling the plugin");
      assert(enableCalls === 1, "Mandatory Paste Image Rename guard did not restore the plugin");
    } finally {
      delete plugin.settings.disablePasteImageRenameDuringCompression;
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    const originalGuardTimeoutMs = plugin.pluginGuardService.operationTimeoutMs;
    const guardDisableTimeoutWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 10;
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        await neverSettlingPromise();
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
      };
      let guardedTaskRan = false;
      await withRealGlobalTimers(() => withTestTimeout("plugin guard disable timeout", plugin.withCompressionGuards(async () => {
        guardedTaskRan = true;
      }), 1000));
      assert(guardedTaskRan, "Plugin guard timeout prevented the guarded compression task from running");
      assert(disableCalls === 1, `Plugin guard timeout did not attempt to disable the plugin exactly once: ${disableCalls}`);
      assert(enableCalls === 0, `Plugin guard timeout restored before disable completion: ${enableCalls}`);
      assert(guardDisableTimeoutWarnings.messages.some((message) => message.includes("Timed out while trying to disable plugin")), "Plugin guard disable timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      guardDisableTimeoutWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    const originalSetWindowTimeoutForEnableRetry = plugin.setWindowTimeout;
    const originalClearWindowTimeoutForEnableRetry = plugin.clearWindowTimeout;
    const guardEnableRetryWarnings = captureConsoleWarn();
    const enableRetryTimers = [];
    try {
      plugin.pluginGuardService.operationTimeoutMs = 1;
      plugin.setWindowTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        enableRetryTimers.push(timer);
        return timer;
      };
      plugin.clearWindowTimeout = (timer) => {
        if (timer) {
          timer.cleared = true;
        }
      };
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        if (enableCalls === 1) {
          await neverSettlingPromise();
          return;
        }
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
      };
      const enableRetryGuard = plugin.withCompressionGuards(async () => {});
      for (let attempt = 0; attempt < 20; attempt++) {
        if (enableCalls === 1 && enableRetryTimers.some((timer) => !timer.cleared && timer.delay === 1)) {
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      const enableTimeoutTimer = enableRetryTimers.findLast((timer) => !timer.cleared && timer.delay === 1);
      assert(enableTimeoutTimer, "Plugin guard enable retry test did not schedule the enable timeout timer");
      enableTimeoutTimer.callback();
      await withTestTimeout("plugin guard enable retry", enableRetryGuard, 1000);
      const retryTimer = enableRetryTimers.find((timer) => !timer.cleared && timer.delay >= 10000);
      assert(retryTimer, "Plugin guard enable timeout did not schedule a retry timer");
      retryTimer.callback();
      await withTestTimeout("plugin guard enable retry callback", (async () => {
        while (enableCalls < 2) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      })(), 1000);
      assert(enableCalls >= 2, `Plugin guard enable timeout did not schedule a retry: ${enableCalls}`);
      assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Plugin guard enable retry left the guarded plugin disabled");
      assert(guardEnableRetryWarnings.messages.some((message) => message.includes("Timed out while trying to enable plugin")), "Plugin guard enable timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      plugin.setWindowTimeout = originalSetWindowTimeoutForEnableRetry;
      plugin.clearWindowTimeout = originalClearWindowTimeoutForEnableRetry;
      guardEnableRetryWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    const parallelGuardIds = ["parallel-guard-one", "parallel-guard-two", "parallel-guard-three"];
    plugin.app.plugins.enabledPlugins = new Set(parallelGuardIds);
    const parallelReleaseTimers = [];
    const parallelReleaseWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 37;
      plugin.setWindowTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        parallelReleaseTimers.push(timer);
        return timer;
      };
      plugin.clearWindowTimeout = (timer) => {
        if (timer) {
          timer.cleared = true;
        }
      };
      plugin.app.plugins.disablePlugin = async (id) => {
        disableCalls += 1;
        plugin.app.plugins.enabledPlugins.delete(id);
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        await neverSettlingPromise();
      };
      const parallelRelease = plugin.pluginGuardService.withDisabled(parallelGuardIds, async () => {});
      for (let attempt = 0; attempt < 20; attempt++) {
        const activeReleaseTimers = parallelReleaseTimers.filter((timer) => !timer.cleared && timer.delay === 37);
        if (activeReleaseTimers.length >= parallelGuardIds.length) {
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      const activeReleaseTimers = parallelReleaseTimers.filter((timer) => !timer.cleared && timer.delay === 37);
      assert(activeReleaseTimers.length === parallelGuardIds.length, `withDisabled() did not start guard releases in parallel: ${activeReleaseTimers.length}/${parallelGuardIds.length}`);
      activeReleaseTimers.forEach((timer) => timer.callback());
      await withTestTimeout("parallel guard release timeout", parallelRelease, 1000);
      assert(enableCalls === parallelGuardIds.length, `Parallel guard release did not attempt every restore: ${enableCalls}/${parallelGuardIds.length}`);
      assert(plugin.pluginGuardService.guards.size === 0, "Parallel guard release left guard state behind");
      assert(parallelReleaseWarnings.messages.filter((message) => message.includes("Timed out while trying to enable plugin")).length === parallelGuardIds.length, "Parallel guard release did not warn for every timed-out restore");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      plugin.setWindowTimeout = originalSetWindowTimeoutForEnableRetry;
      plugin.clearWindowTimeout = originalClearWindowTimeoutForEnableRetry;
      parallelReleaseWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    let resolveLateDisable;
    const lateDisableFinished = new Promise((resolve) => {
      resolveLateDisable = resolve;
    });
    let resolveLateDisableRestore;
    const lateDisableRestoreFinished = new Promise((resolve) => {
      resolveLateDisableRestore = resolve;
    });
    const replacementGuardWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 10;
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        await lateDisableFinished;
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
        resolveLateDisableRestore();
      };
      await withRealGlobalTimers(() => withTestTimeout("replacement guard timeout", plugin.withCompressionGuards(async () => {}), 1000));
      assert(enableCalls === 0, `Timed-out guard release restored before late disable completion: ${enableCalls}`);
      resolveLateDisable();
      await withTestTimeout("late disable restore completion", lateDisableRestoreFinished, 1000);
      assert(enableCalls === 1, `Late disable completion was not followed by restore: ${enableCalls}`);
      assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Late disable completion left the guarded plugin disabled");
      assert(replacementGuardWarnings.messages.some((message) => message.includes("Timed out while trying to disable plugin")), "Replacement guard timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      replacementGuardWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    let resolveFirstLateDisable;
    const firstLateDisableFinished = new Promise((resolve) => {
      resolveFirstLateDisable = resolve;
    });
    let resolveFirstLateDisableReturned;
    const firstLateDisableReturned = new Promise((resolve) => {
      resolveFirstLateDisableReturned = resolve;
    });
    const firstLateDisableWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 10;
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        const isFirstDisableCall = disableCalls === 1;
        if (isFirstDisableCall) {
          await firstLateDisableFinished;
        }
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
        if (isFirstDisableCall) {
          resolveFirstLateDisableReturned();
        }
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
      };
      await withRealGlobalTimers(() => withTestTimeout("first late disable guard timeout", plugin.withCompressionGuards(async () => {}), 1000));
      assert(enableCalls === 0, `First timed-out guard restored before late disable completion: ${enableCalls}`);
      let releaseSecondGuard;
      let resolveSecondEntered;
      const secondEntered = new Promise((resolve) => {
        resolveSecondEntered = resolve;
      });
      const secondGuard = plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {
        resolveSecondEntered();
        await new Promise((resolve) => {
          releaseSecondGuard = resolve;
        });
      });
      await secondEntered;
      assert(disableCalls === 2, `Second guard did not disable the plugin before late restore test: ${disableCalls}`);
      assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Second guard did not leave the plugin disabled during guarded work");
      resolveFirstLateDisable();
      await withTestTimeout("first late disable completion", firstLateDisableReturned, 1000);
      await Promise.resolve();
      assert(enableCalls === 0, `Late disable restore re-enabled plugin during an active replacement guard: ${enableCalls}`);
      assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Late disable restore enabled plugin during an active replacement guard");
      releaseSecondGuard();
      await secondGuard;
      assert(enableCalls === 1, `Second guard did not restore plugin after release: ${enableCalls}`);
      assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Second guard release left plugin disabled");
      assert(firstLateDisableWarnings.messages.some((message) => message.includes("Timed out while trying to disable plugin")), "First late disable timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      firstLateDisableWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    plugin.app.plugins.disablePlugin = async (id) => {
      disableCalls += 1;
      plugin.app.plugins.enabledPlugins.delete(id);
    };
    plugin.app.plugins.enablePlugin = async (id) => {
      enableCalls += 1;
      plugin.app.plugins.enabledPlugins.add(id);
    };
    await plugin.pluginGuardService.acquire(guardedPluginId);
    assert(disableCalls === 1 && !plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Plugin guard unload setup did not disable the guarded plugin");
    await plugin.pluginGuardService.releaseAllGuards();
    assert(enableCalls === 1, `releaseAllGuards did not restore the guarded plugin exactly once: ${enableCalls}`);
    assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "releaseAllGuards left the guarded plugin disabled");
    assert(plugin.pluginGuardService.guards.size === 0, "releaseAllGuards did not clear guard state");

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    await plugin.pluginGuardService.acquire(guardedPluginId);
    const userToggledUnloadGuard = plugin.pluginGuardService.guards.get(guardedPluginId);
    assert(userToggledUnloadGuard, "Plugin guard unload user-toggle setup did not create a guard");
    userToggledUnloadGuard.observedEnabledAfterGuardDisable = true;
    plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
    await plugin.pluginGuardService.releaseAllGuards();
    assert(enableCalls === 0, "releaseAllGuards re-enabled a plugin after user/external toggle left it disabled");
    assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "releaseAllGuards ignored user/external disabled state");
    assert(plugin.pluginGuardService.guards.size === 0, "releaseAllGuards did not clear user-toggle guard state");

    const PluginGuardServiceClass = plugin.pluginGuardService.constructor;
    disableCalls = 0;
    enableCalls = 0;
    let releaseCrossInstanceDisableA = null;
    let crossInstanceDisableAStarted = null;
    const crossInstanceDisableAStartedPromise = new Promise((resolve) => {
      crossInstanceDisableAStarted = resolve;
    });
    const crossInstanceGuardA = new PluginGuardServiceClass(plugin);
    const ReloadedGuardPluginClass = loadFreshPluginClass();
    const reloadedGuardPlugin = new ReloadedGuardPluginClass();
    reloadedGuardPlugin.app = plugin.app;
    reloadedGuardPlugin.manifest = { ...plugin.manifest };
    const crossInstanceGuardB = reloadedGuardPlugin.pluginGuardService;
    crossInstanceGuardA.operationTimeoutMs = 10;
    crossInstanceGuardB.operationTimeoutMs = 1000;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    plugin.app.plugins.disablePlugin = async (id) => {
      disableCalls += 1;
      if (disableCalls === 1) {
        crossInstanceDisableAStarted();
        await new Promise((resolve) => {
          releaseCrossInstanceDisableA = resolve;
        });
      }
      plugin.app.plugins.enabledPlugins.delete(id);
    };
    plugin.app.plugins.enablePlugin = async (id) => {
      enableCalls += 1;
      plugin.app.plugins.enabledPlugins.add(id);
    };
    const crossInstanceAcquireA = withRealGlobalTimers(() => crossInstanceGuardA.acquire(guardedPluginId));
    await crossInstanceDisableAStartedPromise;
    await crossInstanceAcquireA;
    await crossInstanceGuardA.releaseAllGuards(true);
    const crossInstanceAcquireB = crossInstanceGuardB.acquire(guardedPluginId);
    await Promise.resolve();
    releaseCrossInstanceDisableA();
    await withTestTimeout("cross-module replacement guard acquire", crossInstanceAcquireB, 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert(enableCalls === 0, `Old guard module restored a plugin while the re-evaluated reload module owned it: ${enableCalls}`);
    assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Old guard module enabled the guarded plugin during re-evaluated reload work");
    await crossInstanceGuardB.release(guardedPluginId);
    assert(enableCalls === 1, `Reload guard did not restore the plugin exactly once after release: ${enableCalls}`);
    assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Reload guard left the guarded plugin disabled after release");

    disableCalls = 0;
    enableCalls = 0;
    let lateEnableStarted = null;
    let releaseLateEnable = null;
    const lateEnableStartedPromise = new Promise((resolve) => {
      lateEnableStarted = resolve;
    });
    const lateEnableGuardA = new PluginGuardServiceClass(plugin);
    const LateEnableReloadedPluginClass = loadFreshPluginClass();
    const lateEnableReloadedPlugin = new LateEnableReloadedPluginClass();
    lateEnableReloadedPlugin.app = plugin.app;
    lateEnableReloadedPlugin.manifest = { ...plugin.manifest };
    const lateEnableGuardB = lateEnableReloadedPlugin.pluginGuardService;
    lateEnableGuardA.operationTimeoutMs = 10;
    lateEnableGuardB.operationTimeoutMs = 1000;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    plugin.app.plugins.disablePlugin = async (id) => {
      disableCalls += 1;
      plugin.app.plugins.enabledPlugins.delete(id);
    };
    plugin.app.plugins.enablePlugin = async (id) => {
      enableCalls += 1;
      if (enableCalls === 1) {
        lateEnableStarted();
        await new Promise((resolve) => {
          releaseLateEnable = resolve;
        });
      }
      plugin.app.plugins.enabledPlugins.add(id);
    };
    try {
      await lateEnableGuardA.acquire(guardedPluginId);
      const timedOutReleaseA = withRealGlobalTimers(() => lateEnableGuardA.release(guardedPluginId));
      await lateEnableStartedPromise;
      await withTestTimeout("late enable source release timeout", timedOutReleaseA, 1000);
      await lateEnableGuardB.acquire(guardedPluginId);
      assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Reload guard did not begin with the plugin disabled after an old enable timeout");
      releaseLateEnable();
      await withTestTimeout("late enable compensation", (async () => {
        while (disableCalls < 2 || plugin.app.plugins.enabledPlugins.has(guardedPluginId)) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      })(), 1000);
      assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Late old-module enable escaped compensation during reload guard work");
      await lateEnableGuardB.release(guardedPluginId);
      assert(enableCalls === 2 && plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Reload guard did not restore exactly once after compensating a late enable");
    } finally {
      releaseLateEnable?.();
      await lateEnableGuardA.releaseAllGuards(true);
      await lateEnableGuardB.releaseAllGuards(true);
    }

    disableCalls = 0;
    enableCalls = 0;
    const afterEffectGuard = new PluginGuardServiceClass(plugin);
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    plugin.app.plugins.disablePlugin = async (id) => {
      disableCalls += 1;
      plugin.app.plugins.enabledPlugins.delete(id);
      throw new Error("Injected disable after-effect rejection");
    };
    plugin.app.plugins.enablePlugin = async (id) => {
      enableCalls += 1;
      plugin.app.plugins.enabledPlugins.add(id);
      throw new Error("Injected enable after-effect rejection");
    };
    let afterEffectTaskObservedDisabled = false;
    await afterEffectGuard.withDisabled([guardedPluginId], async () => {
      afterEffectTaskObservedDisabled = !plugin.app.plugins.enabledPlugins.has(guardedPluginId);
    });
    assert(afterEffectTaskObservedDisabled, "Plugin guard ignored a disable effect because the registry Promise rejected after changing state");
    assert(disableCalls === 1 && enableCalls === 1, "Plugin guard retried or skipped an after-effect registry operation unexpectedly");
    assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Plugin guard left the plugin disabled after an enable after-effect rejection");

    const originalSetWindowTimeoutForGuardFence = plugin.setWindowTimeout;
    const originalClearWindowTimeoutForGuardFence = plugin.clearWindowTimeout;
    const fencedGuardTimers = [];
    try {
      plugin.setWindowTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        fencedGuardTimers.push(timer);
        return timer;
      };
      plugin.clearWindowTimeout = (timer) => {
        if (timer) {
          timer.cleared = true;
        }
      };

      const timeoutWindowGuard = new PluginGuardServiceClass(plugin);
      timeoutWindowGuard.operationTimeoutMs = 5;
      let resolveTimeoutWindowDisable = null;
      let timeoutWindowEnableCalls = 0;
      plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
      plugin.app.plugins.disablePlugin = async () => {
        await new Promise((resolve) => {
          resolveTimeoutWindowDisable = resolve;
        });
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
      };
      plugin.app.plugins.enablePlugin = async () => {
        timeoutWindowEnableCalls += 1;
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
      };
      const timeoutWindowAcquire = timeoutWindowGuard.acquire(guardedPluginId);
      for (let attempt = 0; attempt < 20 && (!resolveTimeoutWindowDisable || !fencedGuardTimers.some((timer) => !timer.cleared && timer.delay === 5)); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const disableTimeoutWindowTimer = fencedGuardTimers.find((timer) => !timer.cleared && timer.delay === 5);
      assert(disableTimeoutWindowTimer && resolveTimeoutWindowDisable, "Late-disable timeout-window test did not reach the operation boundary");
      disableTimeoutWindowTimer.callback();
      resolveTimeoutWindowDisable();
      await withTestTimeout("late disable timeout-window acquire", timeoutWindowAcquire, 1000);
      await new Promise((resolve) => setImmediate(resolve));
      await timeoutWindowGuard.release(guardedPluginId);
      assert(timeoutWindowEnableCalls === 1, "Disable completing immediately after timeout was not restored exactly once");

      fencedGuardTimers.length = 0;
      let postShutdownEnableCalls = 0;
      const shutdownGuard = new PluginGuardServiceClass(plugin);
      plugin.app.plugins.enabledPlugins = new Set();
      plugin.app.plugins.enablePlugin = async () => {
        postShutdownEnableCalls += 1;
      };
      shutdownGuard.scheduleEnableRetry(guardedPluginId);
      const retryAfterShutdown = fencedGuardTimers.find((timer) => !timer.cleared);
      assert(retryAfterShutdown, "PluginGuard shutdown test did not schedule a retry");
      await shutdownGuard.releaseAllGuards(true);
      await Promise.resolve(retryAfterShutdown.callback());
      assert(postShutdownEnableCalls === 0, "PluginGuard retry invoked Plugin API after shutdown");
      assert(shutdownGuard.enableRetryTimers.size === 0 && shutdownGuard.operationTimeouts.size === 0, "PluginGuard shutdown retained lifecycle timers");

      fencedGuardTimers.length = 0;
      const pendingShutdownGuard = new PluginGuardServiceClass(plugin);
      let finishPendingShutdownDisable = null;
      let pendingShutdownDisableFinished = null;
      let postShutdownCompensationCalls = 0;
      plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
      plugin.app.plugins.disablePlugin = async () => {
        await new Promise((resolve) => {
          finishPendingShutdownDisable = resolve;
        });
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
        pendingShutdownDisableFinished?.();
      };
      plugin.app.plugins.enablePlugin = async () => {
        postShutdownCompensationCalls += 1;
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
      };
      const pendingShutdownDisableCompleted = new Promise((resolve) => {
        pendingShutdownDisableFinished = resolve;
      });
      const pendingShutdownAcquire = pendingShutdownGuard.acquire(guardedPluginId);
      for (let attempt = 0; attempt < 20 && !finishPendingShutdownDisable; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert(finishPendingShutdownDisable, "PluginGuard shutdown test did not reach its pending disable operation");
      await pendingShutdownGuard.releaseAllGuards(true);
      postShutdownCompensationCalls = 0;
      finishPendingShutdownDisable();
      await pendingShutdownDisableCompleted;
      await pendingShutdownAcquire;
      await new Promise((resolve) => setImmediate(resolve));
      assert(postShutdownCompensationCalls === 1, "Late disable after shutdown was not compensated exactly once");
      assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Late disable after shutdown left the third-party plugin disabled");
    } finally {
      plugin.setWindowTimeout = originalSetWindowTimeoutForGuardFence;
      plugin.clearWindowTimeout = originalClearWindowTimeoutForGuardFence;
    }
  } finally {
    plugin.app.plugins = originalPlugins;
  }

  const originalSetWindowTimeout = plugin.setWindowTimeout;
  const originalClearWindowTimeout = plugin.clearWindowTimeout;
  const originalIsUserInactive = plugin.backgroundCompressionService.isUserInactive;
  const originalCheckAndStartBackgroundCompression = plugin.backgroundCompressionService.checkAndStartBackgroundCompression;
  const originalAutoBackgroundCompression = plugin.settings.autoBackgroundCompression;
  try {
    const inactivityTimers = [];
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      inactivityTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    };
    plugin.backgroundCompressionService.inactivityTimer = null;
    plugin.backgroundCompressionService.inactivityCheckActive = false;
    plugin.isUnloading = false;
    plugin.settings.autoBackgroundCompression = true;
    plugin.backgroundCompressionService.isUserInactive = () => true;
    let backgroundChecks = 0;
    plugin.backgroundCompressionService.checkAndStartBackgroundCompression = async () => {
      backgroundChecks += 1;
      plugin.isUnloading = true;
      plugin.backgroundCompressionService.cleanup();
    };
    plugin.backgroundCompressionService.startInactivityCheck();
    assert(inactivityTimers.length === 1, "Inactivity check did not schedule its initial timer");
    await inactivityTimers[0].callback();
    assert(backgroundChecks === 1, "Inactivity check did not run background compression callback");
    assert(inactivityTimers.length === 1, "Inactivity check rescheduled itself after unload");
    assert(plugin.backgroundCompressionService.inactivityCheckActive === false, "Inactivity check stayed active after unload");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeout;
    plugin.clearWindowTimeout = originalClearWindowTimeout;
    plugin.backgroundCompressionService.isUserInactive = originalIsUserInactive;
    plugin.backgroundCompressionService.checkAndStartBackgroundCompression = originalCheckAndStartBackgroundCompression;
    plugin.settings.autoBackgroundCompression = originalAutoBackgroundCompression;
    plugin.isUnloading = false;
    plugin.backgroundCompressionService.inactivityCheckActive = false;
    plugin.backgroundCompressionService.inactivityTimer = null;
  }

  const migrationTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-migration-"));
  const originalCacheFile = plugin.cache.cacheFile;
  const originalCacheBackupsDir = plugin.cache.cacheBackupsDir;
  const originalCacheData = plugin.cache.cacheData;
  const originalFilesForMigration = plugin.app._files;
  const originalCacheAdapterBasePath = plugin.app.vault.adapter.basePath;
  const originalCacheAdapterAbsolutePath = plugin.app.vault.adapter.path.absolute;
  const setCacheTestFile = (cacheFile, cacheBackupsDir = path.join(path.dirname(cacheFile), "cache-backups")) => {
    plugin.app.vault.adapter.basePath = path.dirname(cacheFile);
    plugin.app.vault.adapter.path.absolute = path.dirname(cacheFile);
    plugin.cache.cacheFile = plugin.getPlatformPorts().fs.toVaultRelativePath(cacheFile);
    plugin.cache.cacheBackupsDir = plugin.getPlatformPorts().fs.toVaultRelativePath(cacheBackupsDir);
  };
  const resolveCacheTestPath = (filePath) => plugin.getPlatformPorts().fs.resolvePath(String(filePath));
  const restoreCacheTestPaths = () => {
    plugin.app.vault.adapter.basePath = originalCacheAdapterBasePath;
    plugin.app.vault.adapter.path.absolute = originalCacheAdapterAbsolutePath;
    plugin.cache.cacheFile = originalCacheFile;
    plugin.cache.cacheBackupsDir = originalCacheBackupsDir;
  };
  try {
    const migrationCacheFile = path.join(migrationTemp, "tinyLocal-cache.json");
    fs.writeFileSync(migrationCacheFile, JSON.stringify({
      version: "0.9.0",
      entries: {
        [`Folder:WithColon/image.png:${MOCK_MD5}:123`]: {
          md5: MOCK_MD5,
          mtime: 123,
          timestamp: 1,
          originalSize: 1000
        },
        [`Images/safe-legacy-moved.png:${MOCK_MD5_ALT}:100`]: {
          md5: MOCK_MD5_ALT,
          mtime: 100,
          timestamp: 300,
          originalSize: 1000
        },
        [`Images/estimated-legacy-moved.png:${MOCK_MD5}:100`]: {
          md5: MOCK_MD5,
          mtime: 100,
          timestamp: 300
        },
        "Skipped/raw.png": {
          skipped: true,
          reason: "pngquant_quality_failed",
          timestamp: 1,
          sourceMtime: 5,
          sourceSize: 100
        },
        "Skipped/path-only.png": {
          skipped: true,
          reason: "too_small",
          timestamp: 1,
          originalSize: 100
        }
      }
    }, null, 2));
    plugin.app._files = [
      createMockFile("Images/safe-legacy-moved.png", 600, 200),
      createMockFile("Images/estimated-legacy-moved.png", 700, 250)
    ];
    setCacheTestFile(migrationCacheFile);
    plugin.cache.loadCacheSync();
    assert(plugin.cache.cacheData.version === plugin.cache.CACHE_VERSION, "Cache version mismatch was not migrated");
    assert(plugin.cache.getEntriesForPath("Folder:WithColon/image.png").length === 1, "Legacy cache key with ':' in path was not parsed from the right");
    const migratedSafeMovedEntry = plugin.cache.getEntriesForPath("Images/safe-legacy-moved.png")[0]?.[1];
    assert(migratedSafeMovedEntry?.state === "moved", "Safe legacy processed cache entry was not promoted to moved state");
    assert(migratedSafeMovedEntry.processedMtime === 200 && migratedSafeMovedEntry.processedSize === 600, "Safe legacy processed cache entry did not capture current processed identity");
    assert(migratedSafeMovedEntry.originalSize === 1000, "Safe legacy processed cache entry did not preserve exact originalSize");
    assert(migratedSafeMovedEntry.sourceMtime === undefined && migratedSafeMovedEntry.sourceSize === undefined, "Safe legacy moved migration invented missing source identity");
    const migratedEstimatedMovedEntry = plugin.cache.getEntriesForPath("Images/estimated-legacy-moved.png")[0]?.[1];
    assert(migratedEstimatedMovedEntry?.state === "moved", "Legacy processed cache entry without originalSize was not promoted to moved state");
    assert(migratedEstimatedMovedEntry.processedMtime === 250 && migratedEstimatedMovedEntry.processedSize === 700, "Estimated legacy processed cache entry did not capture current processed identity");
    assert(!Object.prototype.hasOwnProperty.call(migratedEstimatedMovedEntry, "originalSize"), "Estimated legacy moved migration invented originalSize");
    assert(await plugin.cache.getFreshEntryForFile(createMockFile("Images/estimated-legacy-moved.png", 700, 250)), "Estimated legacy moved cache entry was not fresh after migration");
    const changedLegacyMovedFile = createMockFile("Images/estimated-legacy-moved.png", 701, 251);
    fullAuditBugReproducerObserved.legacyMovedCacheInvalidated =
      await plugin.cache.getFreshEntryForFile(changedLegacyMovedFile) === null
      && !await plugin.cache.isFileAlreadyProcessed(changedLegacyMovedFile);
    assert(plugin.cache.getEntriesForPath("Skipped/raw.png").length === 1, "Raw skipped cache key was not preserved");
    assert(plugin.cache.getEntriesForPath("Skipped/path-only.png").length === 0, "Legacy skipped path-only cache entry was preserved instead of dropped");
    const migratedColonEntry = plugin.cache.getEntriesForPath("Folder:WithColon/image.png")[0][1];
    const migratedSkippedEntry = plugin.cache.getEntriesForPath("Skipped/raw.png")[0][1];
    assert(migratedColonEntry.path === "Folder:WithColon/image.png", `Migrated entry path is wrong: ${migratedColonEntry.path}`);
    assert(migratedSkippedEntry.state === "skipped", "Legacy skipped flag was not migrated to canonical state");
    assert(migratedSkippedEntry.skipReason === "pngquant_quality_failed" && !Object.prototype.hasOwnProperty.call(migratedSkippedEntry, "reason"), "Legacy cache reason was not migrated to skipReason");
    assert(!Object.prototype.hasOwnProperty.call(migratedSkippedEntry, "skipped"), "Legacy skipped flag survived cache migration");
    plugin.cache.cacheData.entries["v2:malformed-no-path"] = { timestamp: 1 };
    assert(!plugin.cache.getEntriesByPathMap().has(""), "Cache path map indexed a malformed empty-path entry");
    const migrationBackups = fs.readdirSync(path.join(migrationTemp, "cache-backups")).filter((name) => name.startsWith("tinyLocal-cache-backup-"));
    assert(migrationBackups.length === 1, "Cache migration did not create a backup");
  } finally {
    restoreCacheTestPaths();
    plugin.app._files = originalFilesForMigration;
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(migrationTemp, { recursive: true, force: true });
  }

  const migrationRevisionTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-migration-revision-"));
  const originalCreateBackupForMigrationRevision = plugin.cache.createBackup;
  try {
    const migrationRevisionFile = path.join(migrationRevisionTemp, "tinyLocal-cache.json");
    const newerMigrationPayload = JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {},
      newerMarker: "preserve-migration-winner"
    });
    fs.writeFileSync(migrationRevisionFile, JSON.stringify({ version: "0.9.0", entries: {} }));
    setCacheTestFile(migrationRevisionFile);
    let injectedNewerMigration = false;
    plugin.cache.createBackup = async () => {
      await originalCreateBackupForMigrationRevision.call(plugin.cache);
      if (!injectedNewerMigration) {
        injectedNewerMigration = true;
        fs.writeFileSync(migrationRevisionFile, newerMigrationPayload);
      }
    };
    await plugin.cache.loadCache();
    assert(injectedNewerMigration, "Cache migration revision test did not inject a concurrent writer");
    assert.equal(fs.readFileSync(migrationRevisionFile, "utf8"), newerMigrationPayload, "Cache migration overwrote a newer concurrent revision");
    assert(plugin.cache.cacheData.newerMarker === "preserve-migration-winner", "Cache migration did not reload the newer winning revision");
  } finally {
    plugin.cache.createBackup = originalCreateBackupForMigrationRevision;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(migrationRevisionTemp, { recursive: true, force: true });
  }

  const repairRevisionTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-repair-revision-"));
  const originalWriteCacheFileAtomicForRepairRevision = plugin.cache.writeCacheFileAtomic;
  try {
    const repairRevisionFile = path.join(repairRevisionTemp, "tinyLocal-cache.json");
    const newerRepairPayload = JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {},
      newerMarker: "preserve-repair-winner"
    });
    fs.writeFileSync(repairRevisionFile, "{ invalid repair race");
    setCacheTestFile(repairRevisionFile);
    let injectedNewerRepair = false;
    plugin.cache.writeCacheFileAtomic = async (...args) => {
      if (!injectedNewerRepair) {
        injectedNewerRepair = true;
        fs.writeFileSync(repairRevisionFile, newerRepairPayload);
      }
      return await originalWriteCacheFileAtomicForRepairRevision.apply(plugin.cache, args);
    };
    await plugin.cache.loadCache();
    assert(injectedNewerRepair, "Cache repair revision test did not inject a concurrent writer");
    assert.equal(fs.readFileSync(repairRevisionFile, "utf8"), newerRepairPayload, "Cache repair overwrote a newer concurrent revision");
    assert(plugin.cache.cacheData.newerMarker === "preserve-repair-winner", "Cache repair did not reload the newer winning revision");
  } finally {
    plugin.cache.writeCacheFileAtomic = originalWriteCacheFileAtomicForRepairRevision;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(repairRevisionTemp, { recursive: true, force: true });
  }

  const cacheContentIdentityTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-content-identity-"));
  try {
    setCacheTestFile(path.join(cacheContentIdentityTemp, "tinyLocal-cache.json"));
    const contentIdentityPath = "Images/content-identity.bin";
    const contentIdentityFile = path.join(cacheContentIdentityTemp, "Images", "content-identity.bin");
    const originalIdentityBytes = Buffer.from("alpha");
    const substitutedIdentityBytes = Buffer.from("bravo");
    fs.mkdirSync(path.dirname(contentIdentityFile), { recursive: true });
    fs.writeFileSync(contentIdentityFile, originalIdentityBytes);
    const contentIdentityMtime = 123456;
    const contentIdentityMock = createMockFile(contentIdentityPath, originalIdentityBytes.length, contentIdentityMtime);
    const contentIdentityKey = plugin.cache.buildCacheKey(contentIdentityPath, MOCK_MD5, contentIdentityMtime);
    plugin.cache.cacheData = {
      version: plugin.cache.CACHE_VERSION,
      entries: {
        [contentIdentityKey]: {
          path: contentIdentityPath,
          md5: MOCK_MD5,
          mtime: contentIdentityMtime,
          timestamp: 1,
          lastAccessMs: Date.now() + 60_000,
          state: "processed",
          processedMtime: contentIdentityMtime,
          processedSize: originalIdentityBytes.length,
          outputSha256: crypto.createHash("sha256").update(originalIdentityBytes).digest("hex")
        }
      }
    };
    assert(await plugin.cache.isFileAlreadyProcessed(contentIdentityMock), "Content-bound cache entry rejected its original bytes");
    fs.writeFileSync(contentIdentityFile, substitutedIdentityBytes);
    assert(!await plugin.cache.isFileAlreadyProcessed(contentIdentityMock), "Cache freshness accepted substituted bytes with identical size and mtime metadata");
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(cacheContentIdentityTemp, { recursive: true, force: true });
  }

  const corruptCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-corrupt-cache-"));
  try {
    const corruptCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache.json");
    fs.writeFileSync(corruptCacheFile, "{ invalid json");
    setCacheTestFile(corruptCacheFile);
    await plugin.cache.loadCache();
    assert(plugin.cache.lastLoadError, "Corrupt async cache load did not record lastLoadError");
    assert(plugin.cache.brokenCacheBackupPath, "Corrupt async cache load did not record brokenCacheBackupPath");
    const asyncBrokenPath = plugin.getPlatformPorts().fs.resolvePath(plugin.cache.brokenCacheBackupPath);
    assert(fs.existsSync(asyncBrokenPath), "Corrupt async cache load did not create a broken cache copy");
    assert(plugin.cache.brokenCacheBackupPath.includes("cache-backups/broken"), "Broken async cache copy was not placed under cache-backups/broken");
    assert(fs.readFileSync(asyncBrokenPath, "utf8") === "{ invalid json", "Broken async cache copy does not preserve original corrupt content");
    assert(Object.keys(plugin.cache.cacheData.entries).length === 0, "Corrupt async cache load did not fall back to an empty in-memory cache");
    const asyncBrokenDir = path.dirname(asyncBrokenPath);
    const asyncBrokenCount = fs.readdirSync(asyncBrokenDir).filter((name) => name.startsWith("tinyLocal-cache.broken-")).length;
    assert(JSON.parse(fs.readFileSync(corruptCacheFile, "utf8")).version === plugin.cache.CACHE_VERSION, "Corrupt async cache file was not replaced with an empty valid cache");
    await plugin.cache.loadCache();
    const asyncBrokenCountAfterReload = fs.readdirSync(asyncBrokenDir).filter((name) => name.startsWith("tinyLocal-cache.broken-")).length;
    assert(asyncBrokenCountAfterReload === asyncBrokenCount, "Valid empty cache reload created an extra broken cache copy");

    const corruptSyncCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache-sync.json");
    fs.writeFileSync(corruptSyncCacheFile, "{ invalid json sync");
    setCacheTestFile(corruptSyncCacheFile);
    plugin.cache.loadCacheSync();
    assert(plugin.cache.lastLoadError, "Corrupt sync cache load did not record lastLoadError");
    assert(plugin.cache.brokenCacheBackupPath, "Corrupt sync cache load did not record brokenCacheBackupPath");
    const syncBrokenPath = plugin.getPlatformPorts().fs.resolvePath(plugin.cache.brokenCacheBackupPath);
    assert(fs.existsSync(syncBrokenPath), "Corrupt sync cache load did not create a broken cache copy");
    assert(plugin.cache.brokenCacheBackupPath.includes("cache-backups/broken"), "Broken sync cache copy was not placed under cache-backups/broken");
    assert(fs.readFileSync(syncBrokenPath, "utf8") === "{ invalid json sync", "Broken sync cache copy does not preserve original corrupt content");
    assert(fs.readFileSync(corruptSyncCacheFile, "utf8") === "{ invalid json sync", "Sync recovery performed an unsafe raw cache replacement");
    assert(fs.readdirSync(corruptCacheTemp).some((name) => name.startsWith(".tinyLocal-cache-pending-")), "Sync recovery did not publish a pending journal");
    await plugin.cache.loadCache();
    assert(JSON.parse(fs.readFileSync(corruptSyncCacheFile, "utf8")).version === plugin.cache.CACHE_VERSION, "Async startup did not replay the sync recovery journal");

    const originalWriteCacheFileAtomic = plugin.cache.writeCacheFileAtomic;
    const originalWriteCacheFileSyncAtomic = plugin.cache.writeCacheFileSyncAtomic;
    const originalPersistPendingCacheWriteSync = plugin.cache.persistPendingCacheWriteSync;
    const originalConsoleErrorForBrokenRecovery = console.error;
    let brokenRecoveryLogs = 0;
    try {
      console.error = (...args) => {
        if (String(args[1] || "").includes("Broken cache recovery failed")) {
          brokenRecoveryLogs += 1;
        }
      };

      const recoveryAsyncCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache-recovery-async.json");
      fs.writeFileSync(recoveryAsyncCacheFile, "{ invalid recovery async");
      setCacheTestFile(recoveryAsyncCacheFile);
      plugin.cache.writeCacheFileAtomic = async () => {
        throw new Error("simulated async recovery write failure");
      };
      await plugin.cache.loadCache();
      assert(plugin.cache.brokenCacheBackupPath, "Async recovery write failure did not keep a broken cache backup path");
      assert(fs.existsSync(plugin.getPlatformPorts().fs.resolvePath(plugin.cache.brokenCacheBackupPath)), "Async recovery write failure did not preserve a broken cache copy");
      assert(fs.readFileSync(recoveryAsyncCacheFile, "utf8") === "{ invalid recovery async", "Async recovery write failure unexpectedly rewrote the corrupt cache");

      const recoverySyncCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache-recovery-sync.json");
      fs.writeFileSync(recoverySyncCacheFile, "{ invalid recovery sync");
      setCacheTestFile(recoverySyncCacheFile);
      plugin.cache.persistPendingCacheWriteSync = () => {
        throw new Error("simulated sync pending-journal failure");
      };
      plugin.cache.loadCacheSync();
      assert(plugin.cache.brokenCacheBackupPath, "Sync recovery write failure did not keep a broken cache backup path");
      assert(fs.existsSync(plugin.getPlatformPorts().fs.resolvePath(plugin.cache.brokenCacheBackupPath)), "Sync recovery write failure did not preserve a broken cache copy");
      assert(fs.readFileSync(recoverySyncCacheFile, "utf8") === "{ invalid recovery sync", "Sync recovery write failure unexpectedly rewrote the corrupt cache");
      assert(brokenRecoveryLogs === 2, `Broken cache recovery logged wrong number of failures: ${brokenRecoveryLogs}`);
    } finally {
      plugin.cache.writeCacheFileAtomic = originalWriteCacheFileAtomic;
      plugin.cache.writeCacheFileSyncAtomic = originalWriteCacheFileSyncAtomic;
      plugin.cache.persistPendingCacheWriteSync = originalPersistPendingCacheWriteSync;
      console.error = originalConsoleErrorForBrokenRecovery;
    }
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    plugin.cache.lastLoadError = null;
    plugin.cache.brokenCacheBackupPath = null;
    fs.rmSync(corruptCacheTemp, { recursive: true, force: true });
  }

  const originalFilesForCompaction = plugin.app._files;
  const originalCacheCreateBackupForCompaction = plugin.cache.createBackup;
  const originalCacheSaveCacheForCompaction = plugin.cache.saveCache;
  const originalGetFileMd5ForCompaction = plugin.cache.getFileMd5;
  const originalGetOutputMetadataForCompaction = plugin.cache.getOutputMetadata;
  const originalPointCompactionForCompaction = plugin.cache.compaction.compactPath;
  try {
    const currentFile = createMockFile("Images/current.png", 80, 20);
    const conflictFile = createMockFile("Images/conflict.png", 70, 30);
    const activePendingFile = createMockFile("Images/active-pending.png", 60, 40);
    const ambiguousFile = createMockFile("Images/ambiguous.png", 50, 50);
    const ambiguousMovedFile = createMockFile("Images/ambiguous-moved.png", 40, 60);
    plugin.app._files = [currentFile, conflictFile, activePendingFile, ambiguousFile, ambiguousMovedFile];

    const currentKey = "modern:current";
    const staleKey = "modern:stale";
    const missingModernKey = "modern:missing";
    const missingLegacyKey = "legacy:missing";
    const conflictCurrentKey = "modern:conflict-current";
    const conflictPendingKey = "modern:conflict-pending";
    const stalePendingKey = "modern:stale-pending";
    const activePendingKey = "modern:active-pending";
    const ambiguousLeftKey = "modern:ambiguous-left";
    const ambiguousRightKey = "modern:ambiguous-right";
    const movedLeftKey = "modern:moved-left";
    const movedRightKey = "modern:moved-right";
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries = {
      [currentKey]: { path: currentFile.path, state: "skipped", sourceMtime: 20, sourceSize: 80, md5: "1".repeat(32) },
      [staleKey]: { path: currentFile.path, state: "skipped", sourceMtime: 10, sourceSize: 100, md5: "2".repeat(32) },
      [missingModernKey]: { path: "Missing/modern.png", state: "skipped", sourceMtime: 1, sourceSize: 10, md5: "3".repeat(32) },
      [missingLegacyKey]: { path: "Missing/legacy.png", state: "processed", timestamp: 1 },
      [conflictCurrentKey]: { path: conflictFile.path, state: "skipped", sourceMtime: 30, sourceSize: 70, md5: "4".repeat(32) },
      [conflictPendingKey]: { path: conflictFile.path, state: "pending_move", sourceMtime: 29, sourceSize: 90, outputPath: "Compressed/conflict.png", outputMtime: 31, outputSize: 45, md5: "5".repeat(32) },
      [stalePendingKey]: { path: conflictFile.path, state: "pending_move", sourceMtime: 28, sourceSize: 95, outputPath: "Compressed/stale.png", outputMtime: 32, outputSize: 46, md5: "6".repeat(32) },
      [activePendingKey]: { path: activePendingFile.path, state: "pending_move", sourceMtime: 40, sourceSize: 60, outputPath: "Compressed/active-pending.png", outputMtime: 41, outputSize: 35, md5: "7".repeat(32) },
      [ambiguousLeftKey]: { path: ambiguousFile.path, state: "skipped", sourceMtime: 50, sourceSize: 50, md5: "8".repeat(32) },
      [ambiguousRightKey]: { path: ambiguousFile.path, state: "skipped", sourceMtime: 50, sourceSize: 50, md5: "9".repeat(32) },
      [movedLeftKey]: { path: ambiguousMovedFile.path, state: "moved", processedMtime: 60, processedSize: 40, md5: "a".repeat(32) },
      [movedRightKey]: { path: ambiguousMovedFile.path, state: "moved", processedMtime: 60, processedSize: 40, md5: "b".repeat(32) }
    };

    const md5Paths = [];
    let compactionBackupCalls = 0;
    let compactionSaveCalls = 0;
    let compactionSaveOptions = null;
    plugin.cache.getFileMd5 = async (file) => {
      md5Paths.push(file.path);
      return "f".repeat(32);
    };
    plugin.cache.getOutputMetadata = async (outputPath) => {
      if (outputPath === "Compressed/conflict.png") return { outputPath, outputMtime: 31, outputSize: 45 };
      if (outputPath === "Compressed/active-pending.png") return { outputPath, outputMtime: 41, outputSize: 35 };
      return null;
    };
    plugin.cache.createBackup = async () => {
      compactionBackupCalls += 1;
    };
    plugin.cache.saveCache = async (options) => {
      compactionSaveCalls += 1;
      compactionSaveOptions = options;
      return true;
    };

    const compactionResult = await plugin.cache.compactCache();
    assert(compactionResult.removed === 3 && compactionResult.missingFilesRemoved === 1 && compactionResult.supersededRemoved === 2, `Cache compaction returned wrong counts: ${JSON.stringify(compactionResult)}`);
    assert(!plugin.cache.cacheData.entries[staleKey] && !plugin.cache.cacheData.entries[missingModernKey] && !plugin.cache.cacheData.entries[stalePendingKey], "Cache compaction kept proven stale modern entries");
    assert(
      [staleKey, missingModernKey, stalePendingKey].every((cacheKey) => plugin.cache.getMutationRevision(plugin.cache.cacheData.tombstones?.[cacheKey])),
      "Cache compaction deleted entries without logical tombstones, allowing stale snapshots to resurrect them"
    );
    assert(plugin.cache.cacheData.entries[currentKey] && plugin.cache.cacheData.entries[missingLegacyKey], "Cache compaction removed current or legacy entries");
    assert(plugin.cache.cacheData.entries[conflictPendingKey] && plugin.cache.cacheData.entries[activePendingKey], "Cache compaction removed active/conflicting pending_move entries");
    assert(plugin.cache.cacheData.entries[ambiguousLeftKey] && plugin.cache.cacheData.entries[ambiguousRightKey], "Cache compaction removed ambiguous source records");
    assert(plugin.cache.cacheData.entries[movedLeftKey] && plugin.cache.cacheData.entries[movedRightKey], "Cache compaction removed ambiguous moved records");
    assert(JSON.stringify(md5Paths) === JSON.stringify([ambiguousFile.path]), `Cache compaction hashed unexpected states: ${JSON.stringify(md5Paths)}`);
    assert(compactionBackupCalls === 1 && compactionSaveCalls === 1, "Cache compaction did not create exactly one backup and one save");
    assert(compactionSaveOptions?.mergeDiskEntries === false && compactionSaveOptions?.authoritative === true, "Cache compaction save was not authoritative");

    const secondCompactionResult = await plugin.cache.compactCache();
    assert(secondCompactionResult.removed === 0, "Cache compaction removed ambiguous/current entries on a repeated pass");
    assert(compactionBackupCalls === 1 && compactionSaveCalls === 1, "No-op cache compaction wrote a backup or cache file");

    const replacementRaceKey = "modern:replacement-race";
    const newerReplacementEntry = { path: "Missing/replacement-race.png", state: "moved", processedMtime: 99, processedSize: 9, timestamp: 99 };
    plugin.cache.cacheData.entries[replacementRaceKey] = { path: "Missing/replacement-race.png", state: "skipped", sourceMtime: 1, sourceSize: 10, timestamp: 1 };
    let replacementRaceInjected = false;
    plugin.cache.createBackup = async () => {
      compactionBackupCalls += 1;
      if (!replacementRaceInjected) {
        replacementRaceInjected = true;
        plugin.cache.cacheData.entries[replacementRaceKey] = newerReplacementEntry;
      }
    };
    const savesBeforeReplacementRace = compactionSaveCalls;
    const replacementRaceResult = await plugin.cache.compactCache();
    assert(replacementRaceResult.removed === 0, "Cache compaction reported removal after its selected key was replaced");
    assert(plugin.cache.cacheData.entries[replacementRaceKey] === newerReplacementEntry, "Cache compaction deleted a newer replacement of the same key");
    assert(compactionSaveCalls === savesBeforeReplacementRace, "Cache compaction persisted a stale deletion after key replacement");

    plugin.cache.cacheData.entries["deleted:modern"] = { path: "Deleted/child.png", state: "skipped", sourceMtime: 1, sourceSize: 10 };
    plugin.cache.cacheData.entries["deleted:legacy"] = { path: "Deleted/legacy.png", state: "processed", timestamp: 1 };
    const deletedPathResult = await plugin.cache.compactDeletedPath("Deleted");
    assert(deletedPathResult.removed === 1 && !plugin.cache.cacheData.entries["deleted:modern"], "Point compaction did not remove a deleted modern child entry");
    assert(plugin.cache.getMutationRevision(plugin.cache.cacheData.tombstones?.["deleted:modern"]), "Point compaction deleted an entry without a logical tombstone");
    assert(plugin.cache.cacheData.entries["deleted:legacy"], "Point compaction removed a deleted legacy child entry");
    assert(compactionBackupCalls === 3 && compactionSaveCalls === 2, "Point compaction or replacement-race verification used the wrong backup/save count");

    plugin.cache.compaction.compactPath = async () => {
      throw new Error("post-commit point compaction failure");
    };
    assert.deepEqual(
      await plugin.cache.compactPath("Images/already-committed.png"),
      { removed: 0, missingFilesRemoved: 0, supersededRemoved: 0 },
      "Best-effort point compaction escaped after a durable cache commit"
    );
  } finally {
    plugin.app._files = originalFilesForCompaction;
    plugin.cache.createBackup = originalCacheCreateBackupForCompaction;
    plugin.cache.saveCache = originalCacheSaveCacheForCompaction;
    plugin.cache.getFileMd5 = originalGetFileMd5ForCompaction;
    plugin.cache.getOutputMetadata = originalGetOutputMetadataForCompaction;
    plugin.cache.compaction.compactPath = originalPointCompactionForCompaction;
    plugin.cache.cacheData = originalCacheData;
  }

  const failedCacheCommitTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-failed-cache-commit-"));
  const originalFilesForFailedCacheCommit = plugin.app._files;
  const originalCacheDataForFailedCacheCommit = plugin.cache.cacheData;
  const originalSaveCacheForFailedCacheCommit = plugin.cache.saveCache;
  const originalCreateBackupForFailedCacheCommit = plugin.cache.createBackup;
  const failedCacheCommitPorts = plugin.getPlatformPorts();
  const originalFileSha256ForFailedCacheCommit = failedCacheCommitPorts.hash.fileSha256Hex;
  const originalRemoveFileForFailedCacheCommit = failedCacheCommitPorts.fs.removeFileIfUnchanged;
  const originalStatForFailedCacheCommit = failedCacheCommitPorts.fs.stat;
  const buildArtifact = (sourcePath, outputPath, outputBytes, sourceMtime) => ({
    sourcePath,
    sourceMtime,
    sourceSize: 100,
    sourceMd5: crypto.createHash("md5").update(sourcePath).digest("hex"),
    sourceSha256: crypto.createHash("sha256").update(sourcePath).digest("hex"),
    outputPath,
    outputSize: outputBytes.byteLength,
    outputSha256: crypto.createHash("sha256").update(outputBytes).digest("hex"),
    compressionSettingsKey: "smoke:failed-cache-commit"
  });
  const assertCacheRolledBack = (before, message) => {
    assert.equal(plugin.cache.serializeForDisk(), before, message);
  };
  try {
    setCacheTestFile(path.join(failedCacheCommitTemp, "tinyLocal-cache.json"));
    plugin.cache.acceptingWrites = true;

    const staleMetadataSourcePath = "Images/stale-output-metadata.png";
    const staleMetadataOutputPath = "Compressed/stale-output-metadata.bin";
    const staleMetadataNativePath = path.join(failedCacheCommitTemp, ...staleMetadataOutputPath.split("/"));
    const staleMetadataBytes = Buffer.alloc(40, 0x10);
    fs.mkdirSync(path.dirname(staleMetadataNativePath), { recursive: true });
    fs.writeFileSync(staleMetadataNativePath, staleMetadataBytes);
    plugin.app._files = [createMockFile(staleMetadataSourcePath, 100, 9)];
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    let staleOutputStatReads = 0;
    failedCacheCommitPorts.fs.stat = async function(filePath) {
      const stat = await originalStatForFailedCacheCommit.call(this, filePath);
      if (filePath === staleMetadataOutputPath && stat) {
        staleOutputStatReads++;
        return { ...stat, size: 0 };
      }
      return stat;
    };
    const staleMetadataArtifact = buildArtifact(staleMetadataSourcePath, staleMetadataOutputPath, staleMetadataBytes, 9);
    const staleMetadataResult = await withRealGlobalTimers(() => plugin.cache.addCompressionArtifact(staleMetadataArtifact));
    assert.equal(staleMetadataResult, true, "addCompressionArtifact() rejected exact output bytes with stale size metadata");
    const staleMetadataEntry = plugin.cache.getEntriesForPath(staleMetadataSourcePath)[0]?.[1];
    assert(staleOutputStatReads >= 2, "Compression artifact test did not exercise both stale metadata fences");
    assert.equal(staleMetadataEntry?.outputSize, staleMetadataBytes.byteLength, "Cache did not retain the compressor-verified output size");
    failedCacheCommitPorts.fs.stat = originalStatForFailedCacheCommit;

    const substitutionOutputPath = "Compressed/substitution.bin";
    const substitutionNativePath = path.join(failedCacheCommitTemp, ...substitutionOutputPath.split("/"));
    const ownedSubstitutionBytes = Buffer.alloc(32, 0x11);
    const foreignSubstitutionBytes = Buffer.alloc(32, 0x22);
    fs.mkdirSync(path.dirname(substitutionNativePath), { recursive: true });
    fs.writeFileSync(substitutionNativePath, ownedSubstitutionBytes);
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const substitutionCacheBefore = plugin.cache.serializeForDisk();
    let substitutionInjected = false;
    failedCacheCommitPorts.hash.fileSha256Hex = async function(filePath, token) {
      if (filePath === substitutionOutputPath && !substitutionInjected) {
        substitutionInjected = true;
        fs.writeFileSync(substitutionNativePath, foreignSubstitutionBytes);
      }
      return await originalFileSha256ForFailedCacheCommit.call(this, filePath, token);
    };
    await assert.rejects(
      withRealGlobalTimers(() => plugin.cache.addCompressionArtifact(
        buildArtifact("Images/substitution.png", substitutionOutputPath, ownedSubstitutionBytes, 10)
      )),
      /Compression output changed before cache commit/,
      "addCompressionArtifact() accepted a same-size foreign substitution between stat and hash"
    );
    assert(substitutionInjected, "Compression artifact substitution test did not reach the hash boundary");
    assertCacheRolledBack(substitutionCacheBefore, "Rejected foreign compression output mutated cache RAM");
    assert(fs.readFileSync(substitutionNativePath).equals(foreignSubstitutionBytes), "Rejected foreign compression output was removed or overwritten");
    failedCacheCommitPorts.hash.fileSha256Hex = originalFileSha256ForFailedCacheCommit;

    plugin.cache.saveCache = async () => false;
    const failedOutputPath = "Compressed/save-failed.bin";
    const failedOutputNativePath = path.join(failedCacheCommitTemp, ...failedOutputPath.split("/"));
    const siblingOutputNativePath = path.join(failedCacheCommitTemp, "Compressed", "foreign-sibling.bin");
    const failedOutputBytes = Buffer.alloc(24, 0x33);
    const siblingOutputBytes = Buffer.alloc(24, 0x44);
    fs.writeFileSync(failedOutputNativePath, failedOutputBytes);
    fs.writeFileSync(siblingOutputNativePath, siblingOutputBytes);
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const failedArtifactCacheBefore = plugin.cache.serializeForDisk();
    let cleanupIdentity = null;
    failedCacheCommitPorts.fs.removeFileIfUnchanged = async function(filePath, expectedSha256, token) {
      cleanupIdentity = { filePath, expectedSha256 };
      return await originalRemoveFileForFailedCacheCommit.call(this, filePath, expectedSha256, token);
    };
    const failedArtifact = buildArtifact("Images/save-failed.png", failedOutputPath, failedOutputBytes, 11);
    const failedArtifactResult = await withRealGlobalTimers(() => plugin.cache.addCompressionArtifact(failedArtifact));
    assert.equal(failedArtifactResult, false, "addCompressionArtifact() acknowledged a failed cache save");
    assertCacheRolledBack(failedArtifactCacheBefore, "Failed compression artifact commit left non-durable cache RAM");
    assert.deepEqual(
      cleanupIdentity,
      { filePath: failedOutputPath, expectedSha256: failedArtifact.outputSha256 },
      "Failed compression artifact commit did not clean up its exact owned output identity"
    );
    assert(!fs.existsSync(failedOutputNativePath), "Failed compression artifact commit retained its exact owned output");
    assert(fs.readFileSync(siblingOutputNativePath).equals(siblingOutputBytes), "Failed compression artifact cleanup touched a foreign sibling output");
    failedCacheCommitPorts.fs.removeFileIfUnchanged = originalRemoveFileForFailedCacheCommit;

    const skippedFile = createMockFile("Images/save-failed-skip.png", 100, 12);
    await setMockFiles(plugin, [skippedFile]);
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const skippedCacheBefore = plugin.cache.serializeForDisk();
    const skippedResult = await plugin.cache.addSkippedEntry(skippedFile.path, "too_small");
    assert.equal(skippedResult, false, "addSkippedEntry() acknowledged a failed cache save");
    assertCacheRolledBack(skippedCacheBefore, "Failed skipped-entry commit left non-durable cache RAM");

    const renameOldPath = "Images/save-failed-rename.png";
    const renameNewPath = "Images/save-failed-renamed.png";
    const renameKey = plugin.cache.buildCacheKey(renameOldPath, MOCK_MD5, 13);
    const renameData = plugin.cache.getEmptyCacheData();
    renameData.entries[renameKey] = {
      path: renameOldPath,
      md5: MOCK_MD5,
      mtime: 13,
      sourceMtime: 13,
      sourceSize: 100,
      state: "skipped",
      timestamp: 13
    };
    plugin.cache.cacheData = renameData;
    const renameCacheBefore = plugin.cache.serializeForDisk();
    const renameResult = await plugin.cache.renameCacheEntries(renameOldPath, renameNewPath);
    assert.equal(renameResult, false, "renameCacheEntries() acknowledged a failed cache save");
    assert.strictEqual(plugin.cache.cacheData, renameData, "Failed rename did not restore the original cache snapshot object");
    assertCacheRolledBack(renameCacheBefore, "Failed rename left non-durable cache RAM");

    const clearKey = plugin.cache.buildCacheKey("Images/save-failed-clear.png", MOCK_MD5, 14);
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries[clearKey] = {
      path: "Images/save-failed-clear.png",
      md5: MOCK_MD5,
      mtime: 14,
      sourceMtime: 14,
      sourceSize: 100,
      state: "skipped",
      timestamp: 14
    };
    const clearCacheBefore = plugin.cache.serializeForDisk();
    const clearResult = await plugin.cache.clearCache();
    assert.equal(clearResult, false, "clearCache() acknowledged a failed cache save");
    assertCacheRolledBack(clearCacheBefore, "Failed clearCache() left non-durable cache RAM");

    plugin.app._files = [];
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries["missing:save-failed-compaction"] = {
      path: "Missing/save-failed-compaction.png",
      md5: MOCK_MD5,
      mtime: 15,
      sourceMtime: 15,
      sourceSize: 100,
      state: "skipped",
      timestamp: 15
    };
    const compactionCacheBefore = plugin.cache.serializeForDisk();
    let failedCompactionBackupCalls = 0;
    plugin.cache.createBackup = async () => {
      failedCompactionBackupCalls += 1;
    };
    const failedCompactionResult = await plugin.cache.compactCache();
    assert.deepEqual(
      failedCompactionResult,
      { removed: 0, missingFilesRemoved: 0, supersededRemoved: 0 },
      "compactCache() reported removals after a failed cache save"
    );
    assert.equal(failedCompactionBackupCalls, 1, "Failed compaction test did not reach its durable commit boundary");
    assertCacheRolledBack(compactionCacheBefore, "Failed compactCache() left non-durable cache RAM");
  } finally {
    failedCacheCommitPorts.hash.fileSha256Hex = originalFileSha256ForFailedCacheCommit;
    failedCacheCommitPorts.fs.removeFileIfUnchanged = originalRemoveFileForFailedCacheCommit;
    failedCacheCommitPorts.fs.stat = originalStatForFailedCacheCommit;
    plugin.cache.saveCache = originalSaveCacheForFailedCacheCommit;
    plugin.cache.createBackup = originalCreateBackupForFailedCacheCommit;
    plugin.cache.cacheData = originalCacheDataForFailedCacheCommit;
    plugin.app._files = originalFilesForFailedCacheCommit;
    restoreCacheTestPaths();
    fs.rmSync(failedCacheCommitTemp, { recursive: true, force: true });
  }

  const validCacheBackupNames = [
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-deadbeef.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe0123456789abcdef.json"
  ];
  for (const backupName of validCacheBackupNames) {
    assert(plugin.cache.isValidBackupFileName(backupName), `Valid cache backup filename was rejected: ${backupName}`);
  }
  const invalidCacheBackupNames = [
    "../tinyLocal-cache-backup-2026-05-15T00-00-00-000.json",
    "nested/tinyLocal-cache-backup-2026-05-15T00-00-00-000.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe.txt",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbee.json",
    "tinyLocal-cache-backup-old-00.json"
  ];
  for (const backupName of invalidCacheBackupNames) {
    assert(!plugin.cache.isValidBackupFileName(backupName), `Invalid cache backup filename was accepted: ${backupName}`);
  }

  const restoreTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-"));
  try {
    const restoreCacheFile = path.join(restoreTemp, "tinyLocal-cache.json");
    const restoreBackupDir = path.join(restoreTemp, "cache-backups");
    const restoreBackupName = "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe.json";
    fs.mkdirSync(restoreBackupDir, { recursive: true });
    fs.writeFileSync(restoreCacheFile, JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {}
    }, null, 2));
    fs.writeFileSync(path.join(restoreBackupDir, restoreBackupName), JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        "Images/restored.png": {
          path: "Images/restored.png",
          timestamp: 1234,
          originalSize: 1000
        }
      }
    }, null, 2));
    setCacheTestFile(restoreCacheFile);
    assert(plugin.cache.isValidBackupFileName(restoreBackupName), "restoreFromBackup() rejects the current backup filename format");
    const restored = await plugin.cache.restoreFromBackup(restoreBackupName);
    assert(restored, "restoreFromBackup() did not restore the selected backup");
    const restoredEntry = plugin.cache.getEntriesForPath("Images/restored.png")[0]?.[1];
    assert(restoredEntry && restoredEntry.timestamp === 1234, `restoreFromBackup() changed entry timestamp: ${restoredEntry && restoredEntry.timestamp}`);

    const restoredCacheSnapshot = fs.readFileSync(restoreCacheFile, "utf8");
    const malformedDesktopBackupName = "tinyLocal-cache-backup-2026-05-15T00-00-01-000-deadbeefcafebabe.json";
    fs.writeFileSync(path.join(restoreBackupDir, malformedDesktopBackupName), JSON.stringify({ version: plugin.cache.CACHE_VERSION, entries: [] }));
    const originalConsoleErrorForDesktopRestore = console.error;
    console.error = () => {};
    try {
      assert(!await plugin.cache.restoreFromBackup(malformedDesktopBackupName), "Desktop restore accepted an invalid cache schema");
      assert.equal(fs.readFileSync(restoreCacheFile, "utf8"), restoredCacheSnapshot, "Invalid desktop restore changed the current cache");

      const restoreProbeForRequiredBackup = plugin.getPlatformPorts().fs.restoreProbe;
      const resolveRestorePath = (filePath) => plugin.getPlatformPorts().fs.resolvePath(String(filePath));
      const originalCopyViaHandleForRequiredBackup = restoreProbeForRequiredBackup.copyViaHandle;
      restoreProbeForRequiredBackup.copyViaHandle = async (sourcePath, targetPath, options) => {
        if (path.resolve(resolveRestorePath(sourcePath)) === path.resolve(restoreCacheFile)
          && path.dirname(path.resolve(resolveRestorePath(targetPath))) === path.resolve(restoreBackupDir)) {
          throw new Error("Injected desktop restore safety-backup failure");
        }
        return await originalCopyViaHandleForRequiredBackup.call(restoreProbeForRequiredBackup, sourcePath, targetPath, options);
      };
      try {
        assert(!await plugin.cache.restoreFromBackup(restoreBackupName), "Desktop restore continued without a required safety backup");
      } finally {
        restoreProbeForRequiredBackup.copyViaHandle = originalCopyViaHandleForRequiredBackup;
      }
      assert.equal(fs.readFileSync(restoreCacheFile, "utf8"), restoredCacheSnapshot, "Desktop safety-backup failure changed the current cache");

      const restoreProbe = plugin.getPlatformPorts().fs.restoreProbe;
      const sourceSubstitutionBackupName = "tinyLocal-cache-backup-2026-05-15T00-00-02-000-deadbeefcafebabe.json";
      const sourceSubstitutionBackupPath = path.join(restoreBackupDir, sourceSubstitutionBackupName);
      fs.writeFileSync(sourceSubstitutionBackupPath, JSON.stringify({
        version: plugin.cache.CACHE_VERSION,
        entries: { substitution: { path: "Images/source-substitution.png", timestamp: 2 } }
      }));
      const originalCopyViaHandleForSubstitution = restoreProbe.copyViaHandle;
      let sourceSubstitutionInjected = false;
      restoreProbe.copyViaHandle = async (sourcePath, targetPath, options) => await originalCopyViaHandleForSubstitution.call(
        restoreProbe,
        sourcePath,
        targetPath,
        {
          ...options,
          afterOpen: async () => {
            const release = await options.afterOpen();
            if (!sourceSubstitutionInjected && path.resolve(resolveRestorePath(sourcePath)) === path.resolve(sourceSubstitutionBackupPath)) {
              sourceSubstitutionInjected = true;
              fs.renameSync(sourceSubstitutionBackupPath, `${sourceSubstitutionBackupPath}.opened`);
              fs.writeFileSync(sourceSubstitutionBackupPath, JSON.stringify({ version: plugin.cache.CACHE_VERSION, entries: {} }));
            }
            return release;
          }
        }
      );
      try {
        assert(!await plugin.cache.restoreFromBackup(sourceSubstitutionBackupName), "Desktop restore accepted a backup path substituted after its handle was opened");
      } finally {
        restoreProbe.copyViaHandle = originalCopyViaHandleForSubstitution;
      }
      assert.equal(fs.readFileSync(restoreCacheFile, "utf8"), restoredCacheSnapshot, "Backup source substitution changed the live cache");

      const originalLstatIdentityForLiveSymlink = restoreProbe.lstatIdentity;
      restoreProbe.lstatIdentity = async (filePath) => {
        const identity = await originalLstatIdentityForLiveSymlink.call(restoreProbe, filePath);
        return path.resolve(resolveRestorePath(filePath)) === path.resolve(restoreCacheFile)
          ? { ...identity, isSymbolicLink: true }
          : identity;
      };
      try {
        assert(!await plugin.cache.restoreFromBackup(restoreBackupName), "Desktop restore accepted a symlink-like live cache target");
      } finally {
        restoreProbe.lstatIdentity = originalLstatIdentityForLiveSymlink;
      }
      assert.equal(fs.readFileSync(restoreCacheFile, "utf8"), restoredCacheSnapshot, "Symlink-like live cache rejection changed the target");

      const restoreRaceBackupName = "tinyLocal-cache-backup-2026-05-15T00-00-03-000-deadbeefcafebabe.json";
      const restoreRacePayload = JSON.stringify({
        version: plugin.cache.CACHE_VERSION,
        entries: { selected: { path: "Images/selected-race.png", timestamp: 3 } }
      });
      const preInstallConcurrentPayload = JSON.stringify({
        version: plugin.cache.CACHE_VERSION,
        entries: { concurrent: { path: "Images/concurrent-before-install.png", timestamp: 4 } }
      });
      fs.writeFileSync(path.join(restoreBackupDir, restoreRaceBackupName), restoreRacePayload);
      fs.writeFileSync(restoreCacheFile, restoredCacheSnapshot);
      const desktopFsForRestoreRace = plugin.getPlatformPorts().fs;
      const originalReplaceFileForRestoreRace = desktopFsForRestoreRace.replaceFile;
      let preInstallRaceInjected = false;
      desktopFsForRestoreRace.replaceFile = async (stagedPath, targetPath, options) => {
        if (!preInstallRaceInjected
          && String(stagedPath).includes("tinylocal-recovery")
          && path.resolve(resolveRestorePath(targetPath)) === path.resolve(restoreCacheFile)) {
          preInstallRaceInjected = true;
          fs.writeFileSync(restoreCacheFile, preInstallConcurrentPayload);
        }
        return await originalReplaceFileForRestoreRace.call(desktopFsForRestoreRace, stagedPath, targetPath, options);
      };
      try {
        assert(!await plugin.cache.restoreFromBackup(restoreRaceBackupName), "Desktop restore overwrote a cache written immediately before conditional install");
      } finally {
        desktopFsForRestoreRace.replaceFile = originalReplaceFileForRestoreRace;
      }
      assert.equal(fs.readFileSync(restoreCacheFile, "utf8"), preInstallConcurrentPayload, "Conditional restore install did not preserve the concurrent cache revision");

      const rollbackConcurrentPayload = JSON.stringify({
        version: plugin.cache.CACHE_VERSION,
        entries: { concurrent: { path: "Images/concurrent-before-rollback.png", timestamp: 5 } }
      });
      const originalReadTextForRestoreRollback = desktopFsForRestoreRace.readText;
      let rollbackRaceInjected = false;
      desktopFsForRestoreRace.readText = async (filePath) => {
        if (!rollbackRaceInjected
          && path.resolve(resolveRestorePath(filePath)) === path.resolve(restoreCacheFile)
          && fs.readFileSync(restoreCacheFile, "utf8") === restoreRacePayload) {
          rollbackRaceInjected = true;
          fs.writeFileSync(restoreCacheFile, rollbackConcurrentPayload);
        }
        return await originalReadTextForRestoreRollback.call(desktopFsForRestoreRace, filePath);
      };
      try {
        assert(!await plugin.cache.restoreFromBackup(restoreRaceBackupName), "Desktop restore rollback overwrote a newer concurrent cache revision");
      } finally {
        desktopFsForRestoreRace.readText = originalReadTextForRestoreRollback;
      }
      assert(rollbackRaceInjected, "Desktop restore rollback test did not reach the post-install readback boundary");
      assert.equal(fs.readFileSync(restoreCacheFile, "utf8"), rollbackConcurrentPayload, "Desktop restore rollback replaced the newer concurrent cache revision");
    } finally {
      console.error = originalConsoleErrorForDesktopRestore;
    }
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreTemp, { recursive: true, force: true });
  }

  const normalizedFutureCache = plugin.cache.normalizeCacheData({
    version: "99.0.0",
    futureMetadata: {
      shouldSurvive: true
    },
    entries: {
      "Images/future.png": {
        path: "Images/future.png",
        timestamp: 1,
        originalSize: 100
      }
    }
  }).data;
  assert(normalizedFutureCache.futureMetadata?.shouldSurvive === true, "normalizeCacheData() dropped unknown future cache metadata");
  assert(normalizedFutureCache.version === plugin.cache.CACHE_VERSION, "normalizeCacheData() did not keep the current cache version");
  const sourceCacheForClone = {
    version: plugin.cache.CACHE_VERSION,
    futureMetadata: {
      nested: {
        value: "keep"
      }
    },
    entries: {
      "Images/deep-clone.png": {
        path: "Images/deep-clone.png",
        meta: {
          value: "source"
        }
      }
    }
  };
  const normalizedCloneCache = plugin.cache.normalizeCacheData(sourceCacheForClone).data;
  normalizedCloneCache.futureMetadata.nested.value = "changed";
  normalizedCloneCache.entries["Images/deep-clone.png"].meta.value = "changed";
  assert(sourceCacheForClone.futureMetadata.nested.value === "keep", "normalizeCacheData() leaked top-level nested mutations to source data");
  assert(sourceCacheForClone.entries["Images/deep-clone.png"].meta.value === "source", "normalizeCacheData() leaked entry nested mutations to source data");
  const originalConsoleWarnForNormalize = console.warn;
  let invalidNormalizeWarnings = 0;
  try {
    console.warn = () => {
      invalidNormalizeWarnings += 1;
    };
    const normalizedArrayEntries = plugin.cache.normalizeCacheData({ version: plugin.cache.CACHE_VERSION, entries: [] });
    const normalizedCallableEntry = plugin.cache.normalizeCacheData({ version: plugin.cache.CACHE_VERSION, entries: { bad: () => null } });
    assert(Object.keys(normalizedArrayEntries.data.entries).length === 0, "normalizeCacheData() accepted array entries");
    assert(Object.keys(normalizedCallableEntry.data.entries).length === 0, "normalizeCacheData() accepted callable entries");
    assert(invalidNormalizeWarnings >= 2, "normalizeCacheData() did not warn for invalid entries shapes");
  } finally {
    console.warn = originalConsoleWarnForNormalize;
  }

  const invalidMtimeNaN = plugin.cache.normalizeMtime(NaN);
  const invalidMtimeInfinity = plugin.cache.normalizeMtime(Infinity);
  const invalidMtimeNull = plugin.cache.normalizeMtime(null);
  assert(invalidMtimeNaN > 0 && invalidMtimeInfinity > 0 && invalidMtimeNull > 0, "Invalid mtime fallback returned epoch 0");
  assert(new Set([invalidMtimeNaN, invalidMtimeInfinity, invalidMtimeNull]).size === 3, "Invalid mtime fallback is not monotonic");
  assert.throws(() => plugin.cache.buildCacheKey("Images/invalid-mtime.png", MOCK_MD5, NaN), /without real mtime/, "Cache key accepted NaN mtime");
  assert.throws(() => plugin.cache.buildCacheKey("Images/invalid-mtime.png", MOCK_MD5, Infinity), /without real mtime/, "Cache key accepted infinite mtime");
  const invalidMtimeKeyA = plugin.cache.buildCacheKey("Images/invalid-mtime.png", MOCK_MD5, invalidMtimeNaN);
  const invalidMtimeKeyB = plugin.cache.buildCacheKey("Images/invalid-mtime.png", MOCK_MD5, invalidMtimeInfinity);
  assert(invalidMtimeKeyA !== invalidMtimeKeyB, "Invalid mtime cache keys collide for the same file/md5");

  const unicodeNfcPath = "Images/caf\u00e9.png".normalize("NFC");
  const unicodeNfdPath = "Images/caf\u00e9.png".normalize("NFD");
  assert(unicodeNfcPath !== unicodeNfdPath, "Unicode path fixture must use distinct NFC/NFD byte forms");
  const unicodeNfcKey = plugin.cache.buildCacheKey(unicodeNfcPath, MOCK_MD5, 123);
  const unicodeNfdKey = plugin.cache.buildCacheKey(unicodeNfdPath, MOCK_MD5, 123);
  const unicodeDoubleSlashKey = plugin.cache.buildCacheKey("Images//caf\u00e9.png", MOCK_MD5, 123);
  assert(unicodeNfcKey === unicodeNfdKey, "Cache key normalization does not collapse Unicode NFC/NFD variants");
  assert(unicodeNfcKey === unicodeDoubleSlashKey, "Cache key normalization does not collapse duplicate path separators");
  const migratedUnicodeCache = plugin.cache.normalizeCacheData({
    version: plugin.cache.CACHE_VERSION,
    entries: {
      [`${unicodeNfdPath}:${MOCK_MD5}:123`]: {
        path: unicodeNfdPath,
        md5: MOCK_MD5,
        mtime: 123,
        timestamp: 1
      }
    }
  }).data;
  assert(migratedUnicodeCache.entries[unicodeNfcKey]?.path === unicodeNfcPath, "normalizeCacheData() did not migrate legacy Unicode paths to NFC v2 keys");
  if (process.platform === "win32" || process.platform === "darwin") {
    const originalAllowedRootsForCase = plugin.settings.allowedRoots;
    try {
      plugin.settings.allowedRoots = ["images"];
      assert(plugin.isAllowedPath("Images/CaseSensitive.jpg"), "Allowed roots should compare case-insensitively on this platform");
      plugin.cache.cacheData.entries = {
        [plugin.cache.buildCacheKey("Images/CaseSensitive.jpg", MOCK_MD5, 124)]: {
          path: "Images/CaseSensitive.jpg",
          md5: MOCK_MD5,
          mtime: 124,
          timestamp: 1
        }
      };
      assert(plugin.cache.getEntriesForPath("images/casesensitive.jpg").length === 1, "Cache path lookup should compare case-insensitively on this platform");
    } finally {
      plugin.settings.allowedRoots = originalAllowedRootsForCase;
      plugin.cache.cacheData = originalCacheData;
    }
  }

  const backupSuffixTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-backup-suffix-"));
  try {
    setCacheTestFile(path.join(backupSuffixTemp, "tinyLocal-cache.json"));
    fs.writeFileSync(resolveCacheTestPath(plugin.cache.cacheFile), JSON.stringify(plugin.cache.getEmptyCacheData(), null, 2));
    await plugin.cache.createBackup();
    await plugin.cache.createBackup();
    const backupNames = fs.readdirSync(path.join(backupSuffixTemp, "cache-backups"));
    assert(backupNames.length === 2, `Cache backups collided or were overwritten: ${backupNames.join(", ")}`);
    assert(
      backupNames.every((name) => /^tinyLocal-cache-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{32}\.json$/i.test(name)),
      `Cache backups do not keep millisecond timestamps and 32-hex random suffixes: ${backupNames.join(", ")}`
    );
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(backupSuffixTemp, { recursive: true, force: true });
  }

  const cleanupBackupsTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-"));
  try {
    setCacheTestFile(path.join(cleanupBackupsTemp, "tinyLocal-cache.json"), cleanupBackupsTemp);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 12; index++) {
      const backupPath = path.join(cleanupBackupsTemp, `tinyLocal-cache-backup-old-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(backupPath, "{}");
      fs.utimesSync(backupPath, oldTime, oldTime);
    }
    await plugin.cache.cleanupOldBackups(plugin.cache.cacheBackupsDir);
    const cleanupBackupsAfterOldRetention = fs.readdirSync(cleanupBackupsTemp);
    assert(cleanupBackupsAfterOldRetention.filter((name) => name.startsWith("tinyLocal-cache-backup-old-")).length === 10, `Cache backup cleanup did not keep exactly the latest 10 old backups: ${cleanupBackupsAfterOldRetention.join(", ")}`);
    const retainedSameMtimeBackups = fs.readdirSync(cleanupBackupsTemp).filter((name) => name.startsWith("tinyLocal-cache-backup-old-")).sort();
    assert(!retainedSameMtimeBackups.includes("tinyLocal-cache-backup-old-00.json"), "Cache backup cleanup kept the oldest same-mtime filename");
    assert(!retainedSameMtimeBackups.includes("tinyLocal-cache-backup-old-01.json"), "Cache backup cleanup kept the second-oldest same-mtime filename");
    assert(retainedSameMtimeBackups.includes("tinyLocal-cache-backup-old-11.json"), "Cache backup cleanup did not keep the newest same-mtime filename");
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(cleanupBackupsTemp, `tinyLocal-cache-backup-fresh-${String(index).padStart(2, "0")}.json`), "{}");
    }
    await plugin.cache.cleanupOldBackups(plugin.cache.cacheBackupsDir);
    const remainingFresh = fs.readdirSync(cleanupBackupsTemp).filter((name) => name.includes("fresh-"));
    assert(remainingFresh.length === 12, "Cache backup cleanup deleted backups younger than the minimum retention window");
    const brokenDir = path.join(cleanupBackupsTemp, "broken");
    fs.mkdirSync(brokenDir, { recursive: true });
    for (let index = 0; index < 12; index++) {
      const brokenPath = path.join(brokenDir, `tinyLocal-cache.broken-old-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(brokenPath, "{}");
      fs.utimesSync(brokenPath, oldTime, oldTime);
    }
    const freshBrokenPath = path.join(brokenDir, "tinyLocal-cache.broken-fresh.json");
    fs.writeFileSync(freshBrokenPath, "{}");
    await plugin.cache.cleanupOldBackups(plugin.cache.cacheBackupsDir);
    const remainingBroken = fs.readdirSync(brokenDir).filter((name) => name.startsWith("tinyLocal-cache.broken-"));
    const remainingOldBroken = remainingBroken.filter((name) => name.includes("old-"));
    assert(remainingBroken.length === 10, "Broken cache cleanup did not keep the retained set size at 10");
    assert(remainingOldBroken.length === 9, "Broken cache cleanup did not retain the expected old broken copies alongside a fresh copy");
    assert(remainingBroken.includes("tinyLocal-cache.broken-fresh.json"), "Broken cache cleanup deleted a fresh broken copy");
    for (let index = 0; index < 12; index++) {
      const rootBrokenPath = path.join(cleanupBackupsTemp, `tinyLocal-cache.broken-root-old-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(rootBrokenPath, "{}");
      fs.utimesSync(rootBrokenPath, oldTime, oldTime);
    }
    const freshRootBrokenPath = path.join(cleanupBackupsTemp, "tinyLocal-cache.broken-root-fresh.json");
    fs.writeFileSync(freshRootBrokenPath, "{}");
    await plugin.cache.cleanupOldBackups(plugin.cache.cacheBackupsDir);
    const remainingRootBroken = fs.readdirSync(cleanupBackupsTemp).filter((name) => name.startsWith("tinyLocal-cache.broken-root-"));
    assert(remainingRootBroken.length === 10, "Root-level broken cache cleanup did not keep the retained set size at 10");
    assert(remainingRootBroken.includes("tinyLocal-cache.broken-root-fresh.json"), "Root-level broken cache cleanup deleted a fresh broken copy");
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupBackupsTemp, { recursive: true, force: true });
  }

  const cleanupLargeBackupsTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-large-"));
  try {
    setCacheTestFile(path.join(cleanupLargeBackupsTemp, "tinyLocal-cache.json"), cleanupLargeBackupsTemp);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 1005; index++) {
      const backupPath = path.join(cleanupLargeBackupsTemp, `tinyLocal-cache-backup-large-${String(index).padStart(4, "0")}.json`);
      fs.writeFileSync(backupPath, "{}");
      fs.utimesSync(backupPath, oldTime, oldTime);
    }
    await withRealGlobalTimers(() => plugin.cache.cleanupRetainedFiles(
      plugin.cache.cacheBackupsDir,
      (fileName) => fileName.startsWith("tinyLocal-cache-backup-large-")
    ));
    const remainingLargeBackups = fs.readdirSync(cleanupLargeBackupsTemp).filter((name) => name.startsWith("tinyLocal-cache-backup-large-")).sort();
    assert(remainingLargeBackups.length === 10, `Cache retained-file cleanup left ${remainingLargeBackups.length} files when >1000 candidates existed`);
    assert(remainingLargeBackups[0] === "tinyLocal-cache-backup-large-0995.json", `Cache retained-file cleanup retained wrong lower bound: ${remainingLargeBackups[0]}`);
    assert(remainingLargeBackups[9] === "tinyLocal-cache-backup-large-1004.json", `Cache retained-file cleanup retained wrong upper bound: ${remainingLargeBackups[9]}`);
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupLargeBackupsTemp, { recursive: true, force: true });
  }

  const cleanupFreshCapTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-fresh-cap-"));
  try {
    setCacheTestFile(path.join(cleanupFreshCapTemp, "tinyLocal-cache.json"), cleanupFreshCapTemp);
    for (let index = 0; index < 60; index++) {
      fs.writeFileSync(path.join(cleanupFreshCapTemp, `tinyLocal-cache-backup-fresh-cap-${String(index).padStart(2, "0")}.json`), "{}");
    }
    await plugin.cache.cleanupRetainedFiles(plugin.cache.cacheBackupsDir, (fileName) => fileName.startsWith("tinyLocal-cache-backup-fresh-cap-"));
    const remainingFreshCapBackups = fs.readdirSync(cleanupFreshCapTemp).filter((name) => name.startsWith("tinyLocal-cache-backup-fresh-cap-"));
    assert(remainingFreshCapBackups.length === 50, `Cache backup hard cap retained ${remainingFreshCapBackups.length} fresh files instead of 50`);
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupFreshCapTemp, { recursive: true, force: true });
  }

  const cleanupConcurrencyTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-concurrency-"));
  const originalUnlinkForCleanupConcurrency = fs.promises.unlink;
  try {
    setCacheTestFile(path.join(cleanupConcurrencyTemp, "tinyLocal-cache.json"), cleanupConcurrencyTemp);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 40; index++) {
      const filePath = path.join(cleanupConcurrencyTemp, `cleanup-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(filePath, "{}");
      fs.utimesSync(filePath, oldTime, oldTime);
    }
    let activeUnlinks = 0;
    let maxActiveUnlinks = 0;
    fs.promises.unlink = async (filePath) => {
      activeUnlinks += 1;
      maxActiveUnlinks = Math.max(maxActiveUnlinks, activeUnlinks);
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 2));
      activeUnlinks -= 1;
      return originalUnlinkForCleanupConcurrency.call(fs.promises, filePath);
    };
    await plugin.cache.cleanupRetainedFiles(plugin.cache.cacheBackupsDir, (fileName) => fileName.endsWith(".json"));
    assert(maxActiveUnlinks <= 8, `cleanupRetainedFiles() unlinked too many files concurrently: ${maxActiveUnlinks}`);
  } finally {
    fs.promises.unlink = originalUnlinkForCleanupConcurrency;
    restoreCacheTestPaths();
    fs.rmSync(cleanupConcurrencyTemp, { recursive: true, force: true });
  }

  const cleanupReplacementRaceTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-replacement-"));
  try {
    setCacheTestFile(path.join(cleanupReplacementRaceTemp, "tinyLocal-cache.json"), cleanupReplacementRaceTemp);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 12; index += 1) {
      const candidatePath = path.join(cleanupReplacementRaceTemp, `retention-race-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(candidatePath, `old-${index}`);
      fs.utimesSync(candidatePath, oldTime, oldTime);
    }
    const cleanupFsPort = plugin.getPlatformPorts().fs;
    const originalConditionalRemoveForRetention = cleanupFsPort.removeFileIfUnchanged;
    let replacementRacePath = null;
    try {
      cleanupFsPort.removeFileIfUnchanged = async function(filePath, expectedSha256, token) {
        if (!replacementRacePath && String(filePath).includes("retention-race-")) {
          replacementRacePath = resolveCacheTestPath(filePath);
          fs.writeFileSync(replacementRacePath, "sync-replacement-after-selection");
        }
        return await originalConditionalRemoveForRetention.call(this, filePath, expectedSha256, token);
      };
      await plugin.cache.cleanupRetainedFiles(plugin.cache.cacheBackupsDir, (fileName) => fileName.startsWith("retention-race-"));
    } finally {
      cleanupFsPort.removeFileIfUnchanged = originalConditionalRemoveForRetention;
    }
    assert(replacementRacePath, "Cache retention race did not reach a selected deletion candidate");
    assert(fs.existsSync(replacementRacePath) && fs.readFileSync(replacementRacePath, "utf8") === "sync-replacement-after-selection", "Cache retention deleted a same-path replacement published after selection and hashing");
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupReplacementRaceTemp, { recursive: true, force: true });
  }

  const cleanupFinalBoundaryTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cleanup-final-boundary-"));
  try {
    setCacheTestFile(path.join(cleanupFinalBoundaryTemp, "tinyLocal-cache.json"), cleanupFinalBoundaryTemp);
    const cleanupFsPort = plugin.getPlatformPorts().fs;
    const candidatePath = "cleanup-final-boundary.bin";
    const candidateAbsolutePath = path.join(cleanupFinalBoundaryTemp, candidatePath);
    const candidateBytes = Buffer.from("cleanup-owned-revision");
    const syncReplacementBytes = Buffer.from("sync-replacement-at-trash-boundary");
    fs.writeFileSync(candidateAbsolutePath, candidateBytes);
    const originalDesktopTrashItem = desktopTrashItem;
    let injectedTrashBoundary = false;
    let retainedTrashPath = null;
    desktopTrashItem = async (filePath) => {
      if (!injectedTrashBoundary && path.basename(String(filePath)).startsWith(`${candidatePath}.delete-`)) {
        injectedTrashBoundary = true;
        fs.writeFileSync(filePath, syncReplacementBytes);
        retainedTrashPath = `${filePath}.mock-local-trash`;
        await fs.promises.rename(filePath, retainedTrashPath);
        return;
      }
      await originalDesktopTrashItem(filePath);
    };
    try {
      const result = await cleanupFsPort.removeFileIfUnchanged(
        candidatePath,
        crypto.createHash("sha256").update(candidateBytes).digest("hex")
      );
      assert(result.removed && result.retainedConflictPath === null, "Desktop conditional cleanup did not logically remove its verified revision");
    } finally {
      desktopTrashItem = originalDesktopTrashItem;
    }
    assert(injectedTrashBoundary && retainedTrashPath, "Desktop cleanup regression did not inject at the final trash boundary");
    assert(fs.existsSync(retainedTrashPath) && fs.readFileSync(retainedTrashPath).equals(syncReplacementBytes), "Desktop cleanup destroyed a Sync replacement published after its final identity/hash check");

    const trashFailureCandidatePath = "cleanup-trash-failure.bin";
    const trashFailureCandidateBytes = Buffer.from("cleanup-trash-failure-owned-revision");
    fs.writeFileSync(path.join(cleanupFinalBoundaryTemp, trashFailureCandidatePath), trashFailureCandidateBytes);
    let trashFailureCalls = 0;
    desktopTrashItem = async (filePath) => {
      if (path.basename(String(filePath)).startsWith(`${trashFailureCandidatePath}.delete-`)) {
        trashFailureCalls += 1;
        throw new Error("simulated unavailable OS trash");
      }
      await originalDesktopTrashItem(filePath);
    };
    let trashFailureResult;
    try {
      trashFailureResult = await cleanupFsPort.removeFileIfUnchanged(
        trashFailureCandidatePath,
        crypto.createHash("sha256").update(trashFailureCandidateBytes).digest("hex")
      );
    } finally {
      desktopTrashItem = originalDesktopTrashItem;
    }
    assert(!trashFailureResult.removed && trashFailureResult.retainedConflictPath, "Desktop cleanup did not report its single retained revision when OS trash failed");
    assert(!fs.existsSync(path.join(cleanupFinalBoundaryTemp, trashFailureCandidatePath)), "Desktop cleanup restored a failed-trash revision to the recovery journal path");
    assert(fs.existsSync(cleanupFsPort.resolvePath(trashFailureResult.retainedConflictPath)), "Desktop cleanup lost the detached revision after OS trash failed");
    const countDesktopTrashFailureCopies = () => fs.readdirSync(cleanupFinalBoundaryTemp, { recursive: true })
      .map(String)
      .filter((filePath) => path.basename(filePath).startsWith(`${trashFailureCandidatePath}.delete-`)).length;
    const retainedDesktopTrashFailureCopies = countDesktopTrashFailureCopies();
    await cleanupFsPort.recoverInterruptedReplacement();
    await cleanupFsPort.recoverInterruptedReplacement();
    assert(trashFailureCalls === 1 && retainedDesktopTrashFailureCopies === 1 && countDesktopTrashFailureCopies() === 1, "Repeated desktop recovery amplified a retained failed-trash revision");

    // Regression: a persistently failing OS trash ("Failed to create
    // FileOperation instance") must not poison deletions when Obsidian's
    // vault-local trash is available — trashLocal is the primary mechanism.
    const localTrashCandidatePath = "cleanup-local-trash.bin";
    const localTrashCandidateBytes = Buffer.from("cleanup-local-trash-owned-revision");
    fs.writeFileSync(path.join(cleanupFinalBoundaryTemp, localTrashCandidatePath), localTrashCandidateBytes);
    const localTrashReceived = [];
    let brokenOsTrashCalls = 0;
    desktopTrashItem = async () => {
      brokenOsTrashCalls += 1;
      throw new Error("Failed to create FileOperation instance");
    };
    const cleanupMockAdapter = plugin.app.vault.adapter;
    cleanupMockAdapter.trashLocal = async (vaultPath) => {
      const trashDir = path.join(cleanupFinalBoundaryTemp, ".trash");
      await fs.promises.mkdir(trashDir, { recursive: true });
      const trashedPath = path.join(trashDir, path.basename(String(vaultPath)));
      await fs.promises.rename(cleanupMockAdapter._resolve(vaultPath), trashedPath);
      localTrashReceived.push(trashedPath);
    };
    let localTrashResult;
    let successfulReplacementVaultTrashGrowth = 0;
    try {
      localTrashResult = await cleanupFsPort.removeFileIfUnchanged(
        localTrashCandidatePath,
        crypto.createHash("sha256").update(localTrashCandidateBytes).digest("hex")
      );
      const repeatedTargetPath = "cache-vault-trash-growth.json";
      let repeatedTargetBytes = Buffer.from("cache-v0");
      fs.writeFileSync(path.join(cleanupFinalBoundaryTemp, repeatedTargetPath), repeatedTargetBytes);
      const trashCountBeforeReplacements = localTrashReceived.length;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const nextBytes = Buffer.from(`cache-v${attempt}`);
        const stagedPath = `.cache-vault-trash-growth.json.tinylocal-${Date.now()}-${attempt.toString(16).repeat(32)}.tmp`;
        fs.writeFileSync(path.join(cleanupFinalBoundaryTemp, stagedPath), nextBytes);
        await cleanupFsPort.replaceFile(stagedPath, repeatedTargetPath, {
          expectedTargetSha256: crypto.createHash("sha256").update(repeatedTargetBytes).digest("hex"),
          expectedStagedSha256: crypto.createHash("sha256").update(nextBytes).digest("hex")
        });
        repeatedTargetBytes = nextBytes;
      }
      successfulReplacementVaultTrashGrowth = localTrashReceived.length - trashCountBeforeReplacements;
    } finally {
      desktopTrashItem = originalDesktopTrashItem;
      delete cleanupMockAdapter.trashLocal;
    }
    assert(localTrashResult.removed && localTrashResult.retainedConflictPath === null, "Desktop cleanup did not remove its revision through vault-local trash while OS trash was unavailable");
    assert(brokenOsTrashCalls === 0, "Desktop cleanup used OS trash although vault-local trash was available");
    assert(!fs.existsSync(path.join(cleanupFinalBoundaryTemp, localTrashCandidatePath)), "Vault-local trash removal left the source file behind");
    const localTrashRevision = localTrashReceived.find((trashedPath) => path.basename(trashedPath).startsWith(`${localTrashCandidatePath}.delete-`));
    assert(localTrashRevision && fs.readFileSync(localTrashRevision).equals(localTrashCandidateBytes), "Vault-local trash did not preserve the detached revision bytes");
    assert.equal(successfulReplacementVaultTrashGrowth, 0, "Successful internal replacements accumulated transaction files in the user-visible Vault trash");

    const lifecycleTargetPath = "lifecycle-final-target.bin";
    const lifecycleStagePath = `.lifecycle-final-target.bin.tinylocal-${Date.now()}-${"a".repeat(32)}.tmp`;
    const lifecycleTargetBytes = Buffer.from("lifecycle-old-target");
    const lifecycleStageBytes = Buffer.from("lifecycle-new-stage");
    fs.writeFileSync(path.join(cleanupFinalBoundaryTemp, lifecycleTargetPath), lifecycleTargetBytes);
    fs.writeFileSync(path.join(cleanupFinalBoundaryTemp, lifecycleStagePath), lifecycleStageBytes);
    let desktopCanCommitCalls = 0;
    await assert.rejects(
      () => cleanupFsPort.replaceFile(lifecycleStagePath, lifecycleTargetPath, {
        expectedTargetSha256: crypto.createHash("sha256").update(lifecycleTargetBytes).digest("hex"),
        expectedStagedSha256: crypto.createHash("sha256").update(lifecycleStageBytes).digest("hex"),
        canCommit: () => ++desktopCanCommitCalls === 1
      }),
      /cancelled before publication/
    );
    assert(desktopCanCommitCalls === 2, "Desktop replacement did not re-check lifecycle ownership at the final publication boundary");
    assert(fs.readFileSync(path.join(cleanupFinalBoundaryTemp, lifecycleTargetPath)).equals(lifecycleTargetBytes), "Desktop final lifecycle fence failed to preserve the old target");
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupFinalBoundaryTemp, { recursive: true, force: true });
  }

  const orphanTempCleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-temp-orphans-"));
  try {
    setCacheTestFile(path.join(orphanTempCleanupDir, "tinyLocal-cache.json"));
    const orphanTempFile = path.join(orphanTempCleanupDir, `.tinyLocal-cache.json.tinylocal-${Date.now() - 6 * 60 * 1000}-${"a".repeat(32)}.tmp`);
    const freshTempFile = path.join(orphanTempCleanupDir, `.tinyLocal-cache.json.tinylocal-${Date.now()}-${"b".repeat(32)}.tmp`);
    const orphanRestoreStage = path.join(orphanTempCleanupDir, `tinyLocal-cache.json.tinylocal-recovery-${Date.now() - 6 * 60 * 1000}-${"c".repeat(32)}.tmp`);
    const freshRestoreStage = path.join(orphanTempCleanupDir, `tinyLocal-cache.json.tinylocal-recovery-${Date.now()}-${"d".repeat(32)}.tmp`);
    const malformedTempFile = path.join(orphanTempCleanupDir, ".tinyLocal-cache-test.tmp");
    const unrelatedTempFile = path.join(orphanTempCleanupDir, ".other.tmp");
    fs.writeFileSync(orphanTempFile, "orphan");
    fs.writeFileSync(freshTempFile, "fresh");
    fs.writeFileSync(orphanRestoreStage, "orphan restore");
    fs.writeFileSync(freshRestoreStage, "fresh restore");
    fs.writeFileSync(malformedTempFile, "malformed");
    fs.writeFileSync(unrelatedTempFile, "keep");
    await plugin.cache.cleanupOrphanedTempFiles();
    assert(!fs.existsSync(orphanTempFile), "cleanupOrphanedTempFiles() left a cache temp orphan");
    assert(fs.existsSync(freshTempFile), "cleanupOrphanedTempFiles() removed a live cache temp file");
    assert(!fs.existsSync(orphanRestoreStage), "cleanupOrphanedTempFiles() left an interrupted restore stage");
    assert(fs.existsSync(freshRestoreStage), "cleanupOrphanedTempFiles() removed a live restore stage");
    assert(fs.existsSync(malformedTempFile), "cleanupOrphanedTempFiles() removed an unowned temp lookalike");
    assert(fs.existsSync(unrelatedTempFile), "cleanupOrphanedTempFiles() removed an unrelated temp file");
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(orphanTempCleanupDir, { recursive: true, force: true });
  }

  const liveTempCleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-temp-live-owner-"));
  const originalCachePortWriteText = plugin.getPlatformPorts().fs.writeText;
  let releaseLiveTempWrite = null;
  try {
    const CacheClass = plugin.cache.constructor;
    const liveTempCacheFile = path.join(liveTempCleanupDir, "tinyLocal-cache.json");
    fs.writeFileSync(liveTempCacheFile, JSON.stringify(plugin.cache.getEmptyCacheData()));
    setCacheTestFile(liveTempCacheFile);
    const cacheWriter = new CacheClass(plugin.app, plugin.getBackupStoragePaths().cacheBackups, plugin.getPlatformPorts());
    const cacheCleaner = new CacheClass(plugin.app, plugin.getBackupStoragePaths().cacheBackups, plugin.getPlatformPorts());
    cacheWriter.cacheFile = plugin.cache.cacheFile;
    cacheCleaner.cacheFile = plugin.cache.cacheFile;
    const originalGetStaleTimestamp = cacheCleaner.getStaleCacheTempTimestamp;
    let liveTempPath = null;
    let markLiveTempWritten = null;
    const liveTempWritten = new Promise((resolve) => {
      markLiveTempWritten = resolve;
    });
    plugin.getPlatformPorts().fs.writeText = async (filePath, data) => {
      await originalCachePortWriteText.call(plugin.getPlatformPorts().fs, filePath, data);
      if (!liveTempPath && String(filePath).endsWith(".tmp") && String(filePath).includes("tinylocal-")) {
        liveTempPath = filePath;
        markLiveTempWritten();
        await new Promise((resolve) => {
          releaseLiveTempWrite = resolve;
        });
      }
    };
    cacheCleaner.getStaleCacheTempTimestamp = (fileName, now) =>
      liveTempPath && fileName === path.basename(liveTempPath)
        ? 1
        : originalGetStaleTimestamp.call(cacheCleaner, fileName, now);
    await withRealGlobalTimers(async () => {
      const writer = cacheWriter.writeCacheFileAtomic(JSON.stringify({
        version: cacheWriter.CACHE_VERSION,
        entries: { live: { path: "Images/live-temp.png", timestamp: 1 } }
      }), () => true, { mergeDiskEntries: false });
      await liveTempWritten;
      const cleanup = cacheCleaner.cleanupOrphanedTempFiles();
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 25));
      assert(liveTempPath && fs.existsSync(resolveCacheTestPath(liveTempPath)), "Cache cleanup removed another live owner's staged write");
      releaseLiveTempWrite();
      assert(await writer, "Live cache writer did not publish after cleanup contention");
      await cleanup;
    });
    cacheCleaner.getStaleCacheTempTimestamp = originalGetStaleTimestamp;
    const liveTempCache = JSON.parse(fs.readFileSync(liveTempCacheFile, "utf8"));
    assert(liveTempCache.entries.live?.path === "Images/live-temp.png", "Cache cleanup contention lost the live writer payload");
  } finally {
    releaseLiveTempWrite?.();
    plugin.getPlatformPorts().fs.writeText = originalCachePortWriteText;
    restoreCacheTestPaths();
    fs.rmSync(liveTempCleanupDir, { recursive: true, force: true });
  }

  const debounceCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-debounce-"));
  const originalDebounceWriteCacheFileAtomic = plugin.cache.writeCacheFileAtomic;
  const originalSaveCacheDelayMs = plugin.cache.saveCacheDelayMs;
  try {
    setCacheTestFile(path.join(debounceCacheTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 10;
    let debouncedWriteCalls = 0;
    let debouncedSavedEntryCount = 0;
    let debouncedSavedPayload = "";
    plugin.cache.writeCacheFileAtomic = async (data) => {
      debouncedWriteCalls += 1;
      debouncedSavedPayload = data;
      debouncedSavedEntryCount = Object.keys(JSON.parse(data).entries || {}).length;
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 5));
      return true;
    };
    await withRealGlobalTimers(() => Promise.all(Array.from({ length: 6 }, (_, index) =>
      plugin.cache.addToCache(
        `Images/cache-debounce-${index}.png`,
        1000 + index,
        createMockFile(`Images/cache-debounce-${index}.png`, 1000 + index, 500 + index),
        null
      )
    )));
    assert(debouncedWriteCalls === 1, `Debounced cache save wrote ${debouncedWriteCalls} times instead of once`);
    assert(debouncedSavedEntryCount === 6, `Debounced cache save persisted ${debouncedSavedEntryCount} entries instead of 6`);
    assert(!debouncedSavedPayload.includes("\n  "), "Debounced cache save still pretty-prints JSON in the hot path");
    assert(plugin.cache.saveCachePromise === null && plugin.cache.saveCacheTimer === null, "Debounced cache save left pending state after flush");
  } finally {
    await plugin.cache.flushPendingCacheSave?.();
    plugin.cache.writeCacheFileAtomic = originalDebounceWriteCacheFileAtomic;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(debounceCacheTemp, { recursive: true, force: true });
  }

  const unloadFlushTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-flush-"));
  const originalCompressorDestroyForUnloadFlush = plugin.compressor.destroy;
  try {
    setCacheTestFile(path.join(unloadFlushTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 10000;
    plugin.compressor.destroy = () => {};
    const unloadFlushFile = createMockFile("Images/unload-flush.png", 100000, 91);
    const unloadFlushPromise = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(unloadFlushFile.path, MOCK_MD5, unloadFlushFile.stat.mtime),
      unloadFlushFile.stat.size,
      unloadFlushFile,
      null
    );
    for (let attempt = 0; attempt < 20 && !plugin.cache.saveCacheTimer; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert(plugin.cache.saveCacheTimer, "Unload flush setup did not create a pending save timer");
    plugin.onunload();
    await unloadFlushPromise;
    plugin.isUnloading = false;
    plugin.cache.acceptingWrites = true;
    await plugin.cache.loadCache();
    const persistedAfterUnload = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    assert(
      Object.values(persistedAfterUnload.entries || {}).some((entry) => entry.path === "Images/unload-flush.png"),
      "onunload() did not flush a pending cache save"
    );
  } finally {
    plugin.compressor.destroy = originalCompressorDestroyForUnloadFlush;
    plugin.isUnloading = false;
    plugin.pluginGuardService = new plugin.pluginGuardService.constructor(plugin);
    plugin.cache.acceptingWrites = true;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    await plugin.cache.flushPendingCacheSave?.();
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadFlushTemp, { recursive: true, force: true });
  }

  const lockedWritesOriginalSaveCache = plugin.cache.saveCache;
  try {
    const lockedEntrySnapshot = {
      keep: {
        path: "Images/write-lock.png",
        timestamp: 1,
        md5: MOCK_MD5,
        mtime: 1,
        sourceMtime: 1,
        sourceSize: 100
      }
    };
    plugin.cache.cacheData = {
      version: plugin.cache.CACHE_VERSION,
      entries: { ...lockedEntrySnapshot }
    };
    let lockedWriteSaveCalls = 0;
    plugin.cache.saveCache = async () => {
      lockedWriteSaveCalls += 1;
      return true;
    };
    plugin.cache.lockWritesForUnload();
    await plugin.cache.renameCacheEntries("Images/write-lock.png", "Images/write-lock-renamed.png");
    await plugin.cache.addSkippedEntry("Images/skipped-after-unload.png", "too_small");
    await plugin.cache.markProcessedFileMoved("Images/write-lock.png", { mtimeMs: 2, size: 50 }, 100);
    await plugin.cache.clearCache();
    const lockedCompactionResult = await plugin.cache.compactCache();
    assert(lockedCompactionResult.removed === 0, "compactCache() removed entries after cache writes were locked");
    assert(
      JSON.stringify(plugin.cache.cacheData.entries) === JSON.stringify(lockedEntrySnapshot),
      "Cache write lock allowed a post-unload mutation"
    );
    assert(lockedWriteSaveCalls === 0, "Cache write lock allowed saveCache() after unload");
  } finally {
    plugin.cache.saveCache = lockedWritesOriginalSaveCache;
    plugin.cache.acceptingWrites = true;
    plugin.cache.cacheData = originalCacheData;
  }

  const unloadHungWriteTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-hung-write-"));
  try {
    setCacheTestFile(path.join(unloadHungWriteTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries.hung = { path: "Images/hung-write.png", timestamp: 1 };
    plugin.cache.activeWritePromise = new Promise(() => {});
    const start = Date.now();
    plugin.cache.flushPendingCacheSaveSync();
    assert(Date.now() - start < 100, "flushPendingCacheSaveSync() blocked on activeWritePromise");
    plugin.cache.activeWritePromise = null;
    await plugin.cache.loadCache();
    const persistedHungWrite = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    assert(persistedHungWrite.entries.hung?.path === "Images/hung-write.png", "flushPendingCacheSaveSync() did not write a snapshot during hung write");
  } finally {
    plugin.cache.activeWritePromise = null;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadHungWriteTemp, { recursive: true, force: true });
  }

  const unloadLateWriteTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-late-write-"));
  const originalWriteCacheFileAtomicForLateWrite = plugin.cache.writeCacheFileAtomic;
  let releaseStaleWrite = null;
  try {
    setCacheTestFile(path.join(unloadLateWriteTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    let staleWriteStarted = null;
    let staleWriteSkipped = false;
    const staleWriteStartedPromise = new Promise((resolve) => {
      staleWriteStarted = resolve;
    });
    plugin.cache.writeCacheFileAtomic = async (data, shouldCommit = () => true) => {
      staleWriteStarted();
      await new Promise((resolve) => {
        releaseStaleWrite = resolve;
      });
      if (!shouldCommit()) {
        staleWriteSkipped = true;
        return false;
      }
      const cacheFile = resolveCacheTestPath(plugin.cache.cacheFile);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, data);
      return true;
    };
    const staleWrite = plugin.cache.queueCacheWrite(JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: { stale: { path: "Images/stale-write.png" } }
    }, null, 2));
    await staleWriteStartedPromise;
    plugin.cache.cacheData.entries.fresh = { path: "Images/fresh-unload.png" };
    plugin.cache.flushPendingCacheSaveSync();
    releaseStaleWrite();
    await staleWrite;
    plugin.cache.activeWritePromise = null;
    plugin.cache.writeCacheFileAtomic = originalWriteCacheFileAtomicForLateWrite;
    await plugin.cache.loadCache();
    const persistedLateWrite = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    assert(staleWriteSkipped, "Late active cache write was not skipped after sync unload flush");
    assert(persistedLateWrite.entries.fresh?.path === "Images/fresh-unload.png" && !persistedLateWrite.entries.stale, "Late active cache write overwrote sync unload snapshot");
  } finally {
    releaseStaleWrite?.();
    plugin.cache.activeWritePromise = null;
    plugin.cache.writeCacheFileAtomic = originalWriteCacheFileAtomicForLateWrite;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadLateWriteTemp, { recursive: true, force: true });
  }

  const unloadReplayTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-replay-"));
  const originalGetInFlightReplacementRevisions = plugin.getPlatformPorts().fs.getInFlightReplacementRevisions;
  try {
    setCacheTestFile(path.join(unloadReplayTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries.fresh = { path: "Images/replayed-fresh.png" };
    plugin.cache.pendingSaveMergeDiskEntries = false;
    plugin.cache.pendingSaveAuthoritative = true;
    const lateReplacementPayload = JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: { stale: { path: "Images/replayed-stale.png" } }
    });
    const lateReplacementRevision = crypto.createHash("sha256").update(lateReplacementPayload).digest("hex");
    plugin.getPlatformPorts().fs.getInFlightReplacementRevisions = () => [null, lateReplacementRevision];
    let finishActiveRename = null;
    const activeRenamePromise = new Promise((resolve) => {
      finishActiveRename = () => {
        const cacheFile = resolveCacheTestPath(plugin.cache.cacheFile);
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, lateReplacementPayload);
        resolve();
      };
    });
    plugin.cache.activeWritePromise = activeRenamePromise;
    plugin.cache.flushPendingCacheSaveSync();
    assert(fs.readdirSync(unloadReplayTemp).some((name) => name.startsWith(".tinyLocal-cache-pending-")), "Sync unload flush did not publish a durable replay journal");
    finishActiveRename();
    await activeRenamePromise;
    plugin.cache.activeWritePromise = null;
    await plugin.cache.loadCache();
    const persistedReplay = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    assert(persistedReplay.entries.fresh?.path === "Images/replayed-fresh.png" && !persistedReplay.entries.stale, "Sync unload journal did not accept the tracked late replacement revision");
  } finally {
    plugin.cache.activeWritePromise = null;
    plugin.getPlatformPorts().fs.getInFlightReplacementRevisions = originalGetInFlightReplacementRevisions;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadReplayTemp, { recursive: true, force: true });
  }

  const clearRaceTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-clear-race-"));
  try {
    setCacheTestFile(path.join(clearRaceTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 10000;
    const clearRaceFile = createMockFile("Images/clear-race.png", 100000, 92);
    const pendingAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(clearRaceFile.path, MOCK_MD5, clearRaceFile.stat.mtime),
      clearRaceFile.stat.size,
      clearRaceFile,
      null
    );
    for (let attempt = 0; attempt < 20 && !plugin.cache.saveCacheTimer; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert(plugin.cache.saveCacheTimer, "clearCache race setup did not create a pending save timer");
    plugin.cache.saveCacheDelayMs = 0;
    await withRealGlobalTimers(() => plugin.cache.clearCache());
    await Promise.race([
      pendingAdd,
      new Promise((_, reject) => originalGlobals.setTimeout(() => reject(new Error("pending addToCache did not settle after clearCache()")), 250))
    ]);
    const persistedAfterClear = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    assert(Object.keys(persistedAfterClear.entries || {}).length === 0, "clearCache() allowed a canceled pending save to repopulate the cache");
  } finally {
    plugin.cache.cancelPendingSave?.();
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    await plugin.cache.flushPendingCacheSave?.();
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(clearRaceTemp, { recursive: true, force: true });
  }

  const restoreRaceTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-race-"));
  const originalSetSaveCacheTimeout = plugin.cache.setSaveCacheTimeout;
  const originalClearSaveCacheTimeout = plugin.cache.clearSaveCacheTimeout;
  try {
    const restoreRaceCacheFile = path.join(restoreRaceTemp, "tinyLocal-cache.json");
    const restoreRaceBackupDir = path.join(restoreRaceTemp, "cache-backups");
    const restoreRaceBackupName = "tinyLocal-cache-backup-2026-05-16T00-00-00-000.json";
    fs.mkdirSync(restoreRaceBackupDir, { recursive: true });
    fs.writeFileSync(restoreRaceCacheFile, JSON.stringify({ version: plugin.cache.CACHE_VERSION, entries: {} }, null, 2));
    fs.writeFileSync(path.join(restoreRaceBackupDir, restoreRaceBackupName), JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        restored: {
          path: "Images/restored-race.png",
          timestamp: 5678,
          originalSize: 1234
        }
      }
    }, null, 2));
    let capturedRestoreTimerCallback = null;
    let restoreTimerCleared = false;
    plugin.cache.setSaveCacheTimeout = (callback, delay) => {
      capturedRestoreTimerCallback = callback;
      return { delay, cleared: false };
    };
    plugin.cache.clearSaveCacheTimeout = (timer) => {
      if (timer) timer.cleared = true;
      restoreTimerCleared = true;
    };
    setCacheTestFile(restoreRaceCacheFile);
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const staleRestoreFile = createMockFile("Images/stale-before-restore.png", 100000, 93);
    const pendingRestoreAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(staleRestoreFile.path, MOCK_MD5, staleRestoreFile.stat.mtime),
      staleRestoreFile.stat.size,
      staleRestoreFile,
      null
    );
    for (let attempt = 0; attempt < 20 && !capturedRestoreTimerCallback; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert(capturedRestoreTimerCallback, "restoreFromBackup race setup did not capture a pending save timer");
    const restoredRace = await plugin.cache.restoreFromBackup(restoreRaceBackupName);
    assert(restoredRace, "restoreFromBackup() did not restore while a save was pending");
    assert(restoreTimerCleared, "restoreFromBackup() did not clear the pending save timer");
    await pendingRestoreAdd;
    await capturedRestoreTimerCallback();
    await Promise.resolve();
    const persistedAfterRestoreRace = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    const restoreRacePaths = Object.values(persistedAfterRestoreRace.entries || {}).map((entry) => entry.path).sort();
    assert(
      JSON.stringify(restoreRacePaths) === JSON.stringify(["Images/restored-race.png"]),
      `A stale pending save overwrote restoreFromBackup(): ${restoreRacePaths.join(", ")}`
    );
  } finally {
    plugin.cache.setSaveCacheTimeout = originalSetSaveCacheTimeout;
    plugin.cache.clearSaveCacheTimeout = originalClearSaveCacheTimeout;
    plugin.cache.cancelPendingSave?.();
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreRaceTemp, { recursive: true, force: true });
  }

  const restoreTraversalTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-traversal-"));
  try {
    setCacheTestFile(path.join(restoreTraversalTemp, "tinyLocal-cache.json"));
    fs.mkdirSync(path.join(restoreTraversalTemp, "cache-backups"), { recursive: true });
    fs.writeFileSync(resolveCacheTestPath(plugin.cache.cacheFile), JSON.stringify(plugin.cache.getEmptyCacheData(), null, 2));
    const traversalRestored = await plugin.cache.restoreFromBackup("../tinyLocal-cache-backup-2026-05-16T00-00-00-000.json");
    const nestedRestored = await plugin.cache.restoreFromBackup("nested/tinyLocal-cache-backup-2026-05-16T00-00-00-000.json");
    assert(traversalRestored === false && nestedRestored === false, "restoreFromBackup() accepted a path traversal backup filename");
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreTraversalTemp, { recursive: true, force: true });
  }

  const restoreRealpathTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-realpath-"));
  const originalRestoreRealpath = fs.promises.realpath;
  const originalConsoleErrorForRestoreRealpath = console.error;
  try {
    setCacheTestFile(path.join(restoreRealpathTemp, "tinyLocal-cache.json"));
    const restoreRealpathBackupDir = path.join(restoreRealpathTemp, "cache-backups");
    const restoreRealpathBackupName = "tinyLocal-cache-backup-2026-05-16T00-00-00-deadbeef.json";
    const restoreRealpathBackupPath = path.join(restoreRealpathBackupDir, restoreRealpathBackupName);
    fs.mkdirSync(restoreRealpathBackupDir, { recursive: true });
    fs.writeFileSync(resolveCacheTestPath(plugin.cache.cacheFile), JSON.stringify(plugin.cache.getEmptyCacheData(), null, 2));
    fs.writeFileSync(restoreRealpathBackupPath, JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        "Images/realpath-escaped.png": {
          path: "Images/realpath-escaped.png",
          timestamp: 1
        }
      }
    }, null, 2));
    console.error = () => {};
    fs.promises.realpath = async (target) => {
      if (path.resolve(String(target)) === path.resolve(restoreRealpathBackupPath)) {
        return path.join(os.tmpdir(), "local-image-compress-outside-backup.json");
      }
      return originalRestoreRealpath.call(fs.promises, target);
    };
    const realpathRestored = await plugin.cache.restoreFromBackup(restoreRealpathBackupName);
    assert(realpathRestored === false, "restoreFromBackup() accepted a backup whose real path escapes cache-backups");
    const realpathCache = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    assert(!realpathCache.entries["Images/realpath-escaped.png"], "restoreFromBackup() copied an escaped realpath backup");
  } finally {
    console.error = originalConsoleErrorForRestoreRealpath;
    fs.promises.realpath = originalRestoreRealpath;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreRealpathTemp, { recursive: true, force: true });
  }

  const restoreSymlinkTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-symlink-"));
  const originalLstatForRestoreSymlink = fs.promises.lstat;
  const originalConsoleErrorForRestoreSymlink = console.error;
  try {
    setCacheTestFile(path.join(restoreSymlinkTemp, "tinyLocal-cache.json"));
    const restoreSymlinkBackupDir = path.join(restoreSymlinkTemp, "cache-backups");
    const restoreSymlinkBackupName = "tinyLocal-cache-backup-2026-05-16T00-00-00-deadbeef.json";
    const restoreSymlinkBackupPath = path.join(restoreSymlinkBackupDir, restoreSymlinkBackupName);
    fs.mkdirSync(restoreSymlinkBackupDir, { recursive: true });
    fs.writeFileSync(resolveCacheTestPath(plugin.cache.cacheFile), JSON.stringify(plugin.cache.getEmptyCacheData()));
    fs.writeFileSync(restoreSymlinkBackupPath, JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        "Images/symlink-escaped.png": {
          path: "Images/symlink-escaped.png",
          timestamp: 1
        }
      }
    }));
    console.error = () => {};
    fs.promises.lstat = async (target) => {
      const stats = await originalLstatForRestoreSymlink.call(fs.promises, target);
      if (path.resolve(String(target)) === path.resolve(restoreSymlinkBackupPath)) {
        return {
          ...stats,
          isFile: () => false,
          isSymbolicLink: () => true
        };
      }
      return stats;
    };
    const symlinkRestored = await plugin.cache.restoreFromBackup(restoreSymlinkBackupName);
    assert(symlinkRestored === false, "restoreFromBackup() accepted a symlink-like backup file");
    const symlinkCache = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    assert(!symlinkCache.entries["Images/symlink-escaped.png"], "restoreFromBackup() copied a symlink-like backup");
  } finally {
    console.error = originalConsoleErrorForRestoreSymlink;
    fs.promises.lstat = originalLstatForRestoreSymlink;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreSymlinkTemp, { recursive: true, force: true });
  }

  const writeSerializeTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-write-serialize-"));
  const originalSetSaveCacheTimeoutForSerialize = plugin.cache.setSaveCacheTimeout;
  const originalClearSaveCacheTimeoutForSerialize = plugin.cache.clearSaveCacheTimeout;
  let releaseFirstWrite = null;
  try {
    setCacheTestFile(path.join(writeSerializeTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 0;
    plugin.cache.setSaveCacheTimeout = (callback, delay) => originalGlobals.setTimeout(callback, delay);
    plugin.cache.clearSaveCacheTimeout = (timer) => originalGlobals.clearTimeout(timer);
    let inFlightWrites = 0;
    let maxInFlightWrites = 0;
    let writeCalls = 0;
    let firstWriteStarted = null;
    const firstWriteStartedPromise = new Promise((resolve) => {
      firstWriteStarted = resolve;
    });
    plugin.cache.writeCacheFileAtomic = async (data) => {
      writeCalls += 1;
      inFlightWrites += 1;
      maxInFlightWrites = Math.max(maxInFlightWrites, inFlightWrites);
      if (writeCalls === 1) {
        firstWriteStarted();
        await new Promise((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      const committed = await originalDebounceWriteCacheFileAtomic.call(plugin.cache, data);
      inFlightWrites -= 1;
      return committed;
    };
    const firstSerializeFile = createMockFile("Images/write-serialize-a.png", 100000, 94);
    const secondSerializeFile = createMockFile("Images/write-serialize-b.png", 100000, 95);
    const firstSerializeAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(firstSerializeFile.path, MOCK_MD5, firstSerializeFile.stat.mtime),
      firstSerializeFile.stat.size,
      firstSerializeFile,
      null
    );
    await firstWriteStartedPromise;
    const secondSerializeAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(secondSerializeFile.path, MOCK_MD5_ALT, secondSerializeFile.stat.mtime),
      secondSerializeFile.stat.size,
      secondSerializeFile,
      null
    );
    await new Promise((resolve) => originalGlobals.setTimeout(resolve, 5));
    assert(writeCalls === 1, `A second cache write started before the first completed: ${writeCalls}`);
    releaseFirstWrite();
    await Promise.all([firstSerializeAdd, secondSerializeAdd]);
    assert(maxInFlightWrites === 1, `Cache writes overlapped: max in flight ${maxInFlightWrites}`);
    assert(writeCalls === 2, `Serialized cache write test expected two writes, got ${writeCalls}`);
    const persistedAfterSerializedWrites = JSON.parse(fs.readFileSync(resolveCacheTestPath(plugin.cache.cacheFile), "utf8"));
    const serializedPaths = Object.values(persistedAfterSerializedWrites.entries || {}).map((entry) => entry.path).sort();
    assert(
      JSON.stringify(serializedPaths) === JSON.stringify(["Images/write-serialize-a.png", "Images/write-serialize-b.png"]),
      `Serialized cache writes did not persist both entries: ${serializedPaths.join(", ")}`
    );
  } finally {
    releaseFirstWrite?.();
    await plugin.cache.flushPendingCacheSave?.();
    plugin.cache.writeCacheFileAtomic = originalDebounceWriteCacheFileAtomic;
    plugin.cache.setSaveCacheTimeout = originalSetSaveCacheTimeoutForSerialize;
    plugin.cache.clearSaveCacheTimeout = originalClearSaveCacheTimeoutForSerialize;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(writeSerializeTemp, { recursive: true, force: true });
  }

  const queueContentionTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-queue-contention-"));
  const originalConsoleErrorForQueue = console.error;
  try {
    setCacheTestFile(path.join(queueContentionTemp, "tinyLocal-cache.json"));
    const writeOrder = [];
    plugin.cache.writeCacheFileAtomic = async (data) => {
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 2));
      writeOrder.push(JSON.parse(data).order);
      return true;
    };
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      plugin.cache.queueCacheWrite(JSON.stringify({ order: index }))
    ));
    assert(JSON.stringify(writeOrder) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), `queueCacheWrite changed write order under contention: ${writeOrder.join(",")}`);

    let queueWriteCalls = 0;
    let queueErrorsLogged = 0;
    console.error = () => {
      queueErrorsLogged += 1;
    };
    plugin.cache.writeCacheFileAtomic = async () => {
      queueWriteCalls += 1;
      if (queueWriteCalls === 2) {
        throw new Error("simulated cache write failure");
      }
      return true;
    };
    await Promise.all([
      plugin.cache.queueCacheWrite('{"a":1}'),
      plugin.cache.queueCacheWrite('{"a":2}'),
      plugin.cache.queueCacheWrite('{"a":3}')
    ]);
    assert(queueWriteCalls === 3, `queueCacheWrite stopped after a failed write: ${queueWriteCalls}`);
    assert(queueErrorsLogged === 1, `queueCacheWrite logged wrong error count: ${queueErrorsLogged}`);
  } finally {
    console.error = originalConsoleErrorForQueue;
    await plugin.cache.flushPendingCacheSave?.();
    plugin.cache.writeCacheFileAtomic = originalDebounceWriteCacheFileAtomic;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(queueContentionTemp, { recursive: true, force: true });
  }

  const renameRetryTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-rename-retry-"));
  try {
    const retryCacheFile = path.join(renameRetryTemp, "tinyLocal-cache.json");
    setCacheTestFile(retryCacheFile);
    const originalLink = fs.promises.link;
    let renameAttempts = 0;
    try {
      fs.promises.link = async (sourcePath, targetPath) => {
        if (targetPath === retryCacheFile) {
          renameAttempts += 1;
          if (renameAttempts <= 2) {
            const error = new Error("simulated transient Windows cache rename failure");
            error.code = renameAttempts === 1 ? "EPERM" : "EBUSY";
            throw error;
          }
        }
        return originalLink.call(fs.promises, sourcePath, targetPath);
      };
      await withRealGlobalTimers(() => plugin.cache.writeCacheFileAtomic(JSON.stringify({
        version: plugin.cache.CACHE_VERSION,
        entries: {
          retry: { path: "Images/retry.png", timestamp: 1 }
        }
      }), () => true, { mergeDiskEntries: false }));
    } finally {
      fs.promises.link = originalLink;
    }
    assert(renameAttempts === 3, `Async cache rename retry used wrong attempt count: ${renameAttempts}`);
    const persistedRetryCache = JSON.parse(fs.readFileSync(retryCacheFile, "utf8"));
    assert(persistedRetryCache.entries.retry?.path === "Images/retry.png", "Async cache rename retry did not persist the cache file");

    const tempLeftovers = fs.readdirSync(renameRetryTemp).filter((name) => name.startsWith(".tinyLocal-cache-") && name.endsWith(".tmp"));
    assert(tempLeftovers.length === 0, `Cache rename retry left temp files: ${tempLeftovers.join(", ")}`);
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(renameRetryTemp, { recursive: true, force: true });
  }

  const multiInstanceCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-multi-instance-"));
  try {
    const CacheClass = plugin.cache.constructor;
    const cacheFile = path.join(multiInstanceCacheTemp, "tinyLocal-cache.json");
    setCacheTestFile(cacheFile);
    const cacheA = new CacheClass(plugin.app, plugin.getBackupStoragePaths().cacheBackups, plugin.getPlatformPorts());
    const cacheB = new CacheClass(plugin.app, plugin.getBackupStoragePaths().cacheBackups, plugin.getPlatformPorts());
    cacheA.cacheFile = plugin.cache.cacheFile;
    cacheB.cacheFile = plugin.cache.cacheFile;
    await withRealGlobalTimers(() => Promise.all([
      cacheA.queueCacheWrite(JSON.stringify({
        version: cacheA.CACHE_VERSION,
        entries: {
          fromA: { path: "Images/from-a.png", timestamp: 1 }
        }
      }), { mergeDiskEntries: true }),
      cacheB.queueCacheWrite(JSON.stringify({
        version: cacheB.CACHE_VERSION,
        entries: {
          fromB: { path: "Images/from-b.png", timestamp: 2 }
        }
      }), { mergeDiskEntries: true })
    ]));
    const mergedCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert(mergedCache.entries.fromA?.path === "Images/from-a.png", "Multi-instance cache write lost instance A entry");
    assert(mergedCache.entries.fromB?.path === "Images/from-b.png", "Multi-instance cache write lost instance B entry");
    const releasedLockPath = fs.readdirSync(multiInstanceCacheTemp)
      .map((name) => path.join(multiInstanceCacheTemp, name))
      .find((filePath) => /^tinyLocal-cache\.json\.lock\.device-[a-f0-9]{32}$/i.test(path.basename(filePath)));
    assert(releasedLockPath, "Multi-instance cache write did not publish a device-scoped lease");
    const releasedLockPayload = JSON.parse(fs.readFileSync(releasedLockPath, "utf8"));
    assert(fs.existsSync(resolveCacheTestPath(`${releasedLockPayload.ownerPath}.released`)), "Multi-instance cache write did not mark its exact lock inode as released");
    await withRealGlobalTimers(() => cacheA.queueCacheWrite(JSON.stringify({
      version: cacheA.CACHE_VERSION,
      entries: {
        fromC: { path: "Images/from-c.png", timestamp: 3 }
      }
    }), { mergeDiskEntries: true }));
    const staleLockRecoveredCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert(staleLockRecoveredCache.entries.fromC?.path === "Images/from-c.png", "Released cache lock did not recover for a later writer");

    const sharedStateKey = "Images/shared-state.jpg:hash:10";
    fs.writeFileSync(cacheFile, JSON.stringify({
      version: cacheA.CACHE_VERSION,
      entries: {
        [sharedStateKey]: {
          path: "Images/shared-state.jpg",
          state: "pending_move",
          timestamp: 200,
          stateUpdatedAt: 200,
          lastAccessMs: 200,
          mutationRevision: { counter: 2, ownerId: "disk-owner" }
        }
      }
    }));
    await withRealGlobalTimers(() => cacheA.queueCacheWrite(JSON.stringify({
      version: cacheA.CACHE_VERSION,
      entries: {
        [sharedStateKey]: {
          path: "Images/shared-state.jpg",
          state: "skipped",
          timestamp: 200,
          stateUpdatedAt: 200,
          lastAccessMs: 300,
          mutationRevision: { counter: 1, ownerId: "stale-owner" }
        }
      }
    }), { mergeDiskEntries: true }));
    const mergedAccessState = JSON.parse(fs.readFileSync(cacheFile, "utf8")).entries[sharedStateKey];
    assert(mergedAccessState?.state === "pending_move", "A stale access snapshot replaced a newer cache state");
    assert(mergedAccessState?.lastAccessMs === 300, "Cache merge did not advance access recency independently of state mutation order");

    await withRealGlobalTimers(() => cacheA.queueCacheWrite(JSON.stringify({
      version: cacheA.CACHE_VERSION,
      entries: {},
      tombstones: {
        [sharedStateKey]: { counter: 3, ownerId: "delete-owner" }
      }
    }), { mergeDiskEntries: false }));
    const authoritativeEmptyCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert(Object.keys(authoritativeEmptyCache.entries || {}).length === 0, "Authoritative cache write merged deleted entries back from disk");
    await withRealGlobalTimers(() => cacheB.queueCacheWrite(JSON.stringify({
      version: cacheB.CACHE_VERSION,
      entries: {
        [sharedStateKey]: {
          path: "Images/shared-state.jpg",
          state: "skipped",
          timestamp: 200,
          stateUpdatedAt: 200,
          lastAccessMs: 400,
          mutationRevision: { counter: 2, ownerId: "stale-owner" }
        }
      }
    }), { mergeDiskEntries: true }));
    const cacheAfterStaleAccessFlush = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert(!cacheAfterStaleAccessFlush.entries[sharedStateKey], "A stale cache snapshot crossed a newer logical tombstone");
    assert(cacheAfterStaleAccessFlush.tombstones?.[sharedStateKey]?.counter === 3, "Cache merge lost the logical deletion tombstone");

    const durableConflictKey = cacheA.buildCacheKey("Images/durable-move-conflict.jpg", MOCK_MD5, 10);
    const localPendingEntry = {
      path: "Images/durable-move-conflict.jpg",
      state: "pending_move",
      timestamp: 500,
      stateUpdatedAt: 500,
      lastAccessMs: 500,
      md5: MOCK_MD5,
      mtime: 10,
      sourceMtime: 10,
      sourceSize: 100,
      outputPath: "Compressed/Images/durable-move-conflict.jpg",
      outputMtime: 10,
      outputSize: 50,
      mutationRevision: { counter: 1, ownerId: cacheA.cacheLockOwnerId }
    };
    cacheA.cacheData = {
      version: cacheA.CACHE_VERSION,
      entries: { [durableConflictKey]: localPendingEntry },
      tombstones: {}
    };
    fs.writeFileSync(cacheFile, JSON.stringify({
      version: cacheA.CACHE_VERSION,
      entries: {
        [durableConflictKey]: {
          ...localPendingEntry,
          timestamp: 600,
          stateUpdatedAt: 600,
          mutationRevision: { counter: 3, ownerId: "concurrent-owner" }
        }
      },
      tombstones: {}
    }));
    const originalConflictSleep = cacheA.sleepForCacheLock;
    cacheA.sleepForCacheLock = async () => {};
    let durableConflictCommitted;
    try {
      durableConflictCommitted = await withRealGlobalTimers(() => cacheA.markProcessedFileMoved(
        "Images/durable-move-conflict.jpg",
        { mtimeMs: 20, size: 50 },
        100,
        "Compressed/Images/durable-move-conflict.jpg"
      ));
    } finally {
      cacheA.sleepForCacheLock = originalConflictSleep;
    }
    assert(durableConflictCommitted === false, "Moved transition acknowledged a cache merge won by a concurrent logical revision");
    const durableConflictDiskEntry = JSON.parse(fs.readFileSync(cacheFile, "utf8")).entries[durableConflictKey];
    assert(durableConflictDiskEntry?.state === "pending_move" && durableConflictDiskEntry.mutationRevision?.counter === 3, "Failed moved transition overwrote the concurrent durable cache state");
    assert(cacheA.cacheData.entries[durableConflictKey]?.state === "pending_move", "Failed moved transition did not roll local state back to pending_move");
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(multiInstanceCacheTemp, { recursive: true, force: true });
  }

  const leaseBoundaryTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-lease-boundaries-"));
  const originalLeaseBoundaryBasePath = plugin.app.vault.adapter.basePath;
  const originalLeaseBoundaryAbsolutePath = plugin.app.vault.adapter.path.absolute;
  try {
    plugin.app.vault.adapter.basePath = leaseBoundaryTemp;
    plugin.app.vault.adapter.path.absolute = leaseBoundaryTemp;
    const leasePort = plugin.getPlatformPorts().fs.lease;
    assert(leasePort, "Desktop cache lease port is unavailable");
    const isScopedCanonicalLeasePath = (candidatePath, logicalPath) => {
      const normalizedCandidate = path.resolve(String(candidatePath));
      const normalizedLogical = path.resolve(leaseBoundaryTemp, String(logicalPath)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${normalizedLogical}\\.device-[a-f0-9]{32}$`, "i").test(normalizedCandidate);
    };

    const publicationLock = "publication.lock";
    const originalLinkForPublication = fs.promises.link;
    let publicationLinkStarted = null;
    let releasePublicationLink = null;
    const publicationLinkStartedPromise = new Promise((resolve) => {
      publicationLinkStarted = resolve;
    });
    try {
      let pausedPublication = false;
      fs.promises.link = async (sourcePath, targetPath) => {
        if (!pausedPublication && isScopedCanonicalLeasePath(targetPath, publicationLock)) {
          pausedPublication = true;
          publicationLinkStarted();
          await new Promise((resolve) => {
            releasePublicationLink = resolve;
          });
        }
        return await originalLinkForPublication.call(fs.promises, sourcePath, targetPath);
      };
      await withRealGlobalTimers(async () => {
        const firstAcquire = leasePort.acquire(publicationLock, "publication-a", 250, 5);
        await publicationLinkStartedPromise;
        const secondLease = await leasePort.acquire(publicationLock, "publication-b", 250, 5);
        assert(secondLease, "Complete-owner publication did not allow exactly one contender to claim the empty lock path");
        releasePublicationLink();
        const firstLease = await firstAcquire;
        assert(!firstLease && await leasePort.validate(secondLease), "Paused cache lease publication produced two owners or an invalid winner");
        await leasePort.release(secondLease);
      });
    } finally {
      releasePublicationLink?.();
      fs.promises.link = originalLinkForPublication;
    }

    const takeoverLock = "takeover.lock";
    const releasedTakeoverLease = await leasePort.acquire(takeoverLock, "takeover-old", 250, 5);
    assert(releasedTakeoverLease && await leasePort.release(releasedTakeoverLease), "Takeover fixture did not publish a released owner marker");
    const originalRenameForTakeover = fs.promises.rename;
    let takeoverRenameStarted = null;
    let releaseTakeoverRename = null;
    const takeoverRenameStartedPromise = new Promise((resolve) => {
      takeoverRenameStarted = resolve;
    });
    try {
      let takeoverRenameCalls = 0;
      fs.promises.rename = async (sourcePath, targetPath) => {
        if (isScopedCanonicalLeasePath(sourcePath, takeoverLock)) {
          takeoverRenameCalls += 1;
          if (takeoverRenameCalls === 1) {
            takeoverRenameStarted();
            await new Promise((resolve) => {
              releaseTakeoverRename = resolve;
            });
          }
        }
        return await originalRenameForTakeover.call(fs.promises, sourcePath, targetPath);
      };
      await withRealGlobalTimers(async () => {
        const contenderA = leasePort.acquire(takeoverLock, "takeover-a", 350, 5);
        await takeoverRenameStartedPromise;
        const contenderB = leasePort.acquire(takeoverLock, "takeover-b", 350, 5);
        await new Promise((resolve) => originalGlobals.setTimeout(resolve, 25));
        assert(takeoverRenameCalls === 1, "Concurrent reclaimers reached the canonical cache lock at the same time");
        releaseTakeoverRename();
        const contenders = await Promise.all([contenderA, contenderB]);
        const winners = contenders.filter(Boolean);
        assert(winners.length === 1 && await leasePort.validate(winners[0]), "Released-lock takeover did not preserve single-owner mutual exclusion");
        await leasePort.release(winners[0]);
      });
      const reclaimLeftovers = fs.readdirSync(leaseBoundaryTemp).filter((name) => name.startsWith("takeover.lock.reclaim-"));
      assert(reclaimLeftovers.length === 0, `Cache lease takeover left reclaim artifacts: ${reclaimLeftovers.join(", ")}`);
    } finally {
      releaseTakeoverRename?.();
      fs.promises.rename = originalRenameForTakeover;
    }

    const releaseLock = "release.lock";
    const releasingLease = await leasePort.acquire(releaseLock, "release-old", 250, 5);
    assert(releasingLease, "Release boundary fixture did not acquire its initial lease");
    const originalLinkForRelease = fs.promises.link;
    let releaseMarkerStarted = null;
    let publishReleaseMarker = null;
    const releaseMarkerStartedPromise = new Promise((resolve) => {
      releaseMarkerStarted = resolve;
    });
    try {
      fs.promises.link = async (sourcePath, targetPath) => {
        if (path.resolve(String(targetPath)) === path.resolve(leaseBoundaryTemp, `${releasingLease.ownerPath}.released`)) {
          releaseMarkerStarted();
          await new Promise((resolve) => {
            publishReleaseMarker = resolve;
          });
        }
        return await originalLinkForRelease.call(fs.promises, sourcePath, targetPath);
      };
      await withRealGlobalTimers(async () => {
        const pendingRelease = leasePort.release(releasingLease);
        await releaseMarkerStartedPromise;
        const prematureLease = await leasePort.acquire(releaseLock, "release-premature", 50, 5);
        assert(!prematureLease, "A contender stole a live cache lease while release publication was paused");
        const canonicalPayload = JSON.parse(fs.readFileSync(path.join(leaseBoundaryTemp, releasingLease.lockPath), "utf8"));
        assert(canonicalPayload.leaseId === releasingLease.leaseId, "Paused release removed or replaced another owner's canonical lock");
        publishReleaseMarker();
        assert(await pendingRelease, "Cache lease release marker did not bind to its exact owner inode");
        const successorLease = await leasePort.acquire(releaseLock, "release-successor", 250, 5);
        assert(successorLease && await leasePort.validate(successorLease), "A released cache lease could not be taken over by its successor");
        await leasePort.release(successorLease);
      });
    } finally {
      publishReleaseMarker?.();
      fs.promises.link = originalLinkForRelease;
    }
  } finally {
    plugin.app.vault.adapter.basePath = originalLeaseBoundaryBasePath;
    plugin.app.vault.adapter.path.absolute = originalLeaseBoundaryAbsolutePath;
    fs.rmSync(leaseBoundaryTemp, { recursive: true, force: true });
  }

  const leaseOwnerRotationTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-lease-owner-rotation-"));
  const deviceOwnerStorageKey = "local-image-compress:desktop-device-owner-v1";
  const previousDeviceOwner = mockLocalStorage.get(deviceOwnerStorageKey);
  try {
    const ownerA = "a".repeat(32);
    const ownerB = "b".repeat(32);
    const logicalRotationLock = "rotation.lock";
    const leaseApp = { vault: { adapter: { getBasePath: () => leaseOwnerRotationTemp } } };
    mockLocalStorage.set(deviceOwnerStorageKey, ownerA);
    const ownerAModule = compileTsModuleForTest("platform/desktop.ts");
    const ownerAPort = ownerAModule.createDesktopPorts(leaseApp).fs.lease;
    const releasedOwnerALease = await withRealGlobalTimers(() => ownerAPort.acquire(logicalRotationLock, "owner-a", 250, 5));
    assert(releasedOwnerALease && await ownerAPort.release(releasedOwnerALease), "Owner-rotation fixture did not publish owner A's released lease");
    const ownerACanonicalPath = path.join(leaseOwnerRotationTemp, `${logicalRotationLock}.device-${ownerA}`);
    assert(fs.existsSync(ownerACanonicalPath), "Owner A's released device-scoped lease was not retained");

    const legacyUnscopedLockPath = path.join(leaseOwnerRotationTemp, logicalRotationLock);
    fs.writeFileSync(legacyUnscopedLockPath, "legacy-or-synced-lock");
    mockLocalStorage.set(deviceOwnerStorageKey, ownerB);
    const ownerBModule = compileTsModuleForTest("platform/desktop.ts");
    const ownerBPort = ownerBModule.createDesktopPorts(leaseApp).fs.lease;
    const ownerBLiveLease = await withRealGlobalTimers(() => ownerBPort.acquire(logicalRotationLock, "owner-b-live", 250, 5));
    assert(ownerBLiveLease && await ownerBPort.validate(ownerBLiveLease), "Rotated owner B could not progress beside owner A's released or legacy unscoped lease");
    assert(fs.readFileSync(legacyUnscopedLockPath, "utf8") === "legacy-or-synced-lock" && fs.existsSync(ownerACanonicalPath), "Owner rotation mutated a foreign or legacy lease namespace");

    const ownerBContenderModule = compileTsModuleForTest("platform/desktop.ts");
    const ownerBContenderPort = ownerBContenderModule.createDesktopPorts(leaseApp).fs.lease;
    const blockedForeignLiveLease = await withRealGlobalTimers(() => ownerBContenderPort.acquire(logicalRotationLock, "owner-b-contender", 60, 5));
    assert(!blockedForeignLiveLease, "A same-device contender reclaimed a foreign live lease");
    const blockedForeignLiveSyncLease = ownerBContenderPort.acquireSync(logicalRotationLock, "owner-b-sync-contender", 25, 2);
    assert(!blockedForeignLiveSyncLease, "The sync lease facet reclaimed a foreign live lease");
    assert(await ownerBPort.release(ownerBLiveLease), "Owner B live lease did not publish its released marker");
    const ownerBSyncSuccessor = ownerBContenderPort.acquireSync(logicalRotationLock, "owner-b-sync-successor", 250, 2);
    assert(ownerBSyncSuccessor && ownerBContenderPort.validateSync(ownerBSyncSuccessor), "Sync lease facet could not reclaim the exact released owner after rotation");
    assert(ownerBContenderPort.releaseSync(ownerBSyncSuccessor), "Sync lease successor did not publish a valid release marker");

    const createDeadReclaimMarker = (logicalLock, phase) => {
      const scopedLock = `${logicalLock}.device-${ownerB}`;
      const markerPath = `${scopedLock}.reclaiming`;
      const markerId = crypto.randomBytes(16).toString("hex");
      const markerOwnerPath = `${markerPath}.owner-${markerId}`;
      const payload = {
        version: 1,
        deviceOwnerId: ownerB,
        markerId,
        ownerPath: markerOwnerPath,
        pid: 2147483647,
        createdAt: Date.now()
      };
      const ownerAbsolute = path.join(leaseOwnerRotationTemp, markerOwnerPath);
      const markerAbsolute = path.join(leaseOwnerRotationTemp, markerPath);
      fs.writeFileSync(ownerAbsolute, JSON.stringify(payload), { flag: "wx" });
      fs.linkSync(ownerAbsolute, markerAbsolute);
      if (phase === "recovery") {
        fs.linkSync(ownerAbsolute, path.join(leaseOwnerRotationTemp, `${markerPath}.recovery`));
      }
      return { markerAbsolute, ownerAbsolute, recoveryAbsolute: path.join(leaseOwnerRotationTemp, `${markerPath}.recovery`) };
    };

    const crashLogicalLock = "crash-reclaim.lock";
    const crashSeedLease = await withRealGlobalTimers(() => ownerBPort.acquire(crashLogicalLock, "crash-seed", 250, 5));
    assert(crashSeedLease && await ownerBPort.release(crashSeedLease), "Crash-reclaim fixture did not publish a released canonical lease");
    const markerCrash = createDeadReclaimMarker(crashLogicalLock, "marker");
    const markerCrashSuccessor = await withRealGlobalTimers(() => ownerBContenderPort.acquire(crashLogicalLock, "marker-crash-successor", 250, 5));
    assert(markerCrashSuccessor && await ownerBContenderPort.validate(markerCrashSuccessor), "Async lease did not recover a dead reclaimer that crashed after marker publication");
    assert(!fs.existsSync(markerCrash.markerAbsolute) && !fs.existsSync(markerCrash.ownerAbsolute), "Async stale-marker recovery retained dead reclaim artifacts");
    assert(await ownerBContenderPort.release(markerCrashSuccessor), "Marker-crash successor could not release its lease");

    const recoveryCrash = createDeadReclaimMarker(crashLogicalLock, "recovery");
    const recoveryCrashSuccessor = ownerBPort.acquireSync(crashLogicalLock, "recovery-crash-sync-successor", 250, 2);
    assert(recoveryCrashSuccessor && ownerBPort.validateSync(recoveryCrashSuccessor), "Sync lease did not recover a dead reclaimer that crashed after recovery-link publication");
    assert(!fs.existsSync(recoveryCrash.markerAbsolute) && !fs.existsSync(recoveryCrash.ownerAbsolute) && !fs.existsSync(recoveryCrash.recoveryAbsolute), "Sync stale-recovery cleanup retained dead reclaim artifacts");
    assert(ownerBPort.releaseSync(recoveryCrashSuccessor), "Recovery-crash sync successor could not release its lease");
  } finally {
    if (previousDeviceOwner === undefined) {
      mockLocalStorage.delete(deviceOwnerStorageKey);
    } else {
      mockLocalStorage.set(deviceOwnerStorageKey, previousDeviceOwner);
    }
    fs.rmSync(leaseOwnerRotationTemp, { recursive: true, force: true });
  }

  const isolatedLeaseTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-lease-isolated-realms-"));
  const isolatedDesktopModulePath = compileTsModuleFileForIsolatedTest("platform/desktop.ts");
  const { Worker: NodeWorker } = require("worker_threads");
  const isolatedWorkerSource = [
    '"use strict";',
    'const { parentPort, workerData } = require("worker_threads");',
    'const Module = require("module");',
    'const fs = require("fs");',
    'const path = require("path");',
    'const originalLoad = Module._load;',
    'Module._load = function(request, parent, isMain) {',
    '  if (request === "obsidian") return { Platform: { isWin: process.platform === "win32", isMacOS: process.platform === "darwin", isIosApp: false } };',
    '  if (request === "electron") return { shell: { openPath: async () => "" } };',
    '  return originalLoad.call(this, request, parent, isMain);',
    '};',
    'global.window = {',
    '  localStorage: { getItem: () => workerData.deviceOwnerId, setItem() {}, removeItem() {} },',
    '  setTimeout, clearTimeout',
    '};',
    'const desktop = require(workerData.modulePath);',
    'const app = { vault: { adapter: { getBasePath: () => workerData.basePath } } };',
    'const leasePort = desktop.createDesktopPorts(app).fs.lease;',
    'let currentLease = null;',
    'let resumeRename = null;',
    'parentPort.on("message", async (message) => {',
    '  if (message.type === "resume") { resumeRename?.(); resumeRename = null; return; }',
    '  const originalRename = fs.promises.rename;',
    '  try {',
    '    if (message.pauseReclaimRename) {',
    '      let paused = false;',
    '      fs.promises.rename = async (sourcePath, targetPath) => {',
    '        if (!paused && path.basename(String(sourcePath)).startsWith("isolated.lock.device-") && String(targetPath).includes(".reclaim-")) {',
    '          paused = true;',
    '          parentPort.postMessage({ type: "paused", id: message.id });',
    '          await new Promise((resolve) => { resumeRename = resolve; });',
    '        }',
    '        return await originalRename.call(fs.promises, sourcePath, targetPath);',
    '      };',
    '    }',
    '    let value = false;',
    '    if (message.type === "acquire") { currentLease = await leasePort.acquire("isolated.lock", message.ownerId, message.timeoutMs, 5); value = Boolean(currentLease); }',
    '    else if (message.type === "release") { value = Boolean(currentLease && await leasePort.release(currentLease)); currentLease = null; }',
    '    else if (message.type === "validate") { value = Boolean(currentLease && await leasePort.validate(currentLease)); }',
    '    else if (message.type === "acquireSync") { currentLease = leasePort.acquireSync("isolated.lock", message.ownerId, message.timeoutMs, 2); value = Boolean(currentLease); }',
    '    else if (message.type === "releaseSync") { value = Boolean(currentLease && leasePort.releaseSync(currentLease)); currentLease = null; }',
    '    else if (message.type === "validateSync") { value = Boolean(currentLease && leasePort.validateSync(currentLease)); }',
    '    parentPort.postMessage({ type: "result", id: message.id, value });',
    '  } catch (error) {',
    '    parentPort.postMessage({ type: "result", id: message.id, error: String(error && (error.stack || error.message) || error) });',
    '  } finally {',
    '    fs.promises.rename = originalRename;',
    '  }',
    '});'
  ].join("\n");
  const isolatedWorkers = [];
  const waitForIsolatedMessage = (worker, predicate, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const timer = originalGlobals.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for isolated lease worker"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      originalGlobals.clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
  const sendIsolatedLeaseCommand = (worker, message) => {
    const response = waitForIsolatedMessage(worker, (candidate) => candidate.type === "result" && candidate.id === message.id);
    worker.postMessage(message);
    return response;
  };
  try {
    const isolatedOwner = "c".repeat(32);
    for (let index = 0; index < 3; index += 1) {
      isolatedWorkers.push(new NodeWorker(isolatedWorkerSource, {
        eval: true,
        workerData: { modulePath: isolatedDesktopModulePath, basePath: isolatedLeaseTemp, deviceOwnerId: isolatedOwner }
      }));
    }
    const [realmA, realmB, realmC] = isolatedWorkers;
    assert((await sendIsolatedLeaseCommand(realmA, { type: "acquire", id: "seed-acquire", ownerId: "seed", timeoutMs: 250 })).value, "Isolated lease fixture could not acquire its seed lease");
    assert((await sendIsolatedLeaseCommand(realmA, { type: "release", id: "seed-release" })).value, "Isolated lease fixture could not release its seed lease");

    const pausedReclaim = waitForIsolatedMessage(realmA, (message) => message.type === "paused" && message.id === "realm-a-reclaim");
    const realmAReclaim = sendIsolatedLeaseCommand(realmA, { type: "acquire", id: "realm-a-reclaim", ownerId: "realm-a", timeoutMs: 500, pauseReclaimRename: true });
    await pausedReclaim;
    const realmBWhileMarkerHeld = await sendIsolatedLeaseCommand(realmB, { type: "acquire", id: "realm-b-marker", ownerId: "realm-b", timeoutMs: 80 });
    assert(!realmBWhileMarkerHeld.value, "An isolated realm crossed another reclaimer's filesystem-visible marker");
    realmA.postMessage({ type: "resume" });
    assert((await realmAReclaim).value, "The marker-owning isolated realm did not acquire after reclaim resumed");
    assert((await sendIsolatedLeaseCommand(realmA, { type: "validate", id: "realm-a-validate" })).value, "Isolated realm A did not hold a valid lease after reclaim");
    assert(!(await sendIsolatedLeaseCommand(realmC, { type: "acquire", id: "realm-c-live", ownerId: "realm-c", timeoutMs: 80 })).value, "A third isolated realm acquired beside a live owner");
    assert(!(await sendIsolatedLeaseCommand(realmB, { type: "acquireSync", id: "realm-b-sync-live", ownerId: "realm-b-sync", timeoutMs: 25 })).value, "Sync lease facet crossed a live owner in another realm");
    assert((await sendIsolatedLeaseCommand(realmA, { type: "release", id: "realm-a-release" })).value, "Isolated realm A could not release its lease");
    assert((await sendIsolatedLeaseCommand(realmC, { type: "acquireSync", id: "realm-c-sync-successor", ownerId: "realm-c-sync", timeoutMs: 250 })).value, "Sync successor could not acquire the released isolated-realm lease");
    assert((await sendIsolatedLeaseCommand(realmC, { type: "validateSync", id: "realm-c-sync-validate" })).value, "Sync successor did not own a valid isolated-realm lease");
    assert((await sendIsolatedLeaseCommand(realmC, { type: "releaseSync", id: "realm-c-sync-release" })).value, "Sync successor could not release its isolated-realm lease");
  } finally {
    await Promise.allSettled(isolatedWorkers.map((worker) => worker.terminate()));
    fs.rmSync(isolatedLeaseTemp, { recursive: true, force: true });
    fs.rmSync(isolatedDesktopModulePath, { force: true });
  }

  assert(plugin.savingsCalculator.validateSavingsData({
    originalSize: 1000,
    currentSize: 1000,
    savedSize: 0,
    savedPercentage: 0,
    processedFiles: 1,
    totalFiles: 1,
    estimatedFiles: 0
  }), "Savings validation rejected a valid zero-savings result");
  assert(plugin.savingsCalculator.validateSavingsData({
    originalSize: 0,
    currentSize: 0,
    savedSize: 0,
    savedPercentage: 0,
    processedFiles: 0,
    totalFiles: 3,
    estimatedFiles: 0
  }), "Savings validation rejected all-skipped activity");
  assert(!plugin.savingsCalculator.validateSavingsData({
    originalSize: 1000,
    currentSize: 500,
    savedSize: 1500,
    savedPercentage: 150,
    processedFiles: 1,
    totalFiles: 1,
    estimatedFiles: 0
  }), "Savings validation accepted impossible savings totals");
  const originalGetCompressionRatioForEstimate = plugin.savingsCalculator.getCompressionRatio;
  try {
    plugin.savingsCalculator.getCompressionRatio = () => 15;
    assert(
      plugin.savingsCalculator.estimateOriginalSizeFromCurrent({ extension: "png", stat: { size: 100000 } }) === 1500000,
      "Savings estimator rejected a valid 15x compression ratio"
    );
    plugin.savingsCalculator.getCompressionRatio = () => 31;
    assert(
      plugin.savingsCalculator.estimateOriginalSizeFromCurrent({ extension: "png", stat: { size: 100000 } }) === 100000,
      "Savings estimator did not cap implausible ratios"
    );
    plugin.savingsCalculator.getCompressionRatio = () => Infinity;
    assert(
      plugin.savingsCalculator.estimateOriginalSizeFromCurrent({ extension: "png", stat: { size: 100000 } }) === 100000,
      "Savings estimator accepted a non-finite ratio"
    );
  } finally {
    plugin.savingsCalculator.getCompressionRatio = originalGetCompressionRatioForEstimate;
  }
  assert(plugin.savingsCalculator.getCompressionRatio("webp", 100000) === plugin.constructor.COMPRESSION_RATIOS.DEFAULT, "WebP still uses a supported-format-specific savings ratio");

  const originalGetCompressedFileSizeForSavings = plugin.savingsCalculator.getCompressedFileSize;
  try {
    const cachedSavingsFile = createMockFile("Images/cached-output-size.jpg", 400, 96);
    plugin.cache.cacheData.entries = {
      [plugin.cache.buildCacheKey(cachedSavingsFile.path, MOCK_MD5, cachedSavingsFile.stat.mtime)]: {
        path: cachedSavingsFile.path,
        md5: MOCK_MD5,
        mtime: cachedSavingsFile.stat.mtime,
        timestamp: 1,
        state: "moved",
        originalSize: 1000,
        processedMtime: cachedSavingsFile.stat.mtime,
        processedSize: cachedSavingsFile.stat.size,
        outputSize: cachedSavingsFile.stat.size
      }
    };
    let compressedStatCalls = 0;
    plugin.savingsCalculator.getCompressedFileSize = async () => {
      compressedStatCalls += 1;
      throw new Error("cached outputSize should avoid fs.stat fallback");
    };
    const cachedSavingsStats = await plugin.savingsCalculator.collectImageStats([cachedSavingsFile]);
    assert(compressedStatCalls === 0, "collectImageStats() did not use cached outputSize before fs.stat fallback");
    assert(cachedSavingsStats.savings.originalSize === 1000, `Cached savings original size was wrong: ${cachedSavingsStats.savings.originalSize}`);
    assert(cachedSavingsStats.savings.currentSize === 400, `Cached savings current size was wrong: ${cachedSavingsStats.savings.currentSize}`);
  } finally {
    plugin.savingsCalculator.getCompressedFileSize = originalGetCompressedFileSizeForSavings;
    plugin.cache.cacheData = originalCacheData;
  }

  const originalGetEntriesByPathMapForSavings = plugin.cache.getEntriesByPathMap;
  const originalGetEntriesForPathForSavings = plugin.cache.getEntriesForPath;
  try {
    const parallelSavingsFiles = Array.from({ length: 12 }, (_, index) => createMockFile(`Images/parallel-size-${index}.jpg`, 400 + index, 500 + index));
    plugin.cache.cacheData.entries = {};
    for (const file of parallelSavingsFiles) {
      plugin.cache.cacheData.entries[plugin.cache.buildCacheKey(file.path, MOCK_MD5, file.stat.mtime)] = {
        path: file.path,
        md5: MOCK_MD5,
        mtime: file.stat.mtime,
        timestamp: 1,
        state: "moved",
        originalSize: 1000,
        processedMtime: file.stat.mtime,
        processedSize: file.stat.size
      };
    }
    let savingsPathMapBuilds = 0;
    let savingsDirectPathScans = 0;
    plugin.cache.getEntriesByPathMap = function(...args) {
      savingsPathMapBuilds += 1;
      return originalGetEntriesByPathMapForSavings.apply(this, args);
    };
    plugin.cache.getEntriesForPath = function(...args) {
      savingsDirectPathScans += 1;
      return originalGetEntriesForPathForSavings.apply(this, args);
    };
    let inFlightSizeFetches = 0;
    let maxInFlightSizeFetches = 0;
    plugin.savingsCalculator.getCompressedFileSize = async () => {
      inFlightSizeFetches += 1;
      maxInFlightSizeFetches = Math.max(maxInFlightSizeFetches, inFlightSizeFetches);
      await new Promise((resolve) => originalGlobals.setTimeout(resolve, 5));
      inFlightSizeFetches -= 1;
      return 400;
    };
    await plugin.savingsCalculator.collectImageStats(parallelSavingsFiles);
    assert(maxInFlightSizeFetches > 1, `collectImageStats() fetched compressed sizes serially: max=${maxInFlightSizeFetches}`);
    assert(maxInFlightSizeFetches <= 8, `collectImageStats() exceeded the savings stat concurrency cap: max=${maxInFlightSizeFetches}`);
    assert(savingsPathMapBuilds === 1, `collectImageStats() rebuilt the cache path map more than once: ${savingsPathMapBuilds}`);
    assert(savingsDirectPathScans === 0, "collectImageStats() fell back to direct per-file cache path scans");
  } finally {
    plugin.savingsCalculator.getCompressedFileSize = originalGetCompressedFileSizeForSavings;
    plugin.cache.getEntriesByPathMap = originalGetEntriesByPathMapForSavings;
    plugin.cache.getEntriesForPath = originalGetEntriesForPathForSavings;
    plugin.cache.cacheData = originalCacheData;
  }

  plugin.cache.cacheData.entries = {};
  await plugin.cache.addToCache("v2:empty-path", 100, null, null);
  assert(Object.keys(plugin.cache.cacheData.entries).length === 0, "addToCache() created an entry with an empty path");

  plugin.cache.cacheData.entries = {};
  plugin.cache.saveCache = async () => true;
  plugin.cache.createBackup = () => {};
  await setMockFiles(plugin, [createMockFile("Images/a.png", 100000, 1)]);
  plugin.compressor.compress = async () => ({
    success: false,
    error: "pngquant exited with code 99",
    skipReason: "pngquant_quality_failed"
  });
  await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/a.png"));
  const skippedEntry = Object.values(plugin.cache.cacheData.entries).find((entry) => entry.path === "Images/a.png" && entry.state === "skipped");
  assert(skippedEntry && !Object.prototype.hasOwnProperty.call(skippedEntry, "skipped"), "PNG quality failure was not written as a canonical skipped cache entry");
  assert(skippedEntry.skipReason === "pngquant_quality_failed", `Unexpected PNG skip reason: ${skippedEntry && skippedEntry.skipReason}`);
  assert(skippedEntry.compressionSettingsKey === "png:65-80", `PNG skip entry did not record quality settings: ${skippedEntry.compressionSettingsKey}`);
	  const tooLargeSettingsKey = plugin.getCompressionSettingsKey({ extension: "png" }, "too_large");
	  assert(tooLargeSettingsKey === "png:limits:100:100:too_large", `too_large skip entry did not record size/pixel limits: ${tooLargeSettingsKey}`);
	  assert(plugin.cache.isSettingsSensitiveSkipReason("too_large") === true, "too_large skipped entries are not settings-sensitive");
	  const desktopCacheFile = plugin.app.vault.getAbstractFileByPath("Images/a.png");
	  const crossDeviceFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/cross-device.png", 30 * 1024 * 1024, 2));
	  await setMockFiles(plugin, [desktopCacheFile, crossDeviceFile]);
	  const mobileTooLargeKey = plugin.cache.buildCacheKey(crossDeviceFile.path, "", crossDeviceFile.stat.mtime);
	  plugin.cache.cacheData.entries[mobileTooLargeKey] = {
	    path: crossDeviceFile.path,
	    md5: "",
	    mtime: crossDeviceFile.stat.mtime,
	    timestamp: 2,
	    lastAccessMs: 2,
	    originalSize: crossDeviceFile.stat.size,
	    sourceMtime: crossDeviceFile.stat.mtime,
	    sourceSize: crossDeviceFile.stat.size,
	    state: "skipped",
	    stateUpdatedAt: 2,
	    skipReason: "too_large",
	    compressionSettingsKey: "png:limits:25:50:too_large"
	  };
	  assert(await plugin.cache.isFileAlreadyProcessed(crossDeviceFile) === false, "Desktop treated a mobile too_large cache entry as fresh");
	  assert(plugin.getCompressionSettingsKey({ extension: "webp" }, "future_skip_reason") === "webp:future_skip_reason", "Future skip reasons still get a null compression settings key");
  assert(Object.keys(plugin.cache.cacheData.entries).some((key) => key.startsWith("v2:")), "Skipped cache entry was not written with a v2 key");

  const originalNoticeClassForSanitize = ObsidianMock.Notice;
  const originalCompressorCompressForSanitize = plugin.compressor.compress;
  try {
    const noticeMessages = [];
    ObsidianMock.Notice = class {
      constructor(message) {
        noticeMessages.push(String(message));
      }
    };
    const pathLeakErrors = [
      "C:\\Users\\joe\\Documents\\private\\secret.png failed",
      "C:\\Users\\Joe\\My Photos\\secret.jpg failed",
      "/Users/Joe/My Photos/secret.jpeg failed",
      "/opt/vault/private/secret.png failed",
      "~/Documents/private/secret.png failed",
      "file:///Users/joe/private/img.png failed",
      "Cache temp C:\\Users\\Joe\\AppData\\Local\\plugin.tmp failed",
      "Second line\n/Users/Joe/private/plugin.log failed",
      "Markdown /home/joe/private/notes.md failed",
      "http://localhost:8080/private/debug failed",
      "http://127.0.0.1:3000/private/debug failed"
    ];
    plugin.cache.cacheData.entries = {};
    for (let index = 0; index < pathLeakErrors.length; index++) {
      plugin.compressor.compress = async () => ({
        success: false,
        error: pathLeakErrors[index]
      });
      await setMockFiles(plugin, [createMockFile(`Images/path-leak-${index}.png`, 100000, index + 2)]);
      await plugin.compressFile(plugin.app.vault.getAbstractFileByPath(`Images/path-leak-${index}.png`));
    }
    plugin.compressor.compress = async () => ({
      success: false,
      error: "Generic compression error"
    });
    await setMockFiles(plugin, [createMockFile("Images/generic-error.png", 100000, 12)]);
    await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/generic-error.png"));
    plugin.compressor.compress = async () => {
      throw new Error("Thrown compression error");
    };
    await setMockFiles(plugin, [createMockFile("Images/thrown-error.png", 100000, 13)]);
    await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/thrown-error.png"));
    assert(noticeMessages.length > 0, "Compression failure did not show a user notice");
    assert(
      !noticeMessages.some((message) => /C:\\|~\/|file:\/\/|localhost|127\.0\.0\.1|\/Users\/Joe|\/home\/joe|\/opt\/vault|AppData|secret\.(png|jpe?g)|plugin\.(tmp|log)|notes\.md|My Photos/.test(message)),
      `User notice leaked an absolute path: ${noticeMessages.join(" | ")}`
    );
    assert(
      noticeMessages.some((message) => message.includes("Generic compression error")),
      "sanitizeErrorForUser removed a generic error message"
    );
    assert(
      noticeMessages.some((message) => message.includes("progress.error") || message.includes("Error")) && noticeMessages.some((message) => message.includes("Images/thrown-error.png")),
      "Thrown compression error notice did not include the file context"
    );
    const longPathLikeError = `Error: C:\\${"a".repeat(10000)}`;
    const sanitizeStartedAt = Date.now();
    const sanitizedLongPath = plugin.compressor.formatErrorForUser(longPathLikeError);
    const sanitizeElapsedMs = Date.now() - sanitizeStartedAt;
    assert(sanitizedLongPath === "Error: <path>", "sanitizeErrorForUser did not scrub a long path-like Windows token");
    assert(sanitizeElapsedMs < 100, `sanitizeErrorForUser was too slow for a long non-matching path: ${sanitizeElapsedMs}ms`);
  } finally {
    ObsidianMock.Notice = originalNoticeClassForSanitize;
    plugin.compressor.compress = originalCompressorCompressForSanitize;
  }

  const originalGetCompressedFilesCountForAutoMove = plugin.moveService.getCompressedFilesCount;
  const originalMoveCompressedToFilesForAutoMove = plugin.moveService.moveCompressedToFiles;
  const originalCompressorCompressForAutoMove = plugin.compressor.compress;
  const originalAddCompressionArtifactForAutoMove = plugin.cache.addCompressionArtifact;
  const originalCreateBackupForAutoMove = plugin.cache.createBackup;
  const originalUpdateImageIndexForAutoMove = plugin.updateImageIndexForFile;
  const originalStatusBarUpdateForAutoMove = plugin.statusBarController.update;
  const originalUpdateSavingsForAutoMove = plugin.updateSavingsIndicatorInSettings;
  let autoMoveCalls = 0;
  const autoMoveWorkflowCounts = [];
  try {
    plugin.settings.autoMoveCompressedEnabled = true;
    plugin.settings.autoMoveCompressedThreshold = 1;
    plugin.moveService.getCompressedFilesCount = async () => 1;
    plugin.moveService.moveCompressedToFiles = async () => {
      autoMoveWorkflowCounts.push(plugin.compressionWorkflowsInFlight);
      autoMoveCalls += 1;
    };
    plugin.cache.addCompressionArtifact = async () => true;
    plugin.cache.createBackup = async () => {
      throw new Error("post-commit backup failure");
    };
    plugin.updateImageIndexForFile = async () => {
      throw new Error("post-commit index failure");
    };
    plugin.statusBarController.update = async () => {
      throw new Error("post-commit status failure");
    };
    plugin.updateSavingsIndicatorInSettings = async () => {
      throw new Error("post-commit savings failure");
    };
    plugin.compressor.compress = async (file, _settings, operation) => createCompressionSuccess(file, operation);
    plugin.cache.cacheData.entries = {};
    await setMockFiles(plugin, [createMockFile("Images/auto-move.png", 100000, 3)]);
    await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/auto-move.png"));
    assert(autoMoveCalls === 1, `Auto-move did not run after compression reached threshold: ${autoMoveCalls}`);
    assert(autoMoveWorkflowCounts[0] === 0, `Auto-move started while compression workflow was still counted: ${autoMoveWorkflowCounts[0]}`);
    plugin.isAutoMoveRunning = true;
    await plugin.tryAutoMoveCompressed();
    assert(autoMoveCalls === 1, "Auto-move ran re-entrantly while already active");
  } finally {
    plugin.isAutoMoveRunning = false;
    plugin.settings.autoMoveCompressedEnabled = false;
    plugin.moveService.getCompressedFilesCount = originalGetCompressedFilesCountForAutoMove;
    plugin.moveService.moveCompressedToFiles = originalMoveCompressedToFilesForAutoMove;
    plugin.compressor.compress = originalCompressorCompressForAutoMove;
    plugin.cache.addCompressionArtifact = originalAddCompressionArtifactForAutoMove;
    plugin.cache.createBackup = originalCreateBackupForAutoMove;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForAutoMove;
    plugin.statusBarController.update = originalStatusBarUpdateForAutoMove;
    plugin.updateSavingsIndicatorInSettings = originalUpdateSavingsForAutoMove;
  }

  const originalCompressorCompressForMoveLock = plugin.compressor.compress;
  const originalNoticeClassForMoveLock = ObsidianMock.Notice;
  try {
    const moveLockNotices = [];
    ObsidianMock.Notice = class {
      constructor(message) {
        moveLockNotices.push(String(message));
      }
    };
    let compressionDuringMoveCalls = 0;
    plugin.moveService.moveOperationInProgress = true;
    plugin.compressor.compress = async () => {
      compressionDuringMoveCalls += 1;
      return { success: true, savings: 10 };
    };
    const moveLockResult = await plugin.runCompressionBatch([createMockFile("Images/move-lock.png", 100000, 4)]);
    assert(moveLockResult.compressed === 0 && moveLockResult.skippedValidation === 1, "Compression was not deferred while move was in progress");
    assert(compressionDuringMoveCalls === 0, "Compressor ran while move was in progress");
    assert(moveLockNotices.some((message) => message.includes("move operation is in progress")), "Move lock Notice did not explain why compression was deferred");
    await plugin.compressFile(createMockFile("Images/move-lock-direct.png", 100000, 5));
    await plugin.autoCompressNewFile(createMockFile("Images/move-lock-auto.png", 100000, 6));
    assert(compressionDuringMoveCalls === 0, "Direct compression path ran while move was in progress");
  } finally {
    plugin.moveService.moveOperationInProgress = false;
    plugin.compressor.compress = originalCompressorCompressForMoveLock;
    ObsidianMock.Notice = originalNoticeClassForMoveLock;
  }

  const originalWaitForCompressionIdle = plugin.waitForCompressionIdle;
  const originalWithCompressionGuardsForMoveWait = plugin.withCompressionGuards;
  const moveWaitTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-wait-"));
  try {
    let waitForIdleCalls = 0;
    let guardedMoveCalls = 0;
    plugin.withCompressionGuards = async (task) => {
      guardedMoveCalls += 1;
      return await task();
    };
    plugin.waitForCompressionIdle = async () => {
      waitForIdleCalls += 1;
      return false;
    };
    plugin.app.vault.adapter.basePath = moveWaitTemp;
    plugin.app.vault.adapter.path.absolute = moveWaitTemp;
    plugin.settings.outputFolder = "Compressed";
    await plugin.moveService.moveCompressedToFiles();
    assert(waitForIdleCalls === 1, `Move did not evaluate the compression-idle abort result: ${waitForIdleCalls}`);
    assert(guardedMoveCalls === 0, "Move entered guarded scan after compression-idle timeout");

    plugin.waitForCompressionIdle = async () => {
      waitForIdleCalls += 1;
      return true;
    };
    await plugin.moveService.moveCompressedToFiles();
    assert(waitForIdleCalls === 2 && guardedMoveCalls === 1, "Move did not continue exactly once after compression became idle");
  } finally {
    plugin.waitForCompressionIdle = originalWaitForCompressionIdle;
    plugin.withCompressionGuards = originalWithCompressionGuardsForMoveWait;
    plugin.moveService.moveOperationInProgress = false;
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
    fs.rmSync(moveWaitTemp, { recursive: true, force: true });
  }

  const originalWindowSetTimeoutForIdle = global.window.setTimeout;
  const originalGlobalSetTimeoutForIdle = global.setTimeout;
  try {
    let idleMacroTicks = 0;
    global.window.setTimeout = (callback, delay) => originalGlobals.setTimeout(() => {
      idleMacroTicks += 1;
      callback();
    }, delay);
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 1;
    originalGlobals.setTimeout(() => {
      plugin.compressionJobsInFlight = 0;
    }, 0);
    await plugin.waitForCompressionIdle();
    assert(idleMacroTicks > 0, "waitForCompressionIdle did not yield through a macrotask timer");
    assert(plugin.compressionJobsInFlight === 0, "waitForCompressionIdle did not observe drained compression jobs");
  } finally {
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 0;
    global.window.setTimeout = originalWindowSetTimeoutForIdle;
    global.setTimeout = originalGlobalSetTimeoutForIdle;
  }

  const originalWaitTickForIdleTimeout = plugin.waitForCompressionIdleTick;
  const idleTimeoutWarnings = captureConsoleWarn();
  try {
    let idleTimeoutTicks = 0;
    plugin.waitForCompressionIdleTick = async () => {
      idleTimeoutTicks += 1;
    };
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 1;
    const idleTimeoutResult = await plugin.waitForCompressionIdle(0);
    assert(idleTimeoutResult === false, "waitForCompressionIdle timeout did not return an abort result");
    assert(idleTimeoutTicks === 0, "waitForCompressionIdle did not stop before ticking when maxWaitMs elapsed");
    assert(idleTimeoutWarnings.messages.some((message) => message.includes("waitForCompressionIdle giving up after 0ms")), "waitForCompressionIdle timeout did not log stuck counters");
  } finally {
    idleTimeoutWarnings.restore();
    plugin.waitForCompressionIdleTick = originalWaitTickForIdleTimeout;
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 0;
  }

  const originalSetWindowTimeoutForIndexDedupe = plugin.setWindowTimeout;
  const originalClearWindowTimeoutForIndexDedupe = plugin.clearWindowTimeout;
  const originalUpdateImageIndexForDedupe = plugin.updateImageIndexForFile;
  const originalScheduleStatusBarForDedupe = plugin.scheduleStatusBarUpdate;
  const originalGetAbstractFileByPathForDedupe = plugin.app.vault.getAbstractFileByPath;
  try {
    const scheduledTimers = [];
    let refreshCalls = 0;
    let clearedTimers = 0;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      scheduledTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      timer.cleared = true;
      clearedTimers += 1;
    };
    plugin.updateImageIndexForFile = async () => {
      refreshCalls += 1;
    };
    plugin.scheduleStatusBarUpdate = () => {};
    plugin.app.vault.getAbstractFileByPath = (filePath) => createMockFile(filePath, 100, 1);
    for (let index = 0; index < 100; index++) {
      plugin.scheduleImageIndexRefresh("Images/dedupe.png", "modify");
    }
    assert(plugin.indexRefreshTimers.size === 1, `scheduleImageIndexRefresh kept ${plugin.indexRefreshTimers.size} timers for one path`);
    assert(clearedTimers === 99, `scheduleImageIndexRefresh did not clear superseded timers: ${clearedTimers}`);
    const activeTimer = scheduledTimers.filter((timer) => !timer.cleared).at(-1);
    await activeTimer.callback();
    assert(refreshCalls === 1, `scheduleImageIndexRefresh fired ${refreshCalls} refreshes for one path`);
    assert(plugin.indexRefreshTimers.size === 0, "scheduleImageIndexRefresh did not remove the fired timer from the Map");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForIndexDedupe;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForIndexDedupe;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForDedupe;
    plugin.scheduleStatusBarUpdate = originalScheduleStatusBarForDedupe;
    plugin.app.vault.getAbstractFileByPath = originalGetAbstractFileByPathForDedupe;
    plugin.indexRefreshTimers.clear();
  }

  const originalCacheDataForRename = plugin.cache.cacheData;
  try {
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const oldPath = "Images/old-name.png";
    const newPath = "Images/new-name.png";
    const oldKey = plugin.cache.buildCacheKey(oldPath, MOCK_MD5, 777);
    plugin.cache.cacheData.entries[oldKey] = {
      path: oldPath,
      md5: MOCK_MD5,
      mtime: 777,
      sourceMtime: 777,
      sourceSize: 1000,
      timestamp: 1,
      state: "pending_move",
      outputPath: "Compressed/Images/old-name.png"
    };
    await plugin.cache.renameCacheEntries(oldPath, newPath);
    assert(plugin.cache.getEntriesForPath(oldPath).length === 0, "renameCacheEntries() left old path entries behind");
    const renamedEntries = plugin.cache.getEntriesForPath(newPath);
    assert(renamedEntries.length === 1 && renamedEntries[0][1].outputPath === "Compressed/Images/old-name.png", "renameCacheEntries() did not migrate path while preserving output metadata");
    const legacyNoMtimeKey = "legacy-no-mtime";
    plugin.cache.cacheData.entries = {
      [legacyNoMtimeKey]: {
        path: oldPath,
        md5: MOCK_MD5,
        timestamp: 2
      }
    };
    await plugin.cache.renameCacheEntries(oldPath, newPath);
    assert(plugin.cache.cacheData.entries[legacyNoMtimeKey]?.path === oldPath, "renameCacheEntries() rewrote a no-mtime entry with a synthetic Date.now cache key");
    assert(!plugin.cache.getEntriesForPath(newPath).some(([key]) => key !== legacyNoMtimeKey), "renameCacheEntries() created a migrated key without a real source mtime");
  } finally {
    plugin.cache.cacheData = originalCacheDataForRename;
  }

  const originalCacheDataForMissingMtime = plugin.cache.cacheData;
  const noMtimeWarn = captureConsoleWarn();
  try {
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const missingMtimeKey = await plugin.cache.getCacheKey({ path: "Images/no-mtime.png" }, "Images/no-mtime.png", null);
    assert(missingMtimeKey === "", "getCacheKey() synthesized a cache key without a real source mtime");
    await plugin.cache.addToCache("v2:no-mtime", 100, null, "Compressed/Images/no-mtime.png", "Images/no-mtime.png", null);
    assert(Object.keys(plugin.cache.cacheData.entries).length === 0, "addToCache() wrote an entry without a real source mtime");
    assert(noMtimeWarn.messages.some((message) => message.includes("without real mtime")), "Missing-mtime cache key path did not warn");
  } finally {
    noMtimeWarn.restore();
    plugin.cache.cacheData = originalCacheDataForMissingMtime;
  }

  const originalCompressorCompressForSnapshot = plugin.compressor.compress;
  const originalCacheIsProcessedForSnapshot = plugin.cache.isFileAlreadyProcessed;
  const originalCacheAddArtifactForSnapshot = plugin.cache.addCompressionArtifact;
  const originalUpdateImageIndexForSnapshot = plugin.updateImageIndexForFile;
  try {
    const snapshotFile = createMockFile("Images/snapshot.png", 100000, 123);
    let compressorOperation = null;
    let committedArtifact = null;
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.addCompressionArtifact = async (artifact) => {
      committedArtifact = artifact;
      return true;
    };
    plugin.updateImageIndexForFile = async () => {};
    plugin.compressor.compress = async (file, _settings, operation) => {
      compressorOperation = operation;
      file.path = "Images/renamed-mid-flight.png";
      return createCompressionSuccess(file, operation, 10, "Compressed/Images/snapshot.png");
    };
    await plugin.runCompressionBatch([snapshotFile]);
    assert(compressorOperation?.sourcePath === "Images/snapshot.png" && compressorOperation?.sourceMtime === 123, `Batch compression did not pass immutable source identity: ${JSON.stringify(compressorOperation)}`);
    assert(committedArtifact?.sourcePath === "Images/snapshot.png", `Batch cache commit used live renamed path: ${committedArtifact?.sourcePath}`);
    assert(committedArtifact?.outputPath === "Compressed/Images/snapshot.png", `Batch cache commit used a recomputed output path: ${committedArtifact?.outputPath}`);
  } finally {
    plugin.compressor.compress = originalCompressorCompressForSnapshot;
    plugin.cache.isFileAlreadyProcessed = originalCacheIsProcessedForSnapshot;
    plugin.cache.addCompressionArtifact = originalCacheAddArtifactForSnapshot;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForSnapshot;
  }

  const originalCompressorCompressForSettingsSnapshot = plugin.compressor.compress;
  const originalCacheIsProcessedForSettingsSnapshot = plugin.cache.isFileAlreadyProcessed;
  const originalCacheAddArtifactForSettingsSnapshot = plugin.cache.addCompressionArtifact;
  const originalUpdateImageIndexForSettingsSnapshot = plugin.updateImageIndexForFile;
  const originalSettingsForSettingsSnapshot = plugin.settings;
  try {
    plugin.settings = { ...plugin.settings, pngQuality: { min: 30, max: 40 }, jpegQuality: 70 };
    const capturedPngQualities = [];
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.addCompressionArtifact = async () => true;
    plugin.updateImageIndexForFile = async () => {};
    plugin.compressor.compress = async (file, settings, operation) => {
      capturedPngQualities.push({ ...settings.pngQuality });
      plugin.settings.pngQuality = { min: 80, max: 90 };
      return createCompressionSuccess(file, operation, 10);
    };
    await plugin.runCompressionBatch([
      createMockFile("Images/settings-a.png", 100000, 1),
      createMockFile("Images/settings-b.png", 100000, 2),
      createMockFile("Images/settings-c.png", 100000, 3)
    ]);
    assert(capturedPngQualities.length === 3, "Settings snapshot batch did not call compressor for every file");
    assert(capturedPngQualities.every((quality) => quality.min === 30 && quality.max === 40), `Batch used mutated settings mid-flight: ${JSON.stringify(capturedPngQualities)}`);
  } finally {
    plugin.compressor.compress = originalCompressorCompressForSettingsSnapshot;
    plugin.cache.isFileAlreadyProcessed = originalCacheIsProcessedForSettingsSnapshot;
    plugin.cache.addCompressionArtifact = originalCacheAddArtifactForSettingsSnapshot;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForSettingsSnapshot;
    plugin.settings = originalSettingsForSettingsSnapshot;
  }

  plugin.settings.outputFolder = "Compressed";
  await setMockFiles(plugin, [createMockFile("Images/stale.png", 120000, 2)]);
  await setCacheEntries(plugin, {
    [`Images/stale.png:${MOCK_MD5}:1`]: {
      md5: MOCK_MD5,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000,
      sourceMtime: 1,
      sourceSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Changed same-path image was hidden by a stale cache entry");

  await setMockFiles(plugin, [createMockFile("Images/skipped.png", 120000, 2)]);
  await setCacheEntries(plugin, {
    "Images/skipped.png": {
      skipped: true,
      reason: "pngquant_quality_failed",
      originalSize: 100000,
      sourceMtime: 1,
      sourceSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Changed skipped image was hidden by a stale skipped cache entry");

  const qualitySkippedFile = createMockFile("Images/quality-skipped.png", 120000, 7);
  plugin.settings.pngQuality = { min: 65, max: 80 };
  await setMockFiles(plugin, [qualitySkippedFile]);
  await setCacheEntries(plugin, {
    "Images/quality-skipped.png": {
      path: "Images/quality-skipped.png",
      skipped: true,
      state: "skipped",
      reason: "pngquant_quality_failed",
      originalSize: 120000,
      sourceMtime: 7,
      sourceSize: 120000,
      compressionSettingsKey: "png:65-80"
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Quality-aware skipped image was not treated as processed before settings changed");
  plugin.settings.pngQuality = { min: 40, max: 60 };
  await withRealGlobalTimers(() => plugin.rebuildImageIndex("quality-skip-settings-change"));
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Skipped image stayed processed after relevant quality settings changed");
  await setCacheEntries(plugin, {
    "Images/legacy-quality-skipped.png": {
      path: "Images/quality-skipped.png",
      skipped: true,
      state: "skipped",
      reason: "pngquant_quality_failed",
      originalSize: 120000,
      sourceMtime: 7,
      sourceSize: 120000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Legacy settings-sensitive skipped image without quality key was not re-evaluated");
  plugin.settings.pngQuality = { min: 65, max: 80 };

  await setMockFiles(plugin, [createMockFile("Images/legacy-moved.jpg", 70000, 9)]);
  await setCacheEntries(plugin, {
    [`Images/legacy-moved.jpg:${MOCK_MD5}:1`]: {
      md5: MOCK_MD5,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Legacy original-size cache entry was not migrated to processed moved state");

  const legacyMtimeOnlyFile = createMockFile("Images/legacy-mtime-only.jpg", 100000, 9);
  await setMockFiles(plugin, [legacyMtimeOnlyFile]);
  await setCacheEntries(plugin, {
    [`Images/legacy-mtime-only.jpg:${MOCK_MD5}:9`]: {
      md5: MOCK_MD5,
      mtime: 9,
      timestamp: 1
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Legacy processed cache entry without originalSize was not migrated to processed moved state");
  const legacyEstimatedSavings = await plugin.savingsCalculator.collectImageStats([legacyMtimeOnlyFile]);
  assert(legacyEstimatedSavings.savings.processedFiles === 1, "Legacy processed cache entry without originalSize was not counted as processed");
  assert(legacyEstimatedSavings.savings.estimatedFiles === 1, "Legacy processed cache entry without originalSize did not use estimated savings");

  await setMockFiles(plugin, [createMockFile("Images/legacy-path-only.jpg", 120000, 99)]);
  await setCacheEntries(plugin, {
    [`Images/legacy-path-only.jpg:${MOCK_MD5}:1`]: {
      md5: MOCK_MD5,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Legacy processed cache entry with stale source mtime was not migrated to processed moved state");
  assert(plugin.cache.getEntriesForPath("Images/legacy-path-only.jpg").length === 1, "Legacy processed cache entry was deleted instead of migrated");

  await setMockFiles(plugin, [createMockFile("Images/future-moved.jpg", 70000, 9)]);
  await setCacheEntries(plugin, {
    [`Images/future-moved.jpg:${MOCK_MD5_ALT}:1`]: {
      md5: MOCK_MD5_ALT,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000,
      processedMtime: 9,
      processedSize: 70000,
      moved: true
    }
  });
  counts = await plugin.getImageCompressionCounts();
  const migratedMovedEntry = plugin.cache.getEntriesForPath("Images/future-moved.jpg")[0]?.[1];
  assert(migratedMovedEntry?.state === "moved" && !Object.prototype.hasOwnProperty.call(migratedMovedEntry, "moved"), "Legacy moved flag was not migrated to canonical state");
  assert(counts.uncompressedImages === 0, "Moved processed fingerprint was not treated as processed");

  await setMockFiles(plugin, [createMockFile("Images/conflicting-state.jpg", 50000, 20)]);
  await setCacheEntries(plugin, {
    [`Images/conflicting-state.jpg:${MOCK_MD5}:10`]: {
      state: "skipped",
      moved: true,
      md5: MOCK_MD5,
      mtime: 10,
      timestamp: 1,
      sourceMtime: 10,
      sourceSize: 100000,
      processedMtime: 20,
      processedSize: 50000
    }
  });
  const conflictingStateEntry = plugin.cache.getEntriesForPath("Images/conflicting-state.jpg")[0]?.[1];
  assert(conflictingStateEntry?.state === "skipped" && !Object.prototype.hasOwnProperty.call(conflictingStateEntry, "moved"), "Conflicting legacy state fields were not collapsed during normalization");
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Conflicting legacy moved flag overrode canonical skipped state");

  const pendingTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-pending-"));
  const originalSetSaveCacheTimeoutForPending = plugin.cache.setSaveCacheTimeout;
  const originalClearSaveCacheTimeoutForPending = plugin.cache.clearSaveCacheTimeout;
  const originalSaveCacheForPending = plugin.cache.saveCache;
  const originalAcceptingWritesForPending = plugin.cache.acceptingWrites;
  try {
    plugin.cache.setSaveCacheTimeout = (callback, delay) => originalGlobals.setTimeout(callback, delay);
    plugin.cache.clearSaveCacheTimeout = (timer) => originalGlobals.clearTimeout(timer);
    plugin.cache.acceptingWrites = true;
    plugin.cache.saveCache = async () => true;
    plugin.settings.outputFolder = "Compressed";
    plugin.app.vault.adapter.basePath = pendingTemp;
    plugin.app.vault.adapter.path.absolute = pendingTemp;
    plugin.cache.cacheData.entries = {};
    const pendingOutputPath = path.join(pendingTemp, "Compressed", "Images", "pending.jpg");
    fs.mkdirSync(path.dirname(pendingOutputPath), { recursive: true });
    fs.writeFileSync(pendingOutputPath, Buffer.alloc(50000));
    const pendingOutputStats = fs.statSync(pendingOutputPath);
    await setMockFiles(plugin, [createMockFile("Images/pending.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [`Images/pending.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(pendingOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 0, "Valid pending_move output was not treated as processed");

    await setMockFiles(plugin, [createMockFile("Images/pending-missing-output-identity.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [`Images/pending-missing-output-identity.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg"
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "pending_move without output size/mtime identity hid an uncompressed source");

    await setMockFiles(plugin, [createMockFile("Images/pending-null-source-size.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [`Images/pending-null-source-size.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: null,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(pendingOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "pending_move with null source size matched as size zero");

    const lastAccessSaveKey = `Images/last-access.jpg:${MOCK_MD5}:10`;
    await setMockFiles(plugin, [createMockFile("Images/last-access.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [lastAccessSaveKey]: {
        state: "processed",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        lastAccessMs: 1,
        sourceMtime: 10,
        sourceSize: 100000
      }
    });
    const lastAccessSaveEntry = plugin.cache.getEntriesForPath("Images/last-access.jpg")[0]?.[1];
    assert(lastAccessSaveEntry, "lastAccess smoke setup did not retain the normalized cache entry");
    const originalQueueCacheWriteForLastAccess = plugin.cache.queueCacheWrite;
    let lastAccessSaveOptions = null;
    try {
      lastAccessSaveEntry.lastAccessMs = 1;
      plugin.cache.lastAccessSaveAt = 0;
      plugin.cache.lastAccessSavePromise = null;
      plugin.cache.queueCacheWrite = async (_data, options) => {
        lastAccessSaveOptions = options;
        return true;
      };
      const freshLastAccess = await plugin.cache.getFreshEntryForFile(createMockFile("Images/last-access.jpg", 100000, 10));
      await plugin.cache.lastAccessSavePromise;
      assert(freshLastAccess, "lastAccess smoke setup did not find the cache entry");
      assert(lastAccessSaveEntry.lastAccessMs > 1, "Cache hit did not bump lastAccessMs");
      assert(lastAccessSaveOptions?.mergeDiskEntries === true && lastAccessSaveOptions?.existingEntriesOnly === true, "Cache hit did not schedule an existing-only lastAccessMs delta");
    } finally {
      plugin.cache.queueCacheWrite = originalQueueCacheWriteForLastAccess;
      plugin.cache.lastAccessSavePromise = null;
    }

    await setMockFiles(plugin, [createMockFile("Images/pending.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [`Images/pending.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(pendingOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    fs.unlinkSync(pendingOutputPath);
    await plugin.refreshImageIndexProcessedStates();
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "Missing pending_move output did not make the source image uncompressed again");

    fs.writeFileSync(pendingOutputPath, Buffer.alloc(50000));
    const changedSourceOutputStats = fs.statSync(pendingOutputPath);
    await setMockFiles(plugin, [createMockFile("Images/pending-source-changed.jpg", 100001, 11)]);
    await setCacheEntries(plugin, {
      [`Images/pending-source-changed.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(changedSourceOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "Changed source file was hidden by a pending_move cache entry");

    await setMockFiles(plugin, [createMockFile("Images/moved-from-pending.jpg", 50000, 15)]);
    const movedFromPendingKey = `Images/moved-from-pending.jpg:${MOCK_MD5}:10`;
    await setCacheEntries(plugin, {
      [movedFromPendingKey]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(changedSourceOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/moved-from-pending.jpg", { mtimeMs: 15, size: 50000 }, 100000);
    await withRealGlobalTimers(() => plugin.rebuildImageIndex("smoke-moved"));
    const movedEntry = plugin.cache.getEntriesForPath("Images/moved-from-pending.jpg")[0]?.[1];
    assert(movedEntry, "markProcessedFileMoved() removed the moved cache entry");
    assert(movedEntry.state === "moved", "markProcessedFileMoved() did not set state=moved");
    assert(typeof movedEntry.stateUpdatedAt === "number", "markProcessedFileMoved() did not record stateUpdatedAt");
    assert(!Object.prototype.hasOwnProperty.call(movedEntry, "moved") && !Object.prototype.hasOwnProperty.call(movedEntry, "movedAt"), "markProcessedFileMoved() kept legacy moved fields");
    fs.rmSync(path.join(pendingTemp, "Compressed"), { recursive: true, force: true });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 0, "Moved entry still depended on the deleted Compressed output");

    const invalidMovedKey = `Images/invalid-moved.jpg:${MOCK_MD5}:10`;
    await setCacheEntries(plugin, {
      [invalidMovedKey]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(changedSourceOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/invalid-moved.jpg", { mtimeMs: 16 }, 100000);
    const invalidMovedEntry = plugin.cache.getEntriesForPath("Images/invalid-moved.jpg")[0]?.[1];
    assert(invalidMovedEntry?.state === "pending_move", "markProcessedFileMoved() wrote a moved entry without processed size");

    const failedCommitKey = `Images/failed-cache-transition.jpg:${MOCK_MD5}:10`;
    await setCacheEntries(plugin, {
      [failedCommitKey]: {
        path: "Images/failed-cache-transition.jpg",
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 10,
        lastAccessMs: 10,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/failed-cache-transition.jpg"
      }
    });
    const originalSaveCacheForFailedTransition = plugin.cache.saveCache;
    try {
      plugin.cache.saveCache = async () => false;
      const failedMovedCommit = await plugin.cache.markProcessedFileMoved("Images/failed-cache-transition.jpg", { mtimeMs: 20, size: 50000 }, 100000);
      assert(failedMovedCommit === false, "markProcessedFileMoved() acknowledged a failed durable cache commit");
      const rolledBackMovedEntry = plugin.cache.getEntriesForPath("Images/failed-cache-transition.jpg")[0]?.[1];
      assert(rolledBackMovedEntry?.state === "pending_move", "Failed moved commit left a non-durable moved state in memory");
      rolledBackMovedEntry.lastAccessMs = 30;
      const failedIdenticalCommit = await plugin.cache.markProcessedFileSkippedIdentical("Images/failed-cache-transition.jpg", { mtimeMs: 10, size: 100000 }, 100000);
      assert(failedIdenticalCommit === false, "markProcessedFileSkippedIdentical() acknowledged a failed durable cache commit");
      const rolledBackIdenticalEntry = plugin.cache.getEntriesForPath("Images/failed-cache-transition.jpg")[0]?.[1];
      assert(rolledBackIdenticalEntry?.state === "pending_move", "Failed identical transition left a non-durable skipped state in memory");
      assert(rolledBackIdenticalEntry?.lastAccessMs >= 30, "Failed cache transition rollback lost a concurrent access touch");
    } finally {
      plugin.cache.saveCache = originalSaveCacheForFailedTransition;
    }

    await setMockFiles(plugin, [createMockFile("Images/select-pending.jpg", 50000, 20)]);
    const selectPendingKey = `Images/select-pending.jpg:${MOCK_MD5}:10`;
    const selectLegacyKey = `Images/select-pending.jpg:${MOCK_MD5_ALT}:1`;
    await setCacheEntries(plugin, {
      [selectLegacyKey]: {
        md5: MOCK_MD5_ALT,
        mtime: 1,
        timestamp: 999,
        originalSize: 100000
      },
      [selectPendingKey]: {
        path: "Images/select-pending.jpg",
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg"
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/select-pending.jpg", { mtimeMs: 20, size: 50000 }, 100000);
    const selectPendingEntries = plugin.cache.getEntriesForPath("Images/select-pending.jpg").map(([, entry]) => entry);
    assert(selectPendingEntries.find((entry) => entry.md5 === MOCK_MD5)?.state === "moved", "markProcessedFileMoved() did not prefer pending_move entry");
    assert(selectPendingEntries.find((entry) => entry.md5 === MOCK_MD5_ALT)?.timestamp === 999, "markProcessedFileMoved() updated migrated legacy entry instead of pending_move");

    await setMockFiles(plugin, [createMockFile("Images/select-output.jpg", 50000, 25)]);
    const selectCurrentOutputKey = `Images/select-output.jpg:${MOCK_MD5}:10`;
    const selectStaleOutputKey = `Images/select-output.jpg:${MOCK_MD5_ALT}:11`;
    await setCacheEntries(plugin, {
      [selectStaleOutputKey]: {
        path: "Images/select-output.jpg",
        state: "pending_move",
        md5: MOCK_MD5_ALT,
        mtime: 11,
        timestamp: 999,
        originalSize: 100000,
        sourceMtime: 11,
        sourceSize: 100000,
        outputPath: "Compressed/Images/stale-output.jpg"
      },
      [selectCurrentOutputKey]: {
        path: "Images/select-output.jpg",
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/current-output.jpg"
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/select-output.jpg", { mtimeMs: 25, size: 50000 }, 100000, "Compressed/Images/current-output.jpg");
    const selectOutputEntries = plugin.cache.getEntriesForPath("Images/select-output.jpg").map(([, entry]) => entry);
    assert(selectOutputEntries.find((entry) => entry.outputPath === "Compressed/Images/current-output.jpg")?.state === "moved", "markProcessedFileMoved() did not prefer the entry for the moved compressed output");
    assert(selectOutputEntries.find((entry) => entry.outputPath === "Compressed/Images/stale-output.jpg")?.state === "pending_move", "markProcessedFileMoved() updated a newer timestamp entry with a different compressed output");

    const exactPendingPath = "Images/exact-pending.jpg";
    const sharedOutputPath = "Compressed/Images/shared-output.jpg";
    const exactPendingBytes = Buffer.from("exact pending output bytes");
    const exactPendingNativePath = path.join(pendingTemp, ...exactPendingPath.split("/"));
    fs.mkdirSync(path.dirname(exactPendingNativePath), { recursive: true });
    fs.writeFileSync(exactPendingNativePath, exactPendingBytes);
    const exactPendingStats = fs.statSync(exactPendingNativePath);
    const exactPendingOutputSha256 = crypto.createHash("sha256").update(exactPendingBytes).digest("hex");
    const oldMovedKey = plugin.cache.buildCacheKey(exactPendingPath, MOCK_MD5_ALT, 9);
    const exactPendingKey = plugin.cache.buildCacheKey(exactPendingPath, MOCK_MD5, 10);
    await setMockFiles(plugin, [createMockFile(exactPendingPath, exactPendingStats.size, exactPendingStats.mtimeMs)]);
    await setCacheEntries(plugin, {
      [oldMovedKey]: {
        path: exactPendingPath,
        state: "moved",
        md5: MOCK_MD5_ALT,
        mtime: 9,
        timestamp: Date.now() + 365 * 24 * 60 * 60 * 1000,
        originalSize: 100,
        processedMtime: exactPendingStats.mtimeMs,
        processedSize: exactPendingStats.size,
        outputPath: sharedOutputPath,
        outputSha256: "f".repeat(64)
      },
      [exactPendingKey]: {
        path: exactPendingPath,
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100,
        sourceMtime: 10,
        sourceSize: 100,
        sourceSha256: "a".repeat(64),
        outputPath: sharedOutputPath,
        outputMtime: exactPendingStats.mtimeMs,
        outputSize: exactPendingStats.size,
        outputSha256: exactPendingOutputSha256
      }
    });
    const oldMovedBeforeTerminalTransition = JSON.stringify(plugin.cache.cacheData.entries[oldMovedKey]);
    const exactPendingTransition = await plugin.cache.markProcessedFileMoved(
      exactPendingPath,
      { mtimeMs: exactPendingStats.mtimeMs, size: exactPendingStats.size },
      100,
      sharedOutputPath,
      { cacheKey: exactPendingKey, outputSha256: exactPendingOutputSha256 }
    );
    assert.equal(exactPendingTransition, true, "Exact pending_move identity was not durably transitioned");
    const transitionedExactPending = plugin.cache.cacheData.entries[exactPendingKey];
    assert(transitionedExactPending?.state === "moved", "Future-dated moved history won over the exact pending_move identity");
    assert(transitionedExactPending.sourceMtime === 10 && transitionedExactPending.sourceSize === 100, "Terminal pending_move transition rewrote its cache-key source identity");
    assert.equal(JSON.stringify(plugin.cache.cacheData.entries[oldMovedKey]), oldMovedBeforeTerminalTransition, "Terminal transition mutated the old future-dated moved identity");

    const originalMalformedCacheData = plugin.cache.cacheData;
    try {
      plugin.cache.cacheData = { version: plugin.cache.CACHE_VERSION, entries: [] };
      assert(plugin.cache.getEntriesByPathMap().size === 0, "Malformed in-memory cache entries were not rejected");
    } finally {
      plugin.cache.cacheData = originalMalformedCacheData;
    }

    const noCacheMovedFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/no-cache-entry.jpg", 50000, 30));
    await setMockFiles(plugin, [noCacheMovedFile]);
    plugin.cache.cacheData.entries = {};
    await plugin.cache.markProcessedFileMoved("Images/no-cache-entry.jpg", { mtimeMs: 30, size: 50000 }, 100000);
    const expectedMovedFallbackKey = await plugin.cache.getCacheKey(noCacheMovedFile);
    const syntheticMovedEntry = plugin.cache.getEntriesForPath("Images/no-cache-entry.jpg")[0]?.[1];
    assert(syntheticMovedEntry && syntheticMovedEntry.state === "moved", "markProcessedFileMoved() did not create a fallback moved entry");
    assert(plugin.cache.cacheData.entries[expectedMovedFallbackKey]?.state === "moved", "Fallback moved entry key does not match getCacheKey(file)");
    assert(syntheticMovedEntry.md5 === crypto.createHash("md5").update(Buffer.from(noCacheMovedFile.path)).digest("hex"), "Fallback moved entry did not store the real file md5");
    const movedFallbackEntryCount = plugin.cache.getEntriesForPath("Images/no-cache-entry.jpg").length;
    await plugin.cache.addToCache(expectedMovedFallbackKey, 100000, noCacheMovedFile, "Compressed/Images/no-cache-entry.jpg");
    assert(plugin.cache.getEntriesForPath("Images/no-cache-entry.jpg").length === movedFallbackEntryCount, "Real-md5 moved fallback created a duplicate cache entry on later addToCache()");

    await setMockFiles(plugin, []);
    plugin.cache.cacheData.entries = {};
    let missingMd5Logs = 0;
    const originalConsoleErrorForMissingMd5 = console.error;
    try {
      console.error = (...args) => {
        if (String(args[1] || "").includes("Cannot mark moved file without cache entry or md5")) {
          missingMd5Logs += 1;
        }
      };
      await plugin.cache.markProcessedFileMoved("Images/missing-md5.jpg", { mtimeMs: 40, size: 50000 }, 100000);
    } finally {
      console.error = originalConsoleErrorForMissingMd5;
    }
    assert(missingMd5Logs === 1, "Missing-md5 fallback did not log a diagnostic");
    assert(plugin.cache.getEntriesForPath("Images/missing-md5.jpg").length === 0, "Missing-md5 fallback created a cache entry");
  } finally {
    plugin.cache.setSaveCacheTimeout = originalSetSaveCacheTimeoutForPending;
    plugin.cache.clearSaveCacheTimeout = originalClearSaveCacheTimeoutForPending;
    plugin.cache.saveCache = originalSaveCacheForPending;
    plugin.cache.acceptingWrites = originalAcceptingWritesForPending;
    fs.rmSync(pendingTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const originalGetAbstractFileByPathForFolder = plugin.app.vault.getAbstractFileByPath;
  try {
    const folderLikePath = "FolderLike.png";
    plugin.app.vault.getAbstractFileByPath = (filePath) => {
      if (filePath === folderLikePath) {
        const folder = new ObsidianMock.TFolder();
        folder.path = folderLikePath;
        folder.name = folderLikePath;
        return folder;
      }
      return originalGetAbstractFileByPathForFolder(filePath);
    };
    const folderOriginal = await plugin.moveService.findOriginalFileForCompressed({
      compressedPath: `Compressed/${folderLikePath}`,
      relativePath: folderLikePath,
      name: folderLikePath,
      size: 50
    });
    assert(folderOriginal === null, "findOriginalFileForCompressed() treated a TFolder as an image file");
    const noCandidateRecord = {
      compressedPath: "Compressed/missing-original.png",
      relativePath: "",
      name: "missing-original.png",
      size: 50
    };
    const noCandidateOriginal = await plugin.moveService.findOriginalFile("missing-original.png", noCandidateRecord, { byName: new Map() });
    assert(noCandidateOriginal === null, "findOriginalFile() returned an original when the candidate set was empty");
    assert(noCandidateRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.noOriginalCandidate"), `Zero-candidate original used wrong skip reason: ${noCandidateRecord.moveSkipReason}`);
  } finally {
    plugin.app.vault.getAbstractFileByPath = originalGetAbstractFileByPathForFolder;
  }

  const moveLookupTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-lookup-"));
  const originalSetSaveCacheTimeoutForMoveLookup = plugin.cache.setSaveCacheTimeout;
  const originalClearSaveCacheTimeoutForMoveLookup = plugin.cache.clearSaveCacheTimeout;
  try {
    setCacheTestFile(path.join(moveLookupTemp, "tinyLocal-cache.json"), path.join(moveLookupTemp, "cache-backups"));
    const toMoveLookupPath = (filePath) => path.relative(moveLookupTemp, filePath).replace(/\\/g, "/");
    plugin.cache.setSaveCacheTimeout = (callback, delay) => originalGlobals.setTimeout(callback, delay);
    plugin.cache.clearSaveCacheTimeout = (timer) => originalGlobals.clearTimeout(timer);
    plugin.cache.acceptingWrites = true;
    for (const corruptWorkerPoolSize of [NaN, Infinity, -Infinity, "not-a-number"]) {
      plugin.settings.workerPoolSize = corruptWorkerPoolSize;
      assert(plugin.moveService.getIOConcurrency() === Math.max(1, Math.min(plugin.compressor.activeWorkerCount * 2, 16)), `MoveService getIOConcurrency() did not ignore corrupt legacy workerPoolSize: ${String(corruptWorkerPoolSize)}`);
      delete plugin.settings.workerPoolSize;
    }
    const duplicateA = path.join(moveLookupTemp, "Images", "a", "icon.png");
    const duplicateB = path.join(moveLookupTemp, "Images", "b", "icon.png");
    const backslashOriginal = path.join(moveLookupTemp, "Images", "slash", "photo.jpg");
    const duplicateCompressed = path.join(moveLookupTemp, "Compressed", "lost", "icon.png");
    fs.mkdirSync(path.dirname(duplicateA), { recursive: true });
    fs.mkdirSync(path.dirname(duplicateB), { recursive: true });
    fs.mkdirSync(path.dirname(backslashOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(duplicateCompressed), { recursive: true });
    fs.writeFileSync(duplicateA, Buffer.alloc(100));
    fs.writeFileSync(duplicateB, Buffer.alloc(100));
    fs.writeFileSync(backslashOriginal, Buffer.alloc(100));
    fs.writeFileSync(duplicateCompressed, Buffer.alloc(50));
    await setMockFiles(plugin, [
      createMockFile("Images/a/icon.png", 100, 1),
      createMockFile("Images/b/icon.png", 100, 1),
      createMockFile("Images/slash/photo.jpg", 100, 1)
    ]);
    plugin.cache.cacheData.entries = {};
    const renamedOldRelativePath = "Images/rename-race/photo.jpg";
    const renamedNewRelativePath = "Images/renamed/photo.jpg";
    const renamedOldAbsolutePath = path.join(moveLookupTemp, renamedOldRelativePath);
    const renamedNewAbsolutePath = path.join(moveLookupTemp, renamedNewRelativePath);
    const renamedCompressedPath = path.join(moveLookupTemp, "Compressed", "rename-race", "photo.jpg");
    fs.mkdirSync(path.dirname(renamedNewAbsolutePath), { recursive: true });
    fs.mkdirSync(path.dirname(renamedCompressedPath), { recursive: true });
    fs.writeFileSync(renamedNewAbsolutePath, Buffer.alloc(100));
    fs.writeFileSync(renamedCompressedPath, Buffer.alloc(50));
    const renamedFile = Object.assign(new ObsidianMock.TFile(), createMockFile(renamedNewRelativePath, 100, 10));
    await setMockFiles(plugin, [renamedFile]);
    const renamedOldCacheKey = plugin.cache.buildCacheKey(renamedOldRelativePath, MOCK_MD5, 10);
    plugin.cache.cacheData.entries = {
      [renamedOldCacheKey]: {
        path: renamedOldRelativePath,
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100,
        sourceMtime: 10,
        sourceSize: 100,
        outputPath: "Compressed/rename-race/photo.jpg"
      }
    };
    const originalRenameCacheEntriesForMoveRace = plugin.cache.renameCacheEntries;
    let releaseRenameCacheMigration;
    let markRenameCacheMigrationStarted;
    const renameCacheMigrationGate = new Promise((resolve) => {
      releaseRenameCacheMigration = resolve;
    });
    const renameCacheMigrationStarted = new Promise((resolve) => {
      markRenameCacheMigrationStarted = resolve;
    });
    let renameHandlerPromise = null;
    try {
      plugin.cache.renameCacheEntries = async (...args) => {
        markRenameCacheMigrationStarted();
        await renameCacheMigrationGate;
        return await originalRenameCacheEntriesForMoveRace.apply(plugin.cache, args);
      };
      renameHandlerPromise = plugin.handleVaultRename(renamedFile, renamedOldRelativePath);
      await renameCacheMigrationStarted;
      const originalLookupDuringRename = plugin.moveService.buildOriginalFileLookup();
      const resolvedDuringRename = await plugin.moveService.findOriginalFileForCompressed({
        compressedPath: toMoveLookupPath(renamedCompressedPath),
        relativePath: renamedOldRelativePath,
        name: "photo.jpg",
        size: 50
      }, originalLookupDuringRename);
      assert(resolvedDuringRename === renamedNewRelativePath, `Move lookup used a stale pre-rename path during cache migration: ${resolvedDuringRename}`);
      releaseRenameCacheMigration();
      await renameHandlerPromise;
      renameHandlerPromise = null;
    } finally {
      releaseRenameCacheMigration?.();
      await renameHandlerPromise;
      plugin.cache.renameCacheEntries = originalRenameCacheEntriesForMoveRace;
    }
    assert(plugin.cache.getEntriesForPath(renamedOldRelativePath).length === 0, "Rename-to-move integration left the old cache path behind");
    assert(plugin.cache.getEntriesForPath(renamedNewRelativePath).length === 1, "Rename-to-move integration did not migrate the cache entry to the new path");
    const originalRenameForMoveRace = fs.promises.rename;
    const originalCopyForMoveRace = fs.promises.copyFile;
    const originalLinkForMoveRace = fs.promises.link;
    const moveRaceReplacementTargets = [];
    try {
      fs.promises.rename = async (sourcePath, targetPath) => {
        moveRaceReplacementTargets.push(path.resolve(targetPath));
        return await originalRenameForMoveRace.call(fs.promises, sourcePath, targetPath);
      };
      fs.promises.copyFile = async (sourcePath, targetPath, mode) => {
        moveRaceReplacementTargets.push(path.resolve(targetPath));
        return await originalCopyForMoveRace.call(fs.promises, sourcePath, targetPath, mode);
      };
      fs.promises.link = async (sourcePath, targetPath) => {
        moveRaceReplacementTargets.push(path.resolve(targetPath));
        return await originalLinkForMoveRace.call(fs.promises, sourcePath, targetPath);
      };
	      await plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
	        compressedPath: renamedCompressedPath,
	        relativePath: renamedOldRelativePath,
	        name: "photo.jpg",
	        size: 50
	      }, renamedNewAbsolutePath, moveLookupTemp));
    } finally {
      fs.promises.rename = originalRenameForMoveRace;
      fs.promises.copyFile = originalCopyForMoveRace;
      fs.promises.link = originalLinkForMoveRace;
    }
    assert(moveRaceReplacementTargets.includes(path.resolve(renamedNewAbsolutePath)), "Move after rename did not replace the current Vault path");
    assert(!moveRaceReplacementTargets.includes(path.resolve(renamedOldAbsolutePath)), "Move after rename targeted the stale pre-rename path");
    assert(!fs.existsSync(renamedOldAbsolutePath), "Move after rename recreated the stale pre-rename path");

    let duplicateMovedCalls = 0;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    plugin.cache.markProcessedFileMoved = async () => {
      duplicateMovedCalls += 1;
      return true;
    };
    let duplicateFailed = false;
    const originalConsoleError = console.error;
    try {
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath: toMoveLookupPath(duplicateCompressed),
        relativePath: "missing/icon.png",
        name: "icon.png",
        size: 50
      });
    } catch (_) {
      duplicateFailed = true;
    } finally {
      console.error = originalConsoleError;
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
    }
    assert(duplicateFailed, "Duplicate basename move did not fail as ambiguous");
    assert(duplicateMovedCalls === 0, "Duplicate basename move marked cache moved");
    assert(fs.statSync(duplicateA).size === 100 && fs.statSync(duplicateB).size === 100, "Duplicate basename move changed an original file");
    const backslashOriginalResult = await plugin.moveService.findOriginalFileForCompressed({
      compressedPath: "Compressed/Images/slash/photo.jpg",
      relativePath: "Images\\slash\\photo.jpg",
      name: "photo.jpg",
      size: 50
    });
    assert(backslashOriginalResult === "Images/slash/photo.jpg", `MoveService did not normalize backslash relative paths through shared path normalization: ${backslashOriginalResult}`);

    const uniqueOriginal = path.join(moveLookupTemp, "Images", "unique", "photo.jpg");
    const uniqueCompressed = path.join(moveLookupTemp, "Compressed", "lost", "photo.jpg");
    fs.mkdirSync(path.dirname(uniqueOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(uniqueCompressed), { recursive: true });
    fs.writeFileSync(uniqueOriginal, Buffer.alloc(100));
    fs.writeFileSync(uniqueCompressed, Buffer.alloc(50));
    await setMockFiles(plugin, [
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/unique/photo.jpg", 100, 2))
    ]);
    plugin.cache.cacheData.entries = {};
	    await plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
	      compressedPath: uniqueCompressed,
	      relativePath: "missing/photo.jpg",
	      name: "photo.jpg",
	      size: 50
	    }, uniqueOriginal, moveLookupTemp));
    assert(fs.statSync(uniqueOriginal).size === 50, "Unique basename fallback did not replace the original");
    assert(!fs.existsSync(uniqueCompressed), "Unique basename fallback did not remove compressed output");
    const movedUniqueEntry = plugin.cache.getEntriesForPath("Images/unique/photo.jpg").find(([, entry]) => entry.state === "moved");
    assert(movedUniqueEntry, "Unique basename fallback did not mark cache moved");

    const deletedOriginal = path.join(moveLookupTemp, "Images", "deleted", "gone.jpg");
    const deletedCompressed = path.join(moveLookupTemp, "Compressed", "Images", "deleted", "gone.jpg");
    fs.mkdirSync(path.dirname(deletedOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(deletedCompressed), { recursive: true });
    fs.writeFileSync(deletedOriginal, Buffer.alloc(100));
    fs.writeFileSync(deletedCompressed, Buffer.alloc(50));
    fs.unlinkSync(deletedOriginal);
    const deletedRecord = {
      compressedPath: toMoveLookupPath(deletedCompressed),
      originalPath: toMoveLookupPath(deletedOriginal),
      relativePath: "Images/deleted/gone.jpg",
      name: "gone.jpg",
      size: 50
    };
    await plugin.moveService.moveSingleFile(deletedRecord);
    assert(deletedRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.originalNotFoundAtMoveTime"), `Deleted original was not skipped gracefully: ${deletedRecord.moveSkipReason}`);

    const unloadOriginal = path.join(moveLookupTemp, "Images", "unload", "stop.jpg");
    const unloadCompressed = path.join(moveLookupTemp, "Compressed", "Images", "unload", "stop.jpg");
    fs.mkdirSync(path.dirname(unloadOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(unloadCompressed), { recursive: true });
    fs.writeFileSync(unloadOriginal, Buffer.alloc(100));
    fs.writeFileSync(unloadCompressed, Buffer.alloc(50));
    const unloadRecord = {
      compressedPath: toMoveLookupPath(unloadCompressed),
      originalPath: toMoveLookupPath(unloadOriginal),
      relativePath: "Images/unload/stop.jpg",
      name: "stop.jpg",
      size: 50
    };
    try {
      plugin.isUnloading = true;
      await plugin.moveService.moveSingleFile(unloadRecord);
      assert(unloadRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.unloading"), `Move unload skip used wrong reason: ${unloadRecord.moveSkipReason}`);
      assert(fs.statSync(unloadOriginal).size === 100, "Move unload guard changed the original file");
      assert(fs.existsSync(unloadCompressed), "Move unload guard removed compressed output");
      const unloadBackupResult = await plugin.moveService.createBackupBeforeMove([unloadRecord]);
      assert(unloadBackupResult.files.length === 0 && unloadBackupResult.skippedCount === 1, "Backup prepass did not skip while plugin was unloading");
    } finally {
      plugin.isUnloading = false;
    }

    const selfMovePath = path.join(moveLookupTemp, "Images", "self-move.jpg");
    fs.mkdirSync(path.dirname(selfMovePath), { recursive: true });
    fs.writeFileSync(selfMovePath, Buffer.alloc(100, 0xaa));
    const originalCopyFileForSelfMove = fs.promises.copyFile;
    let selfMoveCopyCalls = 0;
    try {
      fs.promises.copyFile = async (...args) => {
        selfMoveCopyCalls += 1;
        return await originalCopyFileForSelfMove.call(fs.promises, ...args);
      };
      const selfMoveRecord = {
        compressedPath: toMoveLookupPath(selfMovePath),
        originalPath: toMoveLookupPath(selfMovePath),
        relativePath: "Images/self-move.jpg",
        name: "self-move.jpg",
        size: 100
      };
      await plugin.moveService.moveSingleFile(selfMoveRecord);
      assert(selfMoveRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.selfMove"), `Self-move used wrong skip reason: ${selfMoveRecord.moveSkipReason}`);
      assert(selfMoveCopyCalls === 0, "Self-move attempted to stage-copy over the original file");
      assert(fs.statSync(selfMovePath).size === 100, "Self-move changed the original file");

      const backupSelfMoveRecord = {
        compressedPath: toMoveLookupPath(selfMovePath),
        originalPath: toMoveLookupPath(selfMovePath),
        relativePath: "Images/self-move.jpg",
        name: "self-move.jpg",
        size: 100
      };
      const backupSelfMoveResult = await plugin.moveService.createBackupBeforeMove([backupSelfMoveRecord]);
      assert(backupSelfMoveResult.files.length === 0, "Backup prepass allowed a self-move into move tasks");
      assert(backupSelfMoveResult.skippedCount === 1, "Backup prepass did not count self-move as skipped");
      assert(backupSelfMoveRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.selfMove"), `Backup self-move used wrong skip reason: ${backupSelfMoveRecord.moveSkipReason}`);
      assert(selfMoveCopyCalls === 0, "Backup self-move copied a file onto itself");
    } finally {
      fs.promises.copyFile = originalCopyFileForSelfMove;
    }

    const pendingConflictOriginal = path.join(moveLookupTemp, "Images", "pending-conflict.jpg");
    const pendingConflictCompressed = path.join(moveLookupTemp, "Compressed", "Images", "pending-conflict.jpg");
    fs.mkdirSync(path.dirname(pendingConflictOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(pendingConflictCompressed), { recursive: true });
    fs.writeFileSync(pendingConflictOriginal, Buffer.alloc(100, 0x11));
    fs.writeFileSync(pendingConflictCompressed, Buffer.alloc(50, 0x22));
    const pendingConflictOriginalStats = fs.statSync(pendingConflictOriginal);
    const pendingConflictCompressedStats = fs.statSync(pendingConflictCompressed);
    const pendingConflictFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/pending-conflict.jpg", pendingConflictOriginalStats.size, pendingConflictOriginalStats.mtimeMs));
    const previousMoveLookupFiles = plugin.app._files;
    const previousMoveLookupEntries = plugin.cache.cacheData.entries;
    try {
      plugin.app._files = [];
      plugin.cache.cacheData.entries = {
        "pending-conflict": {
          path: pendingConflictFile.path,
          state: "pending_move",
          md5: MOCK_MD5,
          sourceMtime: pendingConflictOriginalStats.mtimeMs - 1,
          sourceSize: pendingConflictOriginalStats.size,
          outputPath: "Compressed/Images/pending-conflict.jpg",
          outputMtime: pendingConflictCompressedStats.mtimeMs,
          outputSize: pendingConflictCompressedStats.size
        }
      };
      const pendingConflictRecord = {
        compressedPath: toMoveLookupPath(pendingConflictCompressed),
        originalPath: toMoveLookupPath(pendingConflictOriginal),
        relativePath: "Images/pending-conflict.jpg",
        name: "pending-conflict.jpg",
        size: pendingConflictCompressedStats.size
      };
      const pendingConflictResult = await plugin.moveService.createBackupBeforeMove([pendingConflictRecord]);
      assert(pendingConflictResult.files.length === 0 && pendingConflictResult.skippedCount === 1, "Pending identity conflict entered the move set");
      assert(pendingConflictRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.externalModification"), `Pending identity conflict used wrong skip reason: ${pendingConflictRecord.moveSkipReason}`);
      assert(fs.statSync(pendingConflictOriginal).size === 100 && fs.existsSync(pendingConflictCompressed), "Pending identity conflict changed move inputs");

      plugin.cache.cacheData.entries = {};
      const postBackupOriginal = path.join(moveLookupTemp, "Images", "post-backup-change.jpg");
      const postBackupCompressed = path.join(moveLookupTemp, "Compressed", "Images", "post-backup-change.jpg");
      fs.writeFileSync(postBackupOriginal, Buffer.alloc(100, 0x33));
      fs.writeFileSync(postBackupCompressed, Buffer.alloc(50, 0x44));
      const postBackupStats = fs.statSync(postBackupOriginal);
      plugin.app._files = [Object.assign(new ObsidianMock.TFile(), createMockFile("Images/post-backup-change.jpg", postBackupStats.size, postBackupStats.mtimeMs))];
      const postBackupRecord = {
        compressedPath: toMoveLookupPath(postBackupCompressed),
        originalPath: toMoveLookupPath(postBackupOriginal),
        relativePath: "Images/post-backup-change.jpg",
        name: "post-backup-change.jpg",
        size: 50
      };
      const untrackedPostBackupResult = await plugin.moveService.createBackupBeforeMove([postBackupRecord]);
      assert(untrackedPostBackupResult.files.length === 0 && postBackupRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.externalModification"), "Untracked output was allowed into a destructive move");
      delete postBackupRecord.moveSkipReason;
      seedPendingMoveArtifact(plugin, "Images/post-backup-change.jpg", "Compressed/Images/post-backup-change.jpg", postBackupOriginal, postBackupCompressed);
      const postBackupResult = await plugin.moveService.createBackupBeforeMove([postBackupRecord]);
      assert(postBackupResult.files.length === 1, "Hash-owned pending artifact did not produce a backup-verified move task");
      const verifiedPostBackupRecord = postBackupResult.files[0];
      fs.writeFileSync(postBackupOriginal, Buffer.alloc(100, 0x55));
      verifiedPostBackupRecord.originalMtimeMsBeforeMove = fs.statSync(postBackupOriginal).mtimeMs;
      await plugin.moveService.moveSingleFile(verifiedPostBackupRecord);
      assert(verifiedPostBackupRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.externalModification"), "Post-backup original content change was not rejected");
      assert(fs.readFileSync(postBackupOriginal).equals(Buffer.alloc(100, 0x55)) && fs.existsSync(postBackupCompressed), "Post-backup conflict overwrote the changed original or removed the output");
    } finally {
      plugin.app._files = previousMoveLookupFiles;
      plugin.cache.cacheData.entries = previousMoveLookupEntries;
    }

    const backupRaceOriginal = path.join(moveLookupTemp, "Images", "backup-race.jpg");
    const backupRaceCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-race.jpg");
    fs.mkdirSync(path.dirname(backupRaceOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupRaceCompressed), { recursive: true });
    fs.writeFileSync(backupRaceOriginal, Buffer.alloc(100));
    fs.writeFileSync(backupRaceCompressed, Buffer.alloc(50));
    seedPendingMoveArtifact(plugin, "Images/backup-race.jpg", "Compressed/Images/backup-race.jpg", backupRaceOriginal, backupRaceCompressed);
    const originalStatForBackupRace = fs.promises.stat;
    let backupRaceOriginalStatCount = 0;
    try {
      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForBackupRace.call(fs.promises, filePath, ...args);
        if (filePath === backupRaceOriginal) {
          backupRaceOriginalStatCount += 1;
          if (backupRaceOriginalStatCount >= 2) {
            return { ...stats, size: stats.size + 1, isDirectory: () => false };
          }
        }
        return stats;
      };
      const backupRaceRecord = {
        compressedPath: toMoveLookupPath(backupRaceCompressed),
        originalPath: toMoveLookupPath(backupRaceOriginal),
        relativePath: "Images/backup-race.jpg",
        name: "backup-race.jpg",
        size: 50
      };
      const backupRaceResult = await plugin.moveService.createBackupBeforeMove([backupRaceRecord]);
      assert(backupRaceResult.files.length === 0, "Backup TOCTOU verification allowed a modified original into move tasks");
      assert(backupRaceResult.skippedCount === 1, "Backup TOCTOU verification did not count the modified original as skipped");
      assert(backupRaceRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.originalModifiedDuringBackup"), `Backup TOCTOU used wrong skip reason: ${backupRaceRecord.moveSkipReason}`);
    } finally {
      fs.promises.stat = originalStatForBackupRace;
    }

    const backupHashRaceOriginal = path.join(moveLookupTemp, "Images", "backup-hash-race.jpg");
    const backupHashRaceCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-hash-race.jpg");
    fs.mkdirSync(path.dirname(backupHashRaceOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupHashRaceCompressed), { recursive: true });
    fs.writeFileSync(backupHashRaceOriginal, Buffer.alloc(100, 0xaa));
    fs.writeFileSync(backupHashRaceCompressed, Buffer.alloc(50, 0xbb));
    seedPendingMoveArtifact(plugin, "Images/backup-hash-race.jpg", "Compressed/Images/backup-hash-race.jpg", backupHashRaceOriginal, backupHashRaceCompressed);
    const originalStatForBackupHashRace = fs.promises.stat;
    let backupHashRaceOriginalStatCount = 0;
    try {
      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForBackupHashRace.call(fs.promises, filePath, ...args);
        if (filePath === backupHashRaceOriginal) {
          backupHashRaceOriginalStatCount += 1;
          if (backupHashRaceOriginalStatCount === 2) {
            fs.writeFileSync(backupHashRaceOriginal, Buffer.alloc(100, 0xcc));
            const changedStats = await originalStatForBackupHashRace.call(fs.promises, filePath, ...args);
            return { ...changedStats, size: stats.size, mtimeMs: stats.mtimeMs, isDirectory: () => false };
          }
        }
        return stats;
      };
      const backupHashRaceRecord = {
        compressedPath: toMoveLookupPath(backupHashRaceCompressed),
        originalPath: toMoveLookupPath(backupHashRaceOriginal),
        relativePath: "Images/backup-hash-race.jpg",
        name: "backup-hash-race.jpg",
        size: 50
      };
      const backupHashRaceResult = await plugin.moveService.createBackupBeforeMove([backupHashRaceRecord]);
      assert(backupHashRaceResult.files.length === 0, "Backup content-hash verification allowed a same-size modified original into move tasks");
      assert(backupHashRaceResult.skippedCount === 1, "Backup content-hash verification did not count the modified original as skipped");
      assert(
        backupHashRaceRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.originalContentChangedDuringBackup"),
        `Backup content-hash verification used wrong skip reason: ${backupHashRaceRecord.moveSkipReason}`
      );
    } finally {
      fs.promises.stat = originalStatForBackupHashRace;
    }

    // T1 / H1 phase-2 regression (compressed branch): a same-size content
    // substitution of the COMPRESSED file between prepass and copy must be caught
    // by SHA-256 verification, mirroring the original-file guard above.
    const backupCompressedHashOriginal = path.join(moveLookupTemp, "Images", "backup-compressed-hash.jpg");
    const backupCompressedHashCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-compressed-hash.jpg");
    fs.mkdirSync(path.dirname(backupCompressedHashOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupCompressedHashCompressed), { recursive: true });
    fs.writeFileSync(backupCompressedHashOriginal, Buffer.alloc(100, 0xaa));
    fs.writeFileSync(backupCompressedHashCompressed, Buffer.alloc(50, 0xbb));
    seedPendingMoveArtifact(plugin, "Images/backup-compressed-hash.jpg", "Compressed/Images/backup-compressed-hash.jpg", backupCompressedHashOriginal, backupCompressedHashCompressed);
    const originalStatForCompressedHashRace = fs.promises.stat;
    let backupCompressedHashStatCount = 0;
    try {
      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForCompressedHashRace.call(fs.promises, filePath, ...args);
        if (filePath === backupCompressedHashCompressed) {
          backupCompressedHashStatCount += 1;
          if (backupCompressedHashStatCount === 2) {
            fs.writeFileSync(backupCompressedHashCompressed, Buffer.alloc(50, 0xdd));
            const changedStats = await originalStatForCompressedHashRace.call(fs.promises, filePath, ...args);
            return { ...changedStats, size: stats.size, mtimeMs: stats.mtimeMs, isDirectory: () => false };
          }
        }
        return stats;
      };
      const backupCompressedHashRecord = {
        compressedPath: toMoveLookupPath(backupCompressedHashCompressed),
        originalPath: toMoveLookupPath(backupCompressedHashOriginal),
        relativePath: "Images/backup-compressed-hash.jpg",
        name: "backup-compressed-hash.jpg",
        size: 50
      };
      const backupCompressedHashResult = await plugin.moveService.createBackupBeforeMove([backupCompressedHashRecord]);
      assert(backupCompressedHashResult.files.length === 0, "Backup content-hash verification allowed a same-size modified compressed file into move tasks");
      assert(backupCompressedHashResult.skippedCount === 1, "Backup content-hash verification did not count the modified compressed file as skipped");
      assert(
        backupCompressedHashRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.compressedContentChangedDuringBackup"),
        `Backup compressed content-hash verification used wrong skip reason: ${backupCompressedHashRecord.moveSkipReason}`
      );
    } finally {
      fs.promises.stat = originalStatForCompressedHashRace;
    }

    // T1 / H1 phase-3 regression (post-copy verification): if the bytes that land in
    // the backup do not match the verified source hash (TOCTOU between verify and
    // copy), the backup must be rejected and the partial backup cleaned up — never
    // accepted as a valid backup.
    const backupPostCopyOriginal = path.join(moveLookupTemp, "Images", "backup-postcopy.jpg");
    const backupPostCopyCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-postcopy.jpg");
    fs.mkdirSync(path.dirname(backupPostCopyOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupPostCopyCompressed), { recursive: true });
    fs.writeFileSync(backupPostCopyOriginal, Buffer.alloc(100, 0xaa));
    fs.writeFileSync(backupPostCopyCompressed, Buffer.alloc(50, 0xbb));
    seedPendingMoveArtifact(plugin, "Images/backup-postcopy.jpg", "Compressed/Images/backup-postcopy.jpg", backupPostCopyOriginal, backupPostCopyCompressed);
    const originalCopyFileForPostCopy = fs.promises.copyFile;
    let postCopyTamperApplied = false;
    try {
      fs.promises.copyFile = async (src, dest, ...args) => {
        const destStr = String(dest);
        // Original's backup copy lands with the right size but wrong bytes.
        if (
          String(src) === backupPostCopyOriginal
          && destStr.includes(path.join(".local-image-compress", "backups", "originals"))
        ) {
          fs.writeFileSync(dest, Buffer.alloc(100, 0x00));
          postCopyTamperApplied = true;
          return;
        }
        return await originalCopyFileForPostCopy.call(fs.promises, src, dest, ...args);
      };
      const backupPostCopyRecord = {
        compressedPath: toMoveLookupPath(backupPostCopyCompressed),
        originalPath: toMoveLookupPath(backupPostCopyOriginal),
        relativePath: "Images/backup-postcopy.jpg",
        name: "backup-postcopy.jpg",
        size: 50
      };
      const backupPostCopyResult = await plugin.moveService.createBackupBeforeMove([backupPostCopyRecord]);
      assert(postCopyTamperApplied, "Post-copy backup test never intercepted the original's backup copy");
      assert(backupPostCopyResult.files.length === 0, "Post-copy backup verification accepted a backup whose content did not match the source");
      assert(backupPostCopyResult.skippedCount === 1, "Post-copy backup verification did not count the corrupted backup as skipped");
      assert(
        backupPostCopyRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.contentChangedDuringCopy"),
        `Post-copy backup verification used wrong skip reason: ${backupPostCopyRecord.moveSkipReason}`
      );
    } finally {
      fs.promises.copyFile = originalCopyFileForPostCopy;
    }

    const externalOriginal = path.join(moveLookupTemp, "Images", "external.jpg");
    const externalCompressed = path.join(moveLookupTemp, "Compressed", "Images", "external.jpg");
    fs.mkdirSync(path.dirname(externalOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(externalCompressed), { recursive: true });
    fs.writeFileSync(externalOriginal, Buffer.alloc(100));
    fs.writeFileSync(externalCompressed, Buffer.alloc(50));
    const originalStatForExternalMove = fs.promises.stat;
    const originalMarkProcessedFileMovedForStaleStat = plugin.cache.markProcessedFileMoved;
	    let externalOriginalStatCount = 0;
	    let committedProcessedSize = null;
	    try {
	      plugin.cache.markProcessedFileMoved = async (_filePath, processedStats) => {
	        committedProcessedSize = processedStats.size;
	        return true;
	      };
	      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForExternalMove.call(fs.promises, filePath, ...args);
        if (filePath === externalOriginal) {
          externalOriginalStatCount += 1;
          if (externalOriginalStatCount >= 2) {
            return { ...stats, size: stats.size + 1, isDirectory: () => false };
          }
        }
        return stats;
      };
	      const externalRecord = prepareVerifiedMoveRecord({
	        compressedPath: externalCompressed,
	        originalPath: externalOriginal,
	        relativePath: "Images/external.jpg",
	        name: "external.jpg",
	        size: 50
	      }, externalOriginal, moveLookupTemp);
	      await plugin.moveService.moveSingleFile(externalRecord);
	      assert(
	        fs.statSync(externalOriginal).size === 50 && !fs.existsSync(externalCompressed),
	        "Exact post-replacement bytes were rejected because of stale stat metadata"
	      );
	      assert(committedProcessedSize === 50, "Stale post-replacement size leaked into the moved cache transition");
	    } finally {
	      fs.promises.stat = originalStatForExternalMove;
	      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMovedForStaleStat;
	    }

    const originalModalForMoveResult = ObsidianMock.Modal;
    let moveResultModal = null;
    try {
      ObsidianMock.Modal = class extends originalModalForMoveResult {
        open() {
          moveResultModal = this;
          super.open();
        }
      };
      plugin.moveService.showMoveResult(0, 0, false, 99, [
        { moveSkipReason: "Original missing before backup" },
        { moveSkipReason: "Original missing before backup" },
        { moveSkipReason: "Compressed file changed during backup" }
      ]);
      const skippedSummaryText = (moveResultModal?.contentEl.children || [])
        .map((child) => child.textContent)
        .find((text) => String(text).startsWith("Skipped:"));
      assert(skippedSummaryText === "Skipped: 3", `Move result modal did not derive skipped summary from reason groups: ${skippedSummaryText}`);
      const reasonList = moveResultModal?.contentEl.querySelectorAll(".tiny-local-move-skip-reasons")[0];
      const reasonTexts = (reasonList?.children || []).map((child) => child.textContent).sort();
      assert(
        JSON.stringify(reasonTexts) === JSON.stringify([
          "Compressed file changed during backup: 1",
          "Original missing before backup: 2"
        ]),
        `Move result modal did not show grouped skip reasons: ${reasonTexts.join(" | ")}`
      );
    } finally {
      ObsidianMock.Modal = originalModalForMoveResult;
    }
  } finally {
    plugin.cache.setSaveCacheTimeout = originalSetSaveCacheTimeoutForMoveLookup;
    plugin.cache.clearSaveCacheTimeout = originalClearSaveCacheTimeoutForMoveLookup;
    restoreCacheTestPaths();
    fs.rmSync(moveLookupTemp, { recursive: true, force: true });
  }

  const moveFailTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-fail-"));
  try {
    const originalPath = path.join(moveFailTemp, "Images", "move-fail.jpg");
    const compressedPath = path.join(moveFailTemp, "Compressed", "Images", "move-fail.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = moveFailTemp;
    plugin.app.vault.adapter.path.absolute = moveFailTemp;
    const originalRename = fs.promises.rename;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    const originalConsoleError = console.error;
    let markMovedCalls = 0;
    fs.promises.rename = async () => {
      throw new Error("simulated staged replace failure");
    };
    plugin.cache.markProcessedFileMoved = async () => {
      markMovedCalls += 1;
      return true;
    };
    let failedAsExpected = false;
    try {
      console.error = () => {};
	      await plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
	        compressedPath,
	        originalPath,
	        relativePath: "Images/move-fail.jpg",
	        name: "move-fail.jpg",
	        size: 50
	      }, originalPath, moveFailTemp));
    } catch (_) {
      failedAsExpected = true;
    } finally {
      console.error = originalConsoleError;
      fs.promises.rename = originalRename;
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
    }
    assert(failedAsExpected, "moveSingleFile() did not surface staged replace failure");
    assert(markMovedCalls === 0, "moveSingleFile() marked cache moved after failed staged replace");
    assert(fs.statSync(originalPath).size === 100, "Failed staged replace changed original file size");
    assert(fs.existsSync(compressedPath), "Failed staged replace deleted compressed output");
    const tempLeftovers = fs.readdirSync(path.dirname(originalPath)).filter((name) => name.includes(".tinylocal-"));
    assert(tempLeftovers.length === 1, `Failed staged replace did not retain exactly one verified recovery temp: ${tempLeftovers.join(", ")}`);
    const retainedMoveTemp = path.join(path.dirname(originalPath), tempLeftovers[0]);
    assert(
      crypto.createHash("sha256").update(fs.readFileSync(retainedMoveTemp)).digest("hex")
        === crypto.createHash("sha256").update(fs.readFileSync(compressedPath)).digest("hex"),
      "Failed staged replace retained bytes other than the verified compressed revision"
    );
  } finally {
    fs.rmSync(moveFailTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveCleanupFailTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-cleanup-fail-"));
  try {
    const originalPath = path.join(moveCleanupFailTemp, "Images", "cleanup-fail.jpg");
    const compressedPath = path.join(moveCleanupFailTemp, "Compressed", "Images", "cleanup-fail.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = moveCleanupFailTemp;
    plugin.app.vault.adapter.path.absolute = moveCleanupFailTemp;
    const originalUnlink = fs.promises.unlink;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    const originalConsoleError = console.error;
    let markMovedCalls = 0;
    fs.promises.unlink = async (filePath) => {
      if (path.basename(String(filePath)).startsWith("cleanup-fail.jpg.delete-") && String(filePath).includes(".tinylocal-quarantine-")) {
        throw new Error("simulated compressed cleanup failure");
      }
      return originalUnlink.call(fs.promises, filePath);
    };
    plugin.cache.markProcessedFileMoved = async () => {
      markMovedCalls += 1;
      return true;
    };
    let failedAsExpected = false;
    try {
      console.error = () => {};
	      await plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
	        compressedPath,
	        originalPath,
	        relativePath: "Images/cleanup-fail.jpg",
	        name: "cleanup-fail.jpg",
	        size: 50
	      }, originalPath, moveCleanupFailTemp));
    } catch (_) {
      failedAsExpected = true;
    } finally {
      console.error = originalConsoleError;
      fs.promises.unlink = originalUnlink;
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
    }
    assert(!failedAsExpected, "moveSingleFile() surfaced a non-fatal compressed cleanup failure");
    assert(markMovedCalls === 1, "moveSingleFile() did not mark cache moved before non-fatal compressed cleanup");
    assert(fs.statSync(originalPath).size === 50, "Compressed cleanup failure did not happen after staged replace");
    const retainedCleanupOutputs = fs.readdirSync(moveCleanupFailTemp, { recursive: true })
      .map(String)
      .filter((filePath) => path.basename(filePath).startsWith("cleanup-fail.jpg.delete-") && filePath.includes(".tinylocal-quarantine-"));
    assert(retainedCleanupOutputs.length === 1, "Compressed cleanup failure did not retain the exact output in its recovery quarantine");
    assert(fs.statSync(path.join(moveCleanupFailTemp, retainedCleanupOutputs[0])).size === 50, "Compressed cleanup quarantine did not preserve the output bytes");
    assert(
      fs.readdirSync(path.join(moveCleanupFailTemp, ".local-image-compress", "recovery")).some((name) => name.startsWith("desktop-cleanup-journal-v1-")),
      "Compressed cleanup failure did not retain its durable recovery journal"
    );
  } finally {
    fs.rmSync(moveCleanupFailTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveCleanupReplacementTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-cleanup-replacement-"));
  try {
    const originalPath = path.join(moveCleanupReplacementTemp, "Images", "cleanup-replacement.jpg");
    const compressedPath = path.join(moveCleanupReplacementTemp, "Compressed", "Images", "cleanup-replacement.jpg");
    const replacementBytes = Buffer.alloc(50, 0x7f);
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50, 0x22));
    plugin.app.vault.adapter.basePath = moveCleanupReplacementTemp;
    plugin.app.vault.adapter.path.absolute = moveCleanupReplacementTemp;
    const verifiedRecord = prepareVerifiedMoveRecord({
      compressedPath,
      originalPath,
      relativePath: "Images/cleanup-replacement.jpg",
      name: "cleanup-replacement.jpg",
      size: 50
    }, originalPath, moveCleanupReplacementTemp);
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    let markMovedCalls = 0;
    try {
      plugin.cache.markProcessedFileMoved = async () => {
        markMovedCalls += 1;
        fs.writeFileSync(compressedPath, replacementBytes);
        return true;
      };
      await plugin.moveService.moveSingleFile(verifiedRecord);
    } finally {
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
    }
    assert(markMovedCalls === 1 && fs.statSync(originalPath).size === 50, "Move cleanup replacement test did not reach the post-replacement cache boundary");
    assert(fs.readFileSync(compressedPath).equals(replacementBytes), "Move cleanup deleted a newer same-path compressed output written during the cache await");
  } finally {
    fs.rmSync(moveCleanupReplacementTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveCacheCommitFailureTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-cache-commit-"));
  try {
    plugin.app.vault.adapter.basePath = moveCacheCommitFailureTemp;
    plugin.app.vault.adapter.path.absolute = moveCacheCommitFailureTemp;
    const movedOriginalPath = path.join(moveCacheCommitFailureTemp, "Images", "commit-fail.jpg");
    const movedOutputPath = path.join(moveCacheCommitFailureTemp, "Compressed", "Images", "commit-fail.jpg");
    fs.mkdirSync(path.dirname(movedOriginalPath), { recursive: true });
    fs.mkdirSync(path.dirname(movedOutputPath), { recursive: true });
    fs.writeFileSync(movedOriginalPath, Buffer.alloc(100, 0x11));
    fs.writeFileSync(movedOutputPath, Buffer.alloc(50, 0x22));
    const originalMarkMovedForCommitFailure = plugin.cache.markProcessedFileMoved;
    try {
      plugin.cache.markProcessedFileMoved = async () => false;
      await assert.rejects(() => plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
        compressedPath: movedOutputPath,
        originalPath: movedOriginalPath,
        relativePath: "Images/commit-fail.jpg",
        name: "commit-fail.jpg",
        size: 50
      }, movedOriginalPath, moveCacheCommitFailureTemp)), /cache transition was not durably committed/);
    } finally {
      plugin.cache.markProcessedFileMoved = originalMarkMovedForCommitFailure;
    }
    assert(fs.statSync(movedOriginalPath).size === 50, "Move cache-commit failure did not preserve the landed replacement");
    assert(fs.existsSync(movedOutputPath), "Move cache-commit failure deleted the reconciliation output");

    const identicalOriginalPath = path.join(moveCacheCommitFailureTemp, "Images", "identical-commit-fail.jpg");
    const identicalOutputPath = path.join(moveCacheCommitFailureTemp, "Compressed", "Images", "identical-commit-fail.jpg");
    fs.writeFileSync(identicalOriginalPath, Buffer.alloc(50, 0x33));
    fs.writeFileSync(identicalOutputPath, Buffer.alloc(50, 0x33));
    const originalMarkIdenticalForCommitFailure = plugin.cache.markProcessedFileSkippedIdentical;
    try {
      plugin.cache.markProcessedFileSkippedIdentical = async () => false;
      await assert.rejects(() => plugin.moveService.moveSingleFile({
        compressedPath: "Compressed/Images/identical-commit-fail.jpg",
        originalPath: "Images/identical-commit-fail.jpg",
        relativePath: "Images/identical-commit-fail.jpg",
        name: "identical-commit-fail.jpg",
        size: 50,
        compressedSha256: crypto.createHash("sha256").update(fs.readFileSync(identicalOutputPath)).digest("hex")
      }), /cache transition was not durably committed/);
    } finally {
      plugin.cache.markProcessedFileSkippedIdentical = originalMarkIdenticalForCommitFailure;
    }
    assert(fs.existsSync(identicalOutputPath), "Identical-output cache-commit failure deleted the reconciliation output");

    const retryOriginalPath = path.join(moveCacheCommitFailureTemp, "Images", "retry-commit-fail.jpg");
    const retryOutputPath = path.join(moveCacheCommitFailureTemp, "Compressed", "Images", "retry-commit-fail.jpg");
    const retrySourceRelativePath = "Images/retry-commit-fail.jpg";
    const retryOutputRelativePath = "Compressed/Images/retry-commit-fail.jpg";
    const retrySourceBytes = Buffer.alloc(100, 0x44);
    const retryOutputBytes = Buffer.alloc(50, 0x55);
    fs.writeFileSync(retryOriginalPath, retrySourceBytes);
    fs.writeFileSync(retryOutputPath, retryOutputBytes);
    const retryOutputStat = fs.statSync(retryOutputPath);
    const retrySourceTime = new Date(Date.now() - 60_000);
    fs.utimesSync(retryOriginalPath, retrySourceTime, retrySourceTime);
    const retrySourceStat = fs.statSync(retryOriginalPath);
    const retrySourceSha256 = crypto.createHash("sha256").update(retrySourceBytes).digest("hex");
    const retryOutputSha256 = crypto.createHash("sha256").update(retryOutputBytes).digest("hex");
    const retryCacheKey = `${retrySourceRelativePath}:${MOCK_MD5}:${retrySourceStat.mtimeMs}`;
    const retryPendingEntry = {
      path: retrySourceRelativePath,
      state: "pending_move",
      timestamp: 500,
      stateUpdatedAt: 500,
      lastAccessMs: 500,
      md5: MOCK_MD5,
      mtime: retrySourceStat.mtimeMs,
      sourceMtime: retrySourceStat.mtimeMs,
      sourceSize: retrySourceBytes.byteLength,
      sourceSha256: retrySourceSha256,
      outputPath: retryOutputRelativePath,
      outputMtime: Math.round(retryOutputStat.mtimeMs),
      outputSize: retryOutputBytes.byteLength,
      outputSha256: retryOutputSha256,
      compressionSettingsKey: "jpeg:50"
    };
    const originalRetryCacheFile = plugin.cache.cacheFile;
    const originalRetryBackupsDir = plugin.cache.cacheBackupsDir;
    const originalRetryCacheData = plugin.cache.cacheData;
    const originalRetrySetTimeout = plugin.cache.setSaveCacheTimeout;
    const originalRetryClearTimeout = plugin.cache.clearSaveCacheTimeout;
    const originalRetrySaveDelay = plugin.cache.saveCacheDelayMs;
    const originalRetryWriteAtomic = plugin.cache.writeCacheFileAtomic;
    const originalRetrySleep = plugin.cache.sleepForCacheLock;
    const originalRetrySaveCache = plugin.cache.saveCache;
    const originalRetryVaultFiles = plugin.app._files;
    const retryCacheFile = path.join(moveCacheCommitFailureTemp, "tinyLocal-cache.json");
    let retryWriteAttempts = 0;
    try {
      plugin.cache.cancelPendingSave();
      await withRealGlobalTimers(async () => await plugin.cache.activeWritePromise);
      plugin.cache.cacheFile = "tinyLocal-cache.json";
      plugin.cache.cacheBackupsDir = "cache-backups";
      plugin.cache.cacheData = { version: plugin.cache.CACHE_VERSION, entries: { [retryCacheKey]: retryPendingEntry } };
      fs.writeFileSync(retryCacheFile, plugin.cache.serializeForDisk());
      plugin.cache.saveCacheDelayMs = 0;
      plugin.cache.setSaveCacheTimeout = (callback, delay) => originalGlobals.setTimeout(callback, delay);
      plugin.cache.clearSaveCacheTimeout = (timer) => originalGlobals.clearTimeout(timer);
      plugin.cache.sleepForCacheLock = async () => {};
      plugin.cache.saveCache = plugin.cache.constructor.prototype.saveCache;
      plugin.cache.writeCacheFileAtomic = async () => {
        retryWriteAttempts += 1;
        return false;
      };
      let retryMoveError = null;
      const retryMoveRecord = prepareVerifiedMoveRecord({
        compressedPath: retryOutputPath,
        originalPath: retryOriginalPath,
        relativePath: retrySourceRelativePath,
        name: "retry-commit-fail.jpg",
        size: retryOutputBytes.byteLength
      }, retryOriginalPath, moveCacheCommitFailureTemp);
      try {
        await plugin.moveService.moveSingleFile(retryMoveRecord);
      } catch (error) {
        retryMoveError = error;
      }
      assert(
        retryMoveError && String(retryMoveError.message || retryMoveError).includes("cache transition was not durably committed"),
        `Three-attempt cache failure returned without the expected durability error; attempts=${retryWriteAttempts}, skip=${retryMoveRecord.moveSkipReason || "none"}, originalSize=${fs.statSync(retryOriginalPath).size}, outputExists=${fs.existsSync(retryOutputPath)}`
      );
      assert(retryWriteAttempts === 3, `Move cache transition used ${retryWriteAttempts} conditional commit attempts instead of three`);
      assert(fs.readFileSync(retryOriginalPath).equals(retryOutputBytes), "Three-attempt cache failure did not preserve the landed replacement");
      assert(fs.existsSync(retryOutputPath), "Three-attempt cache failure deleted the reconciliation output");
      const retryLandedStat = fs.statSync(retryOriginalPath);
      plugin.app._files = [createMockFile(retrySourceRelativePath, retryLandedStat.size, retryLandedStat.mtimeMs)];

      plugin.cache.writeCacheFileAtomic = originalRetryWriteAtomic;
      const ReloadedCacheClass = plugin.cache.constructor;
      const reloadedCache = new ReloadedCacheClass(plugin.app, "cache-backups", plugin.getPlatformPorts());
      reloadedCache.cacheFile = "tinyLocal-cache.json";
      reloadedCache.cacheBackupsDir = "cache-backups";
      reloadedCache.saveCacheDelayMs = 0;
      reloadedCache.setSaveCacheTimeout = (callback, delay) => originalGlobals.setTimeout(callback, delay);
      reloadedCache.clearSaveCacheTimeout = (timer) => originalGlobals.clearTimeout(timer);
      const retryLeasePort = plugin.getPlatformPorts().fs.lease;
      const originalRetryLeaseAcquire = retryLeasePort.acquire;
      let retryLeaseObservedRealTimers = false;
      retryLeasePort.acquire = async function(...args) {
        retryLeaseObservedRealTimers = retryLeaseObservedRealTimers || global.setTimeout === originalGlobals.setTimeout;
        return await originalRetryLeaseAcquire.apply(this, args);
      };
      try {
        await withRealGlobalTimers(() => reloadedCache.loadCache());
      } finally {
        retryLeasePort.acquire = originalRetryLeaseAcquire;
      }
      assert(retryLeaseObservedRealTimers, "Reloaded cache lease ran under the non-firing smoke timer stub");
      assert(reloadedCache.getPendingMoveArtifacts().some((artifact) => artifact.sourcePath === retrySourceRelativePath && artifact.outputPath === retryOutputRelativePath), "Reloaded cache lost the pending_move reconciliation artifact after commit failure");
      const ownedCache = plugin.cache;
      plugin.cache = reloadedCache;
      const retryFsPort = plugin.getPlatformPorts().fs;
      const originalRetryReplaceFile = retryFsPort.replaceFile;
      const originalReloadedPointCompaction = reloadedCache.compaction.compactPath;
      const originalRetryShowMoveResult = plugin.moveService.showMoveResult;
      const originalRetryRebuildImageIndex = plugin.rebuildImageIndex;
      const originalRetryStatusUpdate = plugin.statusBarController.update;
      let retryReplaceCalls = 0;
      let retryPointCompactionCalls = 0;
      reloadedCache.compaction.compactPath = async () => {
        retryPointCompactionCalls += 1;
        throw new Error("post-commit landed-move compaction failure");
      };
      retryFsPort.replaceFile = async (...args) => {
        if (String(args[1] || "").replace(/\\/g, "/") === retrySourceRelativePath) {
          retryReplaceCalls += 1;
        }
        return await originalRetryReplaceFile.apply(retryFsPort, args);
      };
      plugin.moveService.showMoveResult = () => {
        throw new Error("post-reconciliation result presentation failure");
      };
      plugin.rebuildImageIndex = async () => {
        throw new Error("post-reconciliation index failure");
      };
      plugin.statusBarController.update = async () => {
        throw new Error("post-reconciliation status failure");
      };
      try {
        await withRealGlobalTimers(() => plugin.moveService.moveCompressedToFiles());
      } finally {
        retryFsPort.replaceFile = originalRetryReplaceFile;
        reloadedCache.compaction.compactPath = originalReloadedPointCompaction;
        plugin.moveService.showMoveResult = originalRetryShowMoveResult;
        plugin.rebuildImageIndex = originalRetryRebuildImageIndex;
        plugin.statusBarController.update = originalRetryStatusUpdate;
        plugin.cache = ownedCache;
      }
      assert(retryReplaceCalls === 0, `Public landed-move reconciliation replaced the target again ${retryReplaceCalls} time(s)`);
      assert(retryPointCompactionCalls > 0, "Public landed-move reconciliation did not exercise best-effort point compaction");
      assert(!fs.existsSync(retryOutputPath), "Reload reconciliation did not remove output after its cache transition became durable");
      assert(!reloadedCache.getPendingMoveArtifacts().some((artifact) => artifact.sourcePath === retrySourceRelativePath), "Reload reconciliation left the pending_move artifact active after its durable landed-move transition");
      const reconciledRetryDisk = JSON.parse(fs.readFileSync(retryCacheFile, "utf8"));
      assert(!Object.values(reconciledRetryDisk.entries || {}).some((entry) => entry.path === retrySourceRelativePath && entry.state === "pending_move"), "Reload reconciliation left pending_move on disk after deleting its output evidence");
      const reconciledRetryEntry = Object.values(reconciledRetryDisk.entries || {}).find((entry) => entry.path === retrySourceRelativePath);
      const reconciledTargetStat = fs.statSync(retryOriginalPath);
      assert(
        reconciledRetryEntry?.state === "moved",
        `Reload reconciliation misclassified a landed move as an originally identical output: ${JSON.stringify(reconciledRetryEntry || null)}`
      );
      assert(reconciledRetryEntry.processedMtime === Math.round(reconciledTargetStat.mtimeMs) && reconciledRetryEntry.processedSize === reconciledTargetStat.size, "Reload reconciliation did not persist the landed target metadata");
    } finally {
      plugin.cache.writeCacheFileAtomic = originalRetryWriteAtomic;
      plugin.cache.sleepForCacheLock = originalRetrySleep;
      plugin.cache.saveCache = originalRetrySaveCache;
      plugin.cache.setSaveCacheTimeout = originalRetrySetTimeout;
      plugin.cache.clearSaveCacheTimeout = originalRetryClearTimeout;
      plugin.cache.saveCacheDelayMs = originalRetrySaveDelay;
      plugin.cache.cacheFile = originalRetryCacheFile;
      plugin.cache.cacheBackupsDir = originalRetryBackupsDir;
      plugin.cache.cacheData = originalRetryCacheData;
      plugin.app._files = originalRetryVaultFiles;
      plugin.cache.cancelPendingSave();
    }

    const unloadOriginalPath = path.join(moveCacheCommitFailureTemp, "Images", "unload-after-replace.jpg");
    const unloadOutputPath = path.join(moveCacheCommitFailureTemp, "Compressed", "Images", "unload-after-replace.jpg");
    const unloadOutputBytes = Buffer.alloc(50, 0x66);
    fs.writeFileSync(unloadOriginalPath, Buffer.alloc(100, 0x77));
    fs.writeFileSync(unloadOutputPath, unloadOutputBytes);
    const moveFsPort = plugin.getPlatformPorts().fs;
    const originalReplaceForUnloadAfterLanded = moveFsPort.replaceFile;
    let unloadReplacementLanded = false;
    try {
      moveFsPort.replaceFile = async function(...args) {
        const result = await originalReplaceForUnloadAfterLanded.apply(this, args);
        unloadReplacementLanded = true;
        plugin.isUnloading = true;
        return result;
      };
      await assert.rejects(() => plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
        compressedPath: unloadOutputPath,
        originalPath: unloadOriginalPath,
        relativePath: "Images/unload-after-replace.jpg",
        name: "unload-after-replace.jpg",
        size: unloadOutputBytes.byteLength
      }, unloadOriginalPath, moveCacheCommitFailureTemp)), /cache transition was not durably committed/);
    } finally {
      moveFsPort.replaceFile = originalReplaceForUnloadAfterLanded;
      plugin.isUnloading = false;
    }
    assert(unloadReplacementLanded && fs.readFileSync(unloadOriginalPath).equals(unloadOutputBytes), "Unload-after-replacement test did not reach and preserve the landed replacement");
    assert(fs.existsSync(unloadOutputPath), "Unload after landed replacement deleted the reconciliation output");
  } finally {
    fs.rmSync(moveCacheCommitFailureTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveExternalEditTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-external-edit-"));
  try {
    const originalPath = path.join(moveExternalEditTemp, "Images", "external-edit.jpg");
    const compressedPath = path.join(moveExternalEditTemp, "Compressed", "Images", "external-edit.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = moveExternalEditTemp;
    plugin.app.vault.adapter.path.absolute = moveExternalEditTemp;
    const originalRenameForExternalEdit = fs.promises.rename;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
	    let markMovedCalls = 0;
	    let externalEditFailed = false;
	    let injectedExternalEdit = false;
	    const concurrentContent = Buffer.alloc(50, 0x7f);
	    try {
      fs.promises.rename = async (sourcePath, destPath) => {
        if (!injectedExternalEdit
          && path.resolve(String(sourcePath)) === path.resolve(originalPath)
          && String(destPath).includes("tinylocal-rollback")) {
          injectedExternalEdit = true;
          fs.writeFileSync(originalPath, concurrentContent);
        }
        return await originalRenameForExternalEdit.call(fs.promises, sourcePath, destPath);
      };
	      plugin.cache.markProcessedFileMoved = async () => {
	        markMovedCalls += 1;
	        return true;
	      };
	      await plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
	        compressedPath,
	        originalPath,
	        relativePath: "Images/external-edit.jpg",
	        name: "external-edit.jpg",
	        size: 50
	      }, originalPath, moveExternalEditTemp));
	    } catch (_) {
	      externalEditFailed = true;
	    } finally {
	      fs.promises.rename = originalRenameForExternalEdit;
	      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
	    }
	    assert(externalEditFailed, "External edit during move did not fail the replacement");
	    assert(markMovedCalls === 0, "External edit during move was written to cache as moved");
	    assert(fs.existsSync(compressedPath), "External edit during move removed compressed output");
	    assert(fs.readFileSync(originalPath).equals(concurrentContent), "External edit after replace was overwritten by rollback");
  } finally {
    fs.rmSync(moveExternalEditTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveBeforeCaptureTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-before-capture-"));
  try {
    const originalPath = path.join(moveBeforeCaptureTemp, "Images", "before-capture.jpg");
    const compressedPath = path.join(moveBeforeCaptureTemp, "Compressed", "Images", "before-capture.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = moveBeforeCaptureTemp;
    plugin.app.vault.adapter.path.absolute = moveBeforeCaptureTemp;
    const originalRename = fs.promises.rename;
    const concurrentContent = Buffer.alloc(100, 0x3c);
    let injectedConcurrentEdit = false;
    let moveFailed = false;
    try {
      fs.promises.rename = async (sourcePath, destPath) => {
        if (!injectedConcurrentEdit
          && path.resolve(sourcePath) === path.resolve(originalPath)
          && String(destPath).includes("tinylocal-rollback")) {
          injectedConcurrentEdit = true;
          fs.writeFileSync(sourcePath, concurrentContent);
        }
        return await originalRename.call(fs.promises, sourcePath, destPath);
      };
      await plugin.moveService.moveSingleFile(prepareVerifiedMoveRecord({
        compressedPath,
        originalPath,
        relativePath: "Images/before-capture.jpg",
        name: "before-capture.jpg",
        size: 50
      }, originalPath, moveBeforeCaptureTemp));
    } catch (_) {
      moveFailed = true;
    } finally {
      fs.promises.rename = originalRename;
    }
    assert(injectedConcurrentEdit, "Concurrent edit immediately before target capture was not injected");
    assert(moveFailed, "Concurrent edit immediately before target capture did not reject the move");
    assert(fs.readFileSync(originalPath).equals(concurrentContent), "Concurrent edit immediately before target capture was deleted");
    assert(fs.existsSync(compressedPath), "Rejected conditional replacement deleted compressed output");
  } finally {
    fs.rmSync(moveBeforeCaptureTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const orphanMoveTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-orphan-move-"));
  try {
    const toOrphanMovePath = (filePath) => path.relative(orphanMoveTemp, filePath).replace(/\\/g, "/");
    const originalPath = path.join(orphanMoveTemp, "Images", "orphan.jpg");
    const compressedPath = path.join(orphanMoveTemp, "Compressed", "Images", "orphan.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    const sharedContent = Buffer.from("already moved compressed content");
    fs.writeFileSync(originalPath, sharedContent);
    fs.writeFileSync(compressedPath, sharedContent);
    plugin.app.vault.adapter.basePath = orphanMoveTemp;
    plugin.app.vault.adapter.path.absolute = orphanMoveTemp;
    await setMockFiles(plugin, [
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/orphan.jpg", sharedContent.length, 44))
    ]);
    plugin.cache.cacheData.entries = {};
    await plugin.moveService.moveSingleFile({
      compressedPath: toOrphanMovePath(compressedPath),
      originalPath: toOrphanMovePath(originalPath),
      relativePath: "Images/orphan.jpg",
      name: "orphan.jpg",
      size: sharedContent.length
    });
    assert(!fs.existsSync(compressedPath), "Orphan compressed output was not removed");
    const orphanIdenticalEntry = plugin.cache.getEntriesForPath("Images/orphan.jpg").find(([, entry]) => entry.state === "skipped_identical");
    assert(orphanIdenticalEntry, "Bit-identical compressed output was not marked with a distinct skipped_identical cache state");

    const streamCompareA = path.join(orphanMoveTemp, "Images", "stream-a.bin");
    const streamCompareB = path.join(orphanMoveTemp, "Images", "stream-b.bin");
    fs.writeFileSync(streamCompareA, Buffer.alloc(256 * 1024, 7));
    fs.writeFileSync(streamCompareB, Buffer.alloc(256 * 1024, 7));
    const originalReadFileSyncForStreamCompare = fs.readFileSync;
    try {
      fs.readFileSync = (filePath, ...args) => {
        if (filePath === streamCompareA || filePath === streamCompareB) {
          throw new Error("filesHaveSameContent should not read whole files");
        }
        return originalReadFileSyncForStreamCompare(filePath, ...args);
      };
      assert(await plugin.moveService.filesHaveSameContent(toOrphanMovePath(streamCompareA), toOrphanMovePath(streamCompareB)), "Streaming same-content comparison returned false for identical files");
      fs.writeFileSync(streamCompareB, Buffer.concat([Buffer.from([8]), Buffer.alloc(256 * 1024 - 1, 7)]));
      assert(!await plugin.moveService.filesHaveSameContent(toOrphanMovePath(streamCompareA), toOrphanMovePath(streamCompareB)), "Streaming same-content comparison returned true for early mismatch");
    } finally {
      fs.readFileSync = originalReadFileSyncForStreamCompare;
    }

    const bigCompareA = path.join(orphanMoveTemp, "Images", "stream-200mb-a.bin");
    const bigCompareB = path.join(orphanMoveTemp, "Images", "stream-200mb-b.bin");
    const bigCompareSize = 200 * 1024 * 1024;
    const writeSparseCompareFile = (filePath, finalByte) => {
      const handle = fs.openSync(filePath, "w");
      try {
        fs.ftruncateSync(handle, bigCompareSize);
        fs.writeSync(handle, Buffer.from([finalByte]), 0, 1, bigCompareSize - 1);
      } finally {
        fs.closeSync(handle);
      }
    };
    writeSparseCompareFile(bigCompareA, 9);
    writeSparseCompareFile(bigCompareB, 9);
    assert(await plugin.moveService.filesHaveSameContent(toOrphanMovePath(bigCompareA), toOrphanMovePath(bigCompareB)), "filesHaveSameContent failed on identical 200MB sparse files");
    writeSparseCompareFile(bigCompareB, 10);
    assert(!await plugin.moveService.filesHaveSameContent(toOrphanMovePath(bigCompareA), toOrphanMovePath(bigCompareB)), "filesHaveSameContent missed a 200MB tail mismatch");

    const differentOriginal = path.join(orphanMoveTemp, "Images", "different.jpg");
    const differentCompressed = path.join(orphanMoveTemp, "Compressed", "Images", "different.jpg");
    fs.writeFileSync(differentOriginal, Buffer.from("same-size-content-a"));
    fs.writeFileSync(differentCompressed, Buffer.from("same-size-content-b"));
    let differentFailed = false;
    const originalConsoleError = console.error;
    try {
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath: toOrphanMovePath(differentCompressed),
        originalPath: toOrphanMovePath(differentOriginal),
        relativePath: "Images/different.jpg",
        name: "different.jpg",
        size: fs.statSync(differentCompressed).size
      });
    } catch (_) {
      differentFailed = true;
    } finally {
      console.error = originalConsoleError;
    }
    assert(differentFailed, "Same-size different-content compressed output was incorrectly treated as orphan");
    assert(fs.existsSync(differentCompressed), "Different-content compressed output was removed");
    assert(!plugin.cache.getEntriesForPath("Images/different.jpg").some(([, entry]) => entry.state === "moved"), "Different-content failure marked cache moved");

    const unlinkFailOriginal = path.join(orphanMoveTemp, "Images", "unlink-fail.jpg");
    const unlinkFailCompressed = path.join(orphanMoveTemp, "Compressed", "Images", "unlink-fail.jpg");
    fs.writeFileSync(unlinkFailOriginal, sharedContent);
    fs.writeFileSync(unlinkFailCompressed, sharedContent);
    await setMockFiles(plugin, [
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/unlink-fail.jpg", sharedContent.length, fs.statSync(unlinkFailOriginal).mtimeMs))
    ]);
    await setCacheEntries(plugin, {
      [`Images/unlink-fail.jpg:${MOCK_MD5}:1`]: {
        path: "Images/unlink-fail.jpg",
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 1,
        timestamp: 1,
        originalSize: sharedContent.length,
        sourceMtime: 1,
        sourceSize: sharedContent.length,
        outputPath: "Compressed/Images/unlink-fail.jpg"
      }
    });
    const originalUnlink = fs.promises.unlink;
    let unlinkFailed = false;
    try {
      fs.promises.unlink = async (filePath) => {
        if (path.basename(String(filePath)).startsWith("unlink-fail.jpg.delete-") && String(filePath).includes(".tinylocal-quarantine-")) {
          throw new Error("simulated orphan unlink failure");
        }
        return originalUnlink.call(fs.promises, filePath);
      };
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath: toOrphanMovePath(unlinkFailCompressed),
        originalPath: toOrphanMovePath(unlinkFailOriginal),
        relativePath: "Images/unlink-fail.jpg",
        name: "unlink-fail.jpg",
        size: sharedContent.length
      });
    } catch (_) {
      unlinkFailed = true;
    } finally {
      fs.promises.unlink = originalUnlink;
      console.error = originalConsoleError;
    }
    assert(!unlinkFailed, "Orphan unlink failure was surfaced even though cleanup is non-fatal");
    const retainedOrphanOutputs = fs.readdirSync(orphanMoveTemp, { recursive: true })
      .map(String)
      .filter((filePath) => path.basename(filePath).startsWith("unlink-fail.jpg.delete-") && filePath.includes(".tinylocal-quarantine-"));
    assert(retainedOrphanOutputs.length === 1, "Orphan unlink failure did not retain the exact output in its recovery quarantine");
    assert(fs.readFileSync(path.join(orphanMoveTemp, retainedOrphanOutputs[0])).equals(sharedContent), "Orphan cleanup quarantine changed the output bytes");
    assert(plugin.cache.getEntriesForPath("Images/unlink-fail.jpg").some(([, entry]) => entry.state === "skipped_identical"), "Orphan unlink failure did not preserve the processed cache state before non-fatal cleanup");
  } finally {
    fs.rmSync(orphanMoveTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const backupFailureMoveTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-backup-failure-"));
  try {
    const okOriginal = path.join(backupFailureMoveTemp, "Images", "ok.jpg");
    const failOriginal = path.join(backupFailureMoveTemp, "Images", "fail.jpg");
    const okCompressed = path.join(backupFailureMoveTemp, "Compressed", "Images", "ok.jpg");
    const failCompressed = path.join(backupFailureMoveTemp, "Compressed", "Images", "fail.jpg");
    for (const filePath of [okOriginal, failOriginal, okCompressed, failCompressed]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(okOriginal, Buffer.alloc(100));
    fs.writeFileSync(failOriginal, Buffer.alloc(100));
    fs.writeFileSync(okCompressed, Buffer.alloc(50));
    fs.writeFileSync(failCompressed, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = backupFailureMoveTemp;
    plugin.app.vault.adapter.path.absolute = backupFailureMoveTemp;
    plugin.settings.outputFolder = "Compressed";
    await setMockFiles(plugin, [
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/ok.jpg", 100, 1)),
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/fail.jpg", 100, 1))
    ]);
    plugin.cache.cacheData.entries = {};
    seedPendingMoveArtifact(plugin, "Images/ok.jpg", "Compressed/Images/ok.jpg", okOriginal, okCompressed);
    seedPendingMoveArtifact(plugin, "Images/fail.jpg", "Compressed/Images/fail.jpg", failOriginal, failCompressed);
    const originalCopyFile = fs.promises.copyFile;
	    const originalConsoleError = console.error;
	    const backupFailureErrors = [];
	    let delayedSiblingCopyFinished = false;
    try {
      console.error = (...args) => {
        backupFailureErrors.push(args.map((value) => value instanceof Error ? value.message : String(value)).join(" "));
      };
      fs.promises.copyFile = async (sourcePath, destPath) => {
        if (
          sourcePath === failOriginal
          && String(destPath).includes(path.join(".local-image-compress", "backups", "originals"))
	        ) {
	          fs.mkdirSync(path.dirname(destPath), { recursive: true });
	          fs.writeFileSync(destPath, "pre-existing-backup");
	          const error = new Error("simulated pre-existing backup collision");
	          error.code = "EEXIST";
	          throw error;
	        }
	        if (sourcePath === failCompressed && String(destPath).includes(path.join(".local-image-compress", "backups", "originals"))) {
	          await new Promise((resolve) => originalGlobals.setTimeout(resolve, 50));
	          await originalCopyFile.call(fs.promises, sourcePath, destPath);
	          delayedSiblingCopyFinished = true;
	          return;
	        }
	        return await originalCopyFile.call(fs.promises, sourcePath, destPath);
      };
      await withRealGlobalTimers(() => plugin.moveService.moveCompressedToFiles());
    } finally {
      fs.promises.copyFile = originalCopyFile;
      console.error = originalConsoleError;
    }
    assert(fs.statSync(okOriginal).size === 50, `Move flow did not move the file with a complete backup: ${backupFailureErrors.join(" | ")}`);
    assert(fs.statSync(failOriginal).size === 100, "Move flow replaced a file whose backup failed");
    assert(!fs.existsSync(okCompressed), "Move flow did not remove moved compressed output");
	    assert(fs.existsSync(failCompressed), "Move flow removed compressed output for a file whose backup failed");
	    assert(delayedSiblingCopyFinished, "Backup failure path did not await the delayed sibling copy before cleanup");
	    const failedBackupRoot = path.join(backupFailureMoveTemp, ".local-image-compress", "backups", "originals");
	    const failedBackupFiles = fs.existsSync(failedBackupRoot)
	      ? fs.readdirSync(failedBackupRoot, { recursive: true }).map(String).filter((filePath) => filePath.endsWith("fail.jpg"))
	      : [];
	    assert(failedBackupFiles.length === 1, `Failed backup cleanup did not preserve exactly the pre-existing collision: ${failedBackupFiles.join(", ")}`);
	    assert(fs.readFileSync(path.join(failedBackupRoot, failedBackupFiles[0]), "utf8") === "pre-existing-backup", "Failed backup cleanup removed or changed a pre-existing collision");
  } finally {
    fs.rmSync(backupFailureMoveTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const backupTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-smoke-"));
  try {
    const originalPath = path.join(backupTemp, "Images", "move-original.jpg");
    const compressedPath = path.join(backupTemp, "Compressed", "Images", "move-original.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = backupTemp;
    plugin.app.vault.adapter.path.absolute = backupTemp;
    seedPendingMoveArtifact(plugin, "Images/move-original.jpg", "Compressed/Images/move-original.jpg", originalPath, compressedPath);
    plugin.settings.autoBackupsRetentionEnabled = false;
    const originalApplyBackupsRetention = plugin.moveService.applyBackupsRetention;
    let retentionCalls = 0;
    plugin.moveService.applyBackupsRetention = async () => {
      retentionCalls += 1;
    };
    await plugin.moveService.createBackupBeforeMove([
      {
        compressedPath: "Compressed/Images/move-original.jpg",
        originalPath: "Images/move-original.jpg",
        relativePath: "Images/move-original.jpg",
        name: "move-original.jpg",
        size: 50
      }
    ]);
    assert(retentionCalls === 0, "Image backup retention ran while autoBackupsRetentionEnabled was false");

    plugin.settings.autoBackupsRetentionEnabled = true;
    await plugin.moveService.createBackupBeforeMove([
      {
        compressedPath: "Compressed/Images/move-original.jpg",
        originalPath: "Images/move-original.jpg",
        relativePath: "Images/move-original.jpg",
        name: "move-original.jpg",
        size: 50
      }
    ]);
    assert(retentionCalls === 1, "Image backup retention did not run while autoBackupsRetentionEnabled was true");

    plugin.moveService.applyBackupsRetention = originalApplyBackupsRetention;
    const originalDeleteDirectoryForClear = plugin.moveService.deleteDirectoryRecursiveAsync;
    try {
      const clearBackupsRoot = plugin.getBackupStoragePaths().originalFilesBackups;
      const backupDirs = [
        plugin.getPlatformPorts().fs.joinPath(clearBackupsRoot, "backup-a"),
        plugin.getPlatformPorts().fs.joinPath(clearBackupsRoot, "backup-b"),
        plugin.getPlatformPorts().fs.joinPath(clearBackupsRoot, "backup-c")
      ];
      const nativeBackupDirs = backupDirs.map((backupDir) => path.join(backupTemp, ...backupDir.split("/")));
      for (const backupDir of nativeBackupDirs) {
        fs.mkdirSync(path.join(backupDir, "nested"), { recursive: true });
        fs.writeFileSync(path.join(backupDir, "nested", "image.jpg"), "backup");
      }
      const backupMarkerFile = path.join(backupTemp, ...plugin.getPlatformPorts().fs.joinPath(clearBackupsRoot, "not-a-directory.txt").split("/"));
      fs.writeFileSync(backupMarkerFile, "keep");
      let activeBackupDeletes = 0;
      let maxActiveBackupDeletes = 0;
      plugin.moveService.deleteDirectoryRecursiveAsync = async function (dirPath) {
        activeBackupDeletes += 1;
        maxActiveBackupDeletes = Math.max(maxActiveBackupDeletes, activeBackupDeletes);
        try {
          await Promise.resolve();
          return await originalDeleteDirectoryForClear.call(this, dirPath);
        } finally {
          activeBackupDeletes -= 1;
        }
      };
      await plugin.clearOriginalFilesBackups();
      assert(maxActiveBackupDeletes > 1, "Original-files backup cleanup did not delete directories concurrently");
      assert(nativeBackupDirs.every((backupDir) => !fs.existsSync(backupDir)), "Original-files backup cleanup left backup directories behind");
      assert(!fs.existsSync(backupMarkerFile), "Original-files backup cleanup left an orphan file in backupDir");
    } finally {
      plugin.moveService.deleteDirectoryRecursiveAsync = originalDeleteDirectoryForClear;
    }
    const retentionRootPath = "original-files-backups-retention";
    const retentionRoot = path.join(backupTemp, retentionRootPath);
    const expiredBackup = path.join(retentionRoot, "backup-expired");
    const freshBackup = path.join(retentionRoot, "backup-fresh");
    fs.mkdirSync(path.join(expiredBackup, "nested"), { recursive: true });
    fs.mkdirSync(freshBackup, { recursive: true });
    fs.writeFileSync(path.join(expiredBackup, "nested", "old.txt"), "old");
    const oldTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(expiredBackup, "nested", "old.txt"), oldTime, oldTime);
    fs.utimesSync(path.join(expiredBackup, "nested"), oldTime, oldTime);
    fs.utimesSync(expiredBackup, oldTime, oldTime);
    plugin.settings.autoBackupsRetentionDays = 0.001;
    await plugin.moveService.applyBackupsRetention(retentionRootPath);
    assert(fs.existsSync(expiredBackup), "Fractional image backup retention days deleted backups");
    assert(fs.existsSync(freshBackup), "Fractional image backup retention days removed a fresh backup");
    plugin.settings.autoBackupsRetentionDays = 1;
    await plugin.moveService.applyBackupsRetention(retentionRootPath);
    assert(!fs.existsSync(expiredBackup), "Expired image backup directory was not removed");
    assert(fs.existsSync(freshBackup), "Fresh image backup directory was removed by retention");

    const concurrentCleanupDir = path.join(retentionRoot, "concurrent-cleanup");
    const concurrentCleanupPath = `${retentionRootPath}/concurrent-cleanup`;
    fs.mkdirSync(concurrentCleanupDir, { recursive: true });
    fs.writeFileSync(path.join(concurrentCleanupDir, "snapshot.txt"), "snapshot");
    const backupFsPortForConcurrentCleanup = plugin.getPlatformPorts().fs;
    const originalListEntriesForConcurrentCleanup = backupFsPortForConcurrentCleanup.listEntries;
    let injectedConcurrentChild = false;
    try {
      backupFsPortForConcurrentCleanup.listEntries = async function(dirPath) {
        const entries = await originalListEntriesForConcurrentCleanup.call(this, dirPath);
        if (!injectedConcurrentChild && path.resolve(backupFsPortForConcurrentCleanup.resolvePath(String(dirPath))) === path.resolve(concurrentCleanupDir)) {
          injectedConcurrentChild = true;
          fs.writeFileSync(path.join(concurrentCleanupDir, "sync-child.txt"), "sync");
        }
        return entries;
      };
      const concurrentCleanupRemoved = await plugin.moveService.deleteDirectoryRecursiveAsync(concurrentCleanupPath);
      assert(concurrentCleanupRemoved === false, "Directory cleanup reported success after Sync created a child outside its snapshot");
    } finally {
      backupFsPortForConcurrentCleanup.listEntries = originalListEntriesForConcurrentCleanup;
    }
    assert(fs.existsSync(path.join(concurrentCleanupDir, "sync-child.txt")), "Directory cleanup deleted a Sync-created child");
    assert(fs.existsSync(concurrentCleanupDir), "Directory cleanup recursively removed a directory that gained a new child");

    const replacementCleanupDir = path.join(retentionRoot, "replacement-cleanup");
    const replacementCleanupPath = `${retentionRootPath}/replacement-cleanup`;
    const replacementCleanupFile = path.join(replacementCleanupDir, "snapshot.txt");
    fs.mkdirSync(replacementCleanupDir, { recursive: true });
    fs.writeFileSync(replacementCleanupFile, "snapshot-old");
    const originalRemoveMatchingVersion = plugin.moveService.removeFileVersionIfContentMatches;
    let replacementCleanupInjected = false;
    try {
      plugin.moveService.removeFileVersionIfContentMatches = async function(filePath, expectedSha256) {
        if (!replacementCleanupInjected && path.resolve(backupFsPortForConcurrentCleanup.resolvePath(String(filePath))) === path.resolve(replacementCleanupFile)) {
          replacementCleanupInjected = true;
          fs.writeFileSync(replacementCleanupFile, "sync-same-name-replacement");
        }
        return await originalRemoveMatchingVersion.call(this, filePath, expectedSha256);
      };
      const replacementCleanupRemoved = await plugin.moveService.deleteDirectoryRecursiveAsync(replacementCleanupPath);
      assert(replacementCleanupRemoved === false, "Directory cleanup reported success after a same-name file replacement");
    } finally {
      plugin.moveService.removeFileVersionIfContentMatches = originalRemoveMatchingVersion;
    }
    assert(replacementCleanupInjected, "Directory cleanup replacement test did not reach the conditional deletion boundary");
    assert(fs.existsSync(replacementCleanupFile) && fs.readFileSync(replacementCleanupFile, "utf8") === "sync-same-name-replacement", "Directory cleanup deleted the same-name replacement published after its hash snapshot");
  } finally {
    fs.rmSync(backupTemp, { recursive: true, force: true });
  }

  // ==== Mobile platform profile ====
  // Re-evaluates the built bundle with every Node/Electron module banned and a
  // DataAdapter-only fake app, then drives init -> compress -> cache ->
  // move+backup -> validated restore/rollback -> async unload flush. Cache keys must stay
  // byte-identical to Node crypto (desktop) output.
  await withTestTimeout("mobile platform profile", (async () => {
    const MobileObsidianMock = require("obsidian");
    const originalPlatformState = { ...MobileObsidianMock.Platform };
	    const previousMobileWorker = global.Worker;
    const stubbedSetTimeout = global.setTimeout;
    const stubbedClearTimeout = global.clearTimeout;
    const artifactPath = require.resolve(artifact);
    const mobileTemp = fs.mkdtempSync(path.join(os.tmpdir(), "lic-mobile-"));
	    const originalConsoleErrorForMobile = console.error;
	    try {
	      const mobileJournalDir = ".local-image-compress/recovery";
	      const mobileLegacyJournalPath = `${mobileJournalDir}/mobile-replacement-journal-v1.json`;
	      const mobileJournalFilePattern = /^mobile-replacement-journal-v2-[a-f0-9]{32}-[a-f0-9]{32}\.json$/i;
	      const serializeMobileJournal = (journal) => {
	        const payload = {
	          version: 2,
	          ownerId: journal.ownerId,
	          transactionId: journal.transactionId,
	          stagedPath: journal.stagedPath,
	          targetPath: journal.targetPath,
	          rollbackPath: journal.rollbackPath,
	          stagedSha256: journal.stagedSha256,
	          expectedTargetSha256: journal.expectedTargetSha256,
	          rollbackSha256: journal.rollbackSha256,
	          phase: journal.phase
	        };
	        return JSON.stringify({ ...payload, checksum: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
	      };
	      const getMobileJournalPath = (journal) => {
	        return `${mobileJournalDir}/mobile-replacement-journal-v2-${journal.ownerId}-${journal.transactionId}.json`;
	      };
	      const isMobileJournalPath = (vaultPath) => {
	        const normalized = String(vaultPath || "").replace(/\\/g, "/");
	        return normalized === mobileLegacyJournalPath
	          || (path.posix.dirname(normalized) === mobileJournalDir && mobileJournalFilePattern.test(path.posix.basename(normalized)));
	      };
      // The bundled js-md5/js-sha256 must take their pure-JS path like on a
      // real mobile webview, not their Node crypto fast path.
      global.window.JS_SHA256_NO_NODE_JS = true;
      global.window.JS_MD5_NO_NODE_JS = true;
      global.setTimeout = originalGlobals.setTimeout;
      global.clearTimeout = originalGlobals.clearTimeout;
      Object.assign(MobileObsidianMock.Platform, {
        isDesktopApp: false,
        isMobile: true,
        isMobileApp: true,
        isWin: false,
        isMacOS: false,
        isLinux: false,
        isIosApp: true,
        isAndroidApp: false
      });
      global.Worker = class MobileFakeWorker {
        constructor() {
          this.onmessage = null;
          this.onerror = null;
        }
        postMessage(message) {
          const reply = message && message.type === "init"
            ? { id: message.id, type: "ready" }
            : { id: message && message.id, type: "result", ok: true, output: createValidEncodedOutput("jpeg") };
          queueMicrotask(() => {
            this.onmessage?.({ data: reply });
          });
        }
        terminate() {}
      };

	      const resolveMobilePath = (vaultPath) => path.join(mobileTemp, ...String(vaultPath || "").split("/").filter(Boolean));
	      let mobileReadBinaryCalls = 0;
	      let mobileBytesInFlight = 0;
	      let mobilePeakBytesInFlight = 0;
	      let mobileRenameFailure = null;
	      let mobileTrashFailure = null;
	      let mobileProcessBarrier = null;
	      const mobileLocalTrash = [];
	      const mobileAdapter = {
	        // Adversarial capability shape: mobile host must win even when an
	        // adapter happens to expose a desktop-looking method.
	        getBasePath() {
	          return mobileTemp;
	        },
        async exists(vaultPath) {
          return fs.existsSync(resolveMobilePath(vaultPath));
        },
        async stat(vaultPath) {
          try {
            const stats = fs.statSync(resolveMobilePath(vaultPath));
            return { type: stats.isDirectory() ? "folder" : "file", ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size };
          } catch {
            return null;
          }
        },
        async list(vaultPath) {
          const prefix = String(vaultPath || "").replace(/\/+$/, "");
          const listedFiles = [];
          const listedFolders = [];
          for (const entry of fs.readdirSync(resolveMobilePath(vaultPath), { withFileTypes: true })) {
            (entry.isDirectory() ? listedFolders : listedFiles).push(prefix ? `${prefix}/${entry.name}` : entry.name);
          }
          return { files: listedFiles, folders: listedFolders };
        },
        async read(vaultPath) {
          return fs.readFileSync(resolveMobilePath(vaultPath), "utf8");
        },
	        async readBinary(vaultPath) {
	          const buffer = fs.readFileSync(resolveMobilePath(vaultPath));
	          mobileReadBinaryCalls += 1;
	          mobileBytesInFlight += buffer.byteLength;
	          mobilePeakBytesInFlight = Math.max(mobilePeakBytesInFlight, mobileBytesInFlight);
	          await new Promise((resolve) => setImmediate(resolve));
	          mobileBytesInFlight -= buffer.byteLength;
	          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        },
	        async write(vaultPath, text) {
	          fs.mkdirSync(path.dirname(resolveMobilePath(vaultPath)), { recursive: true });
          fs.writeFileSync(resolveMobilePath(vaultPath), text);
        },
        async writeBinary(vaultPath, data) {
          fs.mkdirSync(path.dirname(resolveMobilePath(vaultPath)), { recursive: true });
          fs.writeFileSync(resolveMobilePath(vaultPath), Buffer.from(new Uint8Array(data)));
        },
        async mkdir(vaultPath) {
          fs.mkdirSync(resolveMobilePath(vaultPath), { recursive: true });
        },
        async rmdir(vaultPath, recursive) {
          if (recursive) {
            fs.rmSync(resolveMobilePath(vaultPath), { recursive: true, force: false });
          } else {
            fs.rmdirSync(resolveMobilePath(vaultPath));
          }
	        },
	        async remove(vaultPath) {
	          fs.unlinkSync(resolveMobilePath(vaultPath));
	        },
	        async trashLocal(vaultPath) {
	          if (mobileTrashFailure && mobileTrashFailure(String(vaultPath))) {
	            throw new Error(`Injected mobile trash failure: ${vaultPath}`);
	          }
	          const sourcePath = resolveMobilePath(vaultPath);
	          const trashPath = `.trash-local/${Date.now()}-${mobileLocalTrash.length}-${path.posix.basename(String(vaultPath))}`;
	          fs.mkdirSync(path.dirname(resolveMobilePath(trashPath)), { recursive: true });
	          fs.renameSync(sourcePath, resolveMobilePath(trashPath));
	          mobileLocalTrash.push({ sourcePath: String(vaultPath), trashPath });
	        },
	        async rename(fromPath, toPath) {
	          const renameFailureMode = mobileRenameFailure && mobileRenameFailure(String(fromPath), String(toPath));
	          if (renameFailureMode === "before") {
	            throw new Error(`Injected mobile rename failure: ${fromPath} -> ${toPath}`);
	          }
	          if (fs.existsSync(resolveMobilePath(toPath))) {
	            throw new Error(`Destination file already exists! ${toPath}`);
	          }
	          fs.mkdirSync(path.dirname(resolveMobilePath(toPath)), { recursive: true });
	          fs.renameSync(resolveMobilePath(fromPath), resolveMobilePath(toPath));
	          if (renameFailureMode === "after") {
	            throw new Error(`Injected mobile rename after-effect failure: ${fromPath} -> ${toPath}`);
	          }
	        },
	        async copy(fromPath, toPath) {
	          fs.mkdirSync(path.dirname(resolveMobilePath(toPath)), { recursive: true });
	          fs.copyFileSync(resolveMobilePath(fromPath), resolveMobilePath(toPath));
	        },
	        async process(vaultPath, update) {
	          if (mobileProcessBarrier) {
	            await mobileProcessBarrier(String(vaultPath));
	          }
	          const filePath = resolveMobilePath(vaultPath);
	          const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
	          const next = update(current);
	          fs.mkdirSync(path.dirname(filePath), { recursive: true });
	          fs.writeFileSync(filePath, next);
	          return next;
	        }
	      };
	      const listMobileJournalPaths = async () => {
	        if (!await mobileAdapter.exists(mobileJournalDir)) return [];
	        const listing = await mobileAdapter.list(mobileJournalDir);
	        return listing.files.filter(isMobileJournalPath).sort();
	      };
	      const writeMobileJournal = async (journal, journalPath = getMobileJournalPath(journal)) => {
	        const serialized = serializeMobileJournal(journal);
	        if (await mobileAdapter.exists(journalPath)) {
	          await mobileAdapter.process(journalPath, () => serialized);
	        } else {
	          await mobileAdapter.write(journalPath, serialized);
	        }
	      };
      const mobileFiles = [];
      const mobileLayoutCallbacks = [];
      const mobileApp = {
        vault: {
          configDir: ".obsidian",
          adapter: mobileAdapter,
          getFiles: () => mobileFiles,
          getAllLoadedFiles: () => [],
          on: (name) => ({ scope: "vault", name }),
          getFileByPath: (filePath) => mobileFiles.find((file) => file.path === filePath) || null,
          getAbstractFileByPath: (filePath) => mobileFiles.find((file) => file.path === filePath) || null,
          createBinary: async (filePath, data) => {
            const resolvedPath = resolveMobilePath(filePath);
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            fs.writeFileSync(resolvedPath, Buffer.from(new Uint8Array(data)), { flag: "wx" });
          },
          readBinary: async (file) => await mobileAdapter.readBinary(file.path),
          cachedRead: async () => ""
        },
        workspace: {
          activeWindow: global.window,
          onLayoutReady: (callback) => mobileLayoutCallbacks.push(callback),
          on: (name) => ({ scope: "workspace", name }),
          iterateAllLeaves: () => {},
          getActiveFile: () => null
        },
        plugins: {
          enabledPlugins: new Set(),
          disablePlugin: async () => {},
          enablePlugin: async () => {}
        }
      };

      mobileNodeModuleBan = true;
      delete require.cache[artifactPath];
      const mobileModule = require(artifact);
      const MobilePluginClass = mobileModule.default || mobileModule;
      assert(typeof MobilePluginClass === "function", "Mobile bundle evaluation did not expose the plugin class");

      const mobilePlugin = new MobilePluginClass();
      mobilePlugin.app = mobileApp;
      mobilePlugin.manifest = {
        id: "local-image-compress",
        name: "Local Image Compress",
        dir: ".obsidian/plugins/local-image-compress"
      };
      const ribbonRegistrations = [];
	      mobilePlugin.addRibbonIcon = (icon, title, callback) => {
	        ribbonRegistrations.push({ icon, title, callback });
        return createMockElement();
      };
      mobilePlugin.onload();
      for (const callback of mobileLayoutCallbacks) {
        callback();
      }
      await mobilePlugin.initializationPromise;
      assert(mobilePlugin.isInitialized === true, `Mobile plugin initialization failed: ${mobilePlugin.initializationError}`);
      assert(mobilePlugin.cache.ports.fs.sync === null, "Mobile profile did not select the adapter fs port");
      assert(mobilePlugin.cache.ports.fs.restoreProbe === null, "Mobile profile unexpectedly exposes a restore probe");
	      assert(ribbonRegistrations.length === 1, "Mobile profile did not register the ribbon menu trigger");
	      const originalMobileShowMenu = mobilePlugin.statusBarController.showMenu;
	      let mobileRibbonMenuCalls = 0;
	      mobilePlugin.statusBarController.showMenu = async () => {
	        mobileRibbonMenuCalls += 1;
	      };
	      await ribbonRegistrations[0].callback({ preventDefault() {} });
	      mobilePlugin.statusBarController.showMenu = originalMobileShowMenu;
	      assert(mobileRibbonMenuCalls === 1, "Mobile ribbon action did not open the status menu");
	      assert(await mobileAdapter.exists(".obsidian/plugins/local-image-compress/tinyLocal-cache.json"), "Mobile cache file was not created through the adapter");
	      assert(mobilePlugin.compressor.activeWorkerCount === 1, `Mobile worker pool must stay at 1, got ${mobilePlugin.compressor.activeWorkerCount}`);
	      assert(mobilePlugin.cache.ports.fs.writeExclusive === null, "Mobile profile still exposes a false exclusive-create capability");
	      assert(typeof mobilePlugin.cache.ports.fs.processTextAtomically === "function", "Mobile profile does not expose atomic text processing");
	      const originalMobileMkdir = mobileAdapter.mkdir;
	      mobileAdapter.mkdir = async (vaultPath) => {
	        await originalMobileMkdir(vaultPath);
	        if (vaultPath === "Race/Nested") {
	          throw new Error("simulated duplicate mkdir race");
	        }
	      };
	      try {
	        await mobilePlugin.getPlatformPorts().fs.mkdir("Race/Nested");
	      } finally {
	        mobileAdapter.mkdir = originalMobileMkdir;
	      }
	      assert(await mobileAdapter.exists("Race/Nested"), "Mobile FsPort did not tolerate a duplicate mkdir race");

	      const budgetFs = mobilePlugin.getPlatformPorts().fs;
	      const budgetFile = Object.assign(new MobileObsidianMock.TFile(), createMockFile("Budget/shared.bin", 16, 1));
	      await mobileAdapter.writeBinary(budgetFile.path, toArrayBuffer(Buffer.alloc(16, 0x5a)));
	      mobileFiles.push(budgetFile);
	      let releaseHeldBudget = null;
	      let markBudgetEntered = null;
	      const budgetEntered = new Promise((resolve) => { markBudgetEntered = resolve; });
	      const heldBudget = budgetFs.runBufferedOperation(async () => {
	        markBudgetEntered();
	        await new Promise((resolve) => { releaseHeldBudget = resolve; });
	      });
	      await budgetEntered;
	      const readsBeforeQueuedBudgetWork = mobileReadBinaryCalls;
	      const queuedHash = mobilePlugin.getPlatformPorts().hash.fileSha256Hex(budgetFile.path);
	      const queuedCacheFingerprint = mobilePlugin.cache.getFileMd5(budgetFile);
	      await new Promise((resolve) => setImmediate(resolve));
	      assert(mobileReadBinaryCalls === readsBeforeQueuedBudgetWork, "Hash/cache full-buffer reads started while another mobile budget owner was active");
	      releaseHeldBudget();
	      await heldBudget;
	      const [budgetHash, budgetMd5] = await Promise.all([queuedHash, queuedCacheFingerprint]);
	      assert(budgetHash === crypto.createHash("sha256").update(Buffer.alloc(16, 0x5a)).digest("hex") && budgetMd5 === crypto.createHash("md5").update(Buffer.alloc(16, 0x5a)).digest("hex"), "Queued mobile budget operations returned incorrect hashes");

	      const originalBudgetStat = mobileAdapter.stat;
	      const originalBudgetReadBinary = mobileAdapter.readBinary;
	      const growthPath = "Budget/growth.bin";
	      const mobileBufferedLimit = mobilePlugin.getPlatformPorts().runtime.maxBufferedFileBytes;
	      assert(typeof mobileBufferedLimit === "number", "Mobile profile is missing its buffered byte limit");
	      try {
	        mobileAdapter.stat = async (vaultPath) => String(vaultPath) === growthPath
	          ? { type: "file", ctime: 1, mtime: 1, size: 1 }
	          : await originalBudgetStat.call(mobileAdapter, vaultPath);
	        mobileAdapter.readBinary = async (vaultPath) => String(vaultPath) === growthPath
	          ? new ArrayBuffer(mobileBufferedLimit + 1)
	          : await originalBudgetReadBinary.call(mobileAdapter, vaultPath);
	        await assert.rejects(() => mobilePlugin.getPlatformPorts().hash.fileSha256Hex(growthPath), /maintenance limit after read/);
	      } finally {
	        mobileAdapter.stat = originalBudgetStat;
	        mobileAdapter.readBinary = originalBudgetReadBinary;
	      }

	      const growthTextPath = "Budget/growth.txt";
	      const oversizedStatTextPath = "Budget/oversized-stat.txt";
	      const originalBudgetReadText = mobileAdapter.read;
	      let oversizedTextRead = false;
	      let oversizedStatTextReads = 0;
	      try {
	        mobileAdapter.stat = async (vaultPath) => {
	          if (String(vaultPath) === growthTextPath) return { type: "file", ctime: 1, mtime: 1, size: 1 };
	          if (String(vaultPath) === oversizedStatTextPath) return { type: "file", ctime: 1, mtime: 1, size: mobileBufferedLimit + 1 };
	          return await originalBudgetStat.call(mobileAdapter, vaultPath);
	        };
	        mobileAdapter.read = async (vaultPath) => {
	          if (String(vaultPath) === growthTextPath) {
	            oversizedTextRead = true;
	            return "x".repeat(mobileBufferedLimit + 1);
	          }
	          if (String(vaultPath) === oversizedStatTextPath) {
	            oversizedStatTextReads += 1;
	            return "must-not-be-read";
	          }
	          return await originalBudgetReadText.call(mobileAdapter, vaultPath);
	        };
	        await assert.rejects(() => budgetFs.readText(oversizedStatTextPath), /maintenance limit:/);
	        assert(oversizedStatTextReads === 0, "Mobile readText ignored its pre-read stat limit");
	        await assert.rejects(() => budgetFs.readText(growthTextPath), /maintenance limit after read/);
	      } finally {
	        mobileAdapter.stat = originalBudgetStat;
	        mobileAdapter.read = originalBudgetReadText;
	      }
	      assert(oversizedTextRead, "Mobile readText did not exercise its post-read UTF-8 byte limit after stale stat");

	      const serializedTextPath = "Budget/serialized.txt";
	      const serializedBinaryPath = "Budget/serialized.bin";
	      await mobileAdapter.write(serializedTextPath, "serialized-text");
	      await mobileAdapter.writeBinary(serializedBinaryPath, toArrayBuffer(Buffer.from("serialized-binary")));
	      const serializedReadText = mobileAdapter.read;
	      const serializedReadBinary = mobileAdapter.readBinary;
	      let activeBufferedAdapterReads = 0;
	      let peakBufferedAdapterReads = 0;
	      let serializedBinaryReadCalls = 0;
	      let releaseSerializedTextRead = null;
	      let markSerializedTextRead = null;
	      let holdSerializedTextRead = true;
	      const serializedTextReadEntered = new Promise((resolve) => { markSerializedTextRead = resolve; });
	      const trackBufferedAdapterRead = async (operation) => {
	        activeBufferedAdapterReads += 1;
	        peakBufferedAdapterReads = Math.max(peakBufferedAdapterReads, activeBufferedAdapterReads);
	        try {
	          return await operation();
	        } finally {
	          activeBufferedAdapterReads -= 1;
	        }
	      };
	      try {
	        mobileAdapter.read = async (vaultPath) => await trackBufferedAdapterRead(async () => {
	          if (holdSerializedTextRead && String(vaultPath) === serializedTextPath) {
	            markSerializedTextRead();
	            await new Promise((resolve) => { releaseSerializedTextRead = resolve; });
	          }
	          return await serializedReadText.call(mobileAdapter, vaultPath);
	        });
	        mobileAdapter.readBinary = async (vaultPath) => await trackBufferedAdapterRead(async () => {
	          if (String(vaultPath) === serializedBinaryPath) {
	            serializedBinaryReadCalls += 1;
	          }
	          return await serializedReadBinary.call(mobileAdapter, vaultPath);
	        });
	        const serializedTextPromise = budgetFs.readText(serializedTextPath);
	        await serializedTextReadEntered;
	        const serializedBinaryPromise = budgetFs.readBinary(serializedBinaryPath);
	        await new Promise((resolve) => setImmediate(resolve));
	        assert(serializedBinaryReadCalls === 0 && peakBufferedAdapterReads === 1, "Mobile binary read overlapped an active text full-buffer read");
	        holdSerializedTextRead = false;
	        releaseSerializedTextRead();
	        const [serializedText, serializedBinary] = await Promise.all([serializedTextPromise, serializedBinaryPromise]);
	        assert(serializedText === "serialized-text" && Buffer.from(serializedBinary).toString("utf8") === "serialized-binary", "Serialized mobile text/binary reads returned incorrect data");
	        await withTestTimeout("nested mobile buffered-operation token", budgetFs.runBufferedOperation(async (token) => {
	          await budgetFs.runBufferedOperation(async (nestedToken) => {
	            assert(nestedToken === token, "Nested mobile buffered operation changed its ownership token");
	            assert(await budgetFs.readText(serializedTextPath, nestedToken) === "serialized-text", "Nested-token mobile text read returned incorrect data");
	            assert(Buffer.from(await budgetFs.readBinary(serializedBinaryPath, nestedToken)).toString("utf8") === "serialized-binary", "Nested-token mobile binary read returned incorrect data");
	            assert(
	              await mobilePlugin.getPlatformPorts().hash.fileSha256Hex(serializedBinaryPath, nestedToken) === crypto.createHash("sha256").update(Buffer.from("serialized-binary")).digest("hex"),
	              "Nested-token mobile hash returned incorrect data"
	            );
	          }, token);
	        }), 1000);
	        assert(peakBufferedAdapterReads === 1, `Mobile full-buffer adapter reads overlapped: ${peakBufferedAdapterReads}`);
	      } finally {
	        if (holdSerializedTextRead && releaseSerializedTextRead) {
	          releaseSerializedTextRead();
	        }
	        mobileAdapter.read = serializedReadText;
	        mobileAdapter.readBinary = serializedReadBinary;
	      }

	      const originalMobileSetting = MobileObsidianMock.Setting;
	      const originalMobileNotice = MobileObsidianMock.Notice;
	      const originalMobileBackups = mobilePlugin.cache.getAvailableBackups;
	      const originalMobileRestore = mobilePlugin.cache.restoreFromBackup;
	      const originalMobileRebuild = mobilePlugin.rebuildImageIndex;
	      const originalMobileStatusUpdate = mobilePlugin.statusBarController.update;
	      const mobileNotices = [];
	      let restoreDropdownChange = null;
	      let restoreRebuildCalls = 0;
	      let restoreStatusCalls = 0;
	      try {
	        MobileObsidianMock.Setting = class {
	          constructor() {}
	          setName() { return this; }
	          setDesc() { return this; }
	          setHeading() { return this; }
	          setDisabled() { return this; }
	          addButton(callback) {
	            const button = { setButtonText() { return button; }, onClick() { return button; } };
	            callback(button);
	            return this;
	          }
	          addDropdown(callback) {
	            const dropdown = {
	              addOption() { return dropdown; },
	              onChange(handler) { restoreDropdownChange = handler; return dropdown; }
	            };
	            callback(dropdown);
	            return this;
	          }
	        };
	        MobileObsidianMock.Notice = class {
	          constructor(message) { mobileNotices.push(String(message)); }
	        };
	        mobilePlugin.cache.getAvailableBackups = async () => ["tinyLocal-cache-backup-2026-01-01T00-00-00-000.json"];
	        mobilePlugin.cache.restoreFromBackup = async () => false;
	        mobilePlugin.rebuildImageIndex = async () => { restoreRebuildCalls += 1; };
	        mobilePlugin.statusBarController.update = async () => { restoreStatusCalls += 1; };
	        await mobilePlugin.settingsTab.renderCacheBackupsSection(createMockElement());
	        assert(typeof restoreDropdownChange === "function", "Mobile restore-capable settings did not wire the dropdown action");
	        await restoreDropdownChange("tinyLocal-cache-backup-2026-01-01T00-00-00-000.json");
	        assert(restoreRebuildCalls === 0 && restoreStatusCalls === 0, "Failed restore still rebuilt the index or updated status");
	        assert(mobileNotices.some((message) => message.includes("Operation failed")) && !mobileNotices.some((message) => message.includes("Cache cleared")), "Failed restore emitted a success-like Notice");
	      } finally {
	        MobileObsidianMock.Setting = originalMobileSetting;
	        MobileObsidianMock.Notice = originalMobileNotice;
	        mobilePlugin.cache.getAvailableBackups = originalMobileBackups;
	        mobilePlugin.cache.restoreFromBackup = originalMobileRestore;
	        mobilePlugin.rebuildImageIndex = originalMobileRebuild;
	        mobilePlugin.statusBarController.update = originalMobileStatusUpdate;
	      }

	      const mobileCachePath = ".obsidian/plugins/local-image-compress/tinyLocal-cache.json";
	      await mobileAdapter.remove(mobileCachePath);
	      const emptyMobileCache = JSON.stringify({ entries: {}, version: "2.0.0" });
	      const concurrentEntry = (pathValue, timestamp) => ({
	        path: pathValue,
	        md5: "",
	        mtime: timestamp,
	        timestamp,
	        lastAccessMs: timestamp,
	        originalSize: 1,
	        sourceMtime: timestamp,
	        sourceSize: 1,
	        state: "skipped",
	        stateUpdatedAt: timestamp,
	        skipReason: "too_large",
	        compressionSettingsKey: "png:limits:25:50:too_large"
	      });
	      const concurrentPayloadA = JSON.stringify({ entries: { "v2:mobile-a": concurrentEntry("Images/mobile-a.png", 101) }, version: "2.0.0" });
	      const concurrentPayloadB = JSON.stringify({ entries: { "v2:mobile-b": concurrentEntry("Images/mobile-b.png", 102) }, version: "2.0.0" });
	      await Promise.all([
	        mobilePlugin.cache.ports.fs.processTextAtomically(mobileCachePath, emptyMobileCache, (current) => mobilePlugin.cache.buildMergedCachePayload(concurrentPayloadA, current)),
	        mobilePlugin.cache.ports.fs.processTextAtomically(mobileCachePath, emptyMobileCache, (current) => mobilePlugin.cache.buildMergedCachePayload(concurrentPayloadB, current))
	      ]);
	      const concurrentCache = JSON.parse(await mobileAdapter.read(mobileCachePath));
	      const concurrentCachePaths = new Set(Object.values(concurrentCache.entries).map((entry) => entry.path));
	      assert(concurrentCachePaths.has("Images/mobile-a.png") && concurrentCachePaths.has("Images/mobile-b.png"), "Concurrent initial mobile cache writes lost an entry");

	      await mobileAdapter.remove(mobileCachePath);
	      const originalCreateBinaryForExternalCacheCreate = mobileApp.vault.createBinary;
	      let externalCacheCreateInjected = false;
	      mobileApp.vault.createBinary = async (filePath, data) => {
	        if (!externalCacheCreateInjected && String(filePath) === mobileCachePath) {
	          externalCacheCreateInjected = true;
	          await mobileAdapter.write(mobileCachePath, concurrentPayloadB);
	        }
	        return await originalCreateBinaryForExternalCacheCreate.call(mobileApp.vault, filePath, data);
	      };
	      try {
	        await mobilePlugin.cache.ports.fs.processTextAtomically(
	          mobileCachePath,
	          emptyMobileCache,
	          (current) => mobilePlugin.cache.buildMergedCachePayload(concurrentPayloadA, current)
	        );
	      } finally {
	        mobileApp.vault.createBinary = originalCreateBinaryForExternalCacheCreate;
	      }
	      const externallyCreatedCache = JSON.parse(await mobileAdapter.read(mobileCachePath));
	      const externallyCreatedPaths = new Set(Object.values(externallyCreatedCache.entries).map((entry) => entry.path));
	      assert(externalCacheCreateInjected && externallyCreatedPaths.has("Images/mobile-a.png") && externallyCreatedPaths.has("Images/mobile-b.png"), "Mobile cache initialization overwrote a cache created concurrently by Sync");
	      const mobilePluginDirListing = await mobileAdapter.list(".obsidian/plugins/local-image-compress");
	      assert(!mobilePluginDirListing.files.some((filePath) => String(filePath).includes(".tinylocal-init-")), "Mobile cache initialization left an owned temp file");

	      const mobileFs = mobilePlugin.getPlatformPorts().fs;
	      for (const invalidMobilePath of ["/tmp/absolute-mobile.bin", "C:\\Vault\\absolute-mobile.bin", "../mobile-traversal.bin"]) {
	        await assert.rejects(
	          () => mobileFs.readText(invalidMobilePath),
	          /requires a vault-relative path/,
	          `Mobile FsPort accepted a non-vault-relative path: ${invalidMobilePath}`
	        );
	        await assert.rejects(
	          () => mobileFs.fsyncBestEffort(invalidMobilePath),
	          /requires a vault-relative path/,
	          `Mobile FsPort.fsyncBestEffort hid a non-vault-relative path: ${invalidMobilePath}`
	        );
	      }
	      const exclusiveCopySource = "Exclusive/source.bin";
	      const exclusiveCopyTarget = "Exclusive/target.bin";
	      await mobileAdapter.writeBinary(exclusiveCopySource, toArrayBuffer(Buffer.from("exclusive-source")));
	      const originalCreateBinaryForExclusiveCopy = mobileApp.vault.createBinary;
	      let concurrentExclusiveTargetInjected = false;
	      mobileApp.vault.createBinary = async (filePath, data) => {
	        if (!concurrentExclusiveTargetInjected && String(filePath) === exclusiveCopyTarget) {
	          concurrentExclusiveTargetInjected = true;
	          await mobileAdapter.writeBinary(exclusiveCopyTarget, toArrayBuffer(Buffer.from("sync-winner")));
	        }
	        return await originalCreateBinaryForExclusiveCopy.call(mobileApp.vault, filePath, data);
	      };
	      try {
	        await assert.rejects(() => mobileFs.copyFile(exclusiveCopySource, exclusiveCopyTarget, { exclusive: true }));
	      } finally {
	        mobileApp.vault.createBinary = originalCreateBinaryForExclusiveCopy;
	      }
	      assert(concurrentExclusiveTargetInjected, "Mobile exclusive-copy race did not inject a concurrent destination");
	      assert.equal(await mobileAdapter.read(exclusiveCopyTarget), "sync-winner", "Mobile exclusive copy overwrote the concurrently published destination");

	      const mobileCleanupBoundaryPath = "Cleanup/final-boundary.bin";
	      const mobileCleanupBoundaryBytes = Buffer.from("mobile-cleanup-owned-revision");
	      const mobileCleanupReplacementBytes = Buffer.from("mobile-sync-replacement-at-trash-boundary");
	      await mobileAdapter.writeBinary(mobileCleanupBoundaryPath, toArrayBuffer(mobileCleanupBoundaryBytes));
	      const originalTrashLocalForCleanupBoundary = mobileAdapter.trashLocal;
	      let mobileCleanupBoundaryInjected = false;
	      mobileAdapter.trashLocal = async (vaultPath) => {
	        if (!mobileCleanupBoundaryInjected && path.posix.basename(String(vaultPath)).startsWith("final-boundary.bin.delete-")) {
	          mobileCleanupBoundaryInjected = true;
	          await mobileAdapter.writeBinary(vaultPath, toArrayBuffer(mobileCleanupReplacementBytes));
	        }
	        await originalTrashLocalForCleanupBoundary.call(mobileAdapter, vaultPath);
	      };
	      let mobileCleanupBoundaryResult;
	      try {
	        mobileCleanupBoundaryResult = await mobileFs.removeFileIfUnchanged(
	          mobileCleanupBoundaryPath,
	          crypto.createHash("sha256").update(mobileCleanupBoundaryBytes).digest("hex")
	        );
	      } finally {
	        mobileAdapter.trashLocal = originalTrashLocalForCleanupBoundary;
	      }
	      const mobileCleanupTrashEntry = mobileLocalTrash.find((entry) => path.posix.basename(entry.sourcePath).startsWith("final-boundary.bin.delete-"));
	      assert(mobileCleanupBoundaryResult.removed && mobileCleanupBoundaryResult.retainedConflictPath === null, "Mobile conditional cleanup did not logically remove its verified revision");
	      assert(mobileCleanupBoundaryInjected && mobileCleanupTrashEntry, "Mobile cleanup regression did not inject at the final trash boundary");
	      assert.equal(await mobileAdapter.read(mobileCleanupTrashEntry.trashPath), mobileCleanupReplacementBytes.toString(), "Mobile cleanup destroyed a Sync replacement published after its final hash check");

	      const mobileTrashFailurePath = "Cleanup/trash-failure.bin";
	      const mobileTrashFailureBytes = Buffer.from("mobile-cleanup-trash-failure-owned-revision");
	      await mobileAdapter.writeBinary(mobileTrashFailurePath, toArrayBuffer(mobileTrashFailureBytes));
	      const originalTrashLocalForFailure = mobileAdapter.trashLocal;
	      let mobileTrashFailureCalls = 0;
	      mobileAdapter.trashLocal = async (vaultPath) => {
	        if (path.posix.basename(String(vaultPath)).startsWith("trash-failure.bin.delete-")) {
	          mobileTrashFailureCalls += 1;
	          throw new Error("simulated unavailable local trash");
	        }
	        await originalTrashLocalForFailure.call(mobileAdapter, vaultPath);
	      };
	      let mobileTrashFailureResult;
	      try {
	        mobileTrashFailureResult = await mobileFs.removeFileIfUnchanged(
	          mobileTrashFailurePath,
	          crypto.createHash("sha256").update(mobileTrashFailureBytes).digest("hex")
	        );
	      } finally {
	        mobileAdapter.trashLocal = originalTrashLocalForFailure;
	      }
	      assert(!mobileTrashFailureResult.removed && mobileTrashFailureResult.retainedConflictPath, "Mobile cleanup did not report its single retained revision when local trash failed");
	      assert(!await mobileAdapter.exists(mobileTrashFailurePath), "Mobile cleanup restored a failed-trash revision to the recovery journal path");
	      assert(await mobileAdapter.exists(mobileTrashFailureResult.retainedConflictPath), "Mobile cleanup lost the detached revision after local trash failed");
	      const mobileTrashFailureDirectory = path.posix.dirname(mobileTrashFailureResult.retainedConflictPath);
	      const countMobileTrashFailureCopies = async () => (await mobileAdapter.list(mobileTrashFailureDirectory)).files
	        .filter((filePath) => path.posix.basename(String(filePath)).startsWith("trash-failure.bin.delete-")).length;
	      const retainedMobileTrashFailureCopies = await countMobileTrashFailureCopies();
	      await mobileFs.recoverInterruptedReplacement();
	      await mobileFs.recoverInterruptedReplacement();
	      assert(mobileTrashFailureCalls === 1 && retainedMobileTrashFailureCopies === 1 && await countMobileTrashFailureCopies() === 1, "Repeated mobile recovery amplified a retained failed-trash revision");

	      const mobileLifecycleTarget = "Replacement/lifecycle-final-target.bin";
	      const mobileLifecycleStage = `Replacement/.lifecycle-final-target.bin.tinylocal-${Date.now()}-${"a".repeat(32)}.tmp`;
	      const mobileLifecycleTargetBytes = Buffer.from("mobile-lifecycle-old-target");
	      const mobileLifecycleStageBytes = Buffer.from("mobile-lifecycle-new-stage");
	      await mobileAdapter.writeBinary(mobileLifecycleTarget, toArrayBuffer(mobileLifecycleTargetBytes));
	      await mobileAdapter.writeBinary(mobileLifecycleStage, toArrayBuffer(mobileLifecycleStageBytes));
	      const originalReadBinaryForLifecycleFence = mobileAdapter.readBinary;
	      let lifecycleStageReads = 0;
	      let mobileLifecycleCanCommit = true;
	      let mobileCanCommitCalls = 0;
	      let lifecycleStageReadsAtCommit = 0;
	      mobileAdapter.readBinary = async (vaultPath) => {
	        const data = await originalReadBinaryForLifecycleFence.call(mobileAdapter, vaultPath);
	        if (String(vaultPath) === mobileLifecycleStage && ++lifecycleStageReads === 2) {
	          mobileLifecycleCanCommit = false;
	        }
	        return data;
	      };
	      try {
	        await assert.rejects(
	          () => mobileFs.replaceFile(mobileLifecycleStage, mobileLifecycleTarget, {
	            expectedTargetSha256: crypto.createHash("sha256").update(mobileLifecycleTargetBytes).digest("hex"),
	            expectedStagedSha256: crypto.createHash("sha256").update(mobileLifecycleStageBytes).digest("hex"),
	            canCommit: () => {
	              mobileCanCommitCalls += 1;
	              lifecycleStageReadsAtCommit = lifecycleStageReads;
	              return mobileLifecycleCanCommit;
	            }
	          }),
	          /cancelled before publication/
	        );
	      } finally {
	        mobileAdapter.readBinary = originalReadBinaryForLifecycleFence;
	      }
	      assert(lifecycleStageReadsAtCommit === 2 && mobileCanCommitCalls === 1, "Mobile replacement did not evaluate lifecycle ownership after the final staged read");
	      assert.equal(await mobileAdapter.read(mobileLifecycleTarget), mobileLifecycleTargetBytes.toString(), "Mobile final lifecycle fence failed to preserve the old target");

	      await mobileAdapter.writeBinary("Replacement/target.bin", toArrayBuffer(Buffer.from("old")));
	      const stagedReplacementPath = "Replacement/target.bin.tinylocal-1-0123456789abcdef.tmp";
	      await mobileAdapter.writeBinary(stagedReplacementPath, toArrayBuffer(Buffer.from("new")));
	      const originalCreateBinaryForReplacementFailure = mobileApp.vault.createBinary;
	      let replacementCreateFailureInjected = false;
	      mobileApp.vault.createBinary = async (filePath, data) => {
	        if (!replacementCreateFailureInjected && String(filePath) === "Replacement/target.bin") {
	          replacementCreateFailureInjected = true;
	          throw new Error(`Injected mobile createBinary failure: ${filePath}`);
	        }
	        return await originalCreateBinaryForReplacementFailure.call(mobileApp.vault, filePath, data);
	      };
	      try {
	        await assert.rejects(() => mobileFs.replaceFile(stagedReplacementPath, "Replacement/target.bin"), /Injected mobile createBinary failure/);
	      } finally {
	        mobileApp.vault.createBinary = originalCreateBinaryForReplacementFailure;
	      }
	      assert.equal(await mobileAdapter.read("Replacement/target.bin"), "old", "Mobile replacement failure did not restore the original target");

	      const afterEffectPath = "Replacement/target.bin.tinylocal-2-0123456789abcdef.tmp";
	      await mobileAdapter.writeBinary(afterEffectPath, toArrayBuffer(Buffer.from("after")));
	      const originalCreateBinaryForAfterEffect = mobileApp.vault.createBinary;
	      let replacementAfterEffectInjected = false;
	      mobileApp.vault.createBinary = async (filePath, data) => {
	        const result = await originalCreateBinaryForAfterEffect.call(mobileApp.vault, filePath, data);
	        if (!replacementAfterEffectInjected && String(filePath) === "Replacement/target.bin") {
	          replacementAfterEffectInjected = true;
	          throw new Error(`Injected mobile createBinary after-effect failure: ${filePath}`);
	        }
	        return result;
	      };
	      try {
	        await mobileFs.replaceFile(afterEffectPath, "Replacement/target.bin");
	      } finally {
	        mobileApp.vault.createBinary = originalCreateBinaryForAfterEffect;
	      }
	      assert.equal(await mobileAdapter.read("Replacement/target.bin"), "after", "Mobile replacement rejected a createBinary operation that had already landed");

	      const cleanupPath = "Replacement/target.bin.tinylocal-3-0123456789abcdef.tmp";
	      await mobileAdapter.writeBinary(cleanupPath, toArrayBuffer(Buffer.from("clean")));
	      const originalRemoveForReplacementCleanup = mobileAdapter.remove;
	      mobileAdapter.remove = async (vaultPath) => {
	        if (String(vaultPath).includes("tinylocal-rollback")) {
	          throw new Error(`Injected mobile transaction cleanup failure: ${vaultPath}`);
	        }
	        await originalRemoveForReplacementCleanup.call(mobileAdapter, vaultPath);
	      };
	      let cleanupReplacement;
	      try {
	        cleanupReplacement = await mobileFs.replaceFile(cleanupPath, "Replacement/target.bin");
	      } finally {
	        mobileAdapter.remove = originalRemoveForReplacementCleanup;
	      }
	      assert(cleanupReplacement.leftoverRollbackPath && await mobileAdapter.exists(cleanupReplacement.leftoverRollbackPath), "Mobile replacement did not report a leftover rollback file");
	      const cleanupJournalPaths = await listMobileJournalPaths();
	      assert(cleanupJournalPaths.length === 0, "Resolved mobile replacement retained a stale recovery journal");
	      await mobileFs.recoverInterruptedReplacement();
	      assert(await mobileAdapter.exists(cleanupReplacement.leftoverRollbackPath), "Startup maintenance deleted the exact rollback safety copy using mutable canonical proof");

	      const noTrashTarget = "Replacement/no-vault-trash.bin";
	      const noTrashStage = "Replacement/no-vault-trash.bin.tinylocal-4-0123456789abcdef.tmp";
	      await mobileAdapter.writeBinary(noTrashTarget, toArrayBuffer(Buffer.from("old")));
	      await mobileAdapter.writeBinary(noTrashStage, toArrayBuffer(Buffer.from("new")));
	      const mobileTrashCountBeforeReplacement = mobileLocalTrash.length;
	      await mobileFs.replaceFile(noTrashStage, noTrashTarget);
	      assert.equal(mobileLocalTrash.length, mobileTrashCountBeforeReplacement, "Successful mobile replacement accumulated transaction files in the user-visible Vault trash");

	      const originalJournalWrite = mobileAdapter.write;
	      const journalWriteTarget = "Replacement/journal-write.bin";
	      const journalWriteStage = "Replacement/journal-write.bin.tinylocal-8-0123456789abcdef.tmp";
	      await mobileAdapter.writeBinary(journalWriteTarget, toArrayBuffer(Buffer.from("journal-write-old")));
	      await mobileAdapter.writeBinary(journalWriteStage, toArrayBuffer(Buffer.from("journal-write-new")));
	      mobileAdapter.write = async (vaultPath, value) => {
	        if (isMobileJournalPath(vaultPath)) throw new Error("Injected journal write failure");
	        await originalJournalWrite(vaultPath, value);
	      };
	      await assert.rejects(() => mobileFs.replaceFile(journalWriteStage, journalWriteTarget), /Injected journal write failure/);
	      mobileAdapter.write = originalJournalWrite;
	      assert.equal(await mobileAdapter.read(journalWriteTarget), "journal-write-old", "Journal write failure changed the replacement target");
	      assert(await mobileAdapter.exists(journalWriteStage), "Journal write failure removed the staged file");

	      const journalRemoveTarget = "Replacement/journal-remove.bin";
	      const journalRemoveStage = "Replacement/journal-remove.bin.tinylocal-9-0123456789abcdef.tmp";
	      await mobileAdapter.writeBinary(journalRemoveTarget, toArrayBuffer(Buffer.from("journal-remove-old")));
	      await mobileAdapter.writeBinary(journalRemoveStage, toArrayBuffer(Buffer.from("journal-remove-new")));
	      mobileAdapter.remove = async (vaultPath) => {
	        if (String(vaultPath).includes("mobile-replacement-journal-v2-")) {
	          throw new Error(`Injected mobile journal cleanup failure: ${vaultPath}`);
	        }
	        await originalRemoveForReplacementCleanup.call(mobileAdapter, vaultPath);
	      };
	      try {
	        await mobileFs.replaceFile(journalRemoveStage, journalRemoveTarget);
	      } finally {
	        mobileAdapter.remove = originalRemoveForReplacementCleanup;
	      }
	      assert.equal(await mobileAdapter.read(journalRemoveTarget), "journal-remove-new", "Journal cleanup failure reverted a successful replacement");
	      const detachedJournalPaths = (await mobileAdapter.list(mobileJournalDir)).files
	        .filter((filePath) => path.posix.basename(String(filePath)).includes("mobile-replacement-journal-v2-") && String(filePath).includes(".json.delete-"));
	      assert(detachedJournalPaths.length === 1 && await mobileAdapter.exists(detachedJournalPaths[0]), "Journal cleanup failure did not retain exactly one detached terminal journal");
	      assert((await listMobileJournalPaths()).length === 0, "Journal cleanup failure restored a terminal journal to the active recovery namespace");
	      await mobileFs.recoverInterruptedReplacement();
	      assert(await mobileAdapter.exists(detachedJournalPaths[0]), "Startup maintenance destroyed the detached terminal journal after cleanup failed");
	      assert((await mobileAdapter.list(mobileJournalDir)).files.filter((filePath) => String(filePath).includes(".json.delete-")).length === 1, "Repeated mobile recovery amplified a detached terminal journal");

	      const localDeviceOwner = mockLocalStorage.get("local-image-compress:device-owner-v1");
	      assert(/^[a-f0-9]{32}$/i.test(localDeviceOwner || ""), "Mobile replacement did not persist a device-local owner identity");
	      const foreignDeviceOwner = localDeviceOwner === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32);
	      const sha256Text = (value) => crypto.createHash("sha256").update(value).digest("hex");
	      let recoveryCaseId = 100;
	      const createRecoveryState = async ({ ownerId = localDeviceOwner, phase = "detached", expectedTargetText = "old", stagedText = "compressed", targetText = null, rollbackText = null, journalRollbackText = rollbackText } = {}) => {
	        recoveryCaseId += 1;
	        const targetPath = `Replacement/matrix-${recoveryCaseId}.bin`;
	        const stagedPath = `${targetPath}.tinylocal-${recoveryCaseId}-0123456789abcdef.tmp`;
	        const rollbackPath = `Replacement/.matrix-${recoveryCaseId}.bin.tinylocal-rollback-${recoveryCaseId}-0123456789abcdef0123456789abcdef.tmp`;
	        if (stagedText !== null) await mobileAdapter.writeBinary(stagedPath, toArrayBuffer(Buffer.from(stagedText)));
	        if (targetText !== null) await mobileAdapter.writeBinary(targetPath, toArrayBuffer(Buffer.from(targetText)));
	        if (rollbackText !== null) await mobileAdapter.writeBinary(rollbackPath, toArrayBuffer(Buffer.from(rollbackText)));
	        const journal = {
	          ownerId,
	          transactionId: recoveryCaseId.toString(16).padStart(32, "0"),
	          stagedPath,
	          targetPath,
	          rollbackPath: rollbackText === null ? null : rollbackPath,
	          stagedSha256: sha256Text("compressed"),
	          expectedTargetSha256: expectedTargetText === null ? null : sha256Text(expectedTargetText),
	          rollbackSha256: journalRollbackText === null ? null : sha256Text(journalRollbackText),
	          phase
	        };
	        const journalPath = getMobileJournalPath(journal);
	        await writeMobileJournal(journal, journalPath);
	        return { ...journal, journalPath };
	      };
	      const removeRecoveryState = async (state) => {
	        for (const filePath of [state.stagedPath, state.targetPath, state.rollbackPath, state.journalPath]) {
	          if (filePath && await mobileAdapter.exists(filePath)) await mobileAdapter.remove(filePath);
	        }
	      };

	      // Every foreign J/S/T/R subset is read-only. Partial Sync delivery and
	      // a later journal tombstone may never command this device's filesystem.
	      for (let mask = 0; mask < 8; mask++) {
	        const state = await createRecoveryState({
	          ownerId: foreignDeviceOwner,
	          phase: ["prepared", "detached", "installed"][mask % 3],
	          stagedText: (mask & 1) ? "compressed" : null,
	          targetText: (mask & 2) ? "foreign-current" : null,
	          rollbackText: (mask & 4) ? "old" : null
	        });
	        await mobileFs.recoverInterruptedReplacement();
	        assert(await mobileAdapter.exists(state.journalPath), `Foreign recovery journal subset ${mask} was consumed`);
	        assert.equal(await mobileAdapter.exists(state.stagedPath), Boolean(mask & 1), `Foreign staged subset ${mask} was mutated`);
	        assert.equal(await mobileAdapter.exists(state.targetPath), Boolean(mask & 2), `Foreign target subset ${mask} was mutated`);
	        assert.equal(Boolean(state.rollbackPath && await mobileAdapter.exists(state.rollbackPath)), Boolean(mask & 4), `Foreign rollback subset ${mask} was mutated`);
	        await mobileAdapter.remove(state.journalPath);
	        await mobileFs.recoverInterruptedReplacement();
	        assert.equal(await mobileAdapter.exists(state.stagedPath), Boolean(mask & 1), `Foreign staged subset ${mask} changed after journal tombstone`);
	        assert.equal(await mobileAdapter.exists(state.targetPath), Boolean(mask & 2), `Foreign target subset ${mask} changed after journal tombstone`);
	        assert.equal(Boolean(state.rollbackPath && await mobileAdapter.exists(state.rollbackPath)), Boolean(mask & 4), `Foreign rollback subset ${mask} changed after journal tombstone`);
	        await removeRecoveryState(state);
	      }

	      const notStartedState = await createRecoveryState({ phase: "prepared", stagedText: "compressed", targetText: "old" });
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(notStartedState.targetPath), "old", "Prepared recovery changed an untouched target");
	      assert(!await mobileAdapter.exists(notStartedState.stagedPath) && !await mobileAdapter.exists(notStartedState.journalPath), "Prepared recovery did not abort its owned staged artifact");
	      await removeRecoveryState(notStartedState);

	      const detachedState = await createRecoveryState({ phase: "detached", stagedText: "compressed", targetText: null, rollbackText: "old" });
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(detachedState.targetPath), "old", "Detached recovery did not restore the captured target");
	      assert(!await mobileAdapter.exists(detachedState.stagedPath) && await mobileAdapter.exists(detachedState.rollbackPath) && !await mobileAdapter.exists(detachedState.journalPath), "Detached recovery did not retain only the exact rollback safety copy");
	      await removeRecoveryState(detachedState);

	      const detachedWithoutStageState = await createRecoveryState({ phase: "detached", stagedText: null, targetText: null, rollbackText: "captured-without-stage" });
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(detachedWithoutStageState.targetPath), "captured-without-stage", "Mobile recovery left the canonical target missing when its exact rollback existed without a staged file");
	      assert(await mobileAdapter.exists(detachedWithoutStageState.rollbackPath) && !await mobileAdapter.exists(detachedWithoutStageState.journalPath), "Mobile detached-without-stage recovery did not retain only its exact rollback safety copy");
	      await removeRecoveryState(detachedWithoutStageState);

	      const mismatchedRollbackState = await createRecoveryState({
	        phase: "detached",
	        stagedText: "compressed",
	        targetText: null,
	        rollbackText: "sync-replaced-rollback",
	        journalRollbackText: "journal-owned-rollback"
	      });
	      await mobileFs.recoverInterruptedReplacement();
	      assert(!await mobileAdapter.exists(mismatchedRollbackState.targetPath), "Mobile recovery installed a rollback revision that did not match journal.rollbackSha256");
	      assert.equal(await mobileAdapter.read(mismatchedRollbackState.rollbackPath), "sync-replaced-rollback", "Mobile recovery changed the mismatched rollback bytes");
	      assert(await mobileAdapter.exists(mismatchedRollbackState.stagedPath) && await mobileAdapter.exists(mismatchedRollbackState.journalPath), "Mobile recovery discarded staged or journal evidence after rollback hash mismatch");
	      await removeRecoveryState(mismatchedRollbackState);

	      for (const stagedText of [null, "compressed"]) {
	        const installedState = await createRecoveryState({ phase: "installed", stagedText, targetText: "compressed", rollbackText: "old" });
	        await mobileFs.recoverInterruptedReplacement();
	        assert.equal(await mobileAdapter.read(installedState.targetPath), "compressed", "Installed recovery reverted the verified target");
	        assert(!await mobileAdapter.exists(installedState.stagedPath) && await mobileAdapter.exists(installedState.rollbackPath) && !await mobileAdapter.exists(installedState.journalPath), "Installed recovery did not retain only the exact rollback safety copy");
	        await removeRecoveryState(installedState);
	      }

	      const preparedAfterDetachState = await createRecoveryState({
	        phase: "prepared",
	        stagedText: "compressed",
	        targetText: null,
	        rollbackText: "old",
	        journalRollbackText: null
	      });
	      const installedForeignSidesState = await createRecoveryState({
	        phase: "installed",
	        stagedText: "foreign-staged",
	        targetText: "compressed",
	        rollbackText: "foreign-rollback",
	        journalRollbackText: "old"
	      });
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(preparedAfterDetachState.targetPath), "old", "Prepared-after-detach mobile recovery left the canonical target missing");
	      assert(!await mobileAdapter.exists(preparedAfterDetachState.stagedPath) && await mobileAdapter.exists(preparedAfterDetachState.rollbackPath) && !await mobileAdapter.exists(preparedAfterDetachState.journalPath), "Prepared-after-detach mobile recovery retained active metadata or lost rollback safety");
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.targetPath), "compressed", "Installed mobile terminal recovery changed the verified target");
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.stagedPath), "foreign-staged", "Installed mobile terminal recovery changed the foreign staged artifact");
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.rollbackPath), "foreign-rollback", "Installed mobile terminal recovery changed the foreign rollback artifact");
	      assert(!await mobileAdapter.exists(installedForeignSidesState.journalPath), "Installed mobile terminal recovery retained its active journal");
	      await mobileFs.recoverInterruptedReplacement();
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.stagedPath), "foreign-staged", "Repeated mobile recovery changed the foreign staged artifact");
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.rollbackPath), "foreign-rollback", "Repeated mobile recovery changed the foreign rollback artifact");
	      const afterPreparedStage = `${preparedAfterDetachState.targetPath}.tinylocal-1900000000000-${"1".repeat(32)}.tmp`;
	      await mobileAdapter.writeBinary(afterPreparedStage, toArrayBuffer(Buffer.from("after-prepared-detach")));
	      await mobileFs.replaceFile(afterPreparedStage, preparedAfterDetachState.targetPath, {
	        expectedTargetSha256: sha256Text("old"),
	        expectedStagedSha256: sha256Text("after-prepared-detach")
	      });
	      assert.equal(await mobileAdapter.read(preparedAfterDetachState.targetPath), "after-prepared-detach", "Prepared-after-detach recovery blocked the next mobile replacement");
	      const afterForeignSidesStage = `${installedForeignSidesState.targetPath}.tinylocal-1900000000000-${"2".repeat(32)}.tmp`;
	      await mobileAdapter.writeBinary(afterForeignSidesStage, toArrayBuffer(Buffer.from("after-foreign-sides")));
	      await mobileFs.replaceFile(afterForeignSidesStage, installedForeignSidesState.targetPath, {
	        expectedTargetSha256: sha256Text("compressed"),
	        expectedStagedSha256: sha256Text("after-foreign-sides")
	      });
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.targetPath), "after-foreign-sides", "Installed terminal recovery blocked the next mobile replacement");
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.stagedPath), "foreign-staged", "Later mobile replacement changed the retained foreign staged artifact");
	      assert.equal(await mobileAdapter.read(installedForeignSidesState.rollbackPath), "foreign-rollback", "Later mobile replacement changed the retained foreign rollback artifact");
	      await removeRecoveryState(preparedAfterDetachState);
	      await removeRecoveryState(installedForeignSidesState);

	      const capturedConcurrentState = await createRecoveryState({ phase: "detached", stagedText: "compressed", targetText: null, rollbackText: "concurrent-before-capture" });
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(capturedConcurrentState.targetPath), "concurrent-before-capture", "Recovery deleted the concurrent version captured in rollback");
	      assert(!await mobileAdapter.exists(capturedConcurrentState.journalPath), "Recovered concurrent capture left its journal");
	      await removeRecoveryState(capturedConcurrentState);

	      const restoredExpectedState = await createRecoveryState({ phase: "detached", stagedText: null, targetText: "old", rollbackText: "old" });
	      const concurrentCreateState = await createRecoveryState({ phase: "detached", expectedTargetText: null, stagedText: "compressed", targetText: "concurrent-create", rollbackText: null });
	      const conflictState = await createRecoveryState({ phase: "detached", stagedText: null, targetText: "concurrent-after-install", rollbackText: "old" });
	      const independentState = await createRecoveryState({ phase: "installed", stagedText: null, targetText: "compressed", rollbackText: "old" });
	      const detachedMobileJournalCountBeforeStaleRecovery = (await mobileAdapter.list(mobileJournalDir)).files
	        .filter((filePath) => String(filePath).includes(".json.delete-")).length;
	      mobileAdapter.remove = async (vaultPath) => {
	        if (String(vaultPath).startsWith(`${conflictState.journalPath}.delete-`)) {
	          throw new Error(`Injected stale mobile journal cleanup failure: ${vaultPath}`);
	        }
	        await originalRemoveForReplacementCleanup.call(mobileAdapter, vaultPath);
	      };
	      try {
	        await mobileFs.recoverInterruptedReplacement();
	      } finally {
	        mobileAdapter.remove = originalRemoveForReplacementCleanup;
	      }
	      assert.equal(await mobileAdapter.read(restoredExpectedState.targetPath), "old", "Mobile terminal recovery changed an already restored expected target");
	      assert(await mobileAdapter.exists(restoredExpectedState.rollbackPath) && !await mobileAdapter.exists(restoredExpectedState.journalPath), "Mobile terminal recovery discarded the restored target's exact rollback copy or kept its active journal");
	      assert.equal(await mobileAdapter.read(concurrentCreateState.targetPath), "concurrent-create", "Mobile create-race recovery overwrote the concurrent target");
	      assert(await mobileAdapter.exists(concurrentCreateState.stagedPath) && !await mobileAdapter.exists(concurrentCreateState.journalPath), "Mobile create-race recovery discarded staged safety evidence or kept its active journal");
	      assert.equal(await mobileAdapter.read(conflictState.targetPath), "concurrent-after-install", "Stale mobile recovery overwrote the newer target");
	      assert(await mobileAdapter.exists(conflictState.rollbackPath), "Stale mobile recovery discarded the exact rollback safety copy");
	      assert(!await mobileAdapter.exists(conflictState.journalPath), "Stale mobile journal remained in the active recovery namespace");
	      assert(await mobileAdapter.exists(independentState.rollbackPath) && !await mobileAdapter.exists(independentState.journalPath), "One unresolved journal blocked or over-cleaned an independent recovery");
	      const detachedConflictJournalPaths = (await mobileAdapter.list(mobileJournalDir)).files
	        .filter((filePath) => String(filePath).startsWith(`${conflictState.journalPath}.delete-`));
	      assert(detachedConflictJournalPaths.length === 1, "Mobile stale-journal cleanup failure did not retain exactly one detached terminal journal");
	      await mobileFs.recoverInterruptedReplacement();
	      await mobileFs.recoverInterruptedReplacement();
	      assert(
	        (await mobileAdapter.list(mobileJournalDir)).files.filter((filePath) => String(filePath).includes(".json.delete-")).length === detachedMobileJournalCountBeforeStaleRecovery + 1,
	        "Repeated mobile recovery amplified a detached stale journal"
	      );
	      const blockedStage = `${conflictState.targetPath}.tinylocal-999-0123456789abcdef.tmp`;
	      await mobileAdapter.writeBinary(blockedStage, toArrayBuffer(Buffer.from("blocked")));
	      await mobileFs.replaceFile(blockedStage, conflictState.targetPath);
	      assert.equal(await mobileAdapter.read(conflictState.targetPath), "blocked", "Stale mobile journal still blocked a later replacement");
	      assert(!await mobileAdapter.exists(blockedStage), "Successful mobile replacement retained its staged file");
	      assert(await mobileAdapter.exists(conflictState.rollbackPath), "Later mobile replacement removed the retained old safety copy");
	      const restoredExpectedStage = `${restoredExpectedState.targetPath}.tinylocal-998-fedcba9876543210.tmp`;
	      await mobileAdapter.writeBinary(restoredExpectedStage, toArrayBuffer(Buffer.from("after-restored-target")));
	      await mobileFs.replaceFile(restoredExpectedStage, restoredExpectedState.targetPath);
	      assert.equal(await mobileAdapter.read(restoredExpectedState.targetPath), "after-restored-target", "Restored-target journal still blocked a later mobile replacement");
	      assert(await mobileAdapter.exists(restoredExpectedState.rollbackPath), "Later mobile replacement removed the restored target's retained safety copy");
	      await mobileFs.replaceFile(concurrentCreateState.stagedPath, concurrentCreateState.targetPath);
	      assert.equal(await mobileAdapter.read(concurrentCreateState.targetPath), "compressed", "Create-race journal still blocked a later mobile replacement");
	      assert(!await mobileAdapter.exists(concurrentCreateState.stagedPath), "Later mobile create-race replacement retained its staged file");
	      await removeRecoveryState(restoredExpectedState);
	      await removeRecoveryState(concurrentCreateState);
	      await removeRecoveryState(conflictState);
	      await removeRecoveryState(independentState);

	      const missingAbortState = await createRecoveryState({ phase: "prepared", expectedTargetText: null, stagedText: "compressed", targetText: null, rollbackText: null });
	      await mobileFs.recoverInterruptedReplacement();
	      assert(!await mobileAdapter.exists(missingAbortState.stagedPath) && !await mobileAdapter.exists(missingAbortState.journalPath), "Missing-target prepared recovery did not abort its owned staged file");
	      await removeRecoveryState(missingAbortState);
	      const missingInstalledState = await createRecoveryState({ phase: "installed", expectedTargetText: null, stagedText: null, targetText: "compressed", rollbackText: null });
	      await mobileFs.recoverInterruptedReplacement();
	      assert(!await mobileAdapter.exists(missingInstalledState.journalPath) && await mobileAdapter.exists(missingInstalledState.targetPath), "Missing-target installed recovery did not reach terminal state");
	      await removeRecoveryState(missingInstalledState);

	      const invalidState = await createRecoveryState({ phase: "detached", stagedText: "compressed", targetText: "keep-invalid-target", rollbackText: "old" });
	      await mobileAdapter.process(invalidState.journalPath, (current) => current.replace(/"checksum":"[a-f0-9]+"/i, '"checksum":"invalid"'));
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(invalidState.targetPath), "keep-invalid-target", "Invalid journal changed its target");
	      assert(await mobileAdapter.exists(invalidState.journalPath), "Invalid journal was renamed or deleted without trusted ownership");
	      await removeRecoveryState(invalidState);

	      const legacyPayload = {
	        version: 1,
	        stagedPath: "Replacement/legacy.bin.tinylocal-1-0123456789abcdef.tmp",
	        targetPath: "Replacement/legacy.bin",
	        rollbackPath: null,
	        phase: "prepared"
	      };
	      await mobileAdapter.writeBinary(legacyPayload.targetPath, toArrayBuffer(Buffer.from("legacy-current")));
	      await mobileAdapter.write(mobileLegacyJournalPath, JSON.stringify({ ...legacyPayload, checksum: sha256Text(JSON.stringify(legacyPayload)) }));
	      await mobileFs.recoverInterruptedReplacement();
	      assert.equal(await mobileAdapter.read(legacyPayload.targetPath), "legacy-current", "Unowned v1 journal changed an existing target");
	      assert(await mobileAdapter.exists(mobileLegacyJournalPath), "Unowned v1 journal was automatically consumed");
	      await mobileAdapter.remove(mobileLegacyJournalPath);
	      await mobileAdapter.remove(legacyPayload.targetPath);

	      await mobileAdapter.writeBinary("Migration/source-file.bin", toArrayBuffer(Buffer.from("migration-file")));
	      await mobilePlugin.migrationRunner.moveOrCopyMigrationItem("Migration/source-file.bin", "Migration/dest-file.bin");
	      assert(!await mobileAdapter.exists("Migration/source-file.bin") && await mobileAdapter.exists("Migration/dest-file.bin"), "Mobile file migration did not copy, verify and remove the file source");

	      const migrationRaceSource = "Migration/race-source.bin";
	      const migrationRaceDest = "Migration/race-dest.bin";
	      await mobileAdapter.writeBinary(migrationRaceSource, toArrayBuffer(Buffer.from("same-version")));
	      await mobileAdapter.writeBinary(migrationRaceDest, toArrayBuffer(Buffer.from("same-version")));
	      const originalMoveFileToUniqueSibling = mobileFs.moveFileToUniqueSibling;
	      let migrationRaceQuarantine = null;
	      mobileFs.moveFileToUniqueSibling = async (sourcePath, options) => {
	        migrationRaceQuarantine = await originalMoveFileToUniqueSibling.call(mobileFs, sourcePath, options);
	        await mobileAdapter.writeBinary(sourcePath, toArrayBuffer(Buffer.from("new-sync-version")));
	        return migrationRaceQuarantine;
	      };
	      try {
	        await mobilePlugin.migrationRunner.mergeMigrationItem(migrationRaceSource, migrationRaceDest);
	      } finally {
	        mobileFs.moveFileToUniqueSibling = originalMoveFileToUniqueSibling;
	      }
	      assert.equal(await mobileAdapter.read(migrationRaceSource), "new-sync-version", "Migration deleted a source version written after quarantine");
	      assert.equal(await mobileAdapter.read(migrationRaceDest), "same-version", "Migration changed an already verified destination during source quarantine");
	      assert(migrationRaceQuarantine && await mobileAdapter.exists(migrationRaceQuarantine), "Migration discarded the exact isolated source safety copy");
	      assert.equal(await mobileAdapter.read(migrationRaceQuarantine), "same-version", "Migration quarantine did not preserve the isolated source revision");
	      assert(
	        (await mobileAdapter.list(mobileJournalDir)).files.some((journalPath) => path.posix.basename(journalPath).startsWith("migration-quarantine-v1-")),
	        "Migration race did not retain its recovery journal"
	      );

	      const migrationMismatchSource = "Migration/mismatch-source.bin";
	      const migrationMismatchDest = "Migration/mismatch-dest.bin";
	      await mobileAdapter.writeBinary(migrationMismatchSource, toArrayBuffer(Buffer.from("source-version")));
	      await mobileAdapter.writeBinary(migrationMismatchDest, toArrayBuffer(Buffer.from("target-version")));
	      let migrationMismatchQuarantine = null;
	      mobileFs.moveFileToUniqueSibling = async (sourcePath, options) => {
	        migrationMismatchQuarantine = await originalMoveFileToUniqueSibling.call(mobileFs, sourcePath, options);
	        return migrationMismatchQuarantine;
	      };
	      try {
	        await assert.rejects(() => mobilePlugin.migrationRunner.mergeMigrationItem(migrationMismatchSource, migrationMismatchDest), /source retained at/);
	      } finally {
	        mobileFs.moveFileToUniqueSibling = originalMoveFileToUniqueSibling;
	      }
	      assert(migrationMismatchQuarantine && await mobileAdapter.exists(migrationMismatchQuarantine), "Migration mismatch discarded its verified quarantine fallback");
	      assert.equal(await mobileAdapter.read(migrationMismatchSource), "source-version", "Migration mismatch did not restore the isolated source bytes to the original path");
	      assert.equal(await mobileAdapter.read(migrationMismatchDest), "target-version", "Migration mismatch overwrote the destination");
	      assert((await mobileAdapter.list(mobileJournalDir)).files.some((journalPath) => path.posix.basename(journalPath).startsWith("migration-quarantine-v1-")), "Migration mismatch did not retain its recovery journal");

	      const migrationCollisionSource = "Migration/collision-source.bin";
	      const migrationCollisionDest = "Migration/collision-dest.bin";
	      await mobileAdapter.writeBinary(migrationCollisionSource, toArrayBuffer(Buffer.from("collision")));
	      await mobileAdapter.writeBinary(migrationCollisionDest, toArrayBuffer(Buffer.from("collision")));
	      const originalMkdirForMigrationCollision = mobileAdapter.mkdir;
	      let migrationCollisionDir = null;
	      mobileAdapter.mkdir = async (vaultPath) => {
	        if (!migrationCollisionDir && String(vaultPath).includes(".tinylocal-quarantine-")) {
	          migrationCollisionDir = String(vaultPath);
	          await originalMkdirForMigrationCollision(vaultPath);
	          throw new Error("Injected quarantine directory collision");
	        }
	        await originalMkdirForMigrationCollision(vaultPath);
	      };
	      try {
	        await mobilePlugin.migrationRunner.mergeMigrationItem(migrationCollisionSource, migrationCollisionDest);
	      } finally {
	        mobileAdapter.mkdir = originalMkdirForMigrationCollision;
	      }
	      assert(migrationCollisionDir && await mobileAdapter.exists(migrationCollisionDir), "Migration quarantine collision was not retried with a different owned directory");
	      await mobileAdapter.rmdir(migrationCollisionDir, false);

	      const migrationAfterEffectSource = "Migration/after-effect-source.bin";
	      const migrationAfterEffectDest = "Migration/after-effect-dest.bin";
	      await mobileAdapter.writeBinary(migrationAfterEffectSource, toArrayBuffer(Buffer.from("after-effect")));
	      await mobileAdapter.writeBinary(migrationAfterEffectDest, toArrayBuffer(Buffer.from("after-effect")));
	      mobileRenameFailure = (fromPath, toPath) => fromPath === migrationAfterEffectSource && toPath.includes(".tinylocal-quarantine-") ? "after" : null;
	      await mobilePlugin.migrationRunner.mergeMigrationItem(migrationAfterEffectSource, migrationAfterEffectDest);
	      mobileRenameFailure = null;
	      assert(!await mobileAdapter.exists(migrationAfterEffectSource), "Migration rejected a quarantine rename that had already landed");

	      await mobileAdapter.writeBinary("Migration/source-dir/nested.bin", toArrayBuffer(Buffer.from("migration-dir")));
	      await mobilePlugin.migrationRunner.moveOrCopyMigrationItem("Migration/source-dir", "Migration/dest-dir");
	      assert(await mobileAdapter.exists("Migration/dest-dir/nested.bin"), "Mobile directory migration did not publish the verified destination child");
	      assert(!await mobileAdapter.exists("Migration/source-dir/nested.bin"), "Mobile directory migration left the canonical source child in place");
	      if (await mobileAdapter.exists("Migration/source-dir")) {
	        const retainedSourceListing = await mobileAdapter.list("Migration/source-dir");
	        assert(
	          retainedSourceListing.files.length === 0
	            && retainedSourceListing.folders.length > 0
	            && retainedSourceListing.folders.every((folderPath) => path.posix.basename(folderPath).startsWith(".tinylocal-quarantine-")),
	          "Mobile directory migration left non-recovery content at the source"
	        );
	      }
	      await mobilePlugin.migrationRunner.moveOrCopyMigrationItem("Migration/source-dir", "Migration/dest-dir");
	      const repeatedDestinationListing = await mobileAdapter.list("Migration/dest-dir");
	      assert(
	        repeatedDestinationListing.folders.every((folderPath) => !path.posix.basename(folderPath).startsWith(".tinylocal-quarantine-")),
	        "Repeated mobile migration copied a retained recovery directory into the destination"
	      );
	      await mobileAdapter.writeBinary("Migration/late-source/base.bin", toArrayBuffer(Buffer.from("base")));
	      const originalVerifyMigrationForLateChild = mobilePlugin.migrationRunner.verifyMigrationItem;
	      let lateChildInjected = false;
	      mobilePlugin.migrationRunner.verifyMigrationItem = async (...args) => {
	        await originalVerifyMigrationForLateChild.apply(mobilePlugin.migrationRunner, args);
	        if (!lateChildInjected && args[0] === "Migration/late-source") {
	          lateChildInjected = true;
	          await mobileAdapter.writeBinary("Migration/late-source/late.bin", toArrayBuffer(Buffer.from("late")));
	        }
	      };
	      await mobilePlugin.migrationRunner.moveOrCopyMigrationItem("Migration/late-source", "Migration/late-dest");
	      mobilePlugin.migrationRunner.verifyMigrationItem = originalVerifyMigrationForLateChild;
	      assert(lateChildInjected && await mobileAdapter.exists("Migration/late-dest/late.bin"), "Migration reconciliation lost a child added after verification");
	      fs.mkdirSync(path.dirname(resolveMobilePath("Migration/oversized.bin")), { recursive: true });
	      fs.writeFileSync(resolveMobilePath("Migration/oversized.bin"), Buffer.alloc(25 * 1024 * 1024 + 1));
	      await assert.rejects(() => mobilePlugin.migrationRunner.moveOrCopyMigrationItem("Migration/oversized.bin", "Migration/oversized-dest.bin"), /exceeds the mobile maintenance limit/);
	      assert(await mobileAdapter.exists("Migration/oversized.bin") && !await mobileAdapter.exists("Migration/oversized-dest.bin"), "Oversized mobile migration created a partial destination or removed its source");
	      await mobileAdapter.writeBinary("Migration/failing-source.bin", toArrayBuffer(Buffer.from("preserve-me")));
	      const originalCreateBinaryForMigrationFailure = mobileApp.vault.createBinary;
	      mobileApp.vault.createBinary = async (filePath, data) => {
	        if (String(filePath) === "Migration/failing-dest.bin") {
	          throw new Error(`Injected mobile copy failure: ${filePath}`);
	        }
	        return await originalCreateBinaryForMigrationFailure.call(mobileApp.vault, filePath, data);
	      };
	      try {
	        await assert.rejects(() => mobilePlugin.migrationRunner.moveOrCopyMigrationItem("Migration/failing-source.bin", "Migration/failing-dest.bin"), /Injected mobile copy failure/);
	      } finally {
	        mobileApp.vault.createBinary = originalCreateBinaryForMigrationFailure;
	      }
	      assert(await mobileAdapter.exists("Migration/failing-source.bin"), "Failed mobile migration removed its source");

	      const oversizedMobilePath = "Images/mobile-oversized.jpg";
	      fs.mkdirSync(path.dirname(resolveMobilePath(oversizedMobilePath)), { recursive: true });
	      fs.writeFileSync(resolveMobilePath(oversizedMobilePath), Buffer.alloc(25 * 1024 * 1024 + 1));
	      const oversizedMobileStat = await mobileAdapter.stat(oversizedMobilePath);
	      const oversizedMobileFile = Object.assign(new MobileObsidianMock.TFile(), createMockFile(oversizedMobilePath, oversizedMobileStat.size, oversizedMobileStat.mtime));
	      mobileFiles.push(oversizedMobileFile);
	      const readsBeforeOversized = mobileReadBinaryCalls;
	      let oversizedWasmCalls = 0;
	      const originalEnsureWasmReadyForOversized = mobilePlugin.compressor.ensureWasmReady;
	      mobilePlugin.compressor.ensureWasmReady = async () => {
	        oversizedWasmCalls += 1;
	        throw new Error("Oversized mobile input must not initialize WASM");
	      };
	      const oversizedMobileResult = await mobilePlugin.compressor.compress(oversizedMobileFile, mobilePlugin.settings);
	      mobilePlugin.compressor.ensureWasmReady = originalEnsureWasmReadyForOversized;
	      assert(oversizedMobileResult.skipReason === "too_large", "Mobile oversized input did not use the safety skip");
	      await mobilePlugin.cache.addSkippedEntry(oversizedMobilePath, "too_large", mobilePlugin.getCompressionSettingsKey(oversizedMobileFile, "too_large"));
	      assert(mobileReadBinaryCalls === readsBeforeOversized && oversizedWasmCalls === 0, "Mobile too_large persistence read bytes or initialized WASM");
	      const oversizedCacheEntry = Object.values(mobilePlugin.cache.cacheData.entries).find((entry) => entry.path === oversizedMobilePath);
	      assert(!oversizedCacheEntry, "Mobile too_large entry was cached without a content identity");
	      await assert.rejects(() => mobilePlugin.getPlatformPorts().hash.fileSha256Hex(oversizedMobilePath), /exceeds the mobile 25 MB maintenance limit/);
	      assert(mobileReadBinaryCalls === readsBeforeOversized, "Mobile oversized maintenance hash read the file before rejecting it");

	      const mobileInputBytes = createValidJpegBytes(64 * 1024);
      await mobileAdapter.writeBinary("Images/mobile.jpg", cloneArrayBuffer(mobileInputBytes));
      const mobileInputStat = await mobileAdapter.stat("Images/mobile.jpg");
      const mobileImage = Object.assign(new MobileObsidianMock.TFile(), createMockFile("Images/mobile.jpg", mobileInputStat.size, mobileInputStat.mtime));
      mobileFiles.push(mobileImage);
      const mobileValidation = await mobilePlugin.validateFileForCompression(mobileImage);
      assert(mobileValidation.valid === true, `Mobile validation rejected the fixture: ${JSON.stringify(mobileValidation)}`);
	      await mobilePlugin.compressFile(mobileImage);
	      assert(await mobileAdapter.exists("Compressed/Images/mobile.jpg"), "Mobile compression did not write the staged output through the adapter");
	      const mobileOutputStat = await mobileAdapter.stat("Compressed/Images/mobile.jpg");
	      assert(mobileOutputStat.size < mobileInputStat.size, "Mobile compression output is not smaller than the input");
	      const mobileOutputBeforeFailedReplace = Buffer.from(new Uint8Array(await mobileAdapter.readBinary("Compressed/Images/mobile.jpg")));
	      mobileRenameFailure = (fromPath, toPath) => fromPath.includes("Compressed/Images/mobile.jpg.tinylocal-") && toPath === "Compressed/Images/mobile.jpg" ? "before" : null;
	      const failedRepeatedMobileResult = await mobilePlugin.compressor.compress(mobileImage, mobilePlugin.settings);
	      mobileRenameFailure = null;
	      const mobileOutputAfterFailedReplace = Buffer.from(new Uint8Array(await mobileAdapter.readBinary("Compressed/Images/mobile.jpg")));
	      assert(mobileOutputAfterFailedReplace.equals(mobileOutputBeforeFailedReplace), "Interrupted repeated mobile compression did not preserve the previous output bytes");
	      assert(typeof failedRepeatedMobileResult.success === "boolean", "Interrupted repeated mobile compression returned an invalid result");
	      const repeatedMobileResult = await mobilePlugin.compressor.compress(mobileImage, mobilePlugin.settings);
	      assert(repeatedMobileResult.success === true && await mobileAdapter.exists("Compressed/Images/mobile.jpg"), "Repeated mobile compression could not replace an existing output");
	      await mobilePlugin.handleSuccessfulCompression(mobileImage, repeatedMobileResult);
	      await mobilePlugin.cache.flushPendingCacheSave();

      const mobileEntryPair = Object.entries(mobilePlugin.cache.cacheData.entries).find(([, entry]) => entry.path === "Images/mobile.jpg");
      assert(mobileEntryPair, "Mobile compression did not record a cache entry");
      const [mobileCacheKey, mobileEntry] = mobileEntryPair;
      const expectedMobileMd5 = crypto.createHash("md5").update(new Uint8Array(mobileInputBytes)).digest("hex");
      assert.equal(mobileEntry.md5, expectedMobileMd5, "Mobile js-md5 fingerprint diverged from Node crypto");
      const expectedMobileFingerprint = `images/mobile.jpg\n${expectedMobileMd5}\n${Math.round(mobileInputStat.mtime)}`;
      const expectedMobileKey = `v2:${crypto.createHash("sha256").update(expectedMobileFingerprint).digest("hex")}`;
      assert.equal(mobileCacheKey, expectedMobileKey, "Mobile cache key diverged from desktop crypto parity");

	      const mobileMoveRecord = {
        compressedPath: "Compressed/Images/mobile.jpg",
        relativePath: "Images/mobile.jpg",
        name: "mobile.jpg",
	        size: mobileOutputStat.size
	      };
	      const secondMobileInput = createValidJpegBytes(48 * 1024);
	      const secondMobileOutput = createValidEncodedOutput("jpeg");
	      await mobileAdapter.writeBinary("Images/mobile-second.jpg", cloneArrayBuffer(secondMobileInput));
	      await mobileAdapter.writeBinary("Compressed/Images/mobile-second.jpg", secondMobileOutput);
	      const secondMobileInputStat = await mobileAdapter.stat("Images/mobile-second.jpg");
	      const secondMobileOutputStat = await mobileAdapter.stat("Compressed/Images/mobile-second.jpg");
	      mobileFiles.push(Object.assign(new MobileObsidianMock.TFile(), createMockFile("Images/mobile-second.jpg", secondMobileInputStat.size, secondMobileInputStat.mtime)));
	      const secondMobileMd5 = crypto.createHash("md5").update(new Uint8Array(secondMobileInput)).digest("hex");
	      const secondMobileKey = mobilePlugin.cache.buildCacheKey("Images/mobile-second.jpg", secondMobileMd5, secondMobileInputStat.mtime);
	      mobilePlugin.cache.cacheData.entries[secondMobileKey] = {
	        path: "Images/mobile-second.jpg",
	        md5: secondMobileMd5,
	        mtime: secondMobileInputStat.mtime,
	        timestamp: Date.now(),
	        sourceMtime: secondMobileInputStat.mtime,
	        sourceSize: secondMobileInputStat.size,
	        sourceSha256: await mobilePlugin.getPlatformPorts().hash.fileSha256Hex("Images/mobile-second.jpg"),
	        state: "pending_move",
	        outputPath: "Compressed/Images/mobile-second.jpg",
	        outputMtime: secondMobileOutputStat.mtime,
	        outputSize: secondMobileOutputStat.size,
	        outputSha256: await mobilePlugin.getPlatformPorts().hash.fileSha256Hex("Compressed/Images/mobile-second.jpg")
	      };
	      const secondMobileMoveRecord = {
	        compressedPath: "Compressed/Images/mobile-second.jpg",
	        relativePath: "Images/mobile-second.jpg",
	        name: "mobile-second.jpg",
	        size: secondMobileOutputStat.size
	      };
	      mobilePeakBytesInFlight = 0;
	      assert(mobilePlugin.moveService.getIOConcurrency() === 1, "Mobile move I/O concurrency is not serialized");
      const originalMobileMoveStat = mobileAdapter.stat.bind(mobileAdapter);
      let staleCompressedStatReads = 0;
      let staleStagedStatReads = 0;
      mobileAdapter.stat = async (vaultPath) => {
        const stat = await originalMobileMoveStat(vaultPath);
        if (stat?.type === "file" && String(vaultPath) === "Compressed/Images/mobile.jpg") {
          staleCompressedStatReads++;
          return { ...stat, size: 0 };
        }
        if (stat?.type === "file" && String(vaultPath).includes(".tinylocal-") && String(vaultPath).endsWith(".tmp")) {
          staleStagedStatReads++;
          return { ...stat, size: 0 };
        }
        return stat;
      };
      try {
        assert(
          await mobilePlugin.cache.isFileAlreadyProcessed(mobileImage),
          "Mobile pending cache proof rejected exact output bytes because compressed size metadata lagged"
        );
        const mobileBackupResult = await mobilePlugin.moveService.createBackupBeforeMove([mobileMoveRecord, secondMobileMoveRecord]);
        assert(mobileBackupResult.files.length === 2, `Mobile move backup preflight failed: ${mobileMoveRecord.moveSkipReason || secondMobileMoveRecord.moveSkipReason || mobileBackupResult.errorCount}`);
        assert(mobilePeakBytesInFlight <= mobileInputStat.size, `Mobile move preflight exceeded one-file buffered reads: peak=${mobilePeakBytesInFlight}, file=${mobileInputStat.size}`);
        await mobilePlugin.moveService.moveSingleFile(mobileBackupResult.files[0]);
      } finally {
        mobileAdapter.stat = originalMobileMoveStat;
      }
      assert(staleCompressedStatReads > 0, "Mobile move preflight did not exercise stale compressed-output size metadata");
      assert(staleStagedStatReads > 0, "Mobile move did not exercise stale staged-file size metadata");
      assert(!mobileMoveRecord.moveSkipReason, `Mobile move was skipped: ${mobileMoveRecord.moveSkipReason}`);
      assert((await mobileAdapter.stat("Images/mobile.jpg")).size === mobileOutputStat.size, "Mobile move did not replace the original with compressed bytes");
      assert(!await mobileAdapter.exists("Compressed/Images/mobile.jpg"), "Mobile move left the compressed output behind");
      const staleMovedFile = Object.assign(new MobileObsidianMock.TFile(), createMockFile("Images/mobile.jpg", 0, mobileInputStat.mtime));
      assert(
        await mobilePlugin.cache.isFileAlreadyProcessed(staleMovedFile),
        "Mobile moved cache proof rejected exact installed bytes because TFile metadata lagged"
      );
      const mobileBackupRoots = (await mobileAdapter.list(".local-image-compress/backups/originals")).folders;
      assert(mobileBackupRoots.length === 1, "Mobile move did not create exactly one originals backup");
      assert(
        await mobileAdapter.exists(`${mobileBackupRoots[0]}/originals/Images/mobile.jpg`),
        "Mobile originals backup is missing the backed-up file"
      );

      const mobileCacheBackupDir = ".local-image-compress/backups/cache";
      const mobileRestoreBackupName = "tinyLocal-cache-backup-2026-01-01T00-00-00-000.json";
      const mobileRestoreBackupPath = `${mobileCacheBackupDir}/${mobileRestoreBackupName}`;
      const cacheBeforeMobileRestore = await mobileAdapter.read(mobileCachePath);
      const cachePathsBeforeMobileRestore = Object.values(JSON.parse(cacheBeforeMobileRestore).entries).map((entry) => entry.path).sort();
      const restoredPath = "Images/mobile-restored.png";
      const restoredTimestamp = 303;
      const restoredKey = mobilePlugin.cache.buildCacheKey(restoredPath, "", restoredTimestamp);
      const restoredPayload = JSON.stringify({
        entries: { [restoredKey]: concurrentEntry(restoredPath, restoredTimestamp) },
        version: "2.0.0"
      });
      const backupNamesBeforeRestore = new Set(await mobilePlugin.cache.getAvailableBackups());
      await mobileAdapter.write(mobileRestoreBackupPath, restoredPayload);
      const mobileRestoreResult = await mobilePlugin.cache.restoreFromBackup(mobileRestoreBackupName);
      assert(mobileRestoreResult === true, "Mobile restore did not apply a validated adapter backup");
      const restoredDiskCache = JSON.parse(await mobileAdapter.read(mobileCachePath));
      assert(Object.values(restoredDiskCache.entries).some((entry) => entry.path === restoredPath), "Mobile restore did not update the disk cache");
      assert(mobilePlugin.cache.getEntriesForPath(restoredPath).length === 1, "Mobile restore did not update the in-memory cache");

      const backupNamesAfterRestore = await mobilePlugin.cache.getAvailableBackups();
      const newSafetyBackupNames = backupNamesAfterRestore.filter((name) => name !== mobileRestoreBackupName && !backupNamesBeforeRestore.has(name));
      let safetyBackupName = null;
      for (const backupName of newSafetyBackupNames) {
        const candidate = JSON.parse(await mobileAdapter.read(`${mobileCacheBackupDir}/${backupName}`));
        const candidatePaths = Object.values(candidate.entries || {}).map((entry) => entry.path).sort();
        if (JSON.stringify(candidatePaths) === JSON.stringify(cachePathsBeforeMobileRestore)) {
          safetyBackupName = backupName;
          break;
        }
      }
      assert(safetyBackupName, "Mobile restore did not create a verified safety backup of the previous cache");
      assert(await mobilePlugin.cache.restoreFromBackup(safetyBackupName), "Mobile safety backup could not be restored in reverse");
      const reverseRestoredPaths = Object.values(JSON.parse(await mobileAdapter.read(mobileCachePath)).entries).map((entry) => entry.path).sort();
      assert.deepEqual(reverseRestoredPaths, cachePathsBeforeMobileRestore, "Reverse mobile restore did not reproduce the pre-restore cache");

      const cacheBeforeFailedRestores = await mobileAdapter.read(mobileCachePath);
      const memoryBeforeFailedRestores = JSON.stringify(mobilePlugin.cache.cacheData);
      const mobileRestoreErrors = [];
      console.error = (...args) => {
        mobileRestoreErrors.push(args.map((value) => String(value)).join(" "));
      };
      try {
        const malformedBackupName = "tinyLocal-cache-backup-2026-01-02T00-00-00-000.json";
        await mobileAdapter.write(`${mobileCacheBackupDir}/${malformedBackupName}`, JSON.stringify({ entries: [], version: "2.0.0" }));
        assert(!await mobilePlugin.cache.restoreFromBackup(malformedBackupName), "Mobile restore accepted an invalid cache schema");
        assert.equal(await mobileAdapter.read(mobileCachePath), cacheBeforeFailedRestores, "Invalid mobile restore changed the disk cache");
        assert.equal(JSON.stringify(mobilePlugin.cache.cacheData), memoryBeforeFailedRestores, "Invalid mobile restore changed the in-memory cache");

        const safetyFailureBackupName = "tinyLocal-cache-backup-2026-01-03T00-00-00-000.json";
        await mobileAdapter.write(`${mobileCacheBackupDir}/${safetyFailureBackupName}`, restoredPayload);
	        const createBinaryBeforeSafetyFailure = mobileApp.vault.createBinary;
	        mobileApp.vault.createBinary = async (filePath, data) => {
	          if (String(filePath).startsWith(`${mobileCacheBackupDir}/tinyLocal-cache-backup-`)) {
	            throw new Error("Injected required safety-backup failure");
	          }
	          return await createBinaryBeforeSafetyFailure.call(mobileApp.vault, filePath, data);
	        };
	        try {
	          assert(!await mobilePlugin.cache.restoreFromBackup(safetyFailureBackupName), "Mobile restore continued without its required safety backup");
	        } finally {
	          mobileApp.vault.createBinary = createBinaryBeforeSafetyFailure;
	        }
        assert.equal(await mobileAdapter.read(mobileCachePath), cacheBeforeFailedRestores, "Safety-backup failure changed the mobile cache");

        const readbackFailureBackupName = "tinyLocal-cache-backup-2026-01-04T00-00-00-000.json";
        await mobileAdapter.write(`${mobileCacheBackupDir}/${readbackFailureBackupName}`, restoredPayload);
        const processBeforeReadbackFailure = mobileAdapter.process;
        let injectedReadbackResultFailure = false;
        mobileAdapter.process = async (vaultPath, update) => {
          if (!injectedReadbackResultFailure && String(vaultPath) === mobileCachePath) {
            injectedReadbackResultFailure = true;
            const next = await processBeforeReadbackFailure.call(mobileAdapter, vaultPath, update);
            return `${next} `;
          }
          return await processBeforeReadbackFailure.call(mobileAdapter, vaultPath, update);
        };
        try {
          assert(!await mobilePlugin.cache.restoreFromBackup(readbackFailureBackupName), "Mobile restore accepted an inconsistent atomic-process result");
        } finally {
          mobileAdapter.process = processBeforeReadbackFailure;
        }
        assert(injectedReadbackResultFailure, "Mobile restore readback failure was not injected");
        assert.equal(await mobileAdapter.read(mobileCachePath), cacheBeforeFailedRestores, "Failed mobile restore did not roll back the disk cache");
        assert.equal(JSON.stringify(mobilePlugin.cache.cacheData), memoryBeforeFailedRestores, "Failed mobile restore did not roll back the in-memory cache");

        const oversizedBackupName = "tinyLocal-cache-backup-2026-01-05T00-00-00-000.json";
        const oversizedBackupPath = `${mobileCacheBackupDir}/${oversizedBackupName}`;
        await mobileAdapter.write(oversizedBackupPath, restoredPayload);
        const originalRestoreLimit = mobilePlugin.getPlatformPorts().runtime.maxBufferedFileBytes;
        const statBeforeOversizedRestore = mobileAdapter.stat;
        let oversizedRestoreRead = false;
        const readBeforeOversizedRestore = mobileAdapter.read;
        mobilePlugin.getPlatformPorts().runtime.maxBufferedFileBytes = 64;
        mobileAdapter.stat = async (vaultPath) => String(vaultPath) === oversizedBackupPath
          ? { type: "file", ctime: 1, mtime: 1, size: 1 }
          : await statBeforeOversizedRestore.call(mobileAdapter, vaultPath);
        mobileAdapter.read = async (vaultPath) => {
          if (String(vaultPath) === oversizedBackupPath) oversizedRestoreRead = true;
          return await readBeforeOversizedRestore.call(mobileAdapter, vaultPath);
        };
        try {
          assert(!await mobilePlugin.cache.restoreFromBackup(oversizedBackupName), "Mobile restore accepted a backup exceeding the post-read UTF-8 byte limit");
        } finally {
          mobileAdapter.stat = statBeforeOversizedRestore;
          mobileAdapter.read = readBeforeOversizedRestore;
          mobilePlugin.getPlatformPorts().runtime.maxBufferedFileBytes = originalRestoreLimit;
        }
        assert(oversizedRestoreRead, "Mobile restore did not exercise its post-read byte-limit check");
        assert.equal(await mobileAdapter.read(mobileCachePath), cacheBeforeFailedRestores, "Oversized mobile restore changed the cache");
        assert(!await mobilePlugin.cache.restoreFromBackup("../tinyLocal-cache-backup-2026-01-05T00-00-00-000.json"), "Mobile restore accepted path traversal");
      } finally {
        console.error = originalConsoleErrorForMobile;
      }
      assert(mobileRestoreErrors.length >= 5, "Expected mobile restore failures were not surfaced through error logging");

	      mobilePlugin.cache.saveCacheDelayMs = 60_000;
	      mobilePlugin.cache.cacheData.entries["v2:old-unload"] = concurrentEntry("Images/old-unload.png", 201);
	      const pendingOldUnloadSave = mobilePlugin.cache.saveCache({ mergeDiskEntries: true });
	      assert(mobilePlugin.cache.saveCacheTimer, "Mobile unload test did not leave a genuinely pending cache save");

	      const mobileReloadedPlugin = new MobilePluginClass();
	      mobileReloadedPlugin.app = mobileApp;
	      mobileReloadedPlugin.manifest = mobilePlugin.manifest;
	      await mobileReloadedPlugin.initializePlugin();
	      mobileReloadedPlugin.cache.saveCacheDelayMs = 60_000;
	      mobileReloadedPlugin.cache.cacheData.entries["v2:new-load"] = concurrentEntry("Images/new-load.png", 202);
	      const pendingNewLoadSave = mobileReloadedPlugin.cache.saveCache({ mergeDiskEntries: true });
	      let releaseMobileProcessBarrier;
	      let markMobileProcessEntered;
	      let mobileProcessBarrierUsed = false;
	      const mobileProcessEntered = new Promise((resolve) => { markMobileProcessEntered = resolve; });
	      const mobileProcessRelease = new Promise((resolve) => { releaseMobileProcessBarrier = resolve; });
	      mobileProcessBarrier = async () => {
	        if (mobileProcessBarrierUsed) return;
	        mobileProcessBarrierUsed = true;
	        markMobileProcessEntered();
	        await mobileProcessRelease;
	      };
	      const newLoadFlush = mobileReloadedPlugin.cache.flushPendingCacheSave();
	      await mobileProcessEntered;
	      mobilePlugin.onunload();
	      await new Promise((resolve) => setImmediate(resolve));
	      assert(mobilePlugin.cache.activeWritePromise, "Old mobile unload did not queue behind the active new-load cache process");
	      releaseMobileProcessBarrier();
	      await Promise.all([pendingOldUnloadSave, pendingNewLoadSave, newLoadFlush]);
	      mobileProcessBarrier = null;
	      await Promise.all([
	        mobilePlugin.cache.activeWritePromise || Promise.resolve(),
	        mobileReloadedPlugin.cache.activeWritePromise || Promise.resolve()
	      ]);
	      const mobileRawCache = JSON.parse(await mobileAdapter.read(mobileCachePath));
	      const mobileReloadPaths = new Set(Object.values(mobileRawCache.entries).map((entry) => entry.path));
	      assert(mobileReloadPaths.has("Images/old-unload.png") && mobileReloadPaths.has("Images/new-load.png"), "Mobile old-unload/new-load overlap lost a cache entry");
	      mobileReloadedPlugin.onunload();
    } finally {
      console.error = originalConsoleErrorForMobile;
      mobileNodeModuleBan = false;
      Object.assign(MobileObsidianMock.Platform, originalPlatformState);
	      if (previousMobileWorker === undefined) {
        delete global.Worker;
      } else {
        global.Worker = previousMobileWorker;
	      }
      global.setTimeout = stubbedSetTimeout;
      global.clearTimeout = stubbedClearTimeout;
      delete global.window.JS_SHA256_NO_NODE_JS;
      delete global.window.JS_MD5_NO_NODE_JS;
      delete require.cache[artifactPath];
      fs.rmSync(mobileTemp, { recursive: true, force: true });
    }
  })(), 30000);

  // ponytail: keep the approved bug reproductions in one block and one failing signal.
  const bugReproducerObserved = {
    imageIndexDeleteWins: false,
    renamedInFlightPathCleared: false,
    longFenceImageIgnored: false,
    tildeFenceImageIgnored: false,
    multiBacktickImageIgnored: false
  };

  const bugReproducerIndexFile = createMockFile("Images/bug-reproducer-index.png", 100000, 301);
  const originalBugReproducerIsProcessed = plugin.cache.isFileAlreadyProcessed;
  let markBugReproducerIndexLookup;
  let releaseBugReproducerIndexLookup;
  const bugReproducerIndexLookupStarted = new Promise((resolve) => {
    markBugReproducerIndexLookup = resolve;
  });
  try {
    plugin.cache.isFileAlreadyProcessed = async () => {
      markBugReproducerIndexLookup();
      await new Promise((resolve) => {
        releaseBugReproducerIndexLookup = resolve;
      });
      return false;
    };
    const staleIndexUpdate = plugin.imageIndex.upsert(bugReproducerIndexFile, plugin.cache);
    await bugReproducerIndexLookupStarted;
    plugin.imageIndex.remove(bugReproducerIndexFile.path);
    releaseBugReproducerIndexLookup();
    await staleIndexUpdate;
    bugReproducerObserved.imageIndexDeleteWins = !plugin.imageIndex
      .getAllFiles()
      .some((file) => file.path === bugReproducerIndexFile.path);
  } finally {
    releaseBugReproducerIndexLookup?.();
    plugin.imageIndex.remove(bugReproducerIndexFile.path);
    plugin.cache.isFileAlreadyProcessed = originalBugReproducerIsProcessed;
  }

  const bugReproducerQueue = plugin.newFileQueue;
  const bugReproducerOldPath = "Images/bug-reproducer-in-flight.png";
  const bugReproducerNewPath = "Images/bug-reproducer-renamed.png";
  const bugReproducerQueueFile = Object.assign(
    new ObsidianMock.TFile(),
    createMockFile(bugReproducerOldPath, 100000, 302)
  );
  const originalBugReproducerGetFileByPath = plugin.app.vault.getFileByPath;
  const originalBugReproducerBatch = plugin.processBatchCompressionBackground;
  const originalBugReproducerUnloading = plugin.isUnloading;
  try {
    plugin.isUnloading = false;
    bugReproducerQueue.newFileCompressionPending.clear();
    bugReproducerQueue.newFileCompressionInFlight.clear();
    bugReproducerQueue.newFileBatchDrainInProgress = false;
    plugin.app.vault.getFileByPath = (filePath) =>
      filePath === bugReproducerOldPath ? bugReproducerQueueFile : null;
    plugin.processBatchCompressionBackground = async (files) => {
      files[0].path = bugReproducerNewPath;
    };
    bugReproducerQueue.newFileCompressionPending.add(bugReproducerOldPath);
    await plugin.drainNewFileCompressionBatch();
    bugReproducerObserved.renamedInFlightPathCleared =
      !bugReproducerQueue.newFileCompressionInFlight.has(bugReproducerOldPath) &&
      !bugReproducerQueue.newFileCompressionInFlight.has(bugReproducerNewPath);
  } finally {
    bugReproducerQueue.newFileCompressionPending.clear();
    bugReproducerQueue.newFileCompressionInFlight.clear();
    bugReproducerQueue.newFileBatchDrainInProgress = false;
    plugin.app.vault.getFileByPath = originalBugReproducerGetFileByPath;
    plugin.processBatchCompressionBackground = originalBugReproducerBatch;
    plugin.isUnloading = originalBugReproducerUnloading;
  }

  const originalBugReproducerFiles = plugin.app._files;
  const originalBugReproducerCachedRead = plugin.app.vault.cachedRead;
  const originalBugReproducerScannerUnloading = plugin.isUnloading;
  try {
    plugin.isUnloading = false;
    await setMockFiles(plugin, [
      createMockFile("Images/bug-reproducer-long-fence.png", 100000, 303),
      createMockFile("Images/bug-reproducer-tilde-fence.png", 100000, 304),
      createMockFile("Images/bug-reproducer-multi-backtick.png", 100000, 305)
    ]);
    plugin.app.vault.cachedRead = async () => [
      "````markdown",
      "![[Images/bug-reproducer-long-fence.png]]",
      "````",
      "~~~markdown",
      "![[Images/bug-reproducer-tilde-fence.png]]",
      "~~~",
      "``![[Images/bug-reproducer-multi-backtick.png]]``"
    ].join("\n");
    const codeOnlyImages = await plugin.imageScanner.getImagesInNote(
      createMockFile("Notes/bug-reproducer.md", 1000, 306)
    );
    const codeOnlyPaths = new Set(codeOnlyImages.map((file) => file.path));
    bugReproducerObserved.longFenceImageIgnored =
      !codeOnlyPaths.has("Images/bug-reproducer-long-fence.png");
    bugReproducerObserved.tildeFenceImageIgnored =
      !codeOnlyPaths.has("Images/bug-reproducer-tilde-fence.png");
    bugReproducerObserved.multiBacktickImageIgnored =
      !codeOnlyPaths.has("Images/bug-reproducer-multi-backtick.png");
  } finally {
    plugin.app.vault.cachedRead = originalBugReproducerCachedRead;
    plugin.isUnloading = false;
    await setMockFiles(plugin, originalBugReproducerFiles);
    plugin.isUnloading = originalBugReproducerScannerUnloading;
  }

  assert.deepEqual(
    bugReproducerObserved,
    {
      imageIndexDeleteWins: true,
      renamedInFlightPathCleared: true,
      longFenceImageIgnored: true,
      tildeFenceImageIgnored: true,
      multiBacktickImageIgnored: true
    },
    `Approved bug reproductions violated production contracts: ${JSON.stringify(bugReproducerObserved)}`
  );
  assert.deepEqual(
    fullAuditBugReproducerObserved,
    {
      legacyMovedCacheInvalidated: true,
      regionalExternalLanguageWins: true,
      externalLanguageReloadedOnSwitch: true
    },
    `Full-code Gate 1 reproductions violated production contracts: ${JSON.stringify(fullAuditBugReproducerObserved)}`
  );

  if (fs.existsSync(bugResearchPath)) {
    assert(fs.readFileSync(bugResearchPath, "utf8").trim().length === 0, "BUG_RESEARCH_FINDINGS.txt must be empty when no confirmed bugs remain");
  }
  console.log("TypeScript artifact smoke check passed.");
} finally {
  Module._load = originalLoad;
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.setTimeout = originalGlobals.setTimeout;
  global.clearTimeout = originalGlobals.clearTimeout;
  delete require.cache[require.resolve(artifact)];
  cleanupSmokeBackupStorageTemp();
  process.removeListener("exit", cleanupSmokeBackupStorageTemp);
}
})(), 180_000).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
