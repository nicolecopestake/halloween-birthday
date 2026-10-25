/**
 * Cru group dinner pre-order: Google Apps Script backend.
 *
 * The Sheet this script is bound to holds the data:
 *   "Orders"      one row per guest (the hidden "Data" column is the source of truth)
 *   "Dish totals" counts and subtotals per dish, as live formulas over "Orders"
 *
 * The page talks to this script with POST requests whose body is JSON sent as
 * text/plain (a "simple" request, so the browser skips the CORS preflight that
 * Apps Script cannot answer). See README.md for the details.
 *
 * Run setup() once from the editor before deploying. It creates both tabs and
 * an admin key, and prints the admin key in the execution log.
 */

// ── Menu ─────────────────────────────────────────────────────────────────────
// Keep the ids and prices in step with MENU in index.html. If you add, remove
// or rename a dish, edit both files, then run setup() again to rebuild the tabs.
const MENU = [
  { id: 'm_shrimp',       course: 'main',  name: 'Creamy Shrimp Pasta', price: 360 },
  { id: 'm_meatballs',    course: 'main',  name: 'Spaghetti & Meatballs', price: 360 },
  { id: 'm_chicken',      course: 'main',  name: 'Grilled Chicken Thigh with Jaew & Nam Prik Kha 250g', price: 300 },
  { id: 'm_ribs',         course: 'main',  name: 'Braised Beef Short Ribs with Chimichurri 200g', price: 300 },
  { id: 'm_picanha',      course: 'main',  name: 'Grilled Picanha w/ Nam Jim Jaew 250g', price: 550 },

  { id: 's_gougeres',     course: 'share', name: 'Gougères', price: 180 },
  { id: 's_cashew',       course: 'share', name: 'Sea Salt Roasted Cashew Nuts', price: 120 },
  { id: 's_cashew_spicy', course: 'share', name: 'Spicy Roasted Cashew Nuts', price: 150 },
  { id: 's_bruschetta',   course: 'share', name: 'Bruschetta', price: 190 },
  { id: 's_shrimp_toast', course: 'share', name: 'Cheesy Shrimp Toast', price: 250 },
  { id: 's_nanban',       course: 'share', name: 'Chicken Nanban', price: 260 },
  { id: 's_meatball',     course: 'share', name: 'Meatball w/ Spicy Sauce', price: 260 },
  { id: 's_tomato',       course: 'share', name: 'Tomato Salad', price: 220 },
  { id: 's_gambas',       course: 'share', name: 'Gambas al Ajillo', price: 360 },
  { id: 's_yukke',        course: 'share', name: 'Beef Yukke', price: 280 },
  { id: 's_larb',         course: 'share', name: 'Signature Larb Tartare', price: 260 },
  { id: 's_platter_half', course: 'share', name: 'Cru Platter Half (2 cheese / 1 charcuterie)', price: 360 },
  { id: 's_platter_full', course: 'share', name: 'Cru Platter Full (3 cheese / 2 charcuterie)', price: 550 },

  { id: 'd_tomato',       course: 'side',  name: 'Cherry Tomato 100g', price: 80 },
  { id: 'd_baguette',     course: 'side',  name: 'French Baguette 100g', price: 80 },
  { id: 'd_olive',        course: 'side',  name: 'Olive & Pickle 50g', price: 80 },
  { id: 'd_cheese50',     course: 'side',  name: 'Cheese 50g', price: 180 },
  { id: 'd_cheese100',    course: 'side',  name: 'Cheese 100g', price: 300 },
  { id: 'd_cold50',       course: 'side',  name: 'Cold Cut 50g', price: 150 },
  { id: 'd_cold100',      course: 'side',  name: 'Cold Cut 100g', price: 280 },
];
// Raw egg yolk on the larb, charged per portion.
const EGG = { dish: 's_larb', name: 'Raw egg yolk add-on', price: 20 };

const LIMITS = { name: 60, notes: 400, qty: 9, orders: 150, body: 10000 };
const ORDERS = 'Orders';
const TOTALS = 'Dish totals';

const BY_ID = {};
MENU.forEach(d => { BY_ID[d.id] = d; });
const COURSE_LABEL = { main: 'Main', share: 'To share', side: 'Side' };

// ── Web app entry points ─────────────────────────────────────────────────────

/** GET returns the open/closed status only, no orders. Secrets (order ids, admin key) never go in URLs. */
function doGet() {
  return respond_(safely_(() => listPayload_(null, null)));
}

/** POST body: {"action": "list" | "save" | "remove" | "adminRemove" | "setDeadline", ...} */
function doPost(e) {
  return respond_(safely_(() => {
    const body = e && e.postData && e.postData.contents;
    if (!body || body.length > LIMITS.body) throw fail_('bad_request', 'Missing or oversized request.');
    let req;
    try { req = JSON.parse(body); } catch (err) { throw fail_('bad_request', 'Request body must be JSON.'); }
    if (!req || typeof req !== 'object') throw fail_('bad_request', 'Request body must be a JSON object.');
    return route_(req);
  }));
}

function route_(req) {
  switch (req.action) {
    case 'list':        return listPayload_(req.id, req.key);
    case 'save':        return saveOrder_(req);
    case 'remove':      return removeOrder_(req);
    case 'adminRemove': return adminRemove_(req);
    case 'setDeadline': return setDeadline_(req);
    default: throw fail_('bad_action', 'Unknown action.');
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

function listPayload_(id, key) {
  const admin = isAdmin_(key);
  const mine = isValidId_(id) ? id : null;
  const rows = readOrders_(ordersSheet_());
  const hit = mine ? rows.find(r => r.id === mine) : null;
  return {
    ok: true,
    // Only the organiser gets everyone's orders. Guests get their own order back and nothing else.
    orders: admin ? rows.map(r => Object.assign(publicOrder_(r.data), { id: r.id, mine: r.id === mine })) : [],
    me: hit ? publicOrder_(hit.data) : null,
    admin: admin,
    badKey: !!key && !admin,
    deadline: getDeadline_(),
    closed: isClosed_(),
    serverTime: new Date().toISOString(),
    dishIds: MENU.map(d => d.id),
  };
}

function saveOrder_(req) {
  const id = requireId_(req.id);
  if (!isAdmin_(req.key) && isClosed_()) throw fail_('closed', 'Orders are closed.');
  const order = validateOrder_(req.order);
  withLock_(() => {
    const sh = ordersSheet_();
    const rows = readOrders_(sh);
    const existing = rows.find(r => r.id === id);
    if (!existing && rows.length >= LIMITS.orders) throw fail_('full', 'The order list is full.');
    const now = new Date().toISOString();
    order.created = existing && existing.data.created ? existing.data.created : now;
    order.updated = now;
    writeRow_(sh, existing ? existing.row : lastDataRow_(sh) + 1, id, order);
  });
  return listPayload_(id, req.key);
}

function removeOrder_(req) {
  const id = requireId_(req.id);
  if (!isAdmin_(req.key) && isClosed_()) throw fail_('closed', 'Orders are closed.');
  deleteById_(id);
  return listPayload_(id, req.key);
}

function adminRemove_(req) {
  if (!isAdmin_(req.key)) throw fail_('forbidden', 'Admin key required.');
  deleteById_(requireId_(req.target));
  return listPayload_(req.id, req.key);
}

function setDeadline_(req) {
  if (!isAdmin_(req.key)) throw fail_('forbidden', 'Admin key required.');
  const props = PropertiesService.getScriptProperties();
  if (req.deadline === null || req.deadline === '') {
    props.deleteProperty('DEADLINE');
  } else {
    const t = new Date(String(req.deadline));
    if (isNaN(t.getTime())) throw fail_('invalid', 'Deadline must be a date and time.');
    props.setProperty('DEADLINE', t.toISOString());
  }
  return listPayload_(req.id, req.key);
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateOrder_(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail_('invalid', 'Order is missing.');

  const name = cleanText_(o.name, false);
  if (!name) throw fail_('invalid', 'Name is required.');
  if (name.length > LIMITS.name) throw fail_('invalid', 'Name is too long (max ' + LIMITS.name + ' characters).');

  const items = {};
  const raw = o.items == null ? {} : o.items;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fail_('invalid', 'Items must be an object.');
  Object.keys(raw).forEach(k => {
    if (!BY_ID[k]) throw fail_('invalid', 'Unknown dish: ' + String(k).slice(0, 40));
    const q = checkQty_(raw[k], k);
    if (q > 0) items[k] = q;
  });

  const egg = checkQty_(o.egg == null ? 0 : o.egg, 'egg');
  if (egg > (items[EGG.dish] || 0)) throw fail_('invalid', 'More egg yolks than larb portions.');

  const notes = cleanText_(o.notes, true);
  if (notes.length > LIMITS.notes) throw fail_('invalid', 'Notes are too long (max ' + LIMITS.notes + ' characters).');

  return { name: name, items: items, egg: egg, notes: notes };
}

function checkQty_(v, what) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > LIMITS.qty) {
    throw fail_('invalid', 'Quantity for ' + String(what).slice(0, 40) + ' must be a whole number from 0 to ' + LIMITS.qty + '.');
  }
  return v;
}

/** Trims, strips control characters and collapses spaces. Keeps line breaks when multiline. */
function cleanText_(v, multiline) {
  if (v == null) return '';
  if (typeof v !== 'string') throw fail_('invalid', 'Text fields must be text.');
  let s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}

function isValidId_(id) { return typeof id === 'string' && /^[A-Za-z0-9]{16,64}$/.test(id); }
function requireId_(id) {
  if (!isValidId_(id)) throw fail_('bad_id', 'Missing or malformed order id.');
  return id;
}

function isAdmin_(key) {
  const real = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return !!real && real.length >= 8 && typeof key === 'string' && key === real;
}

function getDeadline_() { return PropertiesService.getScriptProperties().getProperty('DEADLINE') || null; }
function isClosed_() {
  const d = getDeadline_();
  return !!d && Date.now() >= new Date(d).getTime();
}

// ── Sheet storage ────────────────────────────────────────────────────────────

function columns_() {
  return ['Name']
    .concat(MENU.map(d => d.name))
    .concat([EGG.name, 'Dietary notes', 'Total (THB)', 'Updated', 'Created', 'Order ID', 'Data']);
}

function ordersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(ORDERS);
  if (sh && sameHeader_(sh)) return sh;
  // First run, or the menu changed since the tabs were built: rebuild them.
  return withLock_(() => rebuildAll_());
}

function sameHeader_(sh) {
  const cols = columns_();
  if (sh.getLastColumn() !== cols.length) return false;
  const head = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  return cols.every((c, i) => head[i] === c);
}

/** Returns [{row, id, data}] for every saved order, found by the "Order ID" and "Data" headers. */
function readOrders_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const head = values[0];
  const iId = head.indexOf('Order ID');
  const iData = head.indexOf('Data');
  if (iId < 0 || iData < 0) return [];
  const out = [];
  values.slice(1).forEach((r, i) => {
    const id = String(r[iId] || '');
    if (!id) return;
    try { out.push({ row: i + 2, id: id, data: JSON.parse(r[iData]) }); } catch (err) { /* skip hand-edited rows */ }
  });
  return out;
}

function lastDataRow_(sh) { return Math.max(1, sh.getLastRow()); }

function writeRow_(sh, row, id, o) {
  const vals = [asText_(o.name)]
    .concat(MENU.map(d => o.items[d.id] || ''))
    .concat([o.egg || '', asText_(o.notes), totalOf_(o), new Date(o.updated), new Date(o.created), id, JSON.stringify(o)]);
  sh.getRange(row, 1, 1, vals.length).setValues([vals]);
}

function deleteById_(id) {
  withLock_(() => {
    const sh = ordersSheet_();
    const hit = readOrders_(sh).find(r => r.id === id);
    if (hit) sh.deleteRow(hit.row);
  });
}

function totalOf_(o) {
  let t = 0;
  Object.keys(o.items || {}).forEach(k => { if (BY_ID[k]) t += BY_ID[k].price * o.items[k]; });
  return t + EGG.price * (o.egg || 0);
}

function publicOrder_(o) {
  return { name: o.name, items: o.items || {}, egg: o.egg || 0, notes: o.notes || '', updated: o.updated };
}

/** A leading = + - @ would make Sheets treat a guest's text as a formula. The apostrophe forces plain text. */
function asText_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }

/** Rebuilds both tabs from the stored Data column, keeping every order. */
function rebuildAll_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ORDERS);
  const keep = sh ? readOrders_(sh) : [];
  if (!sh) sh = ss.insertSheet(ORDERS);
  const cols = columns_();
  sh.clear();
  if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  keep.forEach((r, i) => writeRow_(sh, i + 2, r.id, r.data));
  const at = name => cols.indexOf(name) + 1;
  sh.getRange(2, at('Updated'), sh.getMaxRows() - 1, 2).setNumberFormat('yyyy-mm-dd hh:mm');
  sh.hideColumns(at('Data'));
  buildTotals_(ss);
  return sh;
}

/** "Dish totals" tab: one row per dish, counts and subtotals as formulas over the Orders tab. */
function buildTotals_(ss) {
  const cols = columns_();
  const col = name => colLetter_(cols.indexOf(name) + 1);
  let sh = ss.getSheetByName(TOTALS);
  if (!sh) sh = ss.insertSheet(TOTALS);
  sh.clear();

  const rows = [['Course', 'Dish', 'Price (THB)', 'Count', 'Subtotal (THB)']];
  const add = (course, name, price, count) => {
    const r = rows.length + 1;
    rows.push([course, name, price, count, '=C' + r + '*D' + r]);
  };
  MENU.forEach(d => {
    const c = col(d.name);
    add(COURSE_LABEL[d.course], d.name, d.price, '=SUM(' + ORDERS + '!' + c + '2:' + c + ')');
  });
  const e = col(EGG.name);
  add('Add-on', EGG.name, EGG.price, '=SUM(' + ORDERS + '!' + e + '2:' + e + ')');
  const lastDish = rows.length;
  const id = col('Order ID');
  const tot = col('Total (THB)');
  rows.push(['', '', '', '', '']);
  rows.push(['', 'Orders in', '', '=COUNTA(' + ORDERS + '!' + id + '2:' + id + ')', '']);
  rows.push(['', 'Food total', '', '', '=SUM(E2:E' + lastDish + ')']);
  rows.push(['', 'Check: sum of Orders totals', '', '', '=SUM(' + ORDERS + '!' + tot + '2:' + tot + ')']);

  sh.getRange(1, 1, rows.length, 5).setValues(rows);
  sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  sh.getRange(2, 3, rows.length - 1, 3).setNumberFormat('#,##0');
  sh.setFrozenRows(1);
}

function colLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let holdingLock_ = false;
/** Runs fn while holding the script lock, so two guests saving at once can't clash. Nested calls reuse the lock. */
function withLock_(fn) {
  if (holdingLock_) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw fail_('busy', 'The server is busy. Try again in a moment.');
  holdingLock_ = true;
  try { return fn(); } finally { holdingLock_ = false; lock.releaseLock(); }
}

function fail_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function safely_(fn) {
  try { return fn(); }
  catch (err) {
    if (err && err.code) return { ok: false, error: err.code, message: err.message };
    console.error(err && err.stack || err);
    return { ok: false, error: 'server_error', message: 'Something went wrong on the server.' };
  }
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── Run these from the editor (select the function, press Run) ──────────────

/** One-time setup: builds both tabs and creates an admin key if there isn't one. Safe to re-run. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  withLock_(() => rebuildAll_());
  Logger.log('Setup done. Your admin link is your page URL followed by:  #admin-' + props.getProperty('ADMIN_KEY'));
}

/** Prints the current admin key and deadline. */
function showSettings() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('Admin link suffix: #admin-' + props.getProperty('ADMIN_KEY'));
  Logger.log('Deadline: ' + (props.getProperty('DEADLINE') || 'none'));
}

/** Replaces the admin key. Old admin links stop working. */
function newAdminKey() {
  PropertiesService.getScriptProperties().deleteProperty('ADMIN_KEY');
  setup();
}

/** Deletes every order but keeps the tabs, the admin key and the deadline. */
function resetOrders() {
  withLock_(() => {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ORDERS);
    if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  Logger.log('All orders deleted.');
}

/** Removes the deadline so guests can save again. */
function clearDeadline() {
  PropertiesService.getScriptProperties().deleteProperty('DEADLINE');
  Logger.log('Deadline cleared.');
}
