#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const analyzer = require("./analyze.cjs");

const context = {
  aliases: [
    { exact: null, prefix: "@/" },
    { exact: null, prefix: "~/" },
  ],
};

function analyze(fileName, source, engine = "typescript") {
  return analyzer.analyzeSource(fileName, source, {
    context,
    engine,
    typescript: engine === "typescript" ? ts : null,
  }).report;
}

test("tagged state machines are strong candidates", () => {
  const report = analyze(
    "state-machine.ts",
    `
      export type State =
        | { kind: "idle" }
        | { kind: "running"; count: number }
        | { kind: "done"; count: number };

      export type Event =
        | { kind: "start" }
        | { kind: "tick" }
        | { kind: "finish" };

      export function transition(state: State, event: Event): State {
        switch (state.kind) {
          case "idle":
            return event.kind === "start" ? { kind: "running", count: 0 } : state;
          case "running":
            return event.kind === "finish"
              ? { kind: "done", count: state.count }
              : { kind: "running", count: state.count + 1 };
          case "done":
            return state;
        }
      }
    `,
  );

  assert.equal(report.tier, "Strong candidate");
  assert.equal(report.eligible, true);
  assert.ok(report.dimensions.languageFit >= 70);
  assert.ok(
    report.positiveSignals.some(
      (signal) => signal.label === "discriminated union maps to a custom type",
    ),
  );
  assert.ok(
    report.positiveSignals.some(
      (signal) => signal.label === "switch on a discriminator",
    ),
  );
});

test("bare literal switches are recognized as state-transition logic", () => {
  const stateMachine = analyze(
    "transition.ts",
    `
      export type Action = "start" | "pause" | "finish";
      export function transition(action: Action): number {
        switch (action) {
          case "start": return 1;
          case "pause": return 2;
          case "finish": return 3;
        }
      }
    `,
  );
  const dataOnly = analyze(
    "types.ts",
    `export type Action = "start" | "pause" | "finish";`,
  );

  assert.ok(stateMachine.score > dataOnly.score);
  assert.ok(
    stateMachine.positiveSignals.some(
      (signal) => signal.label === "literal switch / state transition",
    ),
  );
});

test("defensive prototype strings and comments never hard-disqualify", () => {
  const report = analyze(
    "safe-parser.ts",
    `
      const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
      // eval(source) and Thing.prototype.value = 1 are examples of what we reject.
      export function parseKey(value: string): { ok: true; value: string } | { ok: false } {
        return value && !UNSAFE.has(value)
          ? { ok: true, value }
          : { ok: false };
      }
    `,
  );

  assert.equal(report.eligible, true);
  assert.deepEqual(report.disqualifiers, []);
});

test("implicit JSX is excluded even without a React import", () => {
  const report = analyze(
    "message.tsx",
    `
      export const Message = ({ ok }: { ok: boolean }) =>
        ok ? <strong>Ready</strong> : <span>Waiting</span>;
    `,
  );

  assert.equal(report.tier, "Not a fit");
  assert.match(report.reason, /JSX/);
});

test("real dynamic metaprogramming and prototype writes are excluded", () => {
  const dynamic = analyze(
    "dynamic.ts",
    `export const run = (source: string) => eval(source);`,
  );
  const prototype = analyze(
    "prototype.ts",
    `Widget.prototype.render = function () { return "ok"; };`,
  );

  assert.equal(dynamic.eligible, false);
  assert.equal(prototype.eligible, false);
});

test("generated Gleam adapters and FFI files are not migration candidates", () => {
  const generated = analyze(
    "adapter.ts",
    `
      import { Result$Ok$0, Result$isOk } from "gts/gleam.mjs";
      export const unwrap = (value: unknown) =>
        Result$isOk(value) ? Result$Ok$0(value) : null;
    `,
  );
  const ffi = analyze(
    "clock_ffi.mjs",
    `export function now() { return Date.now(); }`,
  );

  assert.equal(generated.verdict, "Already migrated / interop adapter");
  assert.equal(ffi.tier, "Not a fit");
  assert.match(ffi.reason, /FFI/);
});

test("probable compiled Gleam imports are surfaced for manual adapter review", () => {
  const report = analyze(
    "formatters.ts",
    `
      import { registration_fee_label, status_label } from "gts/formatters.mjs";
      export function formatStatus(value: string) {
        return status_label(value);
      }
      export function formatFee(value: number) {
        return registration_fee_label(value, String(value));
      }
    `,
  );

  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "probable generated Gleam module import",
    ),
  );
  assert.ok(report.reviewFlags.some((flag) => /compiled Gleam/.test(flag)));
});

test("empty and declaration-only files remain low priority", () => {
  const empty = analyze("empty.ts", "");
  const declarationOnly = analyze(
    "model.ts",
    `
      export interface User { id: string; name: string }
      export type Role = "admin" | "member";
      export const DEFAULT_ROLE = "member";
    `,
  );

  assert.equal(empty.score, 0);
  assert.equal(empty.tier, "Low priority");
  assert.equal(declarationOnly.tier, "Low priority");
});

test("server orchestration is low priority despite Result-shaped returns", () => {
  const report = analyze(
    "actions.ts",
    `
      "use server";
      import { redirect } from "next/navigation";
      import { fetchMutation } from "convex/nextjs";

      export async function save(input: unknown) {
        try {
          const response = await fetch("https://example.test");
          await fetchMutation("save", { input });
          if (!response.ok) throw new Error("failed");
          redirect("/done");
          return { ok: true, value: await response.json() } as const;
        } catch (error) {
          return { ok: false, error } as const;
        }
      }
    `,
  );

  assert.equal(report.tier, "Low priority");
  assert.ok(report.dimensions.boundaryCost >= 60);
});

test("type-only and configured alias imports add no runtime dependency cost", () => {
  const report = analyze(
    "claims.ts",
    `
      import type { User } from "external-types";
      import { normalize } from "@/local/normalize";
      export function validateUser(user: User) {
        return normalize(user);
      }
    `,
  );

  assert.equal(
    report.boundarySignals.some(
      (signal) => signal.label === "runtime third-party imports",
    ),
    false,
  );
});

test("a locally declared document is not mistaken for the DOM global", () => {
  const report = analyze(
    "pdf.ts",
    `
      export function formatDocument(document: { title: string }) {
        return document.title.trim().toUpperCase();
      }
    `,
  );

  assert.equal(
    report.boundarySignals.some(
      (signal) => signal.label === "DOM / browser host API",
    ),
    false,
  );
});

test("structural and method-bearing public values raise JS boundary cost", () => {
  const report = analyze(
    "columns.ts",
    `
      interface Column {
        id: string;
        getSize(): number;
        isVisible: () => boolean;
      }

      export function totalVisibleSize(columns: readonly Column[]): number {
        return columns
          .filter((column) => column.isVisible())
          .reduce((total, column) => total + column.getSize(), 0);
      }
    `,
  );

  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "structural object-shaped public boundary",
    ),
  );
  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "method-bearing object boundary",
    ),
  );
  assert.ok(report.dimensions.boundaryCost >= 20);
});

test("generic parameters are not opaque imports and null is optional", () => {
  const report = analyze(
    "generic.ts",
    `
      export function first<T>(values: readonly T[]): T | null {
        return values[0] ?? null;
      }
    `,
  );

  assert.equal(
    report.boundarySignals.some(
      (signal) => signal.label === "imported/opaque TypeScript boundary types",
    ),
    false,
  );
  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "optional/defaulted/nullish public boundary",
    ),
  );
});

test("indexed-access number keys are not runtime number boundaries", () => {
  const report = analyze(
    "status.ts",
    `
      const statuses = ["open", "closed"] as const;
      type Status = (typeof statuses)[number];
      export function normalizeStatus(status: Status): Status {
        return status === "open" ? "open" : "closed";
      }
    `,
  );

  assert.equal(
    report.boundarySignals.some(
      (signal) => signal.label === "JS number boundary needs Int/Float audit",
    ),
    false,
  );
});

test("inferred exported parser objects expose structural callback boundaries", () => {
  const report = analyze(
    "parser.ts",
    `
      export const createParser = () => ({
        parse: (value: string) => value.trim(),
        serialize(value: string) {
          return value;
        },
      });
    `,
  );

  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "structural object-shaped public boundary",
    ),
  );
  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "method-bearing object boundary",
    ),
  );
  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "callback-shaped public JS boundary",
    ),
  );
});

test("Object.assign callable exports expose their attached callbacks", () => {
  const report = analyze(
    "filter.ts",
    `
      interface Row<T> { getValue(id: string): T }
      const implementation = <T>(row: Row<T>, id: string) =>
        Boolean(row.getValue(id));
      export const filter = Object.assign(implementation, {
        autoRemove: (value: unknown) => value == null,
        resolveFilterValue: (value: unknown) => String(value),
      });
    `,
  );

  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "callback-shaped public JS boundary",
    ),
  );
  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "method-bearing object boundary",
    ),
  );
});

test("returning caller-owned values is flagged as identity-sensitive", () => {
  const report = analyze(
    "reconcile.ts",
    `
      interface State { value: string }
      export function reconcile(current: State, incoming: State, same: boolean): State {
        return same ? current : incoming;
      }
    `,
  );

  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "returns caller-owned JS value identity",
    ),
  );
  assert.ok(report.reviewFlags.some((flag) => /value identity/.test(flag)));
});

test("returning primitive aliases is not mistaken for object identity", () => {
  const report = analyze(
    "theme.ts",
    `
      const THEMES = ["light", "dark"] as const;
      type Theme = (typeof THEMES)[number];
      export function resolveTheme(theme: Theme): Theme {
        return theme;
      }
    `,
  );

  assert.equal(
    report.boundarySignals.some(
      (signal) => signal.label === "returns caller-owned JS value identity",
    ),
    false,
  );
});

test("primitive default parameters are not mistaken for object identity", () => {
  const report = analyze(
    "redirect.ts",
    `
      const DEFAULT_PATH = "/";
      export function safePath(value: unknown, fallback = DEFAULT_PATH) {
        return typeof value === "string" ? value.trim() : fallback;
      }
    `,
  );

  assert.equal(
    report.boundarySignals.some(
      (signal) => signal.label === "returns caller-owned JS value identity",
    ),
    false,
  );
});

test("identity-coupled callback APIs are not advertised as pure-core extractions", () => {
  const report = analyze(
    "visibility.ts",
    `
      import type { State } from "table-library";
      export function reconcile(
        current: State,
        incoming: State,
        updater: (current: State) => State,
      ): State {
        return updater(current) === incoming ? incoming : current;
      }
    `,
  );

  assert.notEqual(report.verdict, "Extract pure core");
  assert.ok(report.score <= 55);
  assert.ok(report.reviewFlags.some((flag) => /separable pure core/.test(flag)));
});

test("JavaScript coercion and encoding semantics receive explicit review", () => {
  const report = analyze(
    "decode.ts",
    `
      export function decode(value: string) {
        const decoded = decodeURIComponent(value);
        const count = Number(decoded);
        return Object.keys({ decoded, count });
      }
    `,
  );

  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "JS-specific coercion/encoding/object semantics",
    ),
  );
  assert.ok(report.reviewFlags.some((flag) => /coercion/.test(flag)));
});

test("worker and canvas APIs are treated as browser host boundaries", () => {
  const report = analyze(
    "converter.worker.ts",
    `
      self.addEventListener("message", async (event) => {
        const image = await createImageBitmap(event.data);
        const canvas = new OffscreenCanvas(image.width, image.height);
        self.postMessage(await canvas.convertToBlob());
      });
      export {};
    `,
  );

  assert.ok(
    report.boundarySignals.some(
      (signal) => signal.label === "DOM / browser host API",
    ),
  );
  assert.equal(report.tier, "Low priority");
});

test("embedded browser scripts are surfaced as boundary-heavy extraction work", () => {
  const report = analyze(
    "theme.ts",
    `
      export function resolveTheme(theme: "light" | "dark") {
        return theme;
      }
      export const SCRIPT = \`
        (() => {
          const root = document.documentElement;
          const applyTheme = (theme) => root.dataset.theme = theme;
          applyTheme(window.localStorage.getItem("theme") || "light");
        })();
      \`;
    `,
  );

  assert.ok(report.dimensions.boundaryCost >= 40);
  assert.equal(report.tier, "Low priority");
  assert.equal(report.verdict, "Keep in JS/TS");
});

test("lexical fallback masks strings and comments for hard exclusions", () => {
  const report = analyze(
    "fallback.ts",
    `
      // eval(input)
      const blocked = "__proto__";
      export function parse(value) {
        return value === blocked ? null : value;
      }
    `,
    "lexical",
  );

  assert.equal(report.eligible, true);
});

test("discovery supports multiple targets and modern extensions", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gleamability-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const first = path.join(temporary, "first");
  const second = path.join(temporary, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, "one.mts"), "export const one = 1;");
  fs.writeFileSync(path.join(second, "two.cjs"), "exports.two = 2;");
  fs.writeFileSync(path.join(second, "two.test.ts"), "test('two', () => {});");

  const options = analyzer.parseArgs([first, second]);
  const discovery = analyzer.collectFiles(options);

  assert.deepEqual(
    discovery.files.map((file) => path.basename(file)),
    ["one.mts", "two.cjs"],
  );
  assert.equal(discovery.skippedTestFileCount, 1);
});

test("CLI parsing rejects malformed values and unknown options", () => {
  assert.equal(analyzer.parseArgs(["--json", "-"]).jsonOutPath, "-");
  assert.throws(() => analyzer.parseArgs(["--top", "2junk"]), /non-negative integer/);
  assert.throws(() => analyzer.parseArgs(["--top", "-1"]), /requires a value|non-negative/);
  assert.throws(() => analyzer.parseArgs(["--wat"]), /Unknown option/);
  assert.throws(() => analyzer.parseArgs(["--engine", "ast"]), /auto, typescript, or lexical/);
});

test("eligible candidates rank ahead of exclusions regardless of latent score", () => {
  const eligible = analyze(
    "small.ts",
    `export function parse(value: string) { return value.trim(); }`,
  );
  const excluded = analyze(
    "large.tsx",
    `
      export type State = { kind: "one" } | { kind: "two" };
      export function transition(state: State) {
        switch (state.kind) {
          case "one": return <div>one</div>;
          case "two": return <div>two</div>;
        }
      }
    `,
  );

  const ranked = analyzer.rankReports([excluded, eligible]);
  assert.equal(ranked[0].filePath.endsWith("small.ts"), true);
  assert.equal(ranked[1].tier, "Not a fit");
});

test("the .cjs CLI runs inside a type-module host and emits clean JSON stdout", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gleamability-esm-host-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(temporary, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  fs.writeFileSync(
    path.join(temporary, "logic.js"),
    `// UNTRUSTED_SOURCE_MARKER must never appear in analyzer output.\n` +
      `export function normalize(value) { return value.trim().toLowerCase(); }`,
  );

  const stdout = childProcess.execFileSync(
    process.execPath,
    [
      path.join(__dirname, "analyze.cjs"),
      temporary,
      "--engine",
      "lexical",
      "--json",
      "-",
    ],
    { encoding: "utf8" },
  );
  const report = JSON.parse(stdout);

  assert.equal(report.engine, "lexical");
  assert.equal(report.fileCount, 1);
  assert.equal(report.results[0].eligible, true);
  assert.equal(stdout.includes("UNTRUSTED_SOURCE_MARKER"), false);
});

test("auto engine never imports TypeScript from a scan target", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gleamability-untrusted-ts-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const packageDirectory = path.join(temporary, "node_modules", "typescript");
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "typescript", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(packageDirectory, "index.js"),
    `module.exports = {\n` +
      `  ...require(${JSON.stringify(require.resolve("typescript"))}),\n` +
      `  version: "target-wrapper",\n` +
      `};\n`,
  );
  fs.writeFileSync(
    path.join(temporary, "logic.ts"),
    `export function normalize(value: string) { return value.trim(); }`,
  );

  const stdout = childProcess.execFileSync(
    process.execPath,
    [
      path.join(__dirname, "analyze.cjs"),
      temporary,
      "--engine",
      "auto",
      "--json",
      "-",
    ],
    { encoding: "utf8" },
  );
  const report = JSON.parse(stdout);

  assert.notEqual(report.engineVersion, "target-wrapper");
});

test("human output escapes control characters in untrusted filenames", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gleamability-filename-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(temporary, "candidate\ncontinued.ts"),
    `export function normalize(value: string) { return value.trim(); }`,
  );

  const stdout = childProcess.execFileSync(
    process.execPath,
    [path.join(__dirname, "analyze.cjs"), temporary, "--engine", "lexical"],
    { encoding: "utf8" },
  );

  assert.equal(stdout.includes("candidate\\ncontinued.ts"), true);
  assert.equal(stdout.includes("candidate\ncontinued.ts"), false);

  const missing = path.join(temporary, "missing\ncontinued.ts");
  const failed = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, "analyze.cjs"), missing, "--engine", "lexical"],
    { encoding: "utf8" },
  );
  assert.equal(failed.status, 2);
  assert.equal(failed.stderr.includes("missing\\ncontinued.ts"), true);
  assert.equal(failed.stderr.includes("missing\ncontinued.ts"), false);
});

test("CLI skips oversized source without loading it into a report", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gleamability-oversized-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporary, "oversized.js"), "x".repeat(4 * 1024 * 1024 + 1));

  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(__dirname, "analyze.cjs"),
      temporary,
      "--engine",
      "lexical",
      "--json",
      "-",
    ],
    { encoding: "utf8" },
  );
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.results.length, 0);
  assert.ok(
    report.warnings.some((warning) => /4194304-byte analysis limit/.test(warning)),
  );
});
