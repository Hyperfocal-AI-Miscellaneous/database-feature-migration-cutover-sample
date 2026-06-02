const express = require("express");
const { Pool } = require("pg");
const { Registry, Histogram, collectDefaultMetrics } = require("prom-client");

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.PG_HOST || "172.20.0.10",
  port: parseInt(process.env.PG_PORT || "5432"),
  user: process.env.PG_USER || "postgres",
  database: process.env.PG_DATABASE || "postgres",
  max: 10,
});

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

const register = new Registry();
collectDefaultMetrics({ register });

const apiLatency = new Histogram({
  name: "api_request_duration_seconds",
  help: "Total API request duration in seconds",
  labelNames: ["method", "endpoint", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const dbLatency = new Histogram({
  name: "api_db_query_duration_seconds",
  help: "Database query duration from API in seconds",
  labelNames: ["endpoint"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Middleware: track total request latency
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  req._startTime = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path || req.path;
    // Skip /metrics and /health from latency tracking
    if (route === "/metrics" || route === "/health") return;
    const duration = Number(process.hrtime.bigint() - req._startTime) / 1e9;
    apiLatency.observe(
      { method: req.method, endpoint: route, status: res.statusCode },
      duration
    );
  });
  next();
});

// ---------------------------------------------------------------------------
// Helper: timed DB query
// ---------------------------------------------------------------------------

async function timedQuery(endpoint, sql, params = []) {
  const start = process.hrtime.bigint();
  const result = await pool.query(sql, params);
  const duration = Number(process.hrtime.bigint() - start) / 1e9;
  dbLatency.observe({ endpoint }, duration);
  return result;
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

app.get("/orders/by-customer", async (req, res) => {
  try {
    const cid = parseInt(req.query.customer_id) || 1;
    const result = await timedQuery(
      "/orders/by-customer",
      `SELECT o.id, o.quantity, o.created_at, o.status, i.name
       FROM orders o JOIN items i ON i.id = o.item_id
       WHERE o.customer_id = $1
       ORDER BY o.status ASC, o.created_at DESC
       LIMIT 20`,
      [cid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/items/count", async (_req, res) => {
  try {
    const result = await timedQuery(
      "/items/count",
      "SELECT count(*) AS count FROM items"
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/orders/summary", async (_req, res) => {
  try {
    const result = await timedQuery(
      "/orders/summary",
      "SELECT count(*) AS count FROM orders JOIN items ON items.id = orders.item_id LIMIT 1"
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/orders/totals", async (req, res) => {
  try {
    const cid = parseInt(req.query.customer_id) || 1;
    const result = await timedQuery(
      "/orders/totals",
      `SELECT
         count(*) AS order_count,
         sum(o.quantity * i.value) AS gross_total,
         sum(o.quantity * i.value * (1 - o.discount)) AS net_total
       FROM orders o
       JOIN items i ON i.id = o.item_id
       WHERE o.customer_id = $1`,
      [cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/items/avg-value", async (req, res) => {
  try {
    const from = parseInt(req.query.from) || 1;
    const to = parseInt(req.query.to) || 500;
    const result = await timedQuery(
      "/items/avg-value",
      "SELECT avg(value) AS avg_value FROM items WHERE id BETWEEN $1 AND $2",
      [from, to]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/items/top", async (_req, res) => {
  try {
    const result = await timedQuery(
      "/items/top",
      "SELECT name, value FROM items ORDER BY id LIMIT 50"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Write endpoints
// ---------------------------------------------------------------------------

app.post("/orders", async (req, res) => {
  try {
    const itemId = req.body.item_id || Math.floor(Math.random() * 1000) + 1;
    const customerId = req.body.customer_id || Math.floor(Math.random() * 10) + 1;
    const status = req.body.status || "pending";
    const quantity = req.body.quantity || Math.floor(Math.random() * 20) + 1;
    const result = await timedQuery(
      "/orders",
      "INSERT INTO orders (item_id, customer_id, status, quantity) VALUES ($1, $2, $3, $4) RETURNING id",
      [itemId, customerId, status, quantity]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/orders/:id/quantity", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await timedQuery(
      "/orders/:id/quantity",
      "UPDATE orders SET quantity = quantity + 1 WHERE id = $1 RETURNING id, quantity",
      [id]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "order not found" });
    } else {
      res.json(result.rows[0]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/orders/oldest", async (req, res) => {
  try {
    const after = parseInt(req.query.after) || 100;
    const result = await timedQuery(
      "/orders/oldest",
      "DELETE FROM orders WHERE id = (SELECT min(id) FROM orders WHERE id > $1) RETURNING id",
      [after]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "no matching order" });
    } else {
      res.json(result.rows[0]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health & metrics
// ---------------------------------------------------------------------------

app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT inet_server_addr() AS backend");
    res.json({ status: "healthy", backend: r.rows[0].backend });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "8080");
app.listen(PORT, () => {
  console.log(`app listening on port ${PORT}`);
});
