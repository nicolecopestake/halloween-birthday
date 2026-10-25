// Server-side checks against the mock (run dev/mock-server.mjs first):  node dev/api-test.mjs
import assert from "node:assert/strict";

const API = process.env.API || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "localadminkey1";
const call = async (body, raw) => {
  const res = await fetch(API + "/exec", { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: raw ?? JSON.stringify(body) });
  return res.json();
};
const sheet = async () => (await (await fetch(API + "/__sheet")).json()).sheets;
const run = fn => fetch(API + "/__run?fn=" + fn);
const id = s => (s + "x".repeat(24)).slice(0, 24);
let passed = 0;
const ok = (name, fn) => fn().then(() => { passed++; console.log("  ✓", name); });

const A = id("Anna"), B = id("Ben"), C = id("Chai");
const anna = { name: "  Anna   Smith ", main: "m_shrimp", items: { s_larb: 2, s_gougeres: 1, d_baguette: 3 }, egg: 1, notes: "No  peanuts\n\n\n\nplease" };

await run("resetOrders");
await run("clearDeadline");

await ok("empty list", async () => {
  const d = await call({ action: "list" });
  assert.equal(d.ok, true); assert.deepEqual(d.orders, []); assert.equal(d.me, null); assert.equal(d.closed, false);
});

await ok("save normalises text and returns me", async () => {
  const d = await call({ action: "save", id: A, order: anna });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.me.name, "Anna Smith");
  assert.equal(d.me.notes, "No peanuts\n\nplease");
  assert.deepEqual(d.me.items, { s_larb: 2, s_gougeres: 1, d_baguette: 3 });
  assert.equal(d.me.egg, 1);
  assert.deepEqual(d.orders, [], "guests don't get other orders");
  const a = await call({ action: "list", id: A, key: KEY });
  assert.equal(a.orders.length, 1); assert.equal(a.orders[0].mine, true);
});

const bad = [
  ["unknown dish", { ...anna, items: { s_nope: 1 } }],
  ["main id used as an extra", { ...anna, items: { m_ribs: 1 } }],
  ["quantity 10", { ...anna, items: { s_gougeres: 10 } }],
  ["negative quantity", { ...anna, items: { s_gougeres: -1 } }],
  ["fractional quantity", { ...anna, items: { s_gougeres: 1.5 } }],
  ["quantity as string", { ...anna, items: { s_gougeres: "2" } }],
  ["more eggs than larb", { ...anna, items: { s_larb: 1 }, egg: 2 }],
  ["egg without larb", { ...anna, items: {}, egg: 1 }],
  ["unknown main", { ...anna, main: "m_lobster" }],
  ["missing main", { ...anna, main: "" }],
  ["extra used as main", { ...anna, main: "s_larb" }],
  ["empty name", { ...anna, name: "   " }],
  ["name too long", { ...anna, name: "x".repeat(61) }],
  ["notes too long", { ...anna, notes: "x".repeat(401) }],
  ["name not a string", { ...anna, name: { a: 1 } }],
  ["items as array", { ...anna, items: [1, 2] }],
];
for (const [what, order] of bad) {
  await ok("rejects " + what, async () => {
    const d = await call({ action: "save", id: B, order });
    assert.equal(d.ok, false, what); assert.equal(d.error, "invalid", JSON.stringify(d));
  });
}
await ok("rejects bad ids, actions and bodies", async () => {
  assert.equal((await call({ action: "save", id: "short", order: anna })).error, "bad_id");
  assert.equal((await call({ action: "save", id: "a".repeat(20) + "!!!!", order: anna })).error, "bad_id");
  assert.equal((await call({ action: "drop" })).error, "bad_action");
  assert.equal((await call(null, "{not json")).error, "bad_request");
  assert.equal((await call(null, JSON.stringify({ action: "list", pad: "x".repeat(11000) }))).error, "bad_request");
  assert.equal((await call({ action: "list", key: KEY })).orders.length, 1, "nothing extra was saved");
});

await ok("name 60 chars and notes 400 chars are accepted; Thai text works", async () => {
  const d = await call({ action: "save", id: B, order: { name: "B".repeat(60), main: "none", items: { s_cashew: 9 }, egg: 0, notes: "ไม่ทานเผ็ด " + "x".repeat(389) } });
  assert.equal(d.ok, true, JSON.stringify(d)); assert.equal(d.me.notes.length, 400);
});

await ok("guest text can't become a formula in the Sheet", async () => {
  const d = await call({ action: "save", id: C, order: { name: "=IMPORTXML(\"http://x\")", main: "m_picanha", items: { s_larb: 1 }, egg: 1, notes: "+1 gluten free" } });
  assert.equal(d.ok, true);
  const orders = (await sheet()).find(s => s.name === "Orders");
  assert.equal(orders.formulaCount, 0);
  const row = orders.rows.find(r => r.includes("=IMPORTXML(\"http://x\")"));
  assert.ok(row, "stored as plain text");
});

await ok("guests only get their own order; GET returns no orders", async () => {
  const d = await call({ action: "list", id: C });
  assert.deepEqual(d.orders, []);
  assert.equal(d.me.main, "m_picanha");
  assert.ok(!("id" in d.me));
  const g = await (await fetch(API + "/exec")).json();
  assert.equal(g.ok, true); assert.deepEqual(g.orders, []); assert.equal(g.me, null);
  const a = await call({ action: "list", id: C, key: KEY });
  assert.equal(a.orders.length, 3); assert.equal(a.orders.filter(o => o.mine).length, 1);
});

await ok("update keeps one row and the created time", async () => {
  const before = (await sheet()).find(s => s.name === "Orders");
  const head = before.rows[0];
  const createdBefore = before.rows.find(r => r[head.indexOf("Order ID")] === A)[head.indexOf("Created")];
  await new Promise(r => setTimeout(r, 20));
  const d = await call({ action: "save", id: A, order: { ...anna, main: "m_ribs", items: { s_larb: 3 }, egg: 3 } });
  assert.equal((await call({ action: "list", key: KEY })).orders.length, 3);
  assert.equal(d.me.main, "m_ribs"); assert.equal(d.me.egg, 3);
  const after = (await sheet()).find(s => s.name === "Orders");
  const rows = after.rows.filter(r => r[head.indexOf("Order ID")] === A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][head.indexOf("Created")], createdBefore);
  assert.notEqual(rows[0][head.indexOf("Updated")], createdBefore);
});

await ok("Dish totals formulas match the orders", async () => {
  // Anna: ribs 300 + 3 larb 780 + 3 egg 60 = 1140
  // B:    no main + 9 cashews 1080          = 1080
  // C:    picanha 550 + larb 260 + egg 20   =  830
  const t = (await sheet()).find(s => s.name === "Dish totals").rows;
  const get = (dish, col) => { const r = t.find(r => r[1] === dish); const v = r[col]; return v && typeof v === "object" ? v.v : v; };
  assert.equal(get("Braised Beef Short Ribs with Chimichurri 200g", 3), 1);
  assert.equal(get("Grilled Picanha w/ Nam Jim Jaew 250g", 3), 1);
  assert.equal(get("Creamy Shrimp Pasta", 3), 0);
  assert.equal(get("No main", 3), 1);
  assert.equal(get("Signature Larb Tartare", 3), 4);
  assert.equal(get("Signature Larb Tartare", 4), 1040);
  assert.equal(get("Raw egg yolk add-on", 3), 4);
  assert.equal(get("Raw egg yolk add-on", 4), 80);
  assert.equal(get("Sea Salt Roasted Cashew Nuts", 3), 9);
  assert.equal(get("Orders in", 3), 3);
  assert.equal(get("Food total", 4), 1140 + 1080 + 830);
  assert.equal(get("Check: sum of Orders totals", 4), 1140 + 1080 + 830);
});

await ok("admin key shows ids; a wrong key is flagged", async () => {
  const d = await call({ action: "list", key: KEY });
  assert.equal(d.admin, true); assert.ok(d.orders.every(o => o.id));
  const w = await call({ action: "list", key: "wrongkey99" });
  assert.equal(w.admin, false); assert.equal(w.badKey, true); assert.ok(w.orders.every(o => !o.id));
  assert.equal((await call({ action: "setDeadline", key: "wrongkey99", deadline: null })).error, "forbidden");
  assert.equal((await call({ action: "adminRemove", target: A })).error, "forbidden");
});

await ok("deadline closes saving and removing for guests, not for the admin", async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const s = await call({ action: "setDeadline", key: KEY, deadline: past });
  assert.equal(s.closed, true); assert.equal(s.deadline, past);
  assert.equal((await call({ action: "save", id: A, order: anna })).error, "closed");
  assert.equal((await call({ action: "remove", id: A })).error, "closed");
  const a = await call({ action: "save", id: id("Organiser"), key: KEY, order: { ...anna, name: "Organiser" } });
  assert.equal(a.ok, true);
  const future = new Date(Date.now() + 3600e3).toISOString();
  const f = await call({ action: "setDeadline", key: KEY, deadline: future });
  assert.equal(f.closed, false);
  assert.equal((await call({ action: "save", id: A, order: { ...anna, items: { s_larb: 3 }, egg: 3, main: "m_ribs" } })).ok, true);
  assert.equal((await call({ action: "setDeadline", key: KEY, deadline: "not a date" })).error, "invalid");
  assert.equal((await call({ action: "setDeadline", key: KEY, deadline: null })).deadline, null);
});

await ok("admin remove, guest remove", async () => {
  const d = await call({ action: "adminRemove", key: KEY, target: id("Organiser") });
  assert.equal(d.orders.length, 3);
  const r = await call({ action: "remove", id: B });
  assert.equal(r.me, null);
  assert.equal((await call({ action: "list", key: KEY })).orders.length, 2);
  const again = await call({ action: "remove", id: B });
  assert.equal(again.ok, true, "removing twice is harmless");
});

await ok("re-running setup() keeps every order", async () => {
  await run("setup");
  const d = await call({ action: "list", id: A, key: KEY });
  assert.equal(d.orders.length, 2); assert.equal(d.me.egg, 3);
});

await ok("resetOrders() empties the list", async () => {
  await run("resetOrders");
  assert.equal((await call({ action: "list", key: KEY })).orders.length, 0);
  const t = (await sheet()).find(s => s.name === "Dish totals").rows;
  assert.equal(t.find(r => r[1] === "Food total")[4].v, 0);
});

console.log(`\n${passed} checks passed`);
