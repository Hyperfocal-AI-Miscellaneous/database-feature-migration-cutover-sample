import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { sourcePsql } from "../../../clients/psql.js";

const RECENT_QUERY =
  "SELECT o.id, o.customer_id, o.quantity, o.created_at FROM orders o " +
  "WHERE o.status = 'pending' AND o.created_at > now() - interval '60 minutes' " +
  "ORDER BY o.created_at DESC LIMIT 50";

export const recentQueryIndexTest: SimpleTest = {
  id: "recent-query-index-exists",
  name: "Index on (status, created_at) exists for /orders/recent",
  description: "Check that an index covering status + created_at exists on orders",
  run: async (logger: Logger): Promise<SimpleTestResult> => {
    const { exitCode, output } = await sourcePsql(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'orders'",
    );

    if (exitCode !== 0) {
      return { success: false, error: `Could not query pg_indexes: ${output}` };
    }

    const indexDefs = output.trim().split("\n").filter(Boolean);
    logger.info(`Indexes on orders: ${indexDefs.join(" | ")}`);

    const hasStatusCreatedIndex = indexDefs.some(
      (def) => def.includes("status") && def.includes("created_at") && !def.includes("customer_id"),
    );

    if (!hasStatusCreatedIndex) {
      return { success: false, error: "No index on (status, created_at) found on orders table" };
    }

    return { success: true };
  },
};

export const recentQueryExplainTest: SimpleTest = {
  id: "recent-query-uses-index",
  name: "EXPLAIN shows Index Scan for /orders/recent query",
  description: "Run EXPLAIN on the recent orders query and confirm no Seq Scan on orders",
  run: async (_logger: Logger): Promise<SimpleTestResult> => {
    const { exitCode, output } = await sourcePsql(`EXPLAIN (FORMAT JSON) ${RECENT_QUERY}`);

    if (exitCode !== 0) {
      return { success: false, error: `EXPLAIN failed: ${output}` };
    }

    const plan = output.toLowerCase();

    if (plan.includes('"node type": "seq scan"') && plan.includes('"relation name": "orders"')) {
      return { success: false, error: "Recent orders query still uses Seq Scan on orders" };
    }

    return { success: true };
  },
};
