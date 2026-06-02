import { executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { APP_IP, APP_PORT, ORDERS_ROW_COUNT, SLOW_QUERY, QUERY_LATENCY_SLO_MS } from "../../../config.js";
import { sourcePsql } from "../../../clients/psql.js";

export const slowQueryTests: SimpleTest[] = [
  {
    id: "latency-within-slo",
    name: `Mean query execution time is below ${QUERY_LATENCY_SLO_MS}ms SLO`,
    description: "Query pg_stat_statements for the slow query and confirm mean_exec_time < SLO",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      await sourcePsql("SELECT pg_stat_statements_reset()");

      for (let i = 0; i < 5; i++) {
        await executeWithExitCode(
          `curl -sf "http://${APP_IP}:${APP_PORT}/orders/by-customer?customer_id=${(i % 10) + 1}"`,
          { silent: true },
        );
      }

      const { exitCode, output } = await sourcePsql(
        "SELECT mean_exec_time FROM pg_stat_statements WHERE query LIKE '%orders o JOIN items i%customer_id%ORDER BY%' AND query NOT LIKE '%pg_stat_statements%' ORDER BY mean_exec_time DESC LIMIT 1",
      );

      if (exitCode !== 0) {
        return { success: false, error: `Could not query pg_stat_statements: ${output}` };
      }

      const meanTime = parseFloat(output.trim());
      if (isNaN(meanTime)) {
        return { success: false, error: `Could not parse mean_exec_time: ${output}` };
      }

      logger.info(`Mean execution time: ${meanTime.toFixed(2)}ms (SLO: ${QUERY_LATENCY_SLO_MS}ms)`);

      if (meanTime > QUERY_LATENCY_SLO_MS) {
        return {
          success: false,
          score: Math.max(0, 1 - (meanTime - QUERY_LATENCY_SLO_MS) / QUERY_LATENCY_SLO_MS),
          error: `Mean exec time ${meanTime.toFixed(2)}ms exceeds ${QUERY_LATENCY_SLO_MS}ms SLO`,
        };
      }

      return { success: true };
    },
  },

  {
    id: "index-exists",
    name: "Appropriate index exists on orders table for the slow query",
    description: "Check that an index covering customer_id exists on orders",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await sourcePsql(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'orders'",
      );

      if (exitCode !== 0) {
        return { success: false, error: `Could not query pg_indexes: ${output}` };
      }

      const indexDefs = output.trim().split("\n").filter(Boolean);
      logger.info(`Found ${indexDefs.length} indexes on orders: ${indexDefs.join(" | ")}`);

      const hasCustomerIndex = indexDefs.some(
        (def) => def.includes("customer_id") && !def.includes("orders_pkey"),
      );

      if (!hasCustomerIndex) {
        return { success: false, error: "No index on customer_id found on orders table" };
      }

      return { success: true };
    },
  },

  {
    id: "explain-uses-index",
    name: "EXPLAIN shows Index Scan (not Seq Scan) for the slow query",
    description: "Run EXPLAIN (FORMAT JSON) and confirm the plan uses Index Scan",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await sourcePsql(`EXPLAIN (FORMAT JSON) ${SLOW_QUERY}`);

      if (exitCode !== 0) {
        return { success: false, error: `EXPLAIN failed: ${output}` };
      }

      const plan = output.toLowerCase();

      if (plan.includes('"node type": "seq scan"') && plan.includes('"relation name": "orders"')) {
        return { success: false, error: "Query plan contains Seq Scan on orders table" };
      }

      const hasIndexScan =
        (plan.includes('"node type": "index scan"') ||
          plan.includes('"node type": "index only scan"') ||
          plan.includes('"node type": "bitmap index scan"')) &&
        plan.includes('"relation name": "orders"');

      const hasBitmapScan =
        plan.includes('"node type": "bitmap heap scan"') &&
        plan.includes('"relation name": "orders"');

      if (!hasIndexScan && !hasBitmapScan) {
        logger.info(`Plan output (first 500 chars): ${output.slice(0, 500)}`);
        return { success: false, error: "Query plan does not show Index Scan on orders table" };
      }

      return { success: true };
    },
  },

  {
    id: "api-functional",
    name: "API service endpoints are functional",
    description: "All API endpoints return 200, confirms no regression",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const endpoints = [
        `http://${APP_IP}:${APP_PORT}/health`,
        `http://${APP_IP}:${APP_PORT}/items/count`,
        `http://${APP_IP}:${APP_PORT}/orders/summary`,
        `http://${APP_IP}:${APP_PORT}/orders/by-customer?customer_id=1`,
        `http://${APP_IP}:${APP_PORT}/orders/recent?status=pending&minutes=60`,
        `http://${APP_IP}:${APP_PORT}/items/top`,
      ];

      for (const url of endpoints) {
        const { exitCode } = await executeWithExitCode(`curl -sf "${url}"`, { silent: true });
        if (exitCode !== 0) {
          return { success: false, error: `API endpoint failed: ${url}` };
        }
      }

      logger.info("All API endpoints returned 200");
      return { success: true };
    },
  },

  {
    id: "row-count-unchanged",
    name: "Orders table row count is unchanged after fix",
    description: `Confirms the fix didn't delete rows, count should be >= ${ORDERS_ROW_COUNT * 0.95}`,
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await sourcePsql("SELECT count(*) FROM orders");

      if (exitCode !== 0) {
        return { success: false, error: `Could not count orders: ${output}` };
      }

      const count = parseInt(output.trim(), 10);
      if (isNaN(count)) {
        return { success: false, error: `Could not parse count: ${output}` };
      }

      logger.info(`Orders count: ${count} (expected >= ${ORDERS_ROW_COUNT})`);

      if (count < ORDERS_ROW_COUNT * 0.95) {
        return {
          success: false,
          error: `Orders count ${count} is significantly below expected ${ORDERS_ROW_COUNT}. Fix may have deleted data.`,
        };
      }

      return { success: true };
    },
  },
];
