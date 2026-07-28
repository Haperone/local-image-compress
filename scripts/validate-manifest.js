"use strict";

const fs = require("fs");
const { builtinModules, isBuiltin } = require("module");
const path = require("path");
const ts = require("typescript");
const { resolveRepositoryLayout } = require("./repository-layout");

const { isDevLayout, repositoryRoot: root, sourceRoot } = resolveRepositoryLayout();
const manifestPath = path.join(root, "manifest.json");
const versionsPath = path.join(root, "versions.json");
const packagePath = path.join(root, "package.json");
const releaseWorkflowPath = path.join(root, ".github", "workflows", "release.yml");
const gitignorePath = path.join(root, ".gitignore");
const releasePreparePath = path.join(sourceRoot, "scripts", "prepare-release.js");
const releaseNotesPreparePath = path.join(sourceRoot, "scripts", "prepare-release-notes.js");
const sourceTsRoot = path.join(sourceRoot, "src-ts");
const MIN_API_SURFACE_APP_VERSION = "1.4.0";
const DESKTOP_ONLY_REQUIRED_REASON = "cache, move, backup, and migration paths still use desktop Node APIs outside the platform desktop port";
const NODE_BUILTIN_MODULES = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, "")));
const DESKTOP_ONLY_API_PATTERNS = [
  { label: "FileSystemAdapter.getBasePath", pattern: /\bFileSystemAdapter\b|\bgetBasePath\(/ }
];
// The platform desktop port is the single sanctioned home for Node/Electron
// APIs; everything it exposes stays behind runtime desktop detection.
const DESKTOP_ONLY_ALLOWLIST = new Set(["src-ts/platform/desktop.ts"]);
// Ratchet: files still awaiting the v2.x port migration. The set is empty —
// every desktop-only API now lives in the allowlisted platform desktop port.
// Never add new entries.
const DESKTOP_ONLY_MIGRATION_PENDING = new Set([]);

const NODE_RUNTIME_GLOBALS = new Set(["Buffer", "global", "process", "module", "require", "exports", "__dirname", "__filename"]);

function classifyDesktopOnlyModule(moduleName) {
  const unprefixedName = moduleName.replace(/^node:/, "");
  if (moduleName.startsWith("node:") || NODE_BUILTIN_MODULES.has(unprefixedName) || isBuiltin(moduleName)) {
    return `Node builtin module reference (${moduleName})`;
  }
  if (moduleName === "electron" || moduleName.startsWith("electron/")) {
    return `Electron module reference (${moduleName})`;
  }
  return null;
}

function getLiteralModuleName(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function getImportTypeModuleName(node) {
  return ts.isLiteralTypeNode(node.argument) ? getLiteralModuleName(node.argument.literal) : null;
}

function findDesktopOnlyModuleReference(source, fileName = "mutation.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let match = null;
  function inspectModuleName(moduleName) {
    if (!match && moduleName) {
      match = classifyDesktopOnlyModule(moduleName);
    }
  }
  function visit(node) {
    if (match) {
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      inspectModuleName(getLiteralModuleName(node.moduleSpecifier));
    } else if (ts.isImportTypeNode(node)) {
      inspectModuleName(getImportTypeModuleName(node));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspectModuleName(getLiteralModuleName(node.moduleReference.expression));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const moduleName = getLiteralModuleName(node.arguments[0]);
      if (!moduleName) {
        match = "Non-literal dynamic import";
        return;
      }
      inspectModuleName(moduleName);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return match;
}

function isPropertyOrDeclarationName(node) {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isMethodSignature(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node)
    || (ts.isPropertySignature(parent) && parent.name === node)
    || (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
    || (ts.isClassDeclaration(parent) && parent.name === node)
    || (ts.isInterfaceDeclaration(parent) && parent.name === node)
    || (ts.isTypeAliasDeclaration(parent) && parent.name === node)
    || (ts.isEnumDeclaration(parent) && parent.name === node)
    || (ts.isEnumMember(parent) && parent.name === node)
    || (ts.isModuleDeclaration(parent) && parent.name === node)
    || (ts.isClassExpression(parent) && parent.name === node)
    || (ts.isTypeParameterDeclaration(parent) && parent.name === node)
    || (ts.isLabeledStatement(parent) && parent.label === node)
    || (ts.isBreakStatement(parent) && parent.label === node)
    || (ts.isContinueStatement(parent) && parent.label === node)
    || (ts.isNamespaceExportDeclaration(parent) && parent.name === node)
    || (ts.isImportAttribute(parent) && parent.name === node)
    || ts.isBindingElement(parent)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent);
}

function isTypePosition(node) {
  let current = node.parent;
  while (current) {
    if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)
      || ts.isTypeParameterDeclaration(current)) {
      return true;
    }
    if (ts.isExpression(current) || ts.isStatement(current) || ts.isSourceFile(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function findNodeRuntimeGlobal(source, fileName = "mutation.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const globalObjectNames = new Set(["globalThis", "window", "self"]);
  const scopes = [new Set()];
  let match = null;

  function unwrapExpression(node) {
    let expression = node;
    while (expression && (ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression))) {
      expression = expression.expression;
    }
    return expression;
  }

  function bindPattern(pattern, scope = scopes[scopes.length - 1]) {
    if (ts.isIdentifier(pattern)) {
      scope.add(pattern.text);
      return;
    }
    for (const element of pattern.elements) {
      if (!ts.isOmittedExpression(element)) {
        bindPattern(element.name, scope);
      }
    }
  }

  function isBound(name) {
    return scopes.some((scope) => scope.has(name));
  }

  function bindImport(importDeclaration, scope) {
    const importClause = importDeclaration.importClause;
    if (!importClause) {
      return;
    }
    if (importClause.name) {
      scope.add(importClause.name.text);
    }
    const bindings = importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      scope.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        scope.add(element.name.text);
      }
    }
  }

  function predeclareStatements(statements, scope = scopes[scopes.length - 1]) {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          bindPattern(declaration.name, scope);
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement)) && statement.name) {
        scope.add(statement.name.text);
      } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
        scope.add(statement.name.text);
      } else if (ts.isImportEqualsDeclaration(statement)) {
        scope.add(statement.name.text);
      } else if (ts.isImportDeclaration(statement)) {
        bindImport(statement, scope);
      }
    }
  }

  function collectVarBindings(node, scope) {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isVariableDeclarationList(node)
      && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      for (const declaration of node.declarations) {
        bindPattern(declaration.name, scope);
      }
    }
    ts.forEachChild(node, (child) => collectVarBindings(child, scope));
  }

  function resolveSyntacticString(node) {
    const expression = unwrapExpression(node);
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveSyntacticString(expression.left);
      const right = resolveSyntacticString(expression.right);
      return left === null || right === null ? null : left + right;
    }
    return null;
  }

  function getMemberPropertyName(node) {
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text;
    }
    if (ts.isElementAccessExpression(node)) {
      return resolveSyntacticString(node.argumentExpression);
    }
    return null;
  }

  function getPatternPropertyName(element) {
    if (ts.isBindingElement(element)) {
      const propertyNode = element.propertyName || element.name;
      if (ts.isIdentifier(propertyNode) || ts.isStringLiteralLike(propertyNode)
        || ts.isNumericLiteral(propertyNode)) {
        return propertyNode.text;
      }
      return ts.isComputedPropertyName(propertyNode)
        ? resolveSyntacticString(propertyNode.expression)
        : null;
    }
    const propertyNode = element.name;
    if (ts.isIdentifier(propertyNode) || ts.isStringLiteralLike(propertyNode)
      || ts.isNumericLiteral(propertyNode)) {
      return propertyNode.text;
    }
    return ts.isComputedPropertyName(propertyNode)
      ? resolveSyntacticString(propertyNode.expression)
      : null;
  }

  function inspectDestructuringPattern(pattern) {
    if (ts.isIdentifier(pattern)) {
      return;
    }
    const elements = ts.isObjectLiteralExpression(pattern) ? pattern.properties : pattern.elements;
    const objectPattern = ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern);
    for (const element of elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      if (objectPattern && !ts.isSpreadAssignment(element)
        && !(ts.isBindingElement(element) && element.dotDotDotToken)
        && getPatternPropertyName(element) === "require") {
        match = "require";
        return;
      }
      const target = ts.isSpreadAssignment(element) ? element.expression
        : ts.isBindingElement(element) ? element.name
          : ts.isPropertyAssignment(element) ? element.initializer
            : ts.isShorthandPropertyAssignment(element) ? element.name : element;
      if (target && (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)
        || ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target))) {
        inspectDestructuringPattern(target);
      }
    }
  }

  function isSyntacticGlobalObject(node) {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      return globalObjectNames.has(expression.text) && !isBound(expression.text);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const propertyName = getMemberPropertyName(expression);
      return propertyName !== null && globalObjectNames.has(propertyName)
        && isSyntacticGlobalObject(expression.expression);
    }
    return false;
  }

  function isPureMemberWrite(node) {
    let target = node;
    while (target.parent) {
      const parent = target.parent;
      if ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
        || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent)
        || ts.isSatisfiesExpression(parent)) && parent.expression === target) {
        target = parent;
        continue;
      }
      if (ts.isDeleteExpression(parent) && parent.expression === target) {
        return true;
      }
      if (ts.isBinaryExpression(parent) && parent.left === target
        && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return true;
      }
      if ((ts.isArrayLiteralExpression(parent) && parent.elements.includes(target))
        || (ts.isPropertyAssignment(parent) && parent.initializer === target)
        || (ts.isSpreadAssignment(parent) && parent.expression === target)
        || (ts.isObjectLiteralExpression(parent) && parent.properties.includes(target))) {
        target = parent;
        continue;
      }
      return false;
    }
    return false;
  }

  function visit(node) {
    if (match) {
      return;
    }
    if (ts.isSourceFile(node)) {
      predeclareStatements(node.statements);
      collectVarBindings(node, scopes[0]);
      for (const statement of node.statements) {
        visit(statement);
      }
      return;
    }
    if (ts.isFunctionLike(node)) {
      const scope = new Set();
      scopes.push(scope);
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
        scope.add(node.name.text);
      }
      for (const parameter of node.parameters) {
        bindPattern(parameter.name, scope);
        if (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) {
          inspectDestructuringPattern(parameter.name);
        }
      }
      if (match) {
        scopes.pop();
        return;
      }
      if (node.body) {
        collectVarBindings(node.body, scope);
      }
      for (const parameter of node.parameters) {
        if (parameter.initializer) {
          visit(parameter.initializer);
        }
      }
      if (node.body) {
        visit(node.body);
      }
      scopes.pop();
      return;
    }
    if (ts.isClassExpression(node)) {
      const scope = new Set();
      scopes.push(scope);
      if (node.name) {
        scope.add(node.name.text);
      }
      ts.forEachChild(node, visit);
      scopes.pop();
      return;
    }
    if (ts.isBlock(node)) {
      const scope = new Set();
      scopes.push(scope);
      predeclareStatements(node.statements, scope);
      for (const statement of node.statements) {
        visit(statement);
      }
      scopes.pop();
      return;
    }
    if (ts.isModuleBlock(node)) {
      const scope = new Set();
      scopes.push(scope);
      predeclareStatements(node.statements, scope);
      for (const statement of node.statements) {
        visit(statement);
      }
      scopes.pop();
      return;
    }
    if (ts.isCatchClause(node)) {
      const scope = new Set();
      scopes.push(scope);
      if (node.variableDeclaration) {
        bindPattern(node.variableDeclaration.name, scope);
        if (ts.isObjectBindingPattern(node.variableDeclaration.name)
          || ts.isArrayBindingPattern(node.variableDeclaration.name)) {
          inspectDestructuringPattern(node.variableDeclaration.name);
        }
      }
      if (match) {
        scopes.pop();
        return;
      }
      visit(node.block);
      scopes.pop();
      return;
    }
    if (ts.isCaseBlock(node)) {
      const scope = new Set();
      scopes.push(scope);
      predeclareStatements(node.clauses.flatMap((clause) => [...clause.statements]), scope);
      for (const clause of node.clauses) {
        if (ts.isCaseClause(clause)) {
          visit(clause.expression);
        }
        for (const statement of clause.statements) {
          visit(statement);
        }
      }
      scopes.pop();
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const scope = new Set();
      scopes.push(scope);
      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          bindPattern(declaration.name, scope);
        }
      } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
        && (ts.isObjectLiteralExpression(node.initializer) || ts.isArrayLiteralExpression(node.initializer))) {
        inspectDestructuringPattern(node.initializer);
        if (match) {
          scopes.pop();
          return;
        }
      }
      ts.forEachChild(node, visit);
      scopes.pop();
      return;
    }
    if (ts.isVariableDeclaration(node)
      && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))) {
      inspectDestructuringPattern(node.name);
      if (match) {
        return;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrapExpression(node.left);
      if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
        inspectDestructuringPattern(target);
        if (match) {
          return;
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isElementAccessExpression(callee)
        && resolveSyntacticString(callee.argumentExpression) === null) {
        match = "dynamic computed call";
        return;
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const propertyName = getMemberPropertyName(node);
      if (propertyName === "require" && !isPureMemberWrite(node)) {
        match = "require";
        return;
      }
      if (propertyName !== null && NODE_RUNTIME_GLOBALS.has(propertyName)
        && isSyntacticGlobalObject(node.expression)) {
        match = propertyName;
        return;
      }
    }
    if (ts.isIdentifier(node) && NODE_RUNTIME_GLOBALS.has(node.text)
      && !isBound(node.text) && !isPropertyOrDeclarationName(node) && !isTypePosition(node)) {
      match = node.text;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return match;
}

for (const mutation of [
  "const x = Buffer;",
  "const x = global;",
  "const x = process;",
  "Buffer.alloc(1);",
  "process.env.NODE_ENV;",
  "void module;",
  "const load = require;",
  "exports.value = 1;",
  "void __dirname;",
  "void __filename;",
  "object.require('./browser');",
  "object?.require?.('./browser');",
  "object['require'];",
  "object['requ' + 'ire'];",
  "object.require.call(object, './browser');",
  "object.require.apply(object, ['./browser']);",
  "object.require.bind(object);",
  "object.require += browserLoader;",
  "Reflect.apply(object.require, object, ['./browser']);",
  "const { require: load } = object;",
  "const { nested: { require: load } } = object;",
  "const { ['requ' + 'ire']: load } = object;",
  "let load; ({ require: load } = object);",
  "function run({ require: load }) { load('fs'); }",
  "function run({ nested: { require: load } }) { load('fs'); }",
  "try {} catch ({ require: load }) { load('fs'); }",
  "let load; for ({ require: load } of values) { load('fs'); }",
  "const { window: runtime } = globalThis; runtime.require('./native');",
  "let runtime; ({ self: runtime } = window); runtime['require']('./native');",
  "globalThis.require('./native');",
  "globalThis.window.require('./native');",
  "window.process;",
  "globalThis['Buffer'];",
  "self.module;",
  "const key = getKey(); object[key]();",
  "const key = getKey(); window[key]();"
]) {
  if (!findNodeRuntimeGlobal(mutation)) {
    throw new Error(`Node runtime global gate mutation escaped detection: ${mutation}`);
  }
}
for (const safeSource of [
  "globalThis.crypto;",
  "window.setTimeout(callback, 0);",
  "adapter.process(path, update);",
  "function processImage() {}",
  "interface Codec { process(image: unknown): void; }",
  "const local = { require(name) { return name; } };",
  "const local = { require: browserLoader };",
  "class BrowserLoader { require(name) { return name; } }",
  "interface BrowserLoader { require(name: string): string; }",
  "type BrowserLoader = { require(name: string): string };",
  "function browser(require, module, exports, process, Buffer, global, __dirname, __filename) { require('fs'); return module; }",
  "const require = (name: string) => name; require('fs');",
  "function require(name: string) { return name; } require('fs');",
  "import { require, module } from './shim'; require('fs'); void module;",
  "const module = { value: 1 }; void module;",
  "class module { value = 1; } new module();",
  "interface module { value: string }",
  "const value = object[key];",
  "const { window: runtime } = local;",
  "let runtime; ({ window: runtime } = local);",
  "const local = { value: 1 }; let rest; ({ ...rest } = local); void rest;",
  "const local = { value: 1 }; const { ...require } = local; void require;",
  "switch (kind) { case 1: const require = (name: string) => name; require('fs'); break; }",
  "object.require = browserLoader;",
  "delete object.require;",
  "[object.require] = values;",
  "({ x: object.require } = value);",
  "({ ...object.require } = value);",
  "(object.require) = browserLoader;",
  "delete (object.require);",
  "enum X { require = 1 }",
  "module: { break module; }",
  "require: { break require; }",
  "const C = class module {};",
  "const C = class require {};",
  "const C = class module { static value = module };",
  "class C<module> { value?: module }",
  "namespace module { export const value = 1 } void module.value;",
  "namespace require { export const value = 1 } void require.value;",
  "export as namespace module;",
  "export as namespace require;",
  "import data from './x' with { module: 'browser' };",
  "import data from './x' with { require: 'browser' };"
]) {
  if (findNodeRuntimeGlobal(safeSource)) {
    throw new Error(`Node runtime global gate rejected browser-safe source: ${safeSource}`);
  }
}

for (const mutation of [
  'import fs from "fs";',
  'import "node:fs";',
  'import type { Stats } from "node:fs";',
  'import fs = require("fs");',
  'type Stats = typeof import("node:fs");',
  'export { readFile } from "fs/promises";',
  'export * from "node:path";',
  'const fs = require("fs");',
  'const moduleName = "fs"; require(moduleName);',
  'const fs = await import("node:fs");',
  'const moduleName = "node:fs"; import(moduleName);',
  'const timers = import(`timers/promises`);',
  'import { shell } from "electron";'
]) {
  if (!findDesktopOnlyModuleReference(mutation) && !findNodeRuntimeGlobal(mutation)) {
    throw new Error(`Desktop-only module gate mutation escaped detection: ${mutation}`);
  }
}
if (!findDesktopOnlyModuleReference('import "node:not-a-real-module";')) {
  throw new Error("Node protocol module reference escaped detection");
}
for (const moduleName of builtinModules) {
  const unprefixedName = moduleName.replace(/^node:/, "");
  for (const specifier of [unprefixedName, `node:${unprefixedName}`]) {
    if (!findDesktopOnlyModuleReference(`require(${JSON.stringify(specifier)});`)
      && !findNodeRuntimeGlobal(`require(${JSON.stringify(specifier)});`)) {
      throw new Error(`Node builtin module escaped detection: ${specifier}`);
    }
  }
}
for (const safeSource of [
  'import { join } from "./path";',
  'export { processImage } from "./browser-runtime";',
  'object.require("fs");',
  'function require(name) { return name; } require("fs");',
  'const example = `require("fs")`;'
]) {
  if (findDesktopOnlyModuleReference(safeSource)) {
    throw new Error(`Desktop-only module gate rejected browser-safe source: ${safeSource}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listFilesRecursive(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectDesktopOnlyApiMatches() {
  if (!fs.existsSync(sourceTsRoot)) {
    return [];
  }
  const matches = [];
  for (const filePath of listFilesRecursive(sourceTsRoot)) {
    if (!filePath.endsWith(".ts")) {
      continue;
    }
    const relativePath = path.relative(sourceRoot, filePath).replace(/\\/g, "/");
    const source = fs.readFileSync(filePath, "utf8");
    const moduleReference = findDesktopOnlyModuleReference(source, relativePath);
    if (moduleReference) {
      matches.push({ file: relativePath, label: moduleReference });
      continue;
    }
    const runtimeGlobal = findNodeRuntimeGlobal(source, relativePath);
    if (runtimeGlobal) {
      matches.push({ file: relativePath, label: `Node runtime global (${runtimeGlobal})` });
      continue;
    }
    for (const { label, pattern } of DESKTOP_ONLY_API_PATTERNS) {
      if (pattern.test(source)) {
        matches.push({ file: relativePath, label });
        break;
      }
    }
  }
  return matches;
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

const manifest = readJson(manifestPath);
const rootPackage = readJson(packagePath);
const requiredStringFields = [
  "id",
  "name",
  "version",
  "minAppVersion",
  "description",
  "author"
];

for (const field of requiredStringFields) {
  assert(typeof manifest[field] === "string" && manifest[field].trim(), `manifest.json is missing required string field: ${field}`);
}

assert(!manifest.id.includes("obsidian"), "manifest.json id must not contain 'obsidian'");
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.json version must be semver x.y.z");
assert(/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), "manifest.json minAppVersion must be semver x.y.z");
assert(
  compareSemver(manifest.minAppVersion, MIN_API_SURFACE_APP_VERSION) >= 0,
  `manifest.json minAppVersion must be at least ${MIN_API_SURFACE_APP_VERSION} for activeWindow/activeDocument/getBasePath API usage`
);
assert(typeof manifest.isDesktopOnly === "boolean", "manifest.json isDesktopOnly must be a boolean");
assert(rootPackage.version === manifest.version, "package.json version must match manifest.json");
const desktopOnlyApiMatches = collectDesktopOnlyApiMatches();
const nonAllowlistedMatches = desktopOnlyApiMatches.filter((match) => !DESKTOP_ONLY_ALLOWLIST.has(match.file));
const unexpectedDesktopOnlyMatches = nonAllowlistedMatches.filter((match) => !DESKTOP_ONLY_MIGRATION_PENDING.has(match.file));
assert(
  unexpectedDesktopOnlyMatches.length === 0,
  `Desktop-only API usage outside src-ts/platform/desktop.ts and the migration ratchet: ${unexpectedDesktopOnlyMatches.slice(0, 5).map((match) => `${match.file} (${match.label})`).join(", ")}`
);
assert(
  nonAllowlistedMatches.length === 0 || manifest.isDesktopOnly === true,
  `manifest.json isDesktopOnly must remain true until ${DESKTOP_ONLY_REQUIRED_REASON}; found ${nonAllowlistedMatches.slice(0, 5).map((match) => `${match.file} (${match.label})`).join(", ")}`
);
if (manifest.authorUrl) {
  let authorUrl;
  try {
    authorUrl = new URL(manifest.authorUrl);
  } catch (error) {
    throw new Error(`manifest.json authorUrl must be a valid URL: ${manifest.authorUrl}`);
  }
  assert(["http:", "https:"].includes(authorUrl.protocol), "manifest.json authorUrl must use http or https");
  assert(authorUrl.protocol === "https:", "manifest.json authorUrl must use https");
  assert(!["localhost", "127.0.0.1", "::1"].includes(authorUrl.hostname), "manifest.json authorUrl must not point to localhost");
  assert(!/^10\./.test(authorUrl.hostname), "manifest.json authorUrl must not point to a private network");
  assert(!/^192\.168\./.test(authorUrl.hostname), "manifest.json authorUrl must not point to a private network");
  assert(!/^172\.(1[6-9]|2\d|3[0-1])\./.test(authorUrl.hostname), "manifest.json authorUrl must not point to a private network");
}

assert(fs.existsSync(versionsPath), "versions.json is required for rollback-friendly auto updates");
const versions = readJson(versionsPath);
assert(typeof versions === "object" && versions && !Array.isArray(versions), "versions.json must be an object");
assert(versions[manifest.version] === manifest.minAppVersion, "versions.json must map the current manifest version to minAppVersion");

for (const [version, minAppVersion] of Object.entries(versions)) {
  assert(/^\d+\.\d+\.\d+$/.test(version), `versions.json key is not semver: ${version}`);
  assert(typeof minAppVersion === "string" && /^\d+\.\d+\.\d+$/.test(minAppVersion), `versions.json value must be a semver minAppVersion string for ${version}`);
  assert(
    compareSemver(minAppVersion, MIN_API_SURFACE_APP_VERSION) >= 0,
    `versions.json minAppVersion for ${version} must be at least ${MIN_API_SURFACE_APP_VERSION}`
  );
}

const releaseFiles = [
  "manifest.json",
  "main.js",
  "styles.css"
];
const forbiddenReleaseEntries = [
  "cache-backups",
  "original-files-backups",
  "qa-backups",
  "qa-screenshots",
  "mobile-qa-build",
  ".local-image-compress-qa",
  "Local Image Compress QA",
  "QA-LIC-Mobile-",
  ".claude",
  "source-recovery",
  "node_modules",
  "tinyLocal-cache.json",
  "data.json"
];

assert(Array.isArray(rootPackage.files), "package.json must declare a files allowlist for release packaging");
for (const filePath of rootPackage.files) {
  assert(releaseFiles.includes(filePath), `package.json files contains non-release entry: ${filePath}`);
}
for (const filePath of releaseFiles) {
  assert(rootPackage.files.includes(filePath), `package.json files is missing release entry: ${filePath}`);
}
for (const forbidden of forbiddenReleaseEntries) {
  assert(!rootPackage.files.includes(forbidden), `package.json files includes forbidden dev artifact: ${forbidden}`);
}

assert(fs.existsSync(releaseWorkflowPath), "Release workflow is required");
const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
assert(fs.existsSync(releasePreparePath), "Release preparation script is required");
const releasePrepare = fs.readFileSync(releasePreparePath, "utf8");
assert(fs.existsSync(releaseNotesPreparePath), "Release notes preparation script is required");
const releaseNotesPrepare = fs.readFileSync(releaseNotesPreparePath, "utf8");
const gitignore = fs.readFileSync(gitignorePath, "utf8");
assert(
  releaseWorkflow.includes(isDevLayout ? "npm --prefix source-recovery run prepare:release" : "npm run prepare:release"),
  "Release workflow must use the validated release preparation script"
);
assert(
  releaseWorkflow.includes(isDevLayout ? "npm --prefix source-recovery run prepare:release-notes" : "npm run prepare:release-notes")
    && releaseWorkflow.includes("body_path: release-notes.md")
    && releaseNotesPrepare.includes('gitOutput(["log", "-1", "--format=%B", "HEAD"])')
    && releaseNotesPrepare.includes("Release commit message has no promoted DEV subjects"),
  "Release workflow must publish notes from the promoted PROD commit body"
);
assert(releaseWorkflow.includes('"*.*.*"'), "Release workflow must trigger on dotted tag candidates");
assert(releaseWorkflow.includes("^[0-9]+\\.[0-9]+\\.[0-9]+$"), "Release workflow must validate exact numeric SemVer tags");
assert(!releaseWorkflow.includes("GITHUB_REF_NAME#v") && !releaseWorkflow.includes('"v*"'), "Release workflow must reject v-prefixed tags");
const releaseJobIndex = releaseWorkflow.indexOf("\n  release:\n");
assert(releaseJobIndex >= 0, "Release workflow must define a release job");
const releaseJob = releaseWorkflow.slice(releaseJobIndex);
const prepareIndex = releaseJob.indexOf("- name: Prepare artifacts");
const attestIndex = releaseJob.indexOf("uses: actions/attest@v4");
const publishIndex = releaseJob.indexOf("uses: softprops/action-gh-release@v2");
assert(releaseJob.includes("attestations: write") && releaseJob.includes("id-token: write"), "Release job must grant artifact attestation permissions");
assert(releaseJob.includes("subject-path: build/*"), "Release job must attest the staged release allowlist");
assert(prepareIndex >= 0 && prepareIndex < attestIndex && attestIndex < publishIndex, "Release job must prepare, attest, then publish artifacts");
assert(releasePrepare.includes('["manifest.json", "main.js", "styles.css"]'), "Release preparation script must use the explicit install-file allowlist");
assert(!releaseWorkflow.includes("build/versions.json"), "Release workflow must not upload versions.json as a GitHub Release asset");
assert(!releasePrepare.includes('"versions.json"'), "Release preparation script must not stage versions.json as a GitHub Release asset");
for (const pattern of [
  /^node_modules\/$/m,
  /^main\.js$/m,
  /^build\/$/m,
  /^mobile-qa-build\/$/m,
  /^\.local-image-compress-qa\/$/m,
  /^Local Image Compress QA\/$/m,
  /^QA-LIC-Mobile-\*\/$/m,
  /^release-notes\.md$/m,
  /^(?:source-recovery\/)?dist-ts\/$/m,
  /^\.obsidian\/$/m,
  /^data\.json$/m,
  /^tinyLocal-cache\.json$/m,
  /^\*\.map$/m
]) {
  assert(pattern.test(gitignore), `Required generated/local artifact ignore is missing: ${pattern}`);
}

const buildDir = path.join(root, "build");
if (fs.existsSync(buildDir)) {
  for (const forbidden of forbiddenReleaseEntries) {
    assert(!fs.existsSync(path.join(buildDir, forbidden)), `Dev folder leaked into release artifact: ${forbidden}`);
  }
}

console.log("Manifest validation passed.");
