(async () => {
  const fs = require("fs");
  const path = require("path");
  const electron = require("electron");

  const pluginId = "local-image-compress";
  const startedAt = new Date().toISOString();
  const runStamp = startedAt.replace(/[:.]/g, "-").replace(/Z$/, "");
  const qaRoot = `QA-LIC-Runtime-${runStamp}`;
  const report = {
    startedAt,
    pluginId,
    qaRoot,
    checks: [],
    failures: [],
    warnings: [],
    metrics: {}
  };

  const restoreStack = [];
  const cleanupStack = [];
  let progressPath = "";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const normalizeVaultPath = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  const joinVault = (...parts) => normalizeVaultPath(parts.filter(Boolean).join("/"));
  const serializeError = (error) => ({
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : ""
  });
  const assert = (condition, message, details) => {
    if (!condition) {
      const error = new Error(message);
      if (details !== undefined) {
        error.details = details;
      }
      throw error;
    }
  };
  const recordWarning = (name, details) => report.warnings.push({ name, details });
  const writeProgress = (status, name, details = {}) => {
    if (!progressPath) {
      return;
    }
    fs.writeFileSync(progressPath, JSON.stringify({
      status,
      name,
      updatedAt: new Date().toISOString(),
      ...details
    }, null, 2));
  };
  const check = async (name, fn) => {
    const start = Date.now();
    writeProgress("running", name);
    try {
      const details = await fn();
      report.checks.push({
        name,
        status: "pass",
        durationMs: Date.now() - start,
        ...(details === undefined ? {} : { details })
      });
      writeProgress("passed", name, { durationMs: Date.now() - start });
      return details;
    } catch (error) {
      const failure = {
        name,
        status: "fail",
        durationMs: Date.now() - start,
        error: serializeError(error),
        ...(error?.details === undefined ? {} : { details: error.details })
      };
      report.checks.push(failure);
      report.failures.push(failure);
      writeProgress("failed", name, { durationMs: Date.now() - start, error: serializeError(error) });
      return undefined;
    }
  };

  const p = app?.plugins?.plugins?.[pluginId];
  if (!p) {
    throw new Error(`${pluginId} is not loaded`);
  }
  progressPath = path.join(p.getPluginDirectory(), "qa-backups", "runtime-qa-progress.json");
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  writeProgress("starting", "runtime QA");

  const vaultBase = p.moveService?.getVaultBasePath?.() || app.vault.adapter?.getBasePath?.() || app.vault.adapter?.basePath;
  if (!vaultBase) {
    throw new Error("Vault base path is unavailable");
  }
  const absolute = (vaultRel) => path.join(vaultBase, ...normalizeVaultPath(vaultRel).split("/").filter(Boolean));
  const outputRelFor = (sourceRel) => joinVault(p.getOutputFolder(), sourceRel);
  const outputAbsFor = (sourceRel) => absolute(outputRelFor(sourceRel));
  const existsRel = async (vaultRel) => fs.promises.access(absolute(vaultRel)).then(() => true).catch(() => false);
  const statRel = async (vaultRel) => fs.promises.stat(absolute(vaultRel));
  const safeRmAbs = async (targetAbs) => {
    const resolvedBase = path.resolve(vaultBase);
    const resolvedTarget = path.resolve(targetAbs);
    const relative = path.relative(resolvedBase, resolvedTarget);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Refusing to remove outside vault", { targetAbs, vaultBase });
    await fs.promises.rm(resolvedTarget, { recursive: true, force: true });
  };

  // --- QA settings safety net (must survive a hard-killed run) ---
  // This harness overwrites the user's real data.json. The in-renderer restore in the finally
  // below only runs if execution reaches it; a hard process kill skips it and leaves QA values
  // behind. So: auto-heal data.json if a previous crashed run left QA state in it, then snapshot
  // the clean settings to disk *before* any mutation so recovery is always possible.
  const qaStateMarker = "QA-LIC-Runtime-";
  const preQaSettingsBackupPath = path.join(p.getPluginDirectory(), "qa-backups", "pre-qa-data-backup.json");
  const settingsLookLikeQaState = (settings) => {
    const outputFolder = String(settings?.outputFolder || "");
    const roots = Array.isArray(settings?.allowedRoots) ? settings.allowedRoots : [];
    return outputFolder.includes(qaStateMarker) || roots.some((root) => String(root).includes(qaStateMarker));
  };
  if (settingsLookLikeQaState(p.settings)) {
    try {
      p.settings = JSON.parse(await fs.promises.readFile(preQaSettingsBackupPath, "utf8"));
      await p.saveSettings();
      recordWarning("qa.autoHealedPollutedSettings", { from: preQaSettingsBackupPath });
    } catch (error) {
      recordWarning("qa.autoHealUnavailable", serializeError(error));
    }
  }
  if (!settingsLookLikeQaState(p.settings)) {
    try {
      await fs.promises.mkdir(path.dirname(preQaSettingsBackupPath), { recursive: true });
      await fs.promises.writeFile(preQaSettingsBackupPath, JSON.stringify(p.settings, null, 2));
    } catch (error) {
      recordWarning("qa.preBackupFailed", serializeError(error));
    }
  }
  // --- end QA settings safety net ---

  const originalSettings = clone(p.settings);
  const originalCacheData = clone(p.cache.cacheData);
  const originalOpenPath = electron.shell.openPath;
  const originalNewFileDelay = p.newFileQueue?.AUTO_COMPRESS_DELAY;
  restoreStack.push(async () => {
    try {
      p.statusBarController?.closeMenu?.();
      p.closeManagedModals?.();
    } catch (error) {
      recordWarning("cleanup.close-ui", serializeError(error));
    }
    if (originalNewFileDelay !== undefined && p.newFileQueue) {
      p.newFileQueue.AUTO_COMPRESS_DELAY = originalNewFileDelay;
    }
    electron.shell.openPath = originalOpenPath;
    p.settings = clone(originalSettings);
    await p.saveSettings();
    p.cache.cacheData = clone(originalCacheData);
    await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
    await p.rebuildImageIndex?.("runtime-qa-restore");
    await p.statusBarController?.update?.();
  });
  cleanupStack.push(async () => {
    await safeRmAbs(absolute(qaRoot));
  });

  function patchMethod(target, name, replacement) {
    const original = target?.[name];
    target[name] = replacement;
    restoreStack.push(async () => {
      target[name] = original;
    });
    return original;
  }

  async function ensureFolder(vaultRel) {
    const normalized = normalizeVaultPath(vaultRel);
    if (!normalized) {
      return;
    }
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
        await sleep(20);
      }
    }
  }

  async function createTextFile(vaultRel, text) {
    await ensureFolder(path.posix.dirname(normalizeVaultPath(vaultRel)));
    return await app.vault.create(vaultRel, text);
  }

  function drawPattern(ctx, width, height, variant) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, variant % 2 ? "#fb7185" : "#0ea5e9");
    gradient.addColorStop(0.45, variant % 3 ? "#f8fafc" : "#22c55e");
    gradient.addColorStop(1, variant % 2 ? "#0f172a" : "#f59e0b");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    for (let y = 0; y < height; y += 18) {
      for (let x = 0; x < width; x += 18) {
        const r = (x * 13 + y * 3 + variant * 19) % 255;
        const g = (x * 7 + y * 17 + variant * 11) % 255;
        const b = (x * 5 + y * 23 + variant * 29) % 255;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`;
        ctx.fillRect(x, y, 12 + (variant % 5), 12 + ((x + y) % 5));
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.font = "bold 96px sans-serif";
    ctx.fillText(`QA ${variant}`, 44, Math.floor(height * 0.58));
  }

  async function makeImageBuffer(mime, width, height, quality, variant) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    drawPattern(ctx, width, height, variant);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error(`canvas.toBlob failed for ${mime}`)), mime, quality);
    });
    return await blob.arrayBuffer();
  }

  async function createImage(vaultRel, kind, variant) {
    const normalized = normalizeVaultPath(vaultRel);
    await ensureFolder(path.posix.dirname(normalized));
    const buffer = kind === "png"
      ? await makeImageBuffer("image/png", 760, 520, undefined, variant)
      : await makeImageBuffer("image/jpeg", 960, 640, 0.99, variant);
    const file = await app.vault.createBinary(normalized, buffer);
    await sleep(80);
    return file;
  }

  async function createSmallJpeg(vaultRel) {
    const normalized = normalizeVaultPath(vaultRel);
    await ensureFolder(path.posix.dirname(normalized));
    const buffer = await makeImageBuffer("image/jpeg", 64, 64, 0.45, 999);
    const file = await app.vault.createBinary(normalized, buffer);
    await sleep(80);
    return file;
  }

  async function waitForFile(vaultRel, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await existsRel(vaultRel)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function waitForCompressionIdle(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((p.compressionWorkflowsInFlight || 0) === 0 && !p.isAutoMoveRunning && !p.moveService?.moveOperationInProgress && !p.backgroundCompressionService?.isBackgroundCompressionRunning) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function waitForFreshCacheEntry(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const freshEntry = await p.cache.getFreshEntryForFile(file);
      if (freshEntry) {
        return freshEntry;
      }
      await sleep(150);
    }
    return null;
  }

  function getStoredCacheEntryWithState(filePath, state) {
    const entries = p.cache.getEntriesForPath(filePath) || [];
    const matchingEntries = entries
      .map(([cacheKey, entry]) => ({ cacheKey, entry }))
      .filter(({ entry }) => entry?.state === state)
      .sort((left, right) => Number(right.entry?.timestamp || 0) - Number(left.entry?.timestamp || 0));
    return matchingEntries[0] || null;
  }

  async function waitForStatusMenu(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const menu = document.querySelector(".tiny-local-status-menu");
      if (menu) {
        return menu;
      }
      await sleep(100);
    }
    return null;
  }

  async function assertCompressed(file, label) {
    await waitForCompressionIdle();
    const outRel = outputRelFor(file.path);
    assert(await waitForFile(outRel), `${label}: compressed output was not created`, { source: file.path, outRel });
    const originalStats = await statRel(file.path);
    const compressedStats = await statRel(outRel);
    assert(compressedStats.size > 0, `${label}: compressed output is empty`, { outRel });
    assert(compressedStats.size < originalStats.size, `${label}: compressed output is not smaller`, {
      source: file.path,
      originalSize: originalStats.size,
      compressedSize: compressedStats.size
    });
    const freshEntry = await waitForFreshCacheEntry(file);
    assert(!!freshEntry, `${label}: cache entry missing`, { source: file.path });
    assert(freshEntry.entry?.state === "pending_move", `${label}: cache entry is not pending_move`, freshEntry.entry);
    return {
      source: file.path,
      output: outRel,
      originalSize: originalStats.size,
      compressedSize: compressedStats.size,
      savedBytes: originalStats.size - compressedStats.size
    };
  }

  function dispatchInput(input, value) {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickElement(element) {
    if (typeof element.click === "function") {
      element.click();
      return;
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function isToggleOn(toggle) {
    if (toggle.classList.contains("is-enabled")) {
      return true;
    }
    const input = toggle.querySelector?.("input[type='checkbox']");
    if (input) {
      return !!input.checked;
    }
    return false;
  }

  function getToggleLabel(toggle) {
    return toggle.closest?.(".setting-item")?.querySelector?.(".setting-item-name")?.textContent?.trim() || "";
  }

  function refindToggleByLabel(label) {
    if (!label) {
      return null;
    }
    const root = app.setting?.activeTab?.containerEl;
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll(".checkbox-container")).find((candidate) => getToggleLabel(candidate) === label) || null;
  }

  async function setToggle(toggle, value) {
    const label = getToggleLabel(toggle);
    let current = toggle;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current?.isConnected) {
        current = refindToggleByLabel(label) || current;
      }
      if (isToggleOn(current) === value) {
        break;
      }
      clickElement(current);
      await sleep(700);
    }
    if (isToggleOn(current) !== value) {
      const input = current.querySelector?.("input[type='checkbox']");
      if (input) {
        input.checked = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(700);
      }
    }
    if (isToggleOn(current) !== value) {
      recordWarning("settings.toggleVisualState", {
        label,
        requested: value,
        actual: isToggleOn(current)
      });
    }
  }

  async function openSettings() {
    app.setting.open();
    let tab = null;
    const deadline = Date.now() + 5000;
    do {
      app.setting.openTabById(pluginId);
      await sleep(250);
      tab = app.setting.activeTab;
      if (tab?.id === pluginId) {
        break;
      }
    } while (Date.now() < deadline);
    assert(tab?.id === pluginId, "Plugin settings tab is not active", { activeId: tab?.id });
    if (typeof tab.renderSettings === "function") {
      await tab.renderSettings();
    } else if (typeof tab.display === "function") {
      tab.display();
    }
    await sleep(600);
    return tab.containerEl;
  }

  async function closeTopModal() {
    const doc = app.workspace?.activeDocument || document;
    const closeButton = doc.querySelector(".modal-container .modal-close-button");
    if (closeButton) {
      clickElement(closeButton);
      await sleep(200);
      return;
    }
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
  }

  async function runCommand(commandId, timeoutMs = 90000) {
    const result = app.commands.executeCommandById(`${pluginId}:${commandId}`);
    if (result && typeof result.then === "function") {
      await result;
    }
    await waitForCompressionIdle(timeoutMs);
  }

  async function setupIsolatedState() {
    await safeRmAbs(absolute(qaRoot));
    await ensureFolder(qaRoot);
    p.statusBarController?.closeMenu?.();
    p.closeManagedModals?.();
    p.settings = {
      ...clone(p.settings),
      pngQuality: { min: 45, max: 60 },
      jpegQuality: 50,
      allowedRoots: [`${qaRoot}/`],
      outputFolder: `${qaRoot}/Compressed`,
      autoCompressNewFiles: false,
      autoBackgroundCompression: false,
      autoBackgroundThreshold: 10,
      inactivityThresholdMinutes: 1,
      cacheRetentionMonths: 2,
      autoCleanupGhostsOnStart: false,
      autoBackupsRetentionEnabled: false,
      autoBackupsRetentionDays: 7,
      autoMoveCompressedEnabled: false,
      autoMoveCompressedThreshold: 1
    };
    await p.saveSettings();
    await p.cache.clearCache();
    await p.rebuildImageIndex("runtime-qa-start");
    await p.statusBarController.update();
    if (p.newFileQueue) {
      p.newFileQueue.AUTO_COMPRESS_DELAY = 25;
    }
  }

  async function restoreQaDefaults() {
    p.settings = {
      ...clone(p.settings),
      pngQuality: { min: 45, max: 60 },
      jpegQuality: 50,
      allowedRoots: [`${qaRoot}/`],
      outputFolder: `${qaRoot}/Compressed`,
      autoCompressNewFiles: false,
      autoBackgroundCompression: false,
      autoBackgroundThreshold: 10,
      inactivityThresholdMinutes: 1,
      cacheRetentionMonths: 2,
      autoCleanupGhostsOnStart: false,
      autoBackupsRetentionEnabled: false,
      autoBackupsRetentionDays: 7,
      autoMoveCompressedEnabled: false,
      autoMoveCompressedThreshold: 1
    };
    await p.saveSettings();
  }

  try {
    await setupIsolatedState();

    await check("runtime: plugin services and commands are loaded", async () => {
      const commandIds = Object.keys(app.commands.commands).filter((id) => id.startsWith(`${pluginId}:`)).sort();
      const expected = [
        `${pluginId}:compress-all-images`,
        `${pluginId}:compress-images-in-folder`,
        `${pluginId}:compress-images-in-note`,
        `${pluginId}:move-compressed-to-files`
      ].sort();
      for (const id of expected) {
        assert(commandIds.includes(id), `Missing command ${id}`, { commandIds });
      }
      assert(!!p.cache && !!p.compressor && !!p.moveService && !!p.statusBarController && !!p.imageScanner, "Core services missing");
      assert(p.imageIndex?.isReady?.() === true, "Image index is not ready");
      return { commandIds };
    });

    await check("runtime: codec readiness and settings application", async () => {
      const binaries = p.compressor.checkBinaries();
      assert(binaries.pngquant === true, "pngquant WASM is not ready", binaries);
      assert(binaries.mozjpeg === true, "mozjpeg WASM is not ready", binaries);
      const pngVersion = await p.getPngCodecVersions?.();
      const jpegVersion = await p.getJpegCodecVersions?.();
      p.applyRuntimeSettings();
      assert(p.pluginGuardService.operationTimeoutMs === 8000, "Internal guard timeout not applied");
      assert(p.compressor.processTimeoutMs === 120000, "Internal compression timeout not applied");
      assert(p.compressor.initTimeoutMs === 60000, "Internal WASM init timeout not applied");
      assert(p.compressor.maxInputBytes === 100 * 1024 * 1024, "Internal input size limit not applied");
      assert(p.compressor.maxImagePixels === 100 * 1000000, "Internal image pixel limit not applied");
      assert(p.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD === p.settings.autoBackgroundThreshold, "Background threshold not applied");
      return { binaries, pngVersion, jpegVersion };
    });

    await check("settings: DOM surface has every expected control family", async () => {
      const root = await openSettings();
      assert(p.settingsTab === app.setting.activeTab, "Plugin does not own the active settings tab instance");
      assert(p.settingsTab?._isVisible === true, "Plugin-owned settings tab did not record visible state");
      await p.updateSavingsIndicatorInSettings();
      const labels = Array.from(root.querySelectorAll(".setting-item-name")).map((el) => el.textContent.trim()).filter(Boolean);
      const buttons = Array.from(root.querySelectorAll("button"));
      const textInputs = Array.from(root.querySelectorAll("input[type='text']"));
      const rangeInputs = Array.from(root.querySelectorAll("input[type='range']"));
      const toggles = Array.from(root.querySelectorAll(".checkbox-container"));
      const dropdowns = Array.from(root.querySelectorAll("select"));
      report.metrics.settingsLabels = labels;
      assert(labels.length >= 24, "Settings labels count is too low", { count: labels.length, labels });
      assert(buttons.length >= 9, "Settings buttons count is too low", { count: buttons.length, texts: buttons.map((button) => button.textContent.trim()) });
      assert(textInputs.length >= 2, "Expected PNG and output-folder text inputs", { count: textInputs.length });
      assert(rangeInputs.length >= 6, "Expected all remaining settings sliders", { count: rangeInputs.length });
      assert(toggles.length >= 5, "Expected all settings toggles", { count: toggles.length });
      assert(dropdowns.length >= 0, "Dropdown query failed");
      const savingsTarget = root.querySelector(".tiny-local-savings-tooltip-target");
      if (savingsTarget) {
        assert(savingsTarget.getAttribute("role") === "group", "Savings tooltip target is missing group semantics");
        assert(savingsTarget.getAttribute("tabindex") === "0", "Savings tooltip target is not keyboard focusable");
        assert(!!savingsTarget.getAttribute("aria-label"), "Savings tooltip target is missing an accessible summary");
        savingsTarget.focus();
        await sleep(100);
        const tooltip = document.querySelector(".tiny-local-savings-tooltip");
        assert(tooltip?.getAttribute("role") === "tooltip", "Savings tooltip did not open from keyboard focus");
        savingsTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await sleep(100);
        assert(!document.querySelector(".tiny-local-savings-tooltip"), "Savings tooltip did not close from Escape");
      }
      return {
        labelCount: labels.length,
        buttonCount: buttons.length,
        textInputCount: textInputs.length,
        rangeInputCount: rangeInputs.length,
        toggleCount: toggles.length,
        dropdownCount: dropdowns.length,
        keyboardTooltip: !!savingsTarget
      };
    });

    await check("accessibility: theme variables, motion overrides, and popout ownership", async () => {
      const originalThemeClasses = {
        light: document.body.classList.contains("theme-light"),
        dark: document.body.classList.contains("theme-dark")
      };
      const sample = document.querySelector(".tiny-local-savings-indicator") || document.querySelector(".tiny-local-settings");
      assert(!!sample, "No plugin UI sample available for theme verification");
      const readTheme = (themeClass) => {
        document.body.classList.remove("theme-light", "theme-dark");
        document.body.classList.add(themeClass);
        const style = window.getComputedStyle(sample);
        return {
          color: style.color,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor
        };
      };
      let popoutLeaf = null;
      try {
        const light = readTheme("theme-light");
        const dark = readTheme("theme-dark");
        for (const [theme, values] of Object.entries({ light, dark })) {
          assert(Object.values(values).every((value) => value && !value.includes("var(")), `Theme ${theme} left unresolved plugin colors`, values);
        }

        const mediaRules = [];
        for (const sheet of Array.from(document.styleSheets)) {
          let rules = [];
          try {
            rules = Array.from(sheet.cssRules || []);
          } catch {
            continue;
          }
          for (const rule of rules) {
            if (typeof rule.conditionText === "string") {
              mediaRules.push({ condition: rule.conditionText, cssText: rule.cssText, rule });
            }
          }
        }
        const reducedMotion = mediaRules.find((rule) => rule.condition.includes("prefers-reduced-motion") && rule.cssText.includes(".tiny-local-"));
        const highContrast = mediaRules.find((rule) => rule.condition.includes("prefers-contrast") && rule.cssText.includes(".tiny-local-"));
        const reducedMotionRules = Array.from(reducedMotion?.rule.cssRules || []);
        const disablesTransitions = reducedMotionRules.some((rule) => rule.style?.transitionProperty === "none");
        const disablesAnimations = reducedMotionRules.some((rule) => rule.style?.animationName === "none");
        assert(disablesTransitions && disablesAnimations, "Loaded CSS is missing reduced-motion overrides");
        assert(!!highContrast, "Loaded CSS is missing high-contrast overrides");

        popoutLeaf = app.workspace.openPopoutLeaf();
        await sleep(500);
        const popoutContainer = popoutLeaf?.view?.containerEl;
        const popoutDocument = popoutContainer?.doc || popoutContainer?.ownerDocument;
        assert(popoutContainer && popoutDocument && popoutDocument !== document, "Obsidian popout leaf did not expose a distinct document");
        const popoutTarget = popoutContainer.createDiv({ cls: "tiny-local-runtime-popout-tooltip-probe" });
        const savings = (await p.getStatsSnapshot()).savings;
        p.settingsTab.createSavingsTooltip(popoutTarget, savings);
        popoutTarget.focus();
        await sleep(150);
        assert(!!popoutDocument.querySelector(".tiny-local-savings-tooltip"), "Savings tooltip did not render in its owning popout document");
        assert(!document.querySelector(".tiny-local-savings-tooltip"), "Popout savings tooltip leaked into the main document");
        p.settingsTab.cleanupSavingsTooltips();
        popoutTarget.remove();

        return { light, dark, reducedMotion: true, highContrast: true, popoutOwned: true };
      } finally {
        document.body.classList.remove("theme-light", "theme-dark");
        if (originalThemeClasses.light) document.body.classList.add("theme-light");
        if (originalThemeClasses.dark) document.body.classList.add("theme-dark");
        p.settingsTab.cleanupSavingsTooltips();
        popoutLeaf?.detach?.();
      }
    });

    await check("settings: text inputs and sliders update runtime settings", async () => {
      const root = await openSettings();
      const textInputs = Array.from(root.querySelectorAll("input[type='text']"));
      const rangeInputs = Array.from(root.querySelectorAll("input[type='range']"));
      assert(textInputs.length >= 2 && rangeInputs.length >= 6, "Settings controls missing");

      dispatchInput(textInputs[0], "42-58");
      assert(p.settings.pngQuality.min === 42 && p.settings.pngQuality.max === 58, "PNG quality text input did not update settings", p.settings.pngQuality);
      const oldOutput = p.settings.outputFolder;
      dispatchInput(textInputs[1], "../bad-output");
      await sleep(100);
      assert(p.settings.outputFolder === oldOutput, "Invalid output folder was accepted", { oldOutput, current: p.settings.outputFolder });
      dispatchInput(textInputs[1], `${qaRoot}/Compressed`);
      assert(p.settings.outputFolder === `${qaRoot}/Compressed`, "Output folder text input did not update settings", p.settings.outputFolder);

      const sliderAssertions = [
        [0, 55, () => p.settings.jpegQuality === 55, "jpegQuality"],
        [1, 20, () => p.settings.autoBackgroundThreshold === 20 && p.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD === 20, "autoBackgroundThreshold"],
        [2, 3, () => p.settings.inactivityThresholdMinutes === 3 && p.backgroundCompressionService.USER_INACTIVITY_THRESHOLD === 180000, "inactivityThresholdMinutes"],
        [3, 9, () => p.settings.autoBackupsRetentionDays === 9, "autoBackupsRetentionDays"],
        [4, 2, () => p.settings.autoMoveCompressedThreshold === 2, "autoMoveCompressedThreshold"],
        [5, 4, () => p.settings.cacheRetentionMonths === 4, "cacheRetentionMonths"]
      ];
      for (const [index, value, predicate, key] of sliderAssertions) {
        dispatchInput(rangeInputs[index], value);
        await sleep(80);
        assert(predicate(), `Slider did not update ${key}`, { key, value, current: p.settings[key] });
      }

      await sleep(800);
      await restoreQaDefaults();
      return {
        pngQuality: p.settings.pngQuality,
        outputFolder: p.settings.outputFolder,
        slidersTested: sliderAssertions.length
      };
    });

    await check("settings: toggles update runtime settings", async () => {
      await restoreQaDefaults();
      const root = await openSettings();
      const freshToggles = Array.from(root.querySelectorAll(".checkbox-container"));
      assert(freshToggles.length >= 5, "Settings toggles missing", { count: freshToggles.length });
      await setToggle(freshToggles[0], true);
      assert(p.settings.autoCompressNewFiles === true, "autoCompressNewFiles toggle did not update");
      await setToggle(freshToggles[1], true);
      assert(p.settings.autoBackgroundCompression === true, "background toggle did not update");
      await setToggle(freshToggles[2], true);
      assert(p.settings.autoBackupsRetentionEnabled === true, "retention toggle did not update");
      await setToggle(freshToggles[3], true);
      assert(p.settings.autoMoveCompressedEnabled === true, "auto-move toggle did not update");
      await setToggle(freshToggles[4], true);
      assert(p.settings.autoCleanupGhostsOnStart === true, "ghost cleanup toggle did not update");
      await sleep(650);
      await restoreQaDefaults();
      return {
        togglesTested: 5
      };
    });

    await check("settings: allowed roots add modal and clear icon work", async () => {
      p.settings.allowedRoots = [`${qaRoot}/`];
      await p.saveSettings();
      let root = await openSettings();
      let buttons = Array.from(root.querySelectorAll("button"));
      const rootPill = root.querySelector(".tiny-local-roots-pill");
      assert(rootPill?.tagName === "BUTTON" && !!rootPill.getAttribute("aria-label"), "Allowed-root removal pill is not an accessible button");
      const addButton = buttons.find((button) => !button.classList.contains("tiny-local-roots-pill"));
      assert(!!addButton, "Allowed-roots Add button missing");
      clickElement(addButton);
      await sleep(300);
      assert(!!document.querySelector(".modal-container .modal"), "Allowed-roots modal did not open");
      await closeTopModal();
      root = await openSettings();
      const clearIcon = root.querySelector(".tiny-local-roots-clear");
      assert(!!clearIcon, "Allowed-roots clear icon missing");
      clickElement(clearIcon);
      await sleep(400);
      assert(Array.isArray(p.settings.allowedRoots) && p.settings.allowedRoots.length === 0, "Allowed roots were not cleared", p.settings.allowedRoots);
      await restoreQaDefaults();
      return { modalOpened: true, clearWorked: true };
    });

    await check("settings: cache restore dropdown is populated and dispatches restore", async () => {
      const markerMtime = Date.now();
      const markerKey = p.cache.buildCacheKey(`${qaRoot}/restore-marker.jpg`, "restore-marker", markerMtime);
      p.cache.cacheData.entries[markerKey] = {
        path: `${qaRoot}/restore-marker.jpg`,
        md5: "restore-marker",
        mtime: markerMtime,
        timestamp: markerMtime,
        lastAccessMs: markerMtime,
        state: "processed",
        originalSize: 123,
        sourceMtime: markerMtime,
        sourceSize: 123
      };
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      await p.cache.createBackup();
      const backups = await p.cache.getAvailableBackups();
      assert(backups.length > 0, "No cache backups available after createBackup");
      const targetBackup = backups[0];
      const originalRestore = p.cache.restoreFromBackup.bind(p.cache);
      let restoredValue = null;
      p.cache.restoreFromBackup = async (value) => {
        restoredValue = value;
        return true;
      };
      try {
        const root = await openSettings();
        const select = root.querySelector("select");
        assert(!!select, "Cache restore dropdown missing");
        assert(Array.from(select.options).some((option) => option.value === targetBackup), "Created backup is missing from dropdown", { targetBackup });
        select.value = targetBackup;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(600);
        assert(restoredValue === targetBackup, "Dropdown did not dispatch restoreFromBackup", { restoredValue, targetBackup });
      } finally {
        p.cache.restoreFromBackup = originalRestore;
      }
      return { backupCount: backups.length, targetBackup };
    });

    await check("settings: all action buttons dispatch their intended operations", async () => {
      const calls = {
        refresh: 0,
        clearCache: 0,
        rebuildIndex: 0,
        statusUpdate: 0,
        clearGhosts: 0,
        move: 0,
        clearBackups: 0,
        openPath: [],
        showBackupsList: 0
      };
      const originals = {
        forceRefreshCache: p.forceRefreshCache,
        clearCache: p.cache.clearCache,
        rebuildImageIndex: p.rebuildImageIndex,
        statusUpdate: p.statusBarController.update,
        cleanupGhostEntries: p.cleanupGhostEntries,
        moveCompressedToFiles: p.moveService.moveCompressedToFiles,
        clearOriginalFilesBackups: p.clearOriginalFilesBackups,
        showCacheBackupsList: p.showCacheBackupsList,
        openPath: electron.shell.openPath
      };
      p.forceRefreshCache = async () => { calls.refresh++; };
      p.cache.clearCache = async () => { calls.clearCache++; };
      p.rebuildImageIndex = async () => { calls.rebuildIndex++; };
      p.statusBarController.update = async () => { calls.statusUpdate++; };
      p.cleanupGhostEntries = async () => { calls.clearGhosts++; return 1; };
      p.moveService.moveCompressedToFiles = async () => { calls.move++; };
      p.clearOriginalFilesBackups = async () => { calls.clearBackups++; };
      p.showCacheBackupsList = async () => { calls.showBackupsList++; };
      electron.shell.openPath = async (targetPath) => {
        calls.openPath.push(targetPath);
        return "";
      };
      try {
        const root = await openSettings();
        const buttons = Array.from(root.querySelectorAll("button"))
          .filter((button) => !button.classList.contains("tiny-local-roots-pill"));
        assert(buttons.length >= 9, "Expected at least 9 settings buttons", { count: buttons.length, texts: buttons.map((button) => button.textContent.trim()) });
        const buttonIndexes = {
          refreshUncompressed: 1,
          clearCache: 2,
          refreshCache: 3,
          clearGhosts: 4,
          moveCompressed: 5,
          clearImageBackups: 6,
          openImageBackups: 7,
          openCacheBackups: 8
        };
        for (const index of Object.values(buttonIndexes)) {
          assert(buttons[index], `Missing button index ${index}`, { count: buttons.length });
          clickElement(buttons[index]);
          await sleep(450);
        }
        assert(calls.refresh === 2, "Refresh buttons did not dispatch forceRefreshCache twice", calls);
        assert(calls.clearCache === 1, "Clear cache button did not dispatch", calls);
        assert(calls.clearGhosts === 1, "Clear ghosts button did not dispatch", calls);
        assert(calls.move === 1, "Move button did not dispatch", calls);
        assert(calls.clearBackups === 1, "Clear image backups button did not dispatch", calls);
        assert(calls.openPath.length === 1, "Open image backups button did not open path", calls);
        assert(calls.showBackupsList === 1, "Open cache backups button did not dispatch", calls);
      } finally {
        p.forceRefreshCache = originals.forceRefreshCache;
        p.cache.clearCache = originals.clearCache;
        p.rebuildImageIndex = originals.rebuildImageIndex;
        p.statusBarController.update = originals.statusUpdate;
        p.cleanupGhostEntries = originals.cleanupGhostEntries;
        p.moveService.moveCompressedToFiles = originals.moveCompressedToFiles;
        p.clearOriginalFilesBackups = originals.clearOriginalFilesBackups;
        p.showCacheBackupsList = originals.showCacheBackupsList;
        electron.shell.openPath = originals.openPath;
        await restoreQaDefaults();
        await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
        await p.rebuildImageIndex("runtime-qa-after-button-wiring");
        await p.statusBarController.update();
      }
      return calls;
    });

    await check("cache: clear, ghost cleanup, stale prune, backup, and restore work", async () => {
      await p.cache.clearCache();
      assert(p.cache.getCacheStats().total === 0, "clearCache did not empty cache", p.cache.getCacheStats());
      const tiny = await createSmallJpeg(`${qaRoot}/Cache/tiny-too-small.jpg`);
      await p.compressFile(tiny);
      await waitForCompressionIdle();
      let fresh = await p.cache.getFreshEntryForFile(tiny);
      assert(fresh?.entry?.state === "skipped" && fresh.entry.skipReason === "too_small", "Too-small image was not cached as skipped", fresh?.entry);

      const ghostMtime = Date.now();
      const ghostKey = p.cache.buildCacheKey(`${qaRoot}/Cache/missing.jpg`, "ghost-md5", ghostMtime);
      p.cache.cacheData.entries[ghostKey] = {
        path: `${qaRoot}/Cache/missing.jpg`,
        md5: "ghost-md5",
        mtime: ghostMtime,
        timestamp: ghostMtime,
        lastAccessMs: ghostMtime,
        state: "processed",
        originalSize: 100,
        sourceMtime: ghostMtime,
        sourceSize: 100
      };
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      const ghostCount = await p.getGhostEntriesCount();
      const removedGhosts = await p.cleanupGhostEntries();
      assert(ghostCount >= 1 && removedGhosts >= 1, "Ghost cleanup did not remove ghost entry", { ghostCount, removedGhosts });

      const stale = await createSmallJpeg(`${qaRoot}/Cache/stale-source.jpg`);
      const staleMtime = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const staleKey = p.cache.buildCacheKey(stale.path, "stale-md5", staleMtime);
      p.cache.cacheData.entries[staleKey] = {
        path: stale.path,
        md5: "stale-md5",
        mtime: staleMtime,
        timestamp: staleMtime,
        lastAccessMs: staleMtime,
        state: "processed",
        originalSize: stale.stat.size,
        sourceMtime: staleMtime,
        sourceSize: stale.stat.size,
        stateUpdatedAt: staleMtime,
        processedMtime: staleMtime
      };
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      const pruned = await p.cache.pruneStaleCacheEntries(1, Date.now());
      assert(pruned >= 1, "Stale cache entry was not pruned", { pruned });

      const markerMtime = Date.now();
      const markerKey = p.cache.buildCacheKey(`${qaRoot}/Cache/backup-marker.jpg`, "backup-marker", markerMtime);
      p.cache.cacheData.entries[markerKey] = {
        path: `${qaRoot}/Cache/backup-marker.jpg`,
        md5: "backup-marker",
        mtime: markerMtime,
        timestamp: markerMtime,
        lastAccessMs: markerMtime,
        state: "processed",
        originalSize: 456,
        sourceMtime: markerMtime,
        sourceSize: 456
      };
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      await p.cache.createBackup();
      const backups = await p.cache.getAvailableBackups();
      assert(backups.length > 0, "Cache backup list is empty");
      const targetBackup = backups[0];
      delete p.cache.cacheData.entries[markerKey];
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      const restored = await p.cache.restoreFromBackup(targetBackup);
      assert(restored === true, "restoreFromBackup returned false", { targetBackup });
      assert(!!p.cache.cacheData.entries[markerKey], "Cache backup did not restore marker entry", { targetBackup });
      assert(p.cache.isValidBackupFileName("../bad.json") === false, "Invalid backup filename was accepted");
      return { ghostCount, removedGhosts, pruned, backupCount: backups.length, targetBackup };
    });

    await check("compression: direct JPG, JPEG, and PNG produce smaller outputs and pending cache entries", async () => {
      await p.cache.clearCache();
      await p.rebuildImageIndex("runtime-qa-compression-start");
      const jpg = await createImage(`${qaRoot}/Direct/direct-jpg.jpg`, "jpg", 1);
      const jpeg = await createImage(`${qaRoot}/Direct/direct-jpeg.jpeg`, "jpg", 2);
      const png = await createImage(`${qaRoot}/Direct/direct-png.png`, "png", 3);
      await p.compressFile(jpg);
      const jpgResult = await assertCompressed(jpg, "direct jpg");
      await p.compressFile(jpeg);
      const jpegResult = await assertCompressed(jpeg, "direct jpeg");
      await p.compressFile(png);
      const pngResult = await assertCompressed(png, "direct png");
      const validation = await p.validateFileForCompression(jpg);
      assert(validation.valid === false, "Already-compressed file was still valid for compression", validation);
      return { jpgResult, jpegResult, pngResult, alreadyCompressedValidation: validation };
    });

    await check("compression: file context menu action compresses selected image", async () => {
      const file = await createImage(`${qaRoot}/Context/File/context-file.jpg`, "jpg", 4);
      const items = [];
      const menu = {
        addItem(callback) {
          const item = {
            title: "",
            icon: "",
            callback: null,
            setTitle(value) { this.title = value; return this; },
            setIcon(value) { this.icon = value; return this; },
            onClick(value) { this.callback = value; return this; }
          };
          callback(item);
          items.push(item);
        }
      };
      p.addContextMenu(menu, file);
      assert(items.length === 1 && typeof items[0].callback === "function", "File context menu item missing", items);
      await items[0].callback();
      return await assertCompressed(file, "file context menu");
    });

    await check("compression: folder context menu action compresses images in the folder", async () => {
      const file = await createImage(`${qaRoot}/Context/Folder/context-folder.jpg`, "jpg", 5);
      const folder = app.vault.getAbstractFileByPath(`${qaRoot}/Context/Folder`);
      const items = [];
      const menu = {
        addItem(callback) {
          const item = {
            title: "",
            icon: "",
            callback: null,
            setTitle(value) { this.title = value; return this; },
            setIcon(value) { this.icon = value; return this; },
            onClick(value) { this.callback = value; return this; }
          };
          callback(item);
          items.push(item);
        }
      };
      p.addFolderContextMenu(menu, folder);
      assert(items.length === 1 && typeof items[0].callback === "function", "Folder context menu item missing", items);
      await items[0].callback();
      return await assertCompressed(file, "folder context menu");
    });

    await check("commands: compress images in active note", async () => {
      const noteImageA = await createImage(`${qaRoot}/Note/note-a.jpg`, "jpg", 6);
      const noteImageB = await createImage(`${qaRoot}/Note/note-b.png`, "png", 7);
      const note = await createTextFile(`${qaRoot}/Note/note.md`, `# Runtime QA\n\n![[${noteImageA.path}]]\n\n![[${noteImageB.path}]]\n`);
      await app.workspace.getLeaf(false).openFile(note);
      await sleep(1200);
      const discovered = await p.imageScanner.getImagesInNote(note);
      assert(discovered.some((file) => file.path === noteImageA.path), "Image scanner did not find note JPG", discovered.map((file) => file.path));
      assert(discovered.some((file) => file.path === noteImageB.path), "Image scanner did not find note PNG", discovered.map((file) => file.path));
      await runCommand("compress-images-in-note");
      const a = await assertCompressed(noteImageA, "command note jpg");
      const b = await assertCompressed(noteImageB, "command note png");
      return { discovered: discovered.map((file) => file.path), outputs: [a, b] };
    });

    await check("commands: compress images in selected folder", async () => {
      const file = await createImage(`${qaRoot}/FolderCommand/folder-command.jpg`, "jpg", 8);
      const originalSelector = p.showFolderSelector;
      p.showFolderSelector = async () => `${qaRoot}/FolderCommand`;
      try {
        await runCommand("compress-images-in-folder");
      } finally {
        p.showFolderSelector = originalSelector;
      }
      return await assertCompressed(file, "command folder");
    });

    await check("folder selector: cancel, select, and managed close clean up", async () => {
      const folderChoices = ["/", `${qaRoot}/FolderCommand`];
      app.setting?.close?.();
      p.closeManagedModals();
      await sleep(200);
      assert(p.settingsTab?._isVisible === false, "Plugin-owned settings tab remained visible before standalone modal QA");
      assert(p.managedModals.size === 0, "A prior managed modal remained open before standalone modal QA");
      const focusReturnProbe = document.body.createEl("button", { text: "Runtime QA modal trigger" });
      focusReturnProbe.type = "button";
      focusReturnProbe.focus();
      assert(document.activeElement === focusReturnProbe, "Runtime modal trigger could not receive focus before opening the folder selector");
      try {
        const cancelPromise = p.showFolderSelector(folderChoices);
        await sleep(250);
        let select = document.querySelector(".tiny-local-folder-select-control");
        assert(!!select, "Folder selector did not render a select control for cancel path");
        assert(select.getAttribute("aria-label"), "Folder selector select is missing aria-label");
        assert(document.activeElement === select, "Folder selector did not focus its first actionable control");
        clickElement(document.querySelector("#cancel-folder"));
        const cancelResult = await cancelPromise;
        assert(cancelResult === null, "Folder selector cancel did not resolve null", { cancelResult });
        await sleep(150);
        assert(!document.querySelector(".tiny-local-folder-select-control"), "Folder selector DOM remained after cancel");
        assert(document.activeElement === focusReturnProbe, "Folder selector did not return focus to its trigger");

        const selectPromise = p.showFolderSelector(folderChoices);
        await sleep(250);
        select = document.querySelector(".tiny-local-folder-select-control");
        assert(!!select, "Folder selector did not render a select control for selection path");
        select.value = `${qaRoot}/FolderCommand`;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        clickElement(document.querySelector("#select-folder"));
        const selectedResult = await selectPromise;
        assert(selectedResult === `${qaRoot}/FolderCommand`, "Folder selector returned the wrong selected folder", { selectedResult });
        await sleep(150);
        assert(!document.querySelector(".tiny-local-folder-select-control"), "Folder selector DOM remained after selection");

        const cleanupPromise = p.showFolderSelector(folderChoices);
        await sleep(250);
        assert(!!document.querySelector(".tiny-local-folder-select-control"), "Folder selector did not render before managed close");
        p.closeManagedModals();
        const cleanupResult = await cleanupPromise;
        assert(cleanupResult === null, "Managed modal cleanup did not resolve folder selector with null", { cleanupResult });
        await sleep(150);
        assert(!document.querySelector(".tiny-local-folder-select-control"), "Folder selector DOM remained after managed close");

        const moveProgressModal = p.moveService.showMoveProgressModal(1);
        assert(p.managedModals.has(moveProgressModal), "Move progress modal was not tracked");
        const moveProgressBar = moveProgressModal.contentEl.querySelector('[role="progressbar"]');
        const moveProgressStatus = moveProgressModal.contentEl.querySelector('[role="status"]');
        assert(moveProgressBar?.getAttribute("aria-valuemin") === "0" && moveProgressBar?.getAttribute("aria-valuemax") === "1", "Move progress modal is missing bounded ARIA values");
        assert(moveProgressStatus?.getAttribute("aria-live") === "polite", "Move progress modal is missing polite status announcements");
        p.closeManagedModals();
        assert(!p.managedModals.has(moveProgressModal), "Move progress modal remained tracked after cleanup");
        await sleep(100);
        assert(!document.querySelector(".tiny-local-move-progress-modal"), "Move progress modal DOM remained after managed close");

        return { cancelResult, selectedResult, cleanupResult, initialFocus: true, focusReturned: true, moveProgressCleaned: true };
      } finally {
        p.closeManagedModals();
        focusReturnProbe.remove();
      }
    });

    await check("commands: compress all images respects allowed roots and output folder exclusion", async () => {
      const file = await createImage(`${qaRoot}/All/all-command.jpg`, "jpg", 9);
      await runCommand("compress-all-images", 120000);
      const result = await assertCompressed(file, "command all");
      const outputFiles = app.vault.getFiles().filter((candidate) => candidate.path.startsWith(`${qaRoot}/Compressed/`));
      const uncompressed = await p.getImageFiles();
      assert(!uncompressed.some((candidate) => candidate.path.startsWith(`${qaRoot}/Compressed/`)), "Output folder files are treated as compression inputs", {
        outputFiles: outputFiles.map((candidate) => candidate.path),
        uncompressed: uncompressed.map((candidate) => candidate.path)
      });
      return { result, outputVaultFilesSeen: outputFiles.length };
    });

    await check("compression: background batch compression works without modal workflow", async () => {
      const file = await createImage(`${qaRoot}/Background/background.jpg`, "jpg", 10);
      await p.processBatchCompressionBackground([file]);
      return await assertCompressed(file, "background batch");
    });

    await check("compression: new-file auto compression queue drains and compresses", async () => {
      p.settings.autoCompressNewFiles = true;
      await p.saveSettings();
      const file = await createImage(`${qaRoot}/Auto/auto-new-file.jpg`, "jpg", 11);
      await p.handleNewFile(file);
      await sleep(100);
      await p.drainNewFileCompressionBatch();
      const result = await assertCompressed(file, "auto new file");
      await restoreQaDefaults();
      return result;
    });

    await check("validation: unsupported and too-small files are rejected safely", async () => {
      const textFile = await createTextFile(`${qaRoot}/Validation/not-image.txt`, "not an image");
      const unsupported = await p.validateFileForCompression(textFile);
      assert(unsupported.valid === false, "Unsupported text file was accepted", unsupported);
      const small = await createSmallJpeg(`${qaRoot}/Validation/small.jpg`);
      const tooSmall = await p.validateFileForCompression(small);
      assert(tooSmall.valid === false && tooSmall.skipped === true, "Too-small image was not rejected as skipped", tooSmall);
      const fresh = await p.cache.getFreshEntryForFile(small);
      assert(fresh?.entry?.skipReason === "too_small", "Too-small validation did not write cache skip entry", fresh?.entry);
      return { unsupported, tooSmall, skipEntry: fresh.entry };
    });

    await check("status bar: text, aria label, attention state, and menu buttons work", async () => {
      app.setting?.close?.();
      await sleep(200);
      assert(p.settingsTab?._isVisible === false, "Plugin-owned settings tab remained visible after settings close");
      await p.statusBarController.update();
      const statusText = p.statusBarItem?.getText?.() || p.statusBarItem?.textContent || "";
      const aria = p.statusBarItem?.getAttribute?.("aria-label") || "";
      assert(statusText.includes("/"), "Status bar text does not contain counts", { statusText, aria });
      assert(aria.includes(statusText.trim()), "Status bar aria-label does not include status text", { statusText, aria });
      assert(p.statusBarItem?.getAttribute?.("role") === "button", "Status bar item is missing role=button");
      assert(p.statusBarItem?.getAttribute?.("tabindex") === "0", "Status bar item is missing tabindex=0");
      assert(p.statusBarItem?.getAttribute?.("aria-haspopup") === "menu", "Status bar item is missing aria-haspopup=menu");

      const originalNote = p.compressImagesInNote;
      const originalAll = p.compressAllImages;
      const originalMove = p.moveService.moveCompressedToFiles;
      const originalCount = p.moveService.getCompressedFilesCount;
      const calls = { note: 0, all: 0, move: 0 };
      p.compressImagesInNote = async () => { calls.note++; };
      p.compressAllImages = async () => { calls.all++; };
      p.moveService.moveCompressedToFiles = async () => { calls.move++; };
      p.moveService.getCompressedFilesCount = async () => 1;
      try {
        const fakeEvent = {
          target: {
            getBoundingClientRect: () => ({ left: 80, top: 700, bottom: 720, width: 140, height: 22 })
          }
        };
        for (const [index, key] of [[0, "note"], [1, "all"], [2, "move"]]) {
          await p.statusBarController.showMenu(fakeEvent);
          const menu = document.querySelector(".tiny-local-status-menu");
          assert(!!menu, "Status menu did not open");
          const menuWindow = menu.ownerDocument?.defaultView || window;
          const immediateStyle = menuWindow.getComputedStyle(menu);
          const immediateRect = menu.getBoundingClientRect();
          const expectedLeft = Number.parseFloat(immediateStyle.getPropertyValue("--local-image-compress-status-menu-left"));
          const expectedTop = Number.parseFloat(immediateStyle.getPropertyValue("--local-image-compress-status-menu-top"));
          const transitionProperties = immediateStyle.transitionProperty
            .split(",")
            .map((property) => property.trim().toLowerCase());
          const transitionDurationsMs = immediateStyle.transitionDuration
            .split(",")
            .map((duration) => {
              const trimmed = duration.trim().toLowerCase();
              const numeric = Number.parseFloat(trimmed);
              return trimmed.endsWith("ms") ? numeric : numeric * 1000;
            });
          const hasAnimatedPositionTransition = transitionProperties.some((property, propertyIndex) => {
            const durationMs = transitionDurationsMs[propertyIndex % transitionDurationsMs.length] || 0;
            return durationMs > 0 && (property === "all" || property === "left" || property === "top" || property === "transform");
          });
          assert(
            !hasAnimatedPositionTransition,
            "Status menu still transitions dynamic position properties",
            { transitionProperty: immediateStyle.transitionProperty, transitionDuration: immediateStyle.transitionDuration }
          );
          assert(
            Number.isFinite(expectedLeft)
              && Number.isFinite(expectedTop)
              && Math.abs(immediateRect.left - expectedLeft) <= 1
              && Math.abs(immediateRect.top - expectedTop) <= 1,
            "Status menu did not render at its computed position immediately",
            {
              actual: { left: immediateRect.left, top: immediateRect.top },
              expected: { left: expectedLeft, top: expectedTop }
            }
          );
          await sleep(100);
          assert(menu.getAttribute("role") === "menu", "Status menu is missing role=menu");
          const items = Array.from(menu.querySelectorAll(".tiny-local-status-menu-item"));
          assert(items.length >= 3, "Status menu did not include all action items", { itemTexts: items.map((item) => item.textContent.trim()) });
          for (const item of items) {
            assert(item.tagName === "BUTTON", "Status menu action is not rendered as a button", { tagName: item.tagName, text: item.textContent.trim() });
            assert(item.getAttribute("role") === "menuitem", "Status menu action is missing role=menuitem", { text: item.textContent.trim() });
          }
          clickElement(items[index]);
          await sleep(250);
          assert(calls[key] === 1, `Status menu item ${key} did not dispatch`, calls);
        }

        p.statusBarController.closeMenu();
        const viewportWindow = document.defaultView || window;
        const edgeEvent = {
          target: {
            getBoundingClientRect: () => ({
              left: viewportWindow.innerWidth - 2,
              top: viewportWindow.innerHeight - 24,
              bottom: viewportWindow.innerHeight - 4,
              width: 2,
              height: 20
            })
          }
        };
        await p.statusBarController.showMenu(edgeEvent);
        const edgeMenu = await waitForStatusMenu();
        assert(!!edgeMenu, "Status menu did not open for right-edge viewport check");
        const edgeRect = edgeMenu.getBoundingClientRect();
        assert(edgeRect.left >= 0 && edgeRect.right <= viewportWindow.innerWidth && edgeRect.top >= 0 && edgeRect.bottom <= viewportWindow.innerHeight, "Status menu overflowed viewport", {
          rect: { left: edgeRect.left, right: edgeRect.right, top: edgeRect.top, bottom: edgeRect.bottom },
          viewport: { width: viewportWindow.innerWidth, height: viewportWindow.innerHeight }
        });
        const edgeItem = edgeMenu.querySelector(".tiny-local-status-menu-item");
        assert(!!edgeItem, "Status menu right-edge check did not find a menu item");
        const edgeItemStyle = viewportWindow.getComputedStyle(edgeItem);
        assert(edgeItemStyle.backgroundColor === "rgba(0, 0, 0, 0)" || edgeItemStyle.backgroundColor === "transparent", "Status menu item has a separate background", {
          backgroundColor: edgeItemStyle.backgroundColor
        });
        assert(edgeItemStyle.boxShadow === "none", "Status menu item still has theme button shadow", { boxShadow: edgeItemStyle.boxShadow });
        p.statusBarController.closeMenu();

        p.statusBarController.closeMenu();
        const originalStatusBarRect = p.statusBarItem.getBoundingClientRect;
        p.statusBarItem.getBoundingClientRect = () => ({ left: 80, top: 700, bottom: 720, width: 140, height: 22 });
        try {
          const statusBarWindow = p.statusBarItem.ownerDocument?.defaultView || window;
          p.statusBarItem.focus();
          const noteCallsBeforeKeyboard = calls.note;
          p.statusBarItem.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, view: statusBarWindow }));
          const keyboardMenu = await waitForStatusMenu();
          assert(!!keyboardMenu, "Status menu did not open with keyboard context");
          assert(p.statusBarItem.getAttribute("aria-expanded") === "true", "Status bar aria-expanded did not become true after keyboard open");
          const keyboardItems = Array.from(keyboardMenu.querySelectorAll(".tiny-local-status-menu-item"));
          assert(document.activeElement === keyboardItems[0], "Keyboard-opened status menu did not focus first action");
          const focusedItemStyle = statusBarWindow.getComputedStyle(keyboardItems[0]);
          assert(focusedItemStyle.outlineStyle !== "none" && Number.parseFloat(focusedItemStyle.outlineWidth) > 0, "Focused status menu item has no visible focus indicator", {
            outlineStyle: focusedItemStyle.outlineStyle,
            outlineWidth: focusedItemStyle.outlineWidth
          });
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[1], "ArrowDown did not focus the next status menu action");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[0], "ArrowUp did not focus the previous status menu action");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[keyboardItems.length - 1], "End did not focus the last status menu action");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[0], "Home did not focus the first status menu action");
          keyboardItems[0].dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, view: statusBarWindow }));
          await sleep(250);
          assert(calls.note === noteCallsBeforeKeyboard + 1, "Focused status menu first item did not dispatch", calls);
          assert(!document.querySelector(".tiny-local-status-menu"), "Status menu did not close after focused item action");

          await p.statusBarController.showMenu({ keyboard: true, returnFocusTo: p.statusBarItem, target: p.statusBarItem });
          const spaceMenu = await waitForStatusMenu();
          assert(!!spaceMenu, "Status menu did not reopen with keyboard context");
          const spaceItems = Array.from(spaceMenu.querySelectorAll(".tiny-local-status-menu-item"));
          spaceItems[0].dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, view: statusBarWindow }));
          await sleep(250);
          assert(calls.note === noteCallsBeforeKeyboard + 2, "Space did not activate the focused status menu action", calls);
          assert(!document.querySelector(".tiny-local-status-menu"), "Status menu did not close after Space activation");

          await p.statusBarController.showMenu({ keyboard: true, returnFocusTo: p.statusBarItem, target: p.statusBarItem });
          const escapeMenu = await waitForStatusMenu();
          assert(!!escapeMenu, "Status menu did not reopen for Escape verification");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, view: statusBarWindow }));
          await sleep(150);
          assert(!document.querySelector(".tiny-local-status-menu"), "Status menu did not close from Escape key");
          assert(p.statusBarItem.getAttribute("aria-expanded") === "false", "Status bar aria-expanded did not reset after Escape");
          const focusRestoreDeadline = Date.now() + 1000;
          while (document.activeElement !== p.statusBarItem && Date.now() < focusRestoreDeadline) {
            await sleep(50);
          }
          assert(document.activeElement === p.statusBarItem, "Status menu Escape did not restore focus to status bar");
        } finally {
          p.statusBarItem.getBoundingClientRect = originalStatusBarRect;
        }
      } finally {
        p.statusBarController.closeMenu();
        p.compressImagesInNote = originalNote;
        p.compressAllImages = originalAll;
        p.moveService.moveCompressedToFiles = originalMove;
        p.moveService.getCompressedFilesCount = originalCount;
      }
      return { statusText, aria, calls };
    });

    await check("stats: counts and savings calculator reflect QA images", async () => {
      await p.rebuildImageIndex("runtime-qa-stats");
      const counts = await p.getImageCompressionCounts();
      const stats = await p.getStatsSnapshot();
      const savings = await p.savingsCalculator.calculateSpaceSavings();
      assert(counts.totalImages > 0, "Image counts did not see QA images", counts);
      assert(stats.cacheStats.total > 0, "Stats cache total is empty after compression", stats.cacheStats);
      assert(typeof savings.savedPercentage === "number" && savings.savedPercentage >= 0 && savings.savedPercentage <= 100, "Savings result invalid", savings);
      return { counts, cacheStats: stats.cacheStats, savings };
    });

    await check("move: command moves compressed outputs to originals and creates backups", async () => {
      const moveProbe = await createImage(`${qaRoot}/Move/move-probe.jpg`, "jpg", 12);
      const originalBefore = (await statRel(moveProbe.path)).size;
      await p.compressFile(moveProbe);
      const compressed = await assertCompressed(moveProbe, "move command setup");
      const movableBefore = await p.moveService.getCompressedFilesCount();
      assert(movableBefore > 0, "No compressed files are movable before move", { movableBefore });
      await runCommand("move-compressed-to-files", 120000);
      const originalAfter = (await statRel(moveProbe.path)).size;
      assert(originalAfter < originalBefore, "Move command did not replace original with smaller compressed file", { originalBefore, originalAfter, compressed });
      assert(!(await existsRel(outputRelFor(moveProbe.path))), "Move command did not remove compressed output", { output: outputRelFor(moveProbe.path) });
      const movedCacheEntry = getStoredCacheEntryWithState(moveProbe.path, "moved");
      assert(!!movedCacheEntry, "Move command did not mark cache entry as moved", {
        entries: p.cache.getEntriesForPath(moveProbe.path)
      });
      const backupDir = p.getBackupStoragePaths().originalFilesBackups;
      const backups = await fs.promises.readdir(backupDir).catch(() => []);
      assert(backups.length > 0, "Move command did not create an image backup directory", { backupDir });
      return { movableBefore, originalBefore, originalAfter, backupCount: backups.length };
    });

    await check("move: auto-move threshold moves fresh compressed output automatically", async () => {
      p.settings.autoMoveCompressedEnabled = true;
      p.settings.autoMoveCompressedThreshold = 1;
      await p.saveSettings();
      const file = await createImage(`${qaRoot}/AutoMove/auto-move.jpg`, "jpg", 13);
      const originalBefore = (await statRel(file.path)).size;
      await p.compressFile(file);
      await waitForCompressionIdle(120000);
      const originalAfter = (await statRel(file.path)).size;
      assert(originalAfter < originalBefore, "Auto-move did not replace original with smaller compressed file", { originalBefore, originalAfter });
      assert(!(await existsRel(outputRelFor(file.path))), "Auto-move left compressed output behind", { output: outputRelFor(file.path) });
      const movedCacheEntry = getStoredCacheEntryWithState(file.path, "moved");
      assert(!!movedCacheEntry, "Auto-move did not mark cache entry moved", {
        entries: p.cache.getEntriesForPath(file.path)
      });
      await restoreQaDefaults();
      return { originalBefore, originalAfter };
    });

    await check("backups: clear original-files backups is safe when redirected to isolated storage", async () => {
      const isolatedStorageRoot = absolute(`${qaRoot}/IsolatedBackupStorage`);
      const originalGetBackupStoragePaths = p.getBackupStoragePaths;
      p.getBackupStoragePaths = () => ({
        root: isolatedStorageRoot,
        backupsRoot: path.join(isolatedStorageRoot, "backups"),
        cacheBackups: path.join(isolatedStorageRoot, "backups", "cache"),
        originalFilesBackups: path.join(isolatedStorageRoot, "backups", "originals")
      });
      try {
        const backupDir = p.getBackupStoragePaths().originalFilesBackups;
        await fs.promises.mkdir(path.join(backupDir, "backup-test"), { recursive: true });
        await fs.promises.writeFile(path.join(backupDir, "backup-test", "file.txt"), "backup");
        await p.clearOriginalFilesBackups();
        const remaining = await fs.promises.readdir(backupDir).catch(() => []);
        assert(remaining.length === 0, "clearOriginalFilesBackups did not empty isolated backup dir", { remaining, backupDir });
        return { backupDir };
      } finally {
        p.getBackupStoragePaths = originalGetBackupStoragePaths;
      }
    });

    await check("settings: force refresh cache completes and leaves index usable", async () => {
      await p.forceRefreshCache();
      await sleep(200);
      p.closeManagedModals?.();
      assert(p.imageIndex?.isReady?.() === true, "Image index is not ready after forceRefreshCache");
      const counts = await p.getImageCompressionCounts();
      return { counts };
    });
  } catch (error) {
    const failure = {
      name: "runtime-qa: uncaught setup or runner failure",
      status: "fail",
      error: serializeError(error)
    };
    report.checks.push(failure);
    report.failures.push(failure);
  } finally {
    for (let index = cleanupStack.length - 1; index >= 0; index--) {
      try {
        await cleanupStack[index]();
      } catch (error) {
        recordWarning(`cleanup.${index}`, serializeError(error));
      }
    }
    for (let index = restoreStack.length - 1; index >= 0; index--) {
      try {
        await restoreStack[index]();
      } catch (error) {
        recordWarning(`restore.${index}`, serializeError(error));
      }
    }
    try {
      p.closeManagedModals?.();
      p.statusBarController?.closeMenu?.();
    } catch (error) {
      recordWarning("final-ui-close", serializeError(error));
    }
  }

  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.checks.filter((item) => item.status === "pass").length,
    failed: report.failures.length,
    warnings: report.warnings.length
  };
  writeProgress(report.failures.length > 0 ? "completed-with-failures" : "completed", "runtime QA", {
    summary: report.summary
  });
  globalThis.__tinyLocalFullQaLastReport = report;
  return JSON.stringify(report, null, 2);
})()
