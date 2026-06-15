"use strict";

const fs = require("fs");
const path = require("path");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot, sourceRoot: root } = resolveRepositoryLayout();
const sourceRoot = path.join(root, "src-ts");
const stylesPath = path.join(repositoryRoot, "styles.css");

const syncFsMethods = [
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "closeSync",
  "copyFileSync",
  "existsSync",
  "lstatSync",
  "mkdirSync",
  "openSync",
  "readFileSync",
  "readdirSync",
  "readlinkSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statSync",
  "symlinkSync",
  "unlinkSync",
  "writeFileSync"
];

const syncFsPattern = new RegExp(`\\bfs\\d*\\.(${syncFsMethods.join("|")})\\s*\\(`);

const lineRules = [
  {
    id: "sync-fs",
    pattern: syncFsPattern,
    message: "Sync fs is forbidden in src-ts; use fs.promises.* or document a cold-path exception outside this gate."
  },
  {
    id: "console-log",
    pattern: /\bconsole\.log\s*\(/,
    message: "console.log is forbidden in production code; use a logger/debug path or remove it."
  },
  {
    id: "empty-promise-catch",
    pattern: /\.catch\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*\{\s*\}\s*\)/,
    message: "Empty promise rejection handlers hide async failures."
  },
  {
    id: "void-promise",
    pattern: /^\s*void\s+(?:this\.|[A-Za-z_$][\w$]*\.|[A-Za-z_$][\w$]*\(|Promise\.)/,
    message: "Explicitly discarded promises must be awaited or have an explained error path."
  },
  {
    id: "explicit-any",
    pattern: /(?::\s*any\b|\bas\s+any\b|\bis\s+any\b|\bany\s*\[\]|<[^>\n]*\bany\b[^>\n]*>)/,
    message: "Explicit any is forbidden in src-ts; use a domain type, unknown with narrowing, or a narrow structural boundary type."
  }
];

const syncFsExceptionScopes = [
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*removeStaleCacheLockSync\(/,
    endPattern: /^\s*async acquireCacheWriteLock\(/,
    reason: "Synchronous cache lock cleanup is isolated to the unload durability path and explicit recovery tests."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*acquireCacheWriteLockSync\(/,
    endPattern: /^\s*async releaseCacheWriteLock\(/,
    reason: "Synchronous cache lock acquisition is isolated to the unload durability path and explicit recovery tests."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*releaseCacheWriteLockSync\(/,
    endPattern: /^\s*mergeCacheEntries\(/,
    reason: "Synchronous cache lock release is isolated to the unload durability path and explicit recovery tests."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*mergeDiskCacheEntriesSync\(/,
    endPattern: /^\s*createBrokenCacheCopySync\(/,
    reason: "Synchronous disk merge is isolated to the unload durability path and explicit recovery tests."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*createBrokenCacheCopySync\(/,
    endPattern: /^\s*async createBrokenCacheCopy\(/,
    reason: "Synchronous corrupt-cache recovery is retained only for explicit recovery tests."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*writeCacheFileSyncAtomic\(/,
    endPattern: /^\s*async writeCacheFileAtomic\(/,
    reason: "Synchronous atomic write is required only to flush pending cache state during unload and by recovery tests."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*loadCacheSync\(/,
    endPattern: /^\s*async loadCache\(/,
    reason: "Legacy synchronous cache load is test-only; normal startup always awaits async loadCache."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*createBackupSync\(/,
    endPattern: /^\s*async cleanupOldBackups\(/,
    reason: "Synchronous backup helper is retained only for explicit recovery tests."
  },
  {
    file: "src-ts/cache.ts",
    startPattern: /^\s*cleanupRetainedFilesSync\(/,
    endPattern: /^\s*\/\/ Enhanced restore-from-backup method/,
    reason: "Synchronous retention cleanup is retained only for explicit recovery tests."
  },
  {
    file: "src-ts/i18n.ts",
    startPattern: /^export function getMergedDict\(/,
    endPattern: /^export function getUserLang\(/,
    reason: "Translation lookup is synchronous; optional external locale probing is cached and cold."
  }
];

function findSyncFsException(relativePath, lineIndex, lines) {
  for (const scope of syncFsExceptionScopes) {
    if (scope.file !== relativePath) {
      continue;
    }
    const startIndex = lines.findIndex((line) => scope.startPattern.test(line));
    if (startIndex === -1 || lineIndex < startIndex) {
      continue;
    }
    const endOffset = lines.slice(startIndex + 1).findIndex((line) => scope.endPattern.test(line));
    const endIndex = endOffset === -1 ? lines.length : startIndex + 1 + endOffset;
    if (lineIndex < endIndex) {
      return scope;
    }
  }
  return null;
}

function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return target.endsWith(".ts") && !target.endsWith(".d.ts") ? [target] : [];
  }

  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-ts") {
      continue;
    }

    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function parseTargets(argv) {
  const targets = argv.filter((arg) => arg !== "--quiet");
  if (targets.length === 0) {
    return [sourceRoot];
  }
  return targets.map((target) => path.resolve(root, target));
}

function toRelative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function getLineNumber(source, offset) {
  let lineNumber = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      lineNumber += 1;
    }
  }
  return lineNumber;
}

function addEmptyCatchFindings(source, relativePath, findings) {
  const emptyCatchPattern = /\bcatch\s*(?:\([^)]*\)\s*)?\{\s*\}/g;
  let match;
  while ((match = emptyCatchPattern.exec(source)) !== null) {
    findings.push({
      rule: "empty-catch",
      file: relativePath,
      line: getLineNumber(source, match.index),
      text: match[0].replace(/\s+/g, " ").trim(),
      message: "Empty catch blocks hide cleanup and lifecycle failures."
    });
  }
}

function maskCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function addDuplicateCssDeclarationFindings(source, relativePath, findings) {
  const css = maskCssComments(source);
  const frames = [];
  let quote = null;
  let escaped = false;
  let parenthesesDepth = 0;

  const processDeclaration = (frame, endOffset) => {
    const rawDeclaration = css.slice(frame.declarationStart, endOffset);
    const declaration = rawDeclaration.trim();
    if (!declaration) {
      return;
    }
    const colonIndex = declaration.indexOf(":");
    if (colonIndex <= 0) {
      return;
    }
    const property = declaration.slice(0, colonIndex).trim().toLowerCase();
    if (!/^-{0,2}[a-z_][a-z0-9_-]*$/i.test(property)) {
      return;
    }
    const declarationOffset = frame.declarationStart + rawDeclaration.length - rawDeclaration.trimStart().length;
    const firstOffset = frame.properties.get(property);
    if (firstOffset !== undefined) {
      findings.push({
        rule: "duplicate-css-property",
        file: relativePath,
        line: getLineNumber(source, declarationOffset),
        text: declaration.replace(/\s+/g, " "),
        message: `CSS property "${property}" is duplicated in one declaration block; first declared on line ${getLineNumber(source, firstOffset)}.`
      });
      return;
    }
    frame.properties.set(property, declarationOffset);
  };

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      parenthesesDepth += 1;
      continue;
    }
    if (character === ")" && parenthesesDepth > 0) {
      parenthesesDepth -= 1;
      continue;
    }
    if (parenthesesDepth > 0) {
      continue;
    }
    if (character === "{") {
      if (frames.length > 0) {
        frames[frames.length - 1].declarationStart = index + 1;
      }
      frames.push({
        declarationStart: index + 1,
        properties: new Map()
      });
      continue;
    }
    if (character === ";" && frames.length > 0) {
      const frame = frames[frames.length - 1];
      processDeclaration(frame, index);
      frame.declarationStart = index + 1;
      continue;
    }
    if (character === "}" && frames.length > 0) {
      const frame = frames.pop();
      processDeclaration(frame, index);
      if (frames.length > 0) {
        frames[frames.length - 1].declarationStart = index + 1;
      }
    }
  }
}

if (process.argv.includes("--self-test")) {
  const selfTestFindings = [];
  addEmptyCatchFindings("function demo() {\n  try {\n    work();\n  } catch (error) {\n  }\n}\n", "self-test.ts", selfTestFindings);
  if (!selfTestFindings.some((finding) => finding.rule === "empty-catch" && finding.line === 4)) {
    console.error("Class-wide gates self-test failed: multiline empty catch was not detected.");
    process.exit(1);
  }
  const duplicateCssFindings = [];
  addDuplicateCssDeclarationFindings(".demo {\n  width: 10px;\n  color: red;\n  width: 20px;\n}\n", "self-test.css", duplicateCssFindings);
  if (!duplicateCssFindings.some((finding) => finding.rule === "duplicate-css-property" && finding.line === 4)) {
    console.error("Class-wide gates self-test failed: duplicate CSS property was not detected.");
    process.exit(1);
  }
  const validCssFindings = [];
  addDuplicateCssDeclarationFindings("@media (max-width: 600px) {\n  .demo { width: var(--width, 0%); }\n}\n@keyframes fade { from { opacity: 0; } to { opacity: 1; } }\n", "valid.css", validCssFindings);
  if (validCssFindings.length > 0) {
    console.error("Class-wide gates self-test failed: valid nested CSS produced a false positive.");
    process.exit(1);
  }
  console.log("Class-wide gates self-test passed.");
  process.exit(0);
}

const findings = [];
for (const target of parseTargets(process.argv.slice(2))) {
  if (!fs.existsSync(target)) {
    findings.push({
      rule: "missing-target",
      file: toRelative(target),
      line: 0,
      text: "",
      message: "Lint target does not exist."
    });
    continue;
  }

  for (const filePath of collectFiles(target)) {
    const relativePath = toRelative(filePath);
    const fileSource = fs.readFileSync(filePath, "utf8");
    const lines = fileSource.split(/\r?\n/);
    addEmptyCatchFindings(fileSource, relativePath, findings);
    lines.forEach((line, index) => {
      for (const rule of lineRules) {
        if (rule.pattern.test(line)) {
          if (rule.id === "sync-fs" && findSyncFsException(relativePath, index, lines)) {
            continue;
          }
          findings.push({
            rule: rule.id,
            file: relativePath,
            line: index + 1,
            text: line.trim(),
            message: rule.message
          });
        }
      }
    });
  }
}

if (!fs.existsSync(stylesPath)) {
  findings.push({
    rule: "missing-styles",
    file: "styles.css",
    line: 0,
    text: "",
    message: "styles.css is required for CSS linting."
  });
} else {
  addDuplicateCssDeclarationFindings(fs.readFileSync(stylesPath, "utf8"), "styles.css", findings);
}

if (findings.length === 0) {
  console.log("Class-wide gates passed.");
  process.exit(0);
}

console.error(`Class-wide gates failed with ${findings.length} finding(s).`);
for (const finding of findings) {
  const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  console.error(`\n[${finding.rule}] ${location}`);
  console.error(`  ${finding.message}`);
  if (finding.text) {
    console.error(`  ${finding.text}`);
  }
}

process.exit(1);
