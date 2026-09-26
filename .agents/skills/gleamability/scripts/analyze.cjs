#!/usr/bin/env node
"use strict";
/**
 * Gleamability analyzer
 *
 * Uses the analyzer's own TypeScript parser when available and falls back to a
 * zero-dependency lexical pass. It never imports code from a scan target. The
 * parser is optional at runtime: the shipped CommonJS executable can scan
 * plain JavaScript projects without an install step.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORT_SCHEMA_VERSION = exports.ANALYZER_VERSION = void 0;
exports.parseArgs = parseArgs;
exports.collectFiles = collectFiles;
exports.loadProjectContext = loadProjectContext;
exports.analyzeSource = analyzeSource;
exports.rankReports = rankReports;
exports.main = main;
const fs = __importStar(require("node:fs"));
const node_module_1 = require("node:module");
const path = __importStar(require("node:path"));
exports.ANALYZER_VERSION = "2.0.0";
exports.REPORT_SCHEMA_VERSION = 2;
const DEFAULT_EXTENSIONS = [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
];
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const IGNORED_DIR_NAMES = new Set([
    ".agents",
    ".cache",
    ".claude",
    ".codex",
    ".firebase",
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".vercel",
    ".svelte-kit",
    ".turbo",
    ".yarn",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "__generated__",
    "_generated",
]);
const TEST_FILE_RE = /(?:^|[/\\])(?:__tests__|test|tests)(?:[/\\])|(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$|\.stories\.[cm]?[jt]sx?$/i;
const DECLARATION_FILE_RE = /\.d\.[cm]?[jt]s$/i;
const CONFIG_FILE_RE = /(?:^|[/\\])(?:[^/\\]+\.)?(?:config|setup)\.[cm]?[jt]s$/i;
const SEMANTIC_FUNCTION_RE = /^(?:are|as|assert|build|calculate|canonicalize|clamp|collect|compare|compute|convert|create|decode|deserialize|encode|equal|filter|find|format|get|has|is|map|merge|normalize|parse|prepare|reconcile|reduce|resolve|serialize|sort|to|tokenize|transform|transition|validate)/i;
const DISCRIMINATOR_NAMES = new Set([
    "_tag",
    "kind",
    "state",
    "status",
    "tag",
    "type",
    "variant",
]);
const FUNCTIONAL_METHODS = new Set([
    "every",
    "filter",
    "find",
    "flatMap",
    "map",
    "reduce",
    "reduceRight",
    "some",
]);
const MUTATING_METHODS = new Set([
    "add",
    "clear",
    "copyWithin",
    "delete",
    "fill",
    "pop",
    "push",
    "reverse",
    "set",
    "shift",
    "sort",
    "splice",
    "unshift",
]);
const FRAMEWORK_PACKAGES = [
    "@angular/core",
    "next",
    "react",
    "react-dom",
    "solid-js",
    "svelte",
    "vue",
];
const IO_PACKAGE_RE = /^(?:@prisma\/|axios$|convex(?:\/|$)|drizzle-|express$|fastify$|firebase(?:\/|$)|firebase-admin(?:\/|$)|ioredis$|mongoose$|mysql2?$|pg$|redis$)/;
const NODE_BUILTINS = new Set(node_module_1.builtinModules.flatMap((name) => name.startsWith("node:") ? [name, name.slice(5)] : [name, `node:${name}`]));
const HELP_TEXT = `Gleamability analyzer ${exports.ANALYZER_VERSION}

Usage:
  node analyze.cjs [targets...] [options]

Targets default to the current directory. Each target may be a directory or
an individual source file.

Options:
  --top N                 Print the top N eligible candidates (default: 10)
  --json PATH             Write the full report as JSON; use - for JSON stdout
  --ext LIST              Comma-separated extensions (default: ts/tsx/mts/cts/js/jsx/mjs/cjs)
  --include-tests         Include test, spec, and story files
  --engine MODE           auto, typescript, or lexical (default: auto)
  -h, --help              Show this help
`;
class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = "UsageError";
    }
}
function emptyFacts() {
    return {
        functionNames: new Set(),
        exportedFunctionNames: new Set(),
        imports: [],
        constBindings: 0,
        mutableBindings: 0,
        functionalCalls: 0,
        typeDeclarations: 0,
        literalUnions: 0,
        discriminatedUnions: 0,
        taggedSwitches: 0,
        literalSwitches: 0,
        resultShapes: 0,
        immutableTypeHints: 0,
        reassignments: 0,
        propertyMutations: 0,
        mutatingCalls: 0,
        loops: 0,
        classes: 0,
        inheritance: 0,
        exceptions: 0,
        asyncOperations: 0,
        decorators: 0,
        dynamicTypes: 0,
        jsxNodes: 0,
        dynamicMetaprogramming: 0,
        prototypeWrites: 0,
        domUses: 0,
        processUses: 0,
        networkOrDatabaseCalls: 0,
        timerUses: 0,
        hostRuntimeUses: 0,
        embeddedHostCode: 0,
        arrayBoundary: 0,
        callbackBoundary: 0,
        promiseBoundary: 0,
        optionalObjectBoundary: 0,
        numberBoundary: 0,
        structuralObjectBoundary: 0,
        methodObjectBoundary: 0,
        externalTypeBoundary: 0,
        identitySensitiveReturns: 0,
        jsSemanticUses: 0,
        advancedTypeFeatures: 0,
        generatedGleamInterop: 0,
        probableGleamInterop: 0,
        dynamicImports: 0,
        parseErrors: 0,
    };
}
// ---------- CLI ----------
function parseArgs(argv) {
    const targets = [];
    let top = 10;
    let jsonOutPath = null;
    let extensions = DEFAULT_EXTENSIONS;
    let includeTests = false;
    let engine = "auto";
    let help = false;
    let positionalOnly = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (positionalOnly) {
            targets.push(arg);
            continue;
        }
        if (arg === "--") {
            positionalOnly = true;
        }
        else if (arg === "--top") {
            const value = requireOptionValue(argv, index, "--top");
            if (!/^\d+$/.test(value)) {
                throw new UsageError(`--top must be a non-negative integer, received: ${value}`);
            }
            top = Number(value);
            if (!Number.isSafeInteger(top)) {
                throw new UsageError(`--top is outside the safe integer range: ${value}`);
            }
            index += 1;
        }
        else if (arg === "--json") {
            jsonOutPath = requireOptionValue(argv, index, "--json", true);
            index += 1;
        }
        else if (arg === "--ext") {
            const value = requireOptionValue(argv, index, "--ext");
            const parsed = value
                .split(",")
                .map((extension) => extension.trim().toLowerCase())
                .filter(Boolean)
                .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
            if (parsed.length === 0 || parsed.some((extension) => !/^\.[a-z0-9]+$/.test(extension))) {
                throw new UsageError(`--ext must be a comma-separated extension list, received: ${value}`);
            }
            extensions = [...new Set(parsed)];
            index += 1;
        }
        else if (arg === "--include-tests") {
            includeTests = true;
        }
        else if (arg === "--engine") {
            const value = requireOptionValue(argv, index, "--engine");
            if (value !== "auto" && value !== "typescript" && value !== "lexical") {
                throw new UsageError(`--engine must be auto, typescript, or lexical; received: ${value}`);
            }
            engine = value;
            index += 1;
        }
        else if (arg === "--help" || arg === "-h") {
            help = true;
        }
        else if (arg.startsWith("-")) {
            throw new UsageError(`Unknown option: ${arg}`);
        }
        else {
            targets.push(arg);
        }
    }
    return {
        targets: targets.length > 0 ? targets : ["."],
        top,
        jsonOutPath,
        extensions,
        includeTests,
        engine,
        help,
    };
}
function requireOptionValue(argv, index, option, allowDash = false) {
    const value = argv[index + 1];
    if (!value || (value.startsWith("-") && !(allowDash && value === "-"))) {
        throw new UsageError(`${option} requires a value`);
    }
    return value;
}
// ---------- Discovery and project context ----------
function collectFiles(options) {
    const files = new Set();
    const skippedTestFiles = new Set();
    const warnings = [];
    const considerFile = (filePath) => {
        const extension = path.extname(filePath).toLowerCase();
        if (!options.extensions.includes(extension) || DECLARATION_FILE_RE.test(filePath)) {
            return;
        }
        if (!options.includeTests && TEST_FILE_RE.test(filePath)) {
            skippedTestFiles.add(path.resolve(filePath));
            return;
        }
        files.add(path.resolve(filePath));
    };
    const walk = (directory) => {
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        }
        catch (error) {
            warnings.push(`Could not read ${displayPath(directory)}: ${errorMessage(error)}`);
            return;
        }
        entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .forEach((entry) => {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIR_NAMES.has(entry.name)) {
                    walk(entryPath);
                }
            }
            else if (entry.isFile()) {
                considerFile(entryPath);
            }
        });
    };
    options.targets.forEach((target) => {
        const resolved = path.resolve(target);
        let stat;
        try {
            stat = fs.statSync(resolved);
        }
        catch (error) {
            warnings.push(`Could not inspect ${displayPath(resolved)}: ${errorMessage(error)}`);
            return;
        }
        if (stat.isDirectory()) {
            walk(resolved);
        }
        else if (stat.isFile()) {
            considerFile(resolved);
        }
        else {
            warnings.push(`Skipped non-file target: ${displayPath(resolved)}`);
        }
    });
    return {
        files: [...files].sort((left, right) => left.localeCompare(right)),
        skippedTestFileCount: skippedTestFiles.size,
        warnings,
    };
}
function loadProjectContext(targets) {
    const aliases = [
        { exact: null, prefix: "@/" },
        { exact: null, prefix: "~/" },
        { exact: null, prefix: "#" },
    ];
    const visited = new Set();
    targets.forEach((target) => {
        let directory = path.resolve(target);
        try {
            if (fs.statSync(directory).isFile()) {
                directory = path.dirname(directory);
            }
        }
        catch {
            return;
        }
        while (!visited.has(directory)) {
            visited.add(directory);
            const configPath = path.join(directory, "tsconfig.json");
            if (fs.existsSync(configPath)) {
                loadAliasesFromTsconfig(configPath).forEach((alias) => aliases.push(alias));
                break;
            }
            const parent = path.dirname(directory);
            if (parent === directory) {
                break;
            }
            directory = parent;
        }
    });
    const deduped = new Map();
    aliases.forEach((alias) => {
        const key = alias.exact ? `=${alias.exact}` : `^${alias.prefix ?? ""}`;
        deduped.set(key, alias);
    });
    return { aliases: [...deduped.values()] };
}
function loadAliasesFromTsconfig(configPath) {
    try {
        const source = readUtf8FileBounded(configPath);
        const jsonc = maskComments(source, false).replace(/,\s*([}\]])/g, "$1");
        const parsed = JSON.parse(jsonc);
        return Object.keys(parsed.compilerOptions?.paths ?? {}).map((key) => key.endsWith("/*")
            ? { exact: null, prefix: key.slice(0, -1) }
            : { exact: key, prefix: null });
    }
    catch {
        return [];
    }
}
function resolveEngine(choice) {
    if (choice === "lexical") {
        return {
            engine: "lexical",
            typescript: null,
            version: null,
            warning: "Forced lexical engine; treat close scores as leads for manual review.",
        };
    }
    const typescript = tryLoadAnalyzerTypeScript();
    if (typescript) {
        return {
            engine: "typescript",
            typescript,
            version: typescript.version,
            warning: null,
        };
    }
    if (choice === "typescript") {
        throw new UsageError("The TypeScript engine was requested, but the analyzer installation does not provide the typescript package.");
    }
    return {
        engine: "lexical",
        typescript: null,
        version: null,
        warning: "TypeScript was not available; used the lexical fallback. Hard exclusions are masked, but manual review should carry more weight.",
    };
}
// ---------- Parsing ----------
function analyzeSource(filePath, source, options) {
    const typescript = options.engine === "lexical" ? null : (options.typescript ?? tryLoadAnalyzerTypeScript());
    if (options.engine === "typescript" && !typescript) {
        throw new UsageError("The TypeScript engine was requested but could not be loaded.");
    }
    const engine = typescript ? "typescript" : "lexical";
    const facts = typescript
        ? collectTypeScriptFacts(typescript, filePath, source)
        : collectLexicalFacts(filePath, source);
    const report = scoreFacts(filePath, source, facts, options.context, engine);
    return { report, engine };
}
function tryLoadAnalyzerTypeScript() {
    try {
        const analyzerRoot = path.resolve(__dirname, "..");
        const analyzerRequire = (0, node_module_1.createRequire)(path.join(analyzerRoot, "package.json"));
        const entryPoint = analyzerRequire.resolve("typescript");
        const relativeEntryPoint = path.relative(analyzerRoot, entryPoint);
        if (relativeEntryPoint.startsWith("..") || path.isAbsolute(relativeEntryPoint)) {
            return null;
        }
        return analyzerRequire(entryPoint);
    }
    catch {
        return null;
    }
}
function readUtf8FileBounded(filePath) {
    const descriptor = fs.openSync(filePath, "r");
    try {
        const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
            if (count === 0) {
                break;
            }
            bytesRead += count;
        }
        if (bytesRead > MAX_INPUT_BYTES) {
            throw new Error(`input exceeds the ${MAX_INPUT_BYTES}-byte analysis limit`);
        }
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function collectTypeScriptFacts(ts, filePath, source) {
    const facts = emptyFacts();
    const scriptKind = scriptKindForPath(ts, filePath);
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    const sourceFileWithDiagnostics = sourceFile;
    facts.parseErrors = sourceFileWithDiagnostics.parseDiagnostics?.length ?? 0;
    const locallyDeclaredGlobals = collectLocallyDeclaredNames(ts, sourceFile);
    const localTypes = collectLocalTypeDeclarations(ts, sourceFile);
    const localCallables = collectLocalCallableDeclarations(ts, sourceFile);
    const localPrimitiveBindings = collectLocalPrimitiveBindings(ts, sourceFile);
    const seenPublicBoundaryTypes = new Set();
    const visit = (node) => {
        if (ts.canHaveDecorators(node)) {
            facts.decorators += ts.getDecorators(node)?.length ?? 0;
        }
        if (ts.isJsxElement(node) ||
            ts.isJsxSelfClosingElement(node) ||
            ts.isJsxFragment(node)) {
            facts.jsxNodes += 1;
        }
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const clause = node.importClause;
            const namedBindings = clause?.namedBindings;
            const allNamedTypeOnly = namedBindings &&
                ts.isNamedImports(namedBindings) &&
                namedBindings.elements.length > 0 &&
                namedBindings.elements.every((element) => element.isTypeOnly);
            const typeOnly = Boolean(clause?.isTypeOnly ||
                (allNamedTypeOnly && !clause?.name));
            const importedNames = [];
            if (clause?.name) {
                importedNames.push(clause.name.text);
            }
            if (namedBindings && ts.isNamedImports(namedBindings)) {
                namedBindings.elements
                    .filter((element) => !element.isTypeOnly)
                    .forEach((element) => importedNames.push(element.name.text));
            }
            facts.imports.push({
                specifier: node.moduleSpecifier.text,
                typeOnly,
                importedNames,
            });
        }
        else if (ts.isExportDeclaration(node) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            const allNamedTypeOnly = node.exportClause &&
                ts.isNamedExports(node.exportClause) &&
                node.exportClause.elements.length > 0 &&
                node.exportClause.elements.every((element) => element.isTypeOnly);
            facts.imports.push({
                specifier: node.moduleSpecifier.text,
                typeOnly: Boolean(node.isTypeOnly || allNamedTypeOnly),
                importedNames: [],
            });
        }
        if (ts.isCallExpression(node) &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0]) &&
            ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
                node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
            facts.imports.push({
                specifier: node.arguments[0].text,
                typeOnly: false,
                importedNames: [],
            });
        }
        if (ts.isVariableDeclarationList(node)) {
            if ((node.flags & ts.NodeFlags.Const) !== 0) {
                facts.constBindings += node.declarations.length;
            }
            else {
                facts.mutableBindings += node.declarations.length;
            }
        }
        if (ts.isFunctionDeclaration(node)) {
            const name = node.name?.text ?? "default";
            facts.functionNames.add(name);
            if (hasExportModifier(ts, node)) {
                facts.exportedFunctionNames.add(name);
                inspectPublicBoundary(ts, node.parameters, node.type, facts, localTypes, seenPublicBoundaryTypes);
                if (node.body) {
                    inspectPublicReturnBehavior(ts, node.body, node.parameters, facts, node.type === undefined, localTypes, localPrimitiveBindings);
                }
            }
            if (hasAsyncModifier(ts, node)) {
                facts.asyncOperations += 1;
            }
        }
        else if (ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isIdentifier(node.name)) {
            const callable = resolveCallableInitializer(ts, node.initializer, localCallables);
            if (callable) {
                facts.functionNames.add(node.name.text);
                const statement = node.parent.parent;
                if (ts.isVariableStatement(statement) && hasExportModifier(ts, statement)) {
                    facts.exportedFunctionNames.add(node.name.text);
                    inspectPublicBoundary(ts, callable.parameters, callable.type, facts, localTypes, seenPublicBoundaryTypes);
                    if (callable.body) {
                        inspectPublicReturnBehavior(ts, callable.body, callable.parameters, facts, callable.type === undefined, localTypes, localPrimitiveBindings);
                    }
                    inspectAssignedCallableBoundary(ts, node.initializer, facts);
                }
                if ((ts.isArrowFunction(node.initializer) ||
                    ts.isFunctionExpression(node.initializer)) &&
                    hasAsyncModifier(ts, node.initializer)) {
                    facts.asyncOperations += 1;
                }
            }
        }
        if (ts.isTypeAliasDeclaration(node)) {
            facts.typeDeclarations += 1;
            if (ts.isUnionTypeNode(node.type)) {
                if (node.type.types.length >= 2 &&
                    node.type.types.every((member) => ts.isLiteralTypeNode(member))) {
                    facts.literalUnions += 1;
                }
                if (isDiscriminatedUnion(ts, node.type)) {
                    facts.discriminatedUnions += 1;
                }
            }
        }
        else if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
            facts.typeDeclarations += 1;
        }
        if (ts.isSwitchStatement(node)) {
            const caseCount = node.caseBlock.clauses.filter(ts.isCaseClause).length;
            if (caseCount >= 2) {
                if ((ts.isPropertyAccessExpression(node.expression) &&
                    DISCRIMINATOR_NAMES.has(node.expression.name.text)) ||
                    (ts.isElementAccessExpression(node.expression) &&
                        node.expression.argumentExpression &&
                        ts.isStringLiteral(node.expression.argumentExpression) &&
                        DISCRIMINATOR_NAMES.has(node.expression.argumentExpression.text))) {
                    facts.taggedSwitches += 1;
                }
                else {
                    facts.literalSwitches += 1;
                }
            }
        }
        if (ts.isTypeReferenceNode(node)) {
            const typeName = node.typeName.getText(sourceFile);
            if (/(?:^|\.)(?:Maybe|Option|Result)$/.test(typeName)) {
                facts.resultShapes += 1;
            }
            if (/(?:^|\.)Promise$/.test(typeName)) {
                facts.promiseBoundary += isInsideExportedSignature(ts, node) ? 1 : 0;
            }
            if (/(?:^|\.)(?:Readonly|ReadonlyArray)$/.test(typeName)) {
                facts.immutableTypeHints += 1;
            }
        }
        else if (node.kind === ts.SyntaxKind.ReadonlyKeyword) {
            facts.immutableTypeHints += 1;
        }
        else if (ts.isAsExpression(node) &&
            node.type.kind === ts.SyntaxKind.ConstKeyword) {
            facts.immutableTypeHints += 1;
        }
        if (ts.isConditionalTypeNode(node) ||
            ts.isMappedTypeNode(node) ||
            ts.isIntersectionTypeNode(node) ||
            ts.isIndexedAccessTypeNode(node)) {
            facts.advancedTypeFeatures += 1;
        }
        if (node.kind === ts.SyntaxKind.AnyKeyword ||
            node.kind === ts.SyntaxKind.UnknownKeyword) {
            facts.dynamicTypes += 1;
        }
        if ((ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateExpression(node)) &&
            node.getText(sourceFile).length >= 80 &&
            /\b(?:document|localStorage|sessionStorage|window)\s*\./.test(node.getText(sourceFile)) &&
            /=>|\bfunction\b/.test(node.getText(sourceFile))) {
            facts.embeddedHostCode += 1;
        }
        if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
            const okProperty = node.expression.properties.find((property) => ts.isPropertyAssignment(property) &&
                propertyNameText(ts, property.name) === "ok" &&
                (property.initializer.kind === ts.SyntaxKind.TrueKeyword ||
                    property.initializer.kind === ts.SyntaxKind.FalseKeyword));
            if (okProperty) {
                facts.resultShapes += 1;
            }
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            inspectCallLike(ts, node, facts, locallyDeclaredGlobals);
        }
        if (ts.isAwaitExpression(node)) {
            facts.asyncOperations += 1;
        }
        else if (ts.isForStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isForOfStatement(node) ||
            ts.isWhileStatement(node) ||
            ts.isDoStatement(node)) {
            facts.loops += 1;
        }
        else if (ts.isThrowStatement(node) || ts.isTryStatement(node)) {
            facts.exceptions += 1;
        }
        else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            facts.classes += 1;
            if (node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) {
                facts.inheritance += 1;
            }
        }
        if (ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
                facts.propertyMutations += 1;
                if (isPrototypeTarget(ts, node.left)) {
                    facts.prototypeWrites += 1;
                }
            }
            else {
                facts.reassignments += 1;
            }
        }
        else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken ||
                node.operator === ts.SyntaxKind.MinusMinusToken)) {
            if (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand)) {
                facts.propertyMutations += 1;
            }
            else {
                facts.reassignments += 1;
            }
        }
        else if (ts.isDeleteExpression(node) &&
            (ts.isPropertyAccessExpression(node.expression) ||
                ts.isElementAccessExpression(node.expression))) {
            facts.propertyMutations += 1;
        }
        if ((ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) &&
            !isNestedAccessExpression(ts, node)) {
            const root = rootIdentifier(ts, node.expression);
            if (root &&
                ["document", "localStorage", "navigator", "self", "sessionStorage", "window"].includes(root.text) &&
                !locallyDeclaredGlobals.has(root.text)) {
                facts.domUses += 1;
            }
            if (root?.text === "process" && !locallyDeclaredGlobals.has("process")) {
                facts.processUses += 1;
            }
            if (root &&
                ["Date", "Intl"].includes(root.text) &&
                !locallyDeclaredGlobals.has(root.text)) {
                facts.hostRuntimeUses += 1;
            }
            if (root?.text === "Reflect" && !locallyDeclaredGlobals.has("Reflect")) {
                facts.dynamicMetaprogramming += 1;
            }
        }
        else if (ts.isIdentifier(node)) {
            if (/^(?:Result|List|Option)\$/.test(node.text)) {
                facts.generatedGleamInterop += 1;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (facts.imports.some((reference) => !reference.typeOnly &&
        reference.specifier.endsWith(".mjs") &&
        reference.importedNames.some((name) => name.includes("$")))) {
        facts.generatedGleamInterop += 1;
    }
    if (facts.imports.some((reference) => !reference.typeOnly &&
        reference.specifier.endsWith(".mjs") &&
        reference.importedNames.length >= 2 &&
        reference.importedNames.every((name) => /^[a-z][a-z0-9_]*$/.test(name)) &&
        reference.importedNames.some((name) => name.includes("_")))) {
        facts.probableGleamInterop += 1;
    }
    return facts;
}
function scriptKindForPath(ts, filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".js":
        case ".cjs":
        case ".mjs":
            return ts.ScriptKind.JS;
        case ".jsx":
            return ts.ScriptKind.JSX;
        case ".tsx":
            return ts.ScriptKind.TSX;
        default:
            return ts.ScriptKind.TS;
    }
}
function collectLocallyDeclaredNames(ts, sourceFile) {
    const names = new Set();
    const visit = (node) => {
        if (ts.isVariableDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node)) {
            if (node.name && ts.isIdentifier(node.name)) {
                names.add(node.name.text);
            }
        }
        if (ts.isImportClause(node) && node.name) {
            names.add(node.name.text);
        }
        if (ts.isImportSpecifier(node)) {
            names.add(node.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return names;
}
function collectLocalTypeDeclarations(ts, sourceFile) {
    const declarations = new Map();
    sourceFile.statements.forEach((statement) => {
        if (ts.isTypeAliasDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) {
            declarations.set(statement.name.text, statement);
        }
    });
    return declarations;
}
function collectLocalCallableDeclarations(ts, sourceFile) {
    const declarations = new Map();
    sourceFile.statements.forEach((statement) => {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
            declarations.set(statement.name.text, statement);
            return;
        }
        if (!ts.isVariableStatement(statement)) {
            return;
        }
        statement.declarationList.declarations.forEach((declaration) => {
            if (ts.isIdentifier(declaration.name) &&
                declaration.initializer &&
                (ts.isArrowFunction(declaration.initializer) ||
                    ts.isFunctionExpression(declaration.initializer))) {
                declarations.set(declaration.name.text, declaration.initializer);
            }
        });
    });
    return declarations;
}
function collectLocalPrimitiveBindings(ts, sourceFile) {
    const arrays = new Set();
    const values = new Set();
    sourceFile.statements.forEach((statement) => {
        if (!ts.isVariableStatement(statement) ||
            (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
            return;
        }
        statement.declarationList.declarations.forEach((declaration) => {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
                return;
            }
            const initializer = unwrapExpression(ts, declaration.initializer);
            if (isDefinitelyPrimitiveExpression(ts, initializer, values)) {
                values.add(declaration.name.text);
            }
            else if (ts.isArrayLiteralExpression(initializer) &&
                initializer.elements.length > 0 &&
                initializer.elements.every((element) => ts.isExpression(element) &&
                    isDefinitelyPrimitiveExpression(ts, element, values))) {
                arrays.add(declaration.name.text);
            }
        });
    });
    return { arrays, values };
}
function isDefinitelyPrimitiveExpression(ts, expression, primitiveValues) {
    const candidate = unwrapExpression(ts, expression);
    return (ts.isStringLiteral(candidate) ||
        ts.isNumericLiteral(candidate) ||
        ts.isNoSubstitutionTemplateLiteral(candidate) ||
        candidate.kind === ts.SyntaxKind.TrueKeyword ||
        candidate.kind === ts.SyntaxKind.FalseKeyword ||
        candidate.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isPrefixUnaryExpression(candidate) &&
            (candidate.operator === ts.SyntaxKind.MinusToken ||
                candidate.operator === ts.SyntaxKind.PlusToken) &&
            ts.isNumericLiteral(candidate.operand)) ||
        (ts.isIdentifier(candidate) && primitiveValues.has(candidate.text)));
}
function resolveCallableInitializer(ts, initializer, localCallables) {
    const expression = unwrapExpression(ts, initializer);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        return expression;
    }
    if (ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        rootIdentifier(ts, expression.expression.expression)?.text === "Object" &&
        expression.expression.name.text === "assign") {
        const first = expression.arguments[0];
        if (!first) {
            return null;
        }
        const callable = unwrapExpression(ts, first);
        if (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) {
            return callable;
        }
        if (ts.isIdentifier(callable)) {
            return localCallables.get(callable.text) ?? null;
        }
    }
    return null;
}
function inspectAssignedCallableBoundary(ts, initializer, facts) {
    const expression = unwrapExpression(ts, initializer);
    if (!ts.isCallExpression(expression) ||
        !ts.isPropertyAccessExpression(expression.expression) ||
        rootIdentifier(ts, expression.expression.expression)?.text !== "Object" ||
        expression.expression.name.text !== "assign") {
        return;
    }
    let callbackPropertyCount = 0;
    expression.arguments.slice(1).forEach((argument) => {
        const properties = unwrapExpression(ts, argument);
        if (!ts.isObjectLiteralExpression(properties)) {
            return;
        }
        properties.properties.forEach((property) => {
            if (ts.isMethodDeclaration(property) ||
                (ts.isPropertyAssignment(property) &&
                    (ts.isArrowFunction(unwrapExpression(ts, property.initializer)) ||
                        ts.isFunctionExpression(unwrapExpression(ts, property.initializer))))) {
                callbackPropertyCount += 1;
            }
        });
    });
    if (callbackPropertyCount > 0) {
        facts.structuralObjectBoundary += 1;
        facts.methodObjectBoundary += callbackPropertyCount;
        facts.callbackBoundary += callbackPropertyCount;
    }
}
function hasExportModifier(ts, node) {
    return Boolean(ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword ||
            modifier.kind === ts.SyntaxKind.DefaultKeyword));
}
function hasAsyncModifier(ts, node) {
    return Boolean(ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}
function propertyNameText(ts, name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return null;
}
function isDiscriminatedUnion(ts, union) {
    if (union.types.length < 2 || !union.types.every(ts.isTypeLiteralNode)) {
        return false;
    }
    const tagSets = union.types.map((member) => {
        const tags = new Map();
        if (!ts.isTypeLiteralNode(member)) {
            return tags;
        }
        member.members.forEach((candidate) => {
            if (ts.isPropertySignature(candidate) &&
                candidate.type &&
                candidate.name &&
                ts.isLiteralTypeNode(candidate.type)) {
                const name = propertyNameText(ts, candidate.name);
                const literal = candidate.type.literal;
                if (name &&
                    DISCRIMINATOR_NAMES.has(name) &&
                    (ts.isStringLiteral(literal) || ts.isNumericLiteral(literal))) {
                    tags.set(name, literal.text);
                }
            }
        });
        return tags;
    });
    return [...DISCRIMINATOR_NAMES].some((name) => {
        const values = tagSets.map((tags) => tags.get(name));
        return values.every((value) => value !== undefined) && new Set(values).size >= 2;
    });
}
function inspectPublicBoundary(ts, parameters, returnType, facts, localTypes, seenTypes) {
    parameters.forEach((parameter) => {
        if (parameter.questionToken || parameter.initializer) {
            facts.optionalObjectBoundary += 1;
        }
        inspectBoundaryType(ts, parameter.type, facts, localTypes, seenTypes);
    });
    inspectBoundaryType(ts, returnType, facts, localTypes, seenTypes);
}
function inspectPublicReturnBehavior(ts, body, parameters, facts, inferShapes, localTypes, localPrimitiveBindings) {
    const parameterNames = new Set(parameters
        .filter((parameter) => !(isDefinitelyPrimitiveType(ts, parameter.type, localTypes, localPrimitiveBindings, new Set()) ||
        (parameter.initializer &&
            isDefinitelyPrimitiveExpression(ts, parameter.initializer, localPrimitiveBindings.values))))
        .map((parameter) => parameter.name)
        .filter(ts.isIdentifier)
        .map((name) => name.text));
    const inspectExpression = (candidate) => {
        const expression = unwrapExpression(ts, candidate);
        if (ts.isConditionalExpression(expression)) {
            inspectExpression(expression.whenTrue);
            inspectExpression(expression.whenFalse);
            return;
        }
        if (ts.isIdentifier(expression) && parameterNames.has(expression.text)) {
            facts.identitySensitiveReturns += 1;
            return;
        }
        if (ts.isArrayLiteralExpression(expression)) {
            if (inferShapes) {
                facts.arrayBoundary += 1;
            }
            return;
        }
        if (!ts.isObjectLiteralExpression(expression)) {
            return;
        }
        if (inferShapes) {
            facts.structuralObjectBoundary += 1;
        }
        expression.properties.forEach((property) => {
            if (ts.isMethodDeclaration(property) ||
                ts.isGetAccessorDeclaration(property) ||
                ts.isSetAccessorDeclaration(property)) {
                if (inferShapes) {
                    facts.methodObjectBoundary += 1;
                    facts.callbackBoundary += 1;
                }
                return;
            }
            if (!ts.isPropertyAssignment(property)) {
                return;
            }
            const initializer = unwrapExpression(ts, property.initializer);
            if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
                if (inferShapes) {
                    facts.methodObjectBoundary += 1;
                    facts.callbackBoundary += 1;
                }
            }
            else if (ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer) ||
                ts.isConditionalExpression(initializer)) {
                inspectExpression(initializer);
            }
        });
    };
    if (!ts.isBlock(body)) {
        inspectExpression(body);
        return;
    }
    const visitReturns = (node) => {
        if (ts.isReturnStatement(node) && node.expression) {
            inspectExpression(node.expression);
            return;
        }
        if (node !== body &&
            (ts.isFunctionDeclaration(node) ||
                ts.isFunctionExpression(node) ||
                ts.isArrowFunction(node) ||
                ts.isMethodDeclaration(node) ||
                ts.isGetAccessorDeclaration(node) ||
                ts.isSetAccessorDeclaration(node) ||
                ts.isConstructorDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ts.isClassExpression(node))) {
            return;
        }
        ts.forEachChild(node, visitReturns);
    };
    visitReturns(body);
}
function isDefinitelyPrimitiveType(ts, type, localTypes, localPrimitiveBindings, seenTypes) {
    if (!type) {
        return false;
    }
    if (ts.isParenthesizedTypeNode(type)) {
        return isDefinitelyPrimitiveType(ts, type.type, localTypes, localPrimitiveBindings, seenTypes);
    }
    if (ts.isUnionTypeNode(type)) {
        return type.types.every((member) => isDefinitelyPrimitiveType(ts, member, localTypes, localPrimitiveBindings, seenTypes));
    }
    const indexedObjectType = ts.isIndexedAccessTypeNode(type) &&
        ts.isParenthesizedTypeNode(type.objectType)
        ? type.objectType.type
        : ts.isIndexedAccessTypeNode(type)
            ? type.objectType
            : null;
    if (ts.isIndexedAccessTypeNode(type) &&
        indexedObjectType &&
        ts.isTypeQueryNode(indexedObjectType) &&
        ts.isIdentifier(indexedObjectType.exprName) &&
        type.indexType.kind === ts.SyntaxKind.NumberKeyword &&
        localPrimitiveBindings.arrays.has(indexedObjectType.exprName.text)) {
        return true;
    }
    if (ts.isTypeReferenceNode(type)) {
        const typeName = type.typeName.getText();
        const declaration = localTypes.get(typeName);
        if (declaration &&
            ts.isTypeAliasDeclaration(declaration) &&
            !seenTypes.has(typeName)) {
            seenTypes.add(typeName);
            return isDefinitelyPrimitiveType(ts, declaration.type, localTypes, localPrimitiveBindings, seenTypes);
        }
    }
    return (ts.isLiteralTypeNode(type) ||
        ts.isTemplateLiteralTypeNode(type) ||
        [
            ts.SyntaxKind.BigIntKeyword,
            ts.SyntaxKind.BooleanKeyword,
            ts.SyntaxKind.NeverKeyword,
            ts.SyntaxKind.NullKeyword,
            ts.SyntaxKind.NumberKeyword,
            ts.SyntaxKind.StringKeyword,
            ts.SyntaxKind.SymbolKeyword,
            ts.SyntaxKind.UndefinedKeyword,
            ts.SyntaxKind.VoidKeyword,
        ].includes(type.kind));
}
function unwrapExpression(ts, candidate) {
    let expression = candidate;
    while (ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isNonNullExpression(expression) ||
        ts.isSatisfiesExpression(expression)) {
        expression = expression.expression;
    }
    return expression;
}
function inspectBoundaryType(ts, type, facts, localTypes, seenTypes) {
    if (!type) {
        return;
    }
    const visit = (node) => {
        if (ts.isArrayTypeNode(node) ||
            (ts.isTypeReferenceNode(node) &&
                ["Array", "ReadonlyArray"].includes(node.typeName.getText()))) {
            facts.arrayBoundary += 1;
        }
        else if (ts.isFunctionTypeNode(node)) {
            facts.callbackBoundary += 1;
        }
        else if (ts.isTypeReferenceNode(node) &&
            node.typeName.getText().endsWith("Promise")) {
            facts.promiseBoundary += 1;
        }
        else if (node.kind === ts.SyntaxKind.NumberKeyword &&
            !(ts.isIndexedAccessTypeNode(node.parent) &&
                node.parent.indexType === node)) {
            facts.numberBoundary += 1;
        }
        else if (ts.isTypeLiteralNode(node) ||
            ts.isMappedTypeNode(node) ||
            node.kind === ts.SyntaxKind.ObjectKeyword) {
            facts.structuralObjectBoundary += 1;
        }
        if (ts.isTypeReferenceNode(node)) {
            const typeName = node.typeName.getText();
            const localType = localTypes.get(typeName);
            if (localType && !seenTypes.has(typeName)) {
                seenTypes.add(typeName);
                inspectLocalBoundaryType(ts, localType, facts, localTypes, seenTypes);
            }
            else if (["Omit", "Partial", "Pick", "Record", "Required"].includes(typeName)) {
                facts.structuralObjectBoundary += 1;
            }
            else if (!localType &&
                !isBoundaryBuiltinType(typeName) &&
                !/^[A-Za-z]$/.test(typeName) &&
                !seenTypes.has(`external:${typeName}`)) {
                seenTypes.add(`external:${typeName}`);
                facts.externalTypeBoundary += 1;
            }
        }
        if (ts.isUnionTypeNode(node)) {
            const optionalMembers = node.types.filter((member) => isNullishTypeNode(ts, member)).length;
            facts.optionalObjectBoundary += optionalMembers;
        }
        ts.forEachChild(node, visit);
    };
    visit(type);
}
function inspectLocalBoundaryType(ts, declaration, facts, localTypes, seenTypes) {
    if (ts.isInterfaceDeclaration(declaration)) {
        facts.structuralObjectBoundary += 1;
        declaration.members.forEach((member) => {
            if (ts.isPropertySignature(member)) {
                if (member.questionToken) {
                    facts.optionalObjectBoundary += 1;
                }
                inspectBoundaryType(ts, member.type, facts, localTypes, seenTypes);
            }
            else if (ts.isMethodSignature(member)) {
                facts.methodObjectBoundary += 1;
                member.parameters.forEach((parameter) => inspectBoundaryType(ts, parameter.type, facts, localTypes, seenTypes));
                inspectBoundaryType(ts, member.type, facts, localTypes, seenTypes);
            }
            else if (ts.isIndexSignatureDeclaration(member)) {
                facts.structuralObjectBoundary += 1;
                inspectBoundaryType(ts, member.type, facts, localTypes, seenTypes);
            }
            else if (ts.isCallSignatureDeclaration(member)) {
                facts.methodObjectBoundary += 1;
            }
        });
    }
    else if (ts.isTypeAliasDeclaration(declaration)) {
        inspectBoundaryType(ts, declaration.type, facts, localTypes, seenTypes);
    }
}
function isNullishTypeNode(ts, type) {
    return (type.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isLiteralTypeNode(type) &&
            type.literal.kind === ts.SyntaxKind.NullKeyword));
}
function isBoundaryBuiltinType(typeName) {
    return [
        "Array",
        "BigInt",
        "Boolean",
        "Date",
        "Error",
        "Function",
        "Map",
        "Maybe",
        "NonNullable",
        "Option",
        "Promise",
        "Readonly",
        "ReadonlyArray",
        "ReadonlyMap",
        "ReadonlySet",
        "RegExp",
        "Result",
        "Set",
        "String",
        "Symbol",
        "VoidFunction",
        "WeakMap",
        "WeakSet",
    ].includes(typeName);
}
function isInsideExportedSignature(ts, node) {
    let current = node.parent;
    while (current) {
        if (ts.isFunctionDeclaration(current)) {
            return hasExportModifier(ts, current);
        }
        if (ts.isSourceFile(current)) {
            return false;
        }
        current = current.parent;
    }
    return false;
}
function inspectCallLike(ts, node, facts, locallyDeclaredGlobals) {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) {
        if (expression.text === "eval" ||
            expression.text === "Function" ||
            (ts.isNewExpression(node) && expression.text === "Proxy")) {
            facts.dynamicMetaprogramming += 1;
        }
        if (["fetch", "WebSocket", "XMLHttpRequest"].includes(expression.text)) {
            facts.networkOrDatabaseCalls += 1;
        }
        if (["setInterval", "setTimeout"].includes(expression.text)) {
            facts.timerUses += 1;
        }
        if (["Date", "Intl"].includes(expression.text)) {
            facts.hostRuntimeUses += 1;
        }
        if (ts.isNewExpression(node) &&
            ["WeakMap", "WeakSet"].includes(expression.text)) {
            facts.hostRuntimeUses += 1;
        }
        if ([
            "BigInt",
            "Boolean",
            "Number",
            "String",
            "URL",
            "URLSearchParams",
            "decodeURIComponent",
            "encodeURIComponent",
            "parseFloat",
            "parseInt",
        ].includes(expression.text) &&
            !locallyDeclaredGlobals.has(expression.text)) {
            facts.jsSemanticUses += 1;
        }
        if ([
            "Blob",
            "FileReader",
            "ImageData",
            "MessageChannel",
            "OffscreenCanvas",
            "Worker",
            "createImageBitmap",
            "postMessage",
        ].includes(expression.text) &&
            !locallyDeclaredGlobals.has(expression.text)) {
            facts.domUses += 1;
        }
    }
    else if (ts.isPropertyAccessExpression(expression)) {
        const method = expression.name.text;
        const root = rootIdentifier(ts, expression.expression)?.text ?? "";
        const receiver = expression.expression.getText();
        if (FUNCTIONAL_METHODS.has(method)) {
            facts.functionalCalls += 1;
        }
        if (MUTATING_METHODS.has(method)) {
            facts.mutatingCalls += 1;
        }
        const directIoMethod = ["runQuery", "runMutation", "runAction"].includes(method);
        const databaseMethod = ["collect", "delete", "get", "insert", "mutation", "patch", "query", "replace", "take", "unique"].includes(method) && /(?:^|\.)(?:db|prisma|storage)(?:\.|$)/.test(receiver);
        if (directIoMethod ||
            databaseMethod ||
            ["axios", "firebase", "prisma"].includes(root)) {
            facts.networkOrDatabaseCalls += 1;
        }
        if ((root === "Object" && ["assign", "setPrototypeOf"].includes(method)) ||
            (root === "Reflect" && method.length > 0)) {
            if (method === "setPrototypeOf") {
                facts.prototypeWrites += 1;
            }
            else if (root === "Reflect") {
                facts.dynamicMetaprogramming += 1;
            }
            else {
                facts.mutatingCalls += 1;
            }
        }
        if (!locallyDeclaredGlobals.has(root) &&
            ((root === "JSON" && ["parse", "stringify"].includes(method)) ||
                (root === "Object" &&
                    [
                        "assign",
                        "create",
                        "entries",
                        "freeze",
                        "fromEntries",
                        "getPrototypeOf",
                        "hasOwn",
                        "keys",
                        "seal",
                        "values",
                    ].includes(method)) ||
                (root === "Array" && method === "isArray") ||
                (root === "Number" && ["isFinite", "isInteger", "isNaN"].includes(method)))) {
            facts.jsSemanticUses += 1;
        }
        if (method === "normalize") {
            facts.jsSemanticUses += 1;
        }
    }
    else if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        facts.dynamicImports += 1;
    }
}
function rootIdentifier(ts, expression) {
    let current = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = current.expression;
    }
    return ts.isIdentifier(current) ? current : null;
}
function isNestedAccessExpression(ts, expression) {
    const parent = expression.parent;
    return ((ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
        parent.expression === expression);
}
function isPrototypeTarget(ts, expression) {
    const text = expression.getText();
    return (/\.prototype(?:\.|\[)/.test(text) ||
        /\.__proto__$/.test(text) ||
        (ts.isElementAccessExpression(expression) &&
            expression.argumentExpression !== undefined &&
            ts.isStringLiteral(expression.argumentExpression) &&
            expression.argumentExpression.text === "__proto__"));
}
function collectLexicalFacts(filePath, source) {
    const facts = emptyFacts();
    const noComments = maskComments(source, false);
    const code = maskComments(source, true);
    const extension = path.extname(filePath).toLowerCase();
    facts.jsxNodes = countMatches(code, /(?:=>|return|\?|:)\s*\(?\s*<(?:[A-Za-z][\w.:/-]*|>)|<\/[A-Za-z][\w.:/-]*\s*>/g);
    if (![".jsx", ".tsx"].includes(extension) && !/<\/[A-Za-z]/.test(code)) {
        facts.jsxNodes = 0;
    }
    facts.dynamicMetaprogramming = countMatches(code, /\b(?:eval|Function)\s*\(|\bnew\s+Proxy\s*\(|\bReflect(?:\.|\[)/g);
    facts.prototypeWrites = countMatches(code, /(?:(?:\b\w+\.prototype(?:\.\w+|\[[^\]]+\])|\.__proto__)\s*=|Object\.setPrototypeOf\s*\()/g);
    facts.functionalCalls = countMatches(code, /\.(?:every|filter|find|flatMap|map|reduce|reduceRight|some)\s*\(/g);
    facts.typeDeclarations = countMatches(code, /\b(?:interface|type|enum)\s+\w+/g);
    facts.taggedSwitches = countMatches(code, /\bswitch\s*\(\s*[\w$.[\]?]+\s*\.\s*(?:_tag|kind|state|status|tag|type|variant)\s*\)/g);
    facts.literalSwitches = Math.max(0, countMatches(code, /\bswitch\s*\(/g) - facts.taggedSwitches);
    facts.discriminatedUnions = countDiscriminatedUnions(noComments);
    facts.literalUnions = countMatches(noComments, /\btype\s+\w+(?:\s*<[^>]+>)?\s*=\s*(?:["'][^"']+["']\s*\|\s*)+["'][^"']+["']/g);
    facts.resultShapes = countMatches(noComments, /\b(?:Result|Option|Maybe)\s*</g) + countMatches(code, /\bok\s*:\s*(?:true|false)\b/g);
    facts.immutableTypeHints = countMatches(code, /\bas\s+const\b|\breadonly\b/g);
    facts.constBindings = countMatches(code, /\bconst\s+[A-Za-z_$]/g);
    facts.mutableBindings = countMatches(code, /\b(?:let|var)\s+[A-Za-z_$]/g);
    facts.reassignments = countMatches(code, /(?:\+\+|--|[A-Za-z_$][\w$]*\s*(?:\+=|-=|\*=|\/=|%=|\?\?=|\|\|=|&&=))/g);
    facts.propertyMutations = countMatches(code, /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])\s*(?:=|\+=|-=|\*=|\/=|\+\+|--)/g);
    facts.mutatingCalls = countMatches(code, /\.(?:add|clear|copyWithin|delete|fill|pop|push|reverse|set|shift|sort|splice|unshift)\s*\(/g);
    facts.loops = countMatches(code, /\b(?:for|while)\s*\(|\bdo\s*\{/g);
    facts.classes = countMatches(code, /\bclass\s+\w+/g);
    facts.inheritance = countMatches(code, /\bclass\s+\w+\s+extends\b/g);
    facts.exceptions = countMatches(code, /\b(?:throw|try|catch)\b/g);
    facts.asyncOperations = countMatches(code, /\b(?:async|await)\b/g);
    facts.decorators = countMatches(code, /^\s*@[A-Za-z_$]/gm);
    facts.dynamicTypes = countMatches(code, /\b(?:any|unknown)\b/g);
    facts.domUses = countMatches(code, /\b(?:document|localStorage|navigator|self|sessionStorage|window)\s*\.|\b(?:Blob|FileReader|ImageData|MessageChannel|OffscreenCanvas|Worker|createImageBitmap|postMessage)\s*\(/g);
    facts.processUses = countMatches(code, /\bprocess\s*\./g);
    facts.networkOrDatabaseCalls = countMatches(code, /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(|\.(?:insert|mutation|patch|query|replace|request|runAction|runMutation|runQuery)\s*\(/g);
    facts.timerUses = countMatches(code, /\bset(?:Interval|Timeout)\s*\(/g);
    facts.hostRuntimeUses = countMatches(code, /\b(?:Date|Intl)\s*(?:\.|\()/g);
    facts.jsSemanticUses =
        countMatches(code, /\b(?:BigInt|Boolean|Number|String|URL|URLSearchParams|decodeURIComponent|encodeURIComponent|parseFloat|parseInt)\s*\(/g) +
            countMatches(code, /\b(?:JSON\.(?:parse|stringify)|Object\.(?:assign|create|entries|freeze|fromEntries|getPrototypeOf|hasOwn|keys|seal|values)|Array\.isArray|Number\.(?:isFinite|isInteger|isNaN))\s*\(/g) +
            countMatches(code, /\.normalize\s*\(/g);
    facts.embeddedHostCode = countMatches(noComments, /[`"'][\s\S]{80,}?\b(?:document|localStorage|sessionStorage|window)\s*\.[\s\S]{0,1000}?(?:=>|\bfunction\b)/g);
    facts.generatedGleamInterop = countMatches(code, /\b(?:Result|List|Option)\$[A-Za-z0-9_$]+/g);
    facts.dynamicImports = countMatches(code, /\bimport\s*\(/g);
    facts.imports.push(...extractLexicalImports(noComments));
    extractLexicalFunctionNames(code).forEach((entry) => {
        facts.functionNames.add(entry.name);
        if (entry.exported) {
            facts.exportedFunctionNames.add(entry.name);
        }
    });
    return facts;
}
function maskComments(source, maskStrings) {
    const output = source.split("");
    let state = "code";
    const maskAt = (index) => {
        if (source[index] !== "\n" && source[index] !== "\r") {
            output[index] = " ";
        }
    };
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];
        if (state === "code") {
            if (char === "/" && next === "/") {
                maskAt(index);
                maskAt(index + 1);
                state = "line";
                index += 1;
            }
            else if (char === "/" && next === "*") {
                maskAt(index);
                maskAt(index + 1);
                state = "block";
                index += 1;
            }
            else if (char === "'") {
                if (maskStrings)
                    maskAt(index);
                state = "single";
            }
            else if (char === '"') {
                if (maskStrings)
                    maskAt(index);
                state = "double";
            }
            else if (char === "`") {
                if (maskStrings)
                    maskAt(index);
                state = "template";
            }
            continue;
        }
        if (state === "line") {
            maskAt(index);
            if (char === "\n")
                state = "code";
            continue;
        }
        if (state === "block") {
            maskAt(index);
            if (char === "*" && next === "/") {
                maskAt(index + 1);
                state = "code";
                index += 1;
            }
            continue;
        }
        if (maskStrings)
            maskAt(index);
        if (char === "\\") {
            if (index + 1 < source.length) {
                if (maskStrings)
                    maskAt(index + 1);
                index += 1;
            }
            continue;
        }
        if ((state === "single" && char === "'") ||
            (state === "double" && char === '"') ||
            (state === "template" && char === "`")) {
            state = "code";
        }
    }
    return output.join("");
}
function countMatches(source, regex) {
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    return [...source.matchAll(new RegExp(regex.source, flags))].length;
}
function countDiscriminatedUnions(source) {
    const declarations = source.match(/\btype\s+\w+(?:\s*<[^>]+>)?\s*=[\s\S]{0,2000}?(?=\n(?:export\s+)?(?:type|interface|enum|class|function|const|let|var)\b|$)/g) ?? [];
    return declarations.filter((declaration) => {
        const tags = declaration.match(/\b(?:_tag|kind|state|status|tag|type|variant)\s*:\s*["'][^"']+["']/g);
        return declaration.includes("|") && (tags?.length ?? 0) >= 2;
    }).length;
}
function extractLexicalImports(source) {
    const imports = [];
    const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[\s\S]{0,800}?\s+from\s+)?(["'])([^"'\r\n]+)\3/g;
    for (const match of source.matchAll(pattern)) {
        imports.push({
            specifier: match[4],
            typeOnly: Boolean(match[2]),
            importedNames: [],
        });
    }
    for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        imports.push({ specifier: match[1], typeOnly: false, importedNames: [] });
    }
    return imports;
}
function extractLexicalFunctionNames(source) {
    const results = new Map();
    const declaration = /\b(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
    for (const match of source.matchAll(declaration)) {
        results.set(match[2], { name: match[2], exported: Boolean(match[1]) });
    }
    const variable = /\b(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
    for (const match of source.matchAll(variable)) {
        results.set(match[2], { name: match[2], exported: Boolean(match[1]) });
    }
    return [...results.values()];
}
// ---------- Scoring ----------
function scoreFacts(filePath, source, facts, context, engine) {
    const loc = source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    const semanticFunctionCount = [...facts.functionNames].filter((name) => SEMANTIC_FUNCTION_RE.test(name)).length;
    const runtimeImports = uniqueRuntimeImports(facts.imports);
    const externalImports = runtimeImports.filter((reference) => !isLocalSpecifier(reference.specifier, context) &&
        !isNodeBuiltin(reference.specifier));
    const nodeImports = runtimeImports.filter((reference) => isNodeBuiltin(reference.specifier));
    const frameworkImports = externalImports.filter((reference) => FRAMEWORK_PACKAGES.some((packageName) => reference.specifier === packageName ||
        reference.specifier.startsWith(`${packageName}/`)));
    const ioImports = externalImports.filter((reference) => IO_PACKAGE_RE.test(reference.specifier));
    const bindingCount = facts.constBindings + facts.mutableBindings;
    const immutableLean = bindingCount >= 2 && facts.constBindings / Math.max(bindingCount, 1) >= 0.8 ? 1 : 0;
    const pureModule = facts.exportedFunctionNames.size > 0 &&
        facts.reassignments === 0 &&
        facts.propertyMutations === 0 &&
        facts.mutatingCalls === 0 &&
        facts.classes === 0 &&
        facts.exceptions === 0 &&
        facts.asyncOperations === 0 &&
        facts.domUses === 0 &&
        facts.processUses === 0 &&
        facts.networkOrDatabaseCalls === 0 &&
        facts.timerUses === 0 &&
        facts.hostRuntimeUses === 0 &&
        facts.embeddedHostCode === 0 &&
        externalImports.length === 0;
    const logicDenseModule = facts.functionNames.size >= 5 &&
        facts.domUses === 0 &&
        facts.processUses === 0 &&
        facts.networkOrDatabaseCalls === 0 &&
        facts.asyncOperations === 0 &&
        facts.timerUses === 0 &&
        facts.hostRuntimeUses === 0 &&
        facts.embeddedHostCode === 0 &&
        externalImports.length <= 1;
    const identityCoupledApi = facts.identitySensitiveReturns > 0 &&
        facts.callbackBoundary > 0 &&
        facts.externalTypeBoundary > 0;
    const positiveSignals = buildSignals([
        signal("named module-level logic", 8, 3, facts.functionNames.size),
        signal("domain-operation function names", 6, 4, semanticFunctionCount),
        signal("functional collection transforms", 4, 5, facts.functionalCalls),
        signal("explicit domain type declarations", 3, 5, facts.typeDeclarations),
        signal("literal union maps to a custom type", 15, 2, facts.literalUnions),
        signal("discriminated union maps to a custom type", 20, 2, facts.discriminatedUnions),
        signal("switch on a discriminator", 20, 2, facts.taggedSwitches),
        signal("literal switch / state transition", 15, 2, facts.literalSwitches),
        signal("Result-shaped or optional outcome", 6, 2, facts.resultShapes),
        signal("readonly / as-const modeling", 3, 3, facts.immutableTypeHints),
        signal("const-dominant bindings", 10, 1, immutableLean),
        signal("logic-dense self-contained module", 15, 1, logicDenseModule ? 1 : 0),
        signal("self-contained pure module", 15, 1, pureModule ? 1 : 0),
    ]);
    const negativeSignals = buildSignals([
        signal("binding reassignment", 4, 6, facts.reassignments),
        signal("property or indexed mutation", 4, 6, facts.propertyMutations),
        signal("mutating collection/object calls", 3, 6, facts.mutatingCalls),
        signal("imperative loops", 2, 5, facts.loops),
        signal("class-based design", 15, 2, facts.classes),
        signal("class inheritance", 25, 2, facts.inheritance),
        signal("throw / try-catch control flow", 4, 4, facts.exceptions),
        signal("decorators", 10, 3, facts.decorators),
    ]);
    const boundarySignals = buildSignals([
        signal("runtime third-party imports", 6, 5, externalImports.length),
        signal("framework runtime imports", 12, 3, frameworkImports.length),
        signal("database / service imports", 15, 3, ioImports.length),
        signal("Node runtime imports", 15, 3, nodeImports.length),
        signal("DOM / browser host API", 10, 4, facts.domUses),
        signal("process / environment API", 12, 3, facts.processUses),
        signal("network / database calls", 12, 4, facts.networkOrDatabaseCalls),
        signal("async / await orchestration", 5, 5, facts.asyncOperations),
        signal("timers", 8, 3, facts.timerUses),
        signal("Date / Intl / weak-identity host semantics", 8, 3, facts.hostRuntimeUses),
        signal("embedded browser/runtime script", 40, 2, facts.embeddedHostCode),
        signal("array-shaped public JS boundary", 5, 4, facts.arrayBoundary),
        signal("callback-shaped public JS boundary", 6, 3, facts.callbackBoundary),
        signal("Promise-shaped public JS boundary", 10, 2, facts.promiseBoundary),
        signal("optional/defaulted/nullish public boundary", 3, 6, facts.optionalObjectBoundary),
        signal("JS number boundary needs Int/Float audit", 2, 4, facts.numberBoundary),
        signal("structural object-shaped public boundary", 7, 4, facts.structuralObjectBoundary),
        signal("method-bearing object boundary", 10, 4, facts.methodObjectBoundary),
        signal("imported/opaque TypeScript boundary types", 5, 4, facts.externalTypeBoundary),
        signal("returns caller-owned JS value identity", 8, 3, facts.identitySensitiveReturns),
        signal("JS-specific coercion/encoding/object semantics", 4, 5, facts.jsSemanticUses),
        signal("dynamic any/unknown modeling", 2, 8, facts.dynamicTypes),
        signal("advanced TypeScript type modeling", 4, 4, facts.advancedTypeFeatures),
        signal("dynamic module loading", 8, 3, facts.dynamicImports),
        signal("source parse diagnostics", 15, 2, facts.parseErrors),
        signal("probable generated Gleam module import", 25, 1, facts.probableGleamInterop),
    ]);
    const languageFit = clampScore(sumContributions(positiveSignals) - sumContributions(negativeSignals));
    let boundaryCost = clampScore(sumContributions(boundarySignals));
    if (TEST_FILE_RE.test(filePath)) {
        boundaryCost = clampScore(boundaryCost + 30);
    }
    if (CONFIG_FILE_RE.test(filePath)) {
        boundaryCost = clampScore(boundaryCost + 20);
    }
    const substantive = facts.functionNames.size > 0;
    let migrationValue = substantive
        ? 20 +
            Math.min(facts.exportedFunctionNames.size, 3) * 10 +
            Math.min(semanticFunctionCount, 4) * 5 +
            (loc >= 10 && loc <= 500 ? 15 : 5)
        : Math.min(15, facts.typeDeclarations * 3);
    if (TEST_FILE_RE.test(filePath) || CONFIG_FILE_RE.test(filePath)) {
        migrationValue -= 30;
    }
    migrationValue = clampScore(migrationValue);
    const disqualifiers = [];
    if (facts.generatedGleamInterop > 0) {
        disqualifiers.push("already imports generated Gleam runtime values");
    }
    if (/(?:^|[/\\])[^/\\]+_ffi\.[cm]?js$/i.test(filePath)) {
        disqualifiers.push("is a JavaScript FFI adapter");
    }
    if (facts.jsxNodes > 0) {
        disqualifiers.push("contains JSX render output");
    }
    if (facts.dynamicMetaprogramming > 0) {
        disqualifiers.push("uses dynamic metaprogramming");
    }
    if (facts.prototypeWrites > 0) {
        disqualifiers.push("mutates prototypes");
    }
    let scoreBeforeDisqualifiers;
    if (!substantive) {
        scoreBeforeDisqualifiers = Math.min(20, Math.round(languageFit * 0.25 + migrationValue * 0.25));
    }
    else {
        const wholeFileScore = Math.min(95, clampScore(Math.round(languageFit * 0.8 +
            migrationValue * 0.2 +
            10 -
            boundaryCost * 0.5)));
        const extractionOpportunityScore = languageFit >= 60 &&
            migrationValue >= 60 &&
            boundaryCost >= 45 &&
            facts.probableGleamInterop === 0 &&
            !identityCoupledApi
            ? clampScore(Math.round(languageFit * 0.6 +
                migrationValue * 0.1 -
                Math.min(5, sumContributions(negativeSignals) * 0.05)))
            : 0;
        scoreBeforeDisqualifiers = Math.max(wholeFileScore, extractionOpportunityScore);
    }
    if (facts.embeddedHostCode > 0) {
        scoreBeforeDisqualifiers = Math.min(scoreBeforeDisqualifiers, 39);
    }
    if (identityCoupledApi) {
        scoreBeforeDisqualifiers = Math.min(scoreBeforeDisqualifiers, 55);
    }
    const eligible = disqualifiers.length === 0;
    const score = eligible ? scoreBeforeDisqualifiers : 0;
    const tier = !eligible
        ? "Not a fit"
        : score >= 70
            ? "Strong candidate"
            : score >= 40
                ? "Possible candidate"
                : "Low priority";
    let verdict;
    if (facts.generatedGleamInterop > 0) {
        verdict = "Already migrated / interop adapter";
    }
    else if (!eligible) {
        verdict = "Not a fit";
    }
    else if (identityCoupledApi && score >= 40) {
        verdict = "Port with redesign";
    }
    else if (score >= 70 && boundaryCost < 45) {
        verdict =
            sumContributions(negativeSignals) >= 20
                ? "Port with redesign"
                : "Whole-file candidate";
    }
    else if (languageFit >= 60 && boundaryCost >= 45) {
        verdict = "Extract pure core";
    }
    else if (score >= 40) {
        verdict = "Review candidate";
    }
    else {
        verdict = "Keep in JS/TS";
    }
    const reviewFlags = [];
    if (facts.arrayBoundary > 0) {
        reviewFlags.push("Public arrays need an explicit JS-boundary choice: gleam_javascript Array or conversion to List.");
    }
    if (facts.optionalObjectBoundary > 0 || facts.dynamicTypes > 0) {
        reviewFlags.push("Audit null/undefined and structural object decoding at the JavaScript boundary.");
    }
    if (facts.structuralObjectBoundary > 0 ||
        facts.methodObjectBoundary > 0 ||
        facts.externalTypeBoundary > 0) {
        reviewFlags.push("Public structural or method-bearing TypeScript values need primitive adapters, external types, or Dynamic decoding.");
    }
    if (facts.numberBoundary > 0) {
        reviewFlags.push("Decide Int versus Float and reject non-whole Int values plus NaN/Infinity at the boundary.");
    }
    if (facts.identitySensitiveReturns > 0) {
        reviewFlags.push("Preserve caller-visible JS value identity or redesign the API before porting.");
    }
    if (identityCoupledApi) {
        reviewFlags.push("Identity, callbacks, and imported object contracts span the public API; do not assume a separable pure core.");
    }
    if (facts.jsSemanticUses > 0) {
        reviewFlags.push("Test JavaScript coercion, URI/Unicode, JSON, and object-enumeration edge cases explicitly.");
    }
    if (facts.promiseBoundary > 0 || facts.asyncOperations > 0) {
        reviewFlags.push("Plan Promise/callback interop; async orchestration is not a mechanical Gleam port.");
    }
    if (facts.advancedTypeFeatures > 0) {
        reviewFlags.push("Mapped, conditional, intersection, or indexed TypeScript types require redesign.");
    }
    if (facts.parseErrors > 0) {
        reviewFlags.push("The parser reported syntax diagnostics; do not trust the score until the file parses cleanly.");
    }
    if (facts.probableGleamInterop > 0) {
        reviewFlags.push("The module likely imports compiled Gleam already; verify whether it is an adapter before recommending another port.");
    }
    if (engine === "lexical") {
        reviewFlags.push("Lexical fallback used; verify syntax-sensitive signals manually.");
    }
    return {
        filePath: displayPath(filePath),
        loc,
        score,
        scoreBeforeDisqualifiers,
        tier,
        verdict,
        eligible,
        dimensions: { languageFit, boundaryCost, migrationValue },
        reason: summarizeReason(disqualifiers, positiveSignals, boundarySignals, substantive),
        disqualifiers,
        positiveSignals,
        negativeSignals,
        boundarySignals,
        reviewFlags,
    };
}
function signal(label, weight, cap, count) {
    return { label, weight, cap, count };
}
function buildSignals(definitions) {
    return definitions
        .filter((definition) => definition.count > 0)
        .map((definition) => {
        const count = Math.min(definition.count, definition.cap);
        return {
            label: definition.label,
            weight: definition.weight,
            rawCount: definition.count,
            count,
            contribution: definition.weight * count,
        };
    });
}
function sumContributions(signals) {
    return signals.reduce((sum, signalHit) => sum + signalHit.contribution, 0);
}
function uniqueRuntimeImports(imports) {
    const unique = new Map();
    imports
        .filter((reference) => !reference.typeOnly)
        .forEach((reference) => unique.set(reference.specifier, reference));
    return [...unique.values()];
}
function isLocalSpecifier(specifier, context) {
    if (specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("file:")) {
        return true;
    }
    return context.aliases.some((alias) => (alias.exact !== null && specifier === alias.exact) ||
        (alias.prefix !== null && specifier.startsWith(alias.prefix)));
}
function isNodeBuiltin(specifier) {
    const root = specifier.startsWith("node:")
        ? specifier
        : specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    return NODE_BUILTINS.has(root) || NODE_BUILTINS.has(specifier);
}
function summarizeReason(disqualifiers, positiveSignals, boundarySignals, substantive) {
    if (disqualifiers.length > 0) {
        return disqualifiers[0];
    }
    if (!substantive) {
        return "no executable module-level logic to port";
    }
    const positives = [...positiveSignals]
        .sort((left, right) => right.contribution - left.contribution)
        .slice(0, 2)
        .map((hit) => hit.label);
    const boundary = [...boundarySignals].sort((left, right) => right.contribution - left.contribution)[0];
    if (boundary && boundary.contribution >= 15) {
        return `${positives.join(" + ") || "some language fit"}; boundary cost: ${boundary.label}`;
    }
    return positives.join(" + ") || "limited positive evidence";
}
function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}
// ---------- Report generation ----------
function rankReports(reports) {
    return [...reports].sort((left, right) => {
        if (left.eligible !== right.eligible) {
            return left.eligible ? -1 : 1;
        }
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        if (right.scoreBeforeDisqualifiers !== left.scoreBeforeDisqualifiers) {
            return right.scoreBeforeDisqualifiers - left.scoreBeforeDisqualifiers;
        }
        return left.filePath.localeCompare(right.filePath);
    });
}
function buildScanReport(options, discovery, engine, context) {
    const warnings = [...discovery.warnings];
    if (engine.warning) {
        warnings.push(engine.warning);
    }
    const reports = [];
    discovery.files.forEach((filePath) => {
        try {
            // Source is passed only to deterministic parsers; reports never include it.
            const source = readUtf8FileBounded(filePath);
            reports.push(analyzeSource(filePath, source, {
                context,
                engine: engine.engine,
                typescript: engine.typescript,
            }).report);
        }
        catch (error) {
            warnings.push(`Could not analyze ${displayPath(filePath)}: ${errorMessage(error)}`);
        }
    });
    const ranked = rankReports(reports);
    const tierCounts = {
        "Strong candidate": 0,
        "Possible candidate": 0,
        "Low priority": 0,
        "Not a fit": 0,
    };
    ranked.forEach((report) => {
        tierCounts[report.tier] += 1;
    });
    return {
        schemaVersion: exports.REPORT_SCHEMA_VERSION,
        analyzerVersion: exports.ANALYZER_VERSION,
        engine: engine.engine,
        engineVersion: engine.version,
        scannedAt: new Date().toISOString(),
        targets: options.targets,
        fileCount: ranked.length,
        skippedTestFileCount: discovery.skippedTestFileCount,
        tierCounts,
        warnings,
        results: ranked,
    };
}
function printHumanReport(report, topCount) {
    const eligible = report.results.filter((result) => result.eligible);
    const top = eligible.slice(0, topCount);
    process.stdout.write(`Scanned ${report.fileCount} file(s) with ${report.engine}` +
        `${report.engineVersion ? ` ${report.engineVersion}` : ""}; ` +
        `skipped ${report.skippedTestFileCount} test/story file(s).\n\n`);
    process.stdout.write("Rank  Score  Fit  Cost  Tier                Verdict               File\n" +
        "----  -----  ---  ----  ------------------  --------------------  ----\n");
    top.forEach((result, index) => {
        const rank = String(index + 1).padEnd(4);
        const score = String(result.score).padEnd(5);
        const fit = String(result.dimensions.languageFit).padEnd(3);
        const cost = String(result.dimensions.boundaryCost).padEnd(4);
        const tier = result.tier.padEnd(18);
        const verdict = result.verdict.padEnd(20);
        process.stdout.write(`${rank}  ${score}  ${fit}  ${cost}  ${tier}  ${verdict}  ${result.filePath}\n`);
    });
    const excluded = report.tierCounts["Not a fit"];
    if (excluded > 0) {
        process.stdout.write(`\n${excluded} excluded file(s) are retained in JSON but do not consume --top.\n`);
    }
    report.warnings.forEach((warning) => process.stderr.write(`Warning: ${warning}\n`));
}
function main(argv = process.argv.slice(2)) {
    try {
        const options = parseArgs(argv);
        if (options.help) {
            process.stdout.write(HELP_TEXT);
            return 0;
        }
        const discovery = collectFiles(options);
        const context = loadProjectContext(options.targets);
        const engine = resolveEngine(options.engine);
        const report = buildScanReport(options, discovery, engine, context);
        const serialized = `${JSON.stringify(report, null, 2)}\n`;
        if (options.jsonOutPath === "-") {
            process.stdout.write(serialized);
        }
        else {
            printHumanReport(report, options.top);
            if (options.jsonOutPath) {
                fs.writeFileSync(options.jsonOutPath, serialized, "utf8");
                process.stdout.write(`\nFull JSON report written to ${displayPath(options.jsonOutPath)}\n`);
            }
        }
        return discovery.files.length === 0 ? 2 : 0;
    }
    catch (error) {
        const prefix = error instanceof UsageError ? "" : "Analyzer failed: ";
        process.stderr.write(`${prefix}${errorMessage(error)}\n`);
        if (error instanceof UsageError) {
            process.stderr.write("Run with --help for usage.\n");
        }
        return 1;
    }
}
function displayPath(filePath) {
    const absolute = path.resolve(filePath);
    const relative = path.relative(process.cwd(), absolute);
    const displayed = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? relative.split(path.sep).join("/")
        : absolute.split(path.sep).join("/");
    return escapeControlCharacters(displayed);
}
function escapeControlCharacters(value) {
    return value.replace(/[\u0000-\u001f\u007f]/g, (character) => {
        switch (character) {
            case "\n":
                return "\\n";
            case "\r":
                return "\\r";
            case "\t":
                return "\\t";
            default:
                return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
        }
    });
}
function errorMessage(error) {
    return escapeControlCharacters(error instanceof Error ? error.message : String(error));
}
if (require.main === module) {
    process.exitCode = main();
}
