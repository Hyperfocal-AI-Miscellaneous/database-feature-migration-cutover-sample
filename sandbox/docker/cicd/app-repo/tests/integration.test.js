/**
 * Integration tests for the hyperfocal API.
 * Run against a live database + API instance.
 *
 * Expects:
 *   API_URL  - e.g. http://172.20.0.13:8080
 *   PG_HOST  - e.g. 172.20.0.10
 */

const http = require("http");

const API_URL = process.env.API_URL || "http://172.20.0.13:8080";
const PG_HOST = process.env.PG_HOST || "172.20.0.10";

function get(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_URL}${path}`;
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on("error", reject);
  });
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name} — ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

async function run() {
  console.log("Running integration tests...\n");

  await test("GET /health returns healthy", async () => {
    const { status, body } = await get("/health");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "healthy", `Expected healthy, got ${body.status}`);
  });

  await test("GET /items/count returns positive count", async () => {
    const { status, body } = await get("/items/count");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(parseInt(body.count) > 0, `Expected positive count, got ${body.count}`);
  });

  await test("GET /orders/by-customer returns rows", async () => {
    const { status, body } = await get("/orders/by-customer?customer_id=1");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(body), "Expected array response");
    assert(body.length > 0, "Expected at least one order");
  });

  await test("GET /orders/summary returns count", async () => {
    const { status, body } = await get("/orders/summary");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(parseInt(body.count) > 0, `Expected positive count, got ${body.count}`);
  });

  await test("GET /orders/totals returns totals", async () => {
    const { status, body } = await get("/orders/totals?customer_id=1");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(parseInt(body.order_count) > 0, `Expected positive order count, got ${body.order_count}`);
    assert(parseFloat(body.gross_total) > 0, `Expected positive gross total, got ${body.gross_total}`);
    assert(parseFloat(body.net_total) > 0, `Expected positive net total, got ${body.net_total}`);
  });

  await test("GET /items/top returns items", async () => {
    const { status, body } = await get("/items/top");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(body), "Expected array response");
    assert(body.length > 0, "Expected at least one item");
    assert(body[0].name, "Expected item to have name");
  });

  await test("GET /items/avg-value returns average", async () => {
    const { status, body } = await get("/items/avg-value?from=1&to=100");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.avg_value !== undefined, "Expected avg_value field");
    assert(parseFloat(body.avg_value) > 0, `Expected positive avg, got ${body.avg_value}`);
  });

  await test("GET /orders/by-customer has correct fields", async () => {
    const { body } = await get("/orders/by-customer?customer_id=2");
    assert(Array.isArray(body) && body.length > 0, "Expected non-empty array");
    const row = body[0];
    assert(row.id !== undefined, "Missing id");
    assert(row.quantity !== undefined, "Missing quantity");
    assert(row.status !== undefined, "Missing status");
    assert(row.name !== undefined, "Missing item name from join");
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
