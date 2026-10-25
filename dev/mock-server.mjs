// Local stand-in for Google: runs the real Code.gs against an in-memory fake Sheet.
//
//   node dev/mock-server.mjs
//   open http://localhost:8080/?api=http://localhost:8787/exec
//   admin view: http://localhost:8080/?api=http://localhost:8787/exec#admin-localadminkey1
//
// It copies the parts of Apps Script behaviour that matter to the browser:
// POST /exec answers with a 302 redirect to a separate "echo" URL that serves the JSON
// (like script.google.com -> script.googleusercontent.com), both with
// Access-Control-Allow-Origin: *, and OPTIONS preflights are refused, as on Google.
// GET /__sheet shows the fake Sheet with the "Dish totals" formulas evaluated.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.API_PORT || 8787);
const WEB_PORT = Number(process.env.WEB_PORT || 8080);
const LATENCY = Number(process.env.LATENCY || 300);
const ADMIN_KEY = process.env.ADMIN_KEY || "localadminkey1";

// ── Fake SpreadsheetApp ──────────────────────────────────────────────────────
class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet.cell(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  setValues(v) {
    if (v.length !== this.nr || v.some(row => row.length !== this.nc)) {
      throw new Error(`The number of rows or columns in the data does not match the range (${v.length}x${v[0]?.length} vs ${this.nr}x${this.nc})`);
    }
    v.forEach((row, i) => row.forEach((val, j) => this.sheet.put(this.r + i, this.c + j, val)));
    return this;
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.put(this.r + i, this.c + j, "");
    return this;
  }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}
class Formula { constructor(f) { this.f = f; } }
class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.maxRows = 1000; this.maxCols = 26; this.formulaCells = []; }
  getName() { return this.name; }
  cell(r, c) { return (this.rows[r - 1] || [])[c - 1] ?? ""; }
  put(r, c, val) {
    // Mirror Sheets: a leading apostrophe forces text, a leading = becomes a formula.
    if (typeof val === "string" && val.startsWith("'")) val = val.slice(1);
    else if (typeof val === "string" && val.startsWith("=")) { this.formulaCells.push({ r, c, f: val }); val = new Formula(val); }
    (this.rows[r - 1] ||= [])[c - 1] = val;
  }
  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) {
      throw new Error(`The coordinates of the range are outside the dimensions of the sheet (${this.name} r${r} c${c} ${nr}x${nc}, grid ${this.maxRows}x${this.maxCols})`);
    }
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some(v => v !== "" && v != null)) return i;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.rows.forEach(row => (row || []).forEach((v, j) => { if (v !== "" && v != null) m = Math.max(m, j + 1); }));
    return m;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  deleteRows(r, n) { this.rows.splice(r - 1, n); }
  clear() { this.rows = []; this.formulaCells = []; }
  setFrozenRows() {}
  hideColumns() {}
}
const spreadsheet = {
  sheets: [new Sheet("Sheet1")],
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; },
  insertSheet(n) {
    if (this.getSheetByName(n)) throw new Error(`A sheet with the name "${n}" already exists.`);
    const s = new Sheet(n); this.sheets.push(s); return s;
  },
};

// ── Other Apps Script services ───────────────────────────────────────────────
const props = new Map([["ADMIN_KEY", ADMIN_KEY]]);
let lockHeld = false;
const context = {
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (props.has(k) ? props.get(k) : null),
    setProperty: (k, v) => { props.set(k, String(v)); },
    deleteProperty: k => { props.delete(k); },
  }) },
  LockService: { getScriptLock: () => ({
    tryLock() { if (lockHeld) throw new Error("Mock: lock taken twice in one execution"); lockHeld = true; return true; },
    releaseLock() { lockHeld = false; },
  }) },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: s => ({ content: s, setMimeType() { return this; } }),
  },
  Utilities: { getUuid: () => crypto.randomUUID() },
  Logger: { log: (...a) => console.log("[Logger]", ...a) },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, "Code.gs"), "utf8"), context, { filename: "Code.gs" });
context.setup();

// ── Formula evaluation for the "Dish totals" tab (only the shapes Code.gs writes) ─
const colNum = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
function columnValues(sheet, letter, from) {
  const out = [];
  for (let r = from; r <= sheet.getLastRow(); r++) out.push(sheet.cell(r, colNum(letter)));
  return out;
}
function evaluate(sheet, f, r) {
  let m;
  const orders = spreadsheet.getSheetByName("Orders");
  const num = v => (typeof v === "number" ? v : 0);
  const val = (ref) => { const mm = /^([A-Z]+)(\d+)$/.exec(ref); const v = sheet.cell(+mm[2], colNum(mm[1])); return v instanceof Formula ? evaluate(sheet, v.f, +mm[2]) : v; };
  if ((m = /^=([A-Z]+\d+)\*([A-Z]+\d+)$/.exec(f))) return num(val(m[1])) * num(val(m[2]));
  if ((m = /^=COUNTIF\(Orders!([A-Z]+)2:\1,([A-Z]+\d+)\)$/.exec(f))) return columnValues(orders, m[1], 2).filter(v => v === val(m[2])).length;
  if ((m = /^=SUM\(Orders!([A-Z]+)2:\1\)$/.exec(f))) return columnValues(orders, m[1], 2).reduce((a, v) => a + num(v), 0);
  if ((m = /^=COUNTA\(Orders!([A-Z]+)2:\1\)$/.exec(f))) return columnValues(orders, m[1], 2).filter(v => v !== "").length;
  if ((m = /^=SUM\(([A-Z]+)(\d+):\1(\d+)\)$/.exec(f))) {
    let t = 0;
    for (let i = +m[2]; i <= +m[3]; i++) t += num(val(m[1] + i));
    return t;
  }
  throw new Error("Mock can't evaluate formula: " + f);
}
function dumpSheets() {
  return spreadsheet.sheets.map(s => {
    const rows = [];
    for (let r = 1; r <= s.getLastRow(); r++) {
      const row = [];
      for (let c = 1; c <= s.getLastColumn(); c++) {
        const v = s.cell(r, c);
        row.push(v instanceof Formula ? { f: v.f, v: evaluate(s, v.f, r) } : v);
      }
      rows.push(row);
    }
    return { name: s.name, maxCols: s.maxCols, formulaCount: s.formulaCells.length, rows };
  });
}

// ── HTTP: the "web app" and the static page ──────────────────────────────────
const echoes = new Map();
const cors = { "Access-Control-Allow-Origin": "*" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requestLog = [];

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  requestLog.push(`${req.method} ${url.pathname} ${req.headers["content-type"] || ""}`);
  if (req.method === "OPTIONS") {
    // Apps Script has no doOptions, so a preflight fails. Keep it that way here.
    console.warn("!! Preflight OPTIONS received: the page sent a non-simple request");
    res.writeHead(405); return res.end();
  }
  if (url.pathname === "/exec") {
    let body = "";
    for await (const chunk of req) body += chunk;
    await sleep(LATENCY);
    let out;
    try {
      out = req.method === "POST"
        ? context.doPost({ postData: { contents: body, length: body.length, type: req.headers["content-type"] }, parameter: Object.fromEntries(url.searchParams) })
        : context.doGet({ parameter: Object.fromEntries(url.searchParams) });
    } catch (err) {
      // An uncaught exception in Apps Script returns an HTML error page, not JSON.
      console.error(err);
      res.writeHead(200, { ...cors, "Content-Type": "text/html" });
      return res.end("<html><body>Script error: " + String(err.message) + "</body></html>");
    } finally { lockHeld = false; }
    const token = crypto.randomUUID();
    echoes.set(token, out.content);
    res.writeHead(302, { ...cors, Location: `http://localhost:${API_PORT}/echo?t=${token}` });
    return res.end();
  }
  if (url.pathname === "/echo") {
    const body = echoes.get(url.searchParams.get("t"));
    echoes.delete(url.searchParams.get("t"));
    res.writeHead(body ? 200 : 404, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    return res.end(body || "{}");
  }
  if (url.pathname === "/__sheet") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ sheets: dumpSheets(), props: Object.fromEntries(props) }, null, 1));
  }
  if (url.pathname === "/__log") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    const out = JSON.stringify(requestLog); if (url.searchParams.has("clear")) requestLog = [];
    return res.end(out);
  }
  if (url.pathname === "/__run") {
    // Run an editor function such as resetOrders or clearDeadline.
    const fn = url.searchParams.get("fn");
    if (!/^(setup|resetOrders|clearDeadline|showSettings)$/.test(fn)) { res.writeHead(400); return res.end(); }
    context[fn]();
    res.writeHead(200, cors); return res.end("ok");
  }
  res.writeHead(404); res.end();
}).listen(API_PORT, () => console.log(`Mock Apps Script on http://localhost:${API_PORT}/exec  (admin key: ${props.get("ADMIN_KEY")})`));

http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p !== "/" && p !== "/index.html") { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(path.join(ROOT, "index.html")));
}).listen(WEB_PORT, () => console.log(`Page on http://localhost:${WEB_PORT}/?api=http://localhost:${API_PORT}/exec`));
