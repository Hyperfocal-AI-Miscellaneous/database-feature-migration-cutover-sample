import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { SEED_ROW_COUNT } from "../config.js";
import { sourcePsql, targetPsql } from "../clients/psql.js";

export const tests: SimpleTest[] = [
  {
    id: "data-items-migrated",
    name: "Items table migrated to target",
    weight: 5,
    description: `Score = items on target / ${SEED_ROW_COUNT} items on source`,
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const { exitCode, output } = await targetPsql(
        "SELECT count(*) FROM items WHERE name NOT LIKE $$_hf_cdc_marker_%$$"
      );
      if (exitCode !== 0) {
        return { success: false, score: 0, error: `Could not query items on target (exit ${exitCode}): ${output}` };
      }

      const targetCount = parseInt(output, 10);
      if (isNaN(targetCount) || targetCount === 0) {
        return { success: false, score: 0, error: `No items found on target` };
      }

      const score = Math.min(targetCount / SEED_ROW_COUNT, 1.0);
      const pct = (score * 100).toFixed(1);
      logger.info(`Items migrated: ${targetCount}/${SEED_ROW_COUNT} (${pct}%)`);

      // 99%+ rounds to a clean pass: the residual gap is post-snapshot drift
      // from concurrent workload writes, not an agent failure. Returning a
      // sub-1.0 score here would classify the result as "partially_passed".
      if (score >= 0.99) return { success: true };
      return { success: score >= 0.95, score, error: score < 0.95 ? `Only ${pct}% of items migrated (${targetCount}/${SEED_ROW_COUNT})` : undefined };
    },
  },

  {
    id: "data-orders-migrated",
    name: "Orders table migrated to target",
    weight: 5,
    description: "Score = orders on target / orders on source (proportional)",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const src = await sourcePsql("SELECT count(*) FROM orders");
      if (src.exitCode !== 0) {
        return { success: false, error: `Could not query orders on source (exit ${src.exitCode}): ${src.output}` };
      }
      const sourceCount = parseInt(src.output, 10);
      if (!Number.isFinite(sourceCount) || sourceCount === 0) {
        return { success: false, error: `Could not parse source orders count: ${src.output}` };
      }

      const { exitCode, output } = await targetPsql("SELECT count(*) FROM orders");
      if (exitCode !== 0) {
        return { success: false, score: 0, error: `Could not query orders on target (exit ${exitCode}): ${output}` };
      }

      const targetCount = parseInt(output, 10);
      if (isNaN(targetCount) || targetCount === 0) {
        return { success: false, score: 0, error: `No orders found on target` };
      }

      const score = Math.min(targetCount / sourceCount, 1.0);
      const pct = (score * 100).toFixed(1);
      logger.info(`Orders migrated: ${targetCount}/${sourceCount} (${pct}%)`);

      // See data-items-migrated above for why 99%+ is a clean pass.
      if (score >= 0.99) return { success: true };
      return { success: score >= 0.90, score, error: score < 0.90 ? `Only ${pct}% of orders migrated (${targetCount}/${sourceCount})` : undefined };
    },
  },

  {
    id: "data-values-consistent",
    name: "Item data values match between source and target",
    weight: 2,
    description: "MD5 hash of items table content matches source (proves data integrity, not just counts)",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const hashQuery = "SELECT md5(string_agg(name || value::text, ',' ORDER BY id)) FROM items WHERE name NOT LIKE $$_hf_cdc_marker_%$$";
      const src = await sourcePsql(hashQuery);
      if (src.exitCode !== 0) {
        return { success: false, error: `Could not hash source items: ${src.output}` };
      }
      const tgt = await targetPsql(hashQuery);
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not hash target items: ${tgt.output}` };
      }
      const srcVal = src.output.trim();
      const tgtVal = tgt.output.trim();
      logger.info(`Items hash, source: ${srcVal}, target: ${tgtVal}`);
      if (srcVal !== tgtVal) {
        return { success: false, error: `Data hash mismatch: source=${srcVal}, target=${tgtVal}` };
      }
      return { success: true };
    },
  },

  {
    id: "cdc-markers-replicated",
    name: "CDC markers written after setup are present on target",
    weight: 4,
    description: "Verifies that writes during agent work were replicated to target",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      // Source's CDC writer keeps writing AFTER cutover (it bypasses the
      // workload's endpoint by design — that's how this test catches
      // "agent only used pg_dump"). So sourceCount drifts upward post-cutover
      // while targetCount stops at the moment the agent dropped the
      // subscription. Comparing tgt/src always understates how well
      // replication worked. Use an absolute target count instead: any
      // meaningful number of replicated markers proves logical replication
      // ran. pg_dump-only agents have tgt=0; replicating agents have many.
      const tgt = await targetPsql(
        "SELECT count(*) FROM items WHERE name LIKE $$_hf_cdc_marker_%$$"
      );
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not query CDC markers on target: ${tgt.output}` };
      }
      const targetMarkerCount = parseInt(tgt.output, 10);
      // NaN slips past `=== 0` / `<` comparisons (NaN comparisons are always
      // false), so we'd return success:true with score:NaN. Reject explicitly.
      if (!Number.isFinite(targetMarkerCount)) {
        return { success: false, error: `Could not parse CDC marker count on target: ${tgt.output}` };
      }
      // Source count is informational only.
      const src = await sourcePsql(
        "SELECT count(*) FROM items WHERE name LIKE $$_hf_cdc_marker_%$$"
      );
      const sourceMarkerCount = src.exitCode === 0 ? parseInt(src.output, 10) : 0;
      logger.info(`CDC markers: ${targetMarkerCount} on target, ${sourceMarkerCount} on source (source drifts post-cutover; target is the signal)`);

      const PASS_AT = 5;          // replication clearly ran
      const FULL_CREDIT_AT = 15;  // enough markers to call it solid
      if (targetMarkerCount === 0) {
        return { success: false, error: `No CDC markers on target (${sourceMarkerCount} on source). Agent likely used pg_dump without ongoing replication.` };
      }
      if (targetMarkerCount < PASS_AT) {
        return { success: false, score: targetMarkerCount / FULL_CREDIT_AT, error: `Only ${targetMarkerCount} CDC markers on target — too few to confirm logical replication ran.` };
      }
      const score = Math.min(targetMarkerCount / FULL_CREDIT_AT, 1.0);
      return { success: true, score };
    },
  },
  {
    id: "schema-aligned-on-target",
    name: "Source and target schemas match on orders",
    weight: 4,
    description:
      "Target's `orders` has every column present on source's `orders`.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const cols = (output: string) =>
        output.split("\n").map((s) => s.trim()).filter(Boolean).sort();

      const src = await sourcePsql(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' ORDER BY column_name"
      );
      if (src.exitCode !== 0) {
        return { success: false, error: `Could not list source orders columns: ${src.output}` };
      }
      const tgt = await targetPsql(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' ORDER BY column_name"
      );
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not list target orders columns: ${tgt.output}` };
      }
      const srcCols = cols(src.output);
      const tgtCols = cols(tgt.output);
      const missing = srcCols.filter((c) => !tgtCols.includes(c));
      if (missing.length > 0) {
        return {
          success: false,
          error:
            `Target's orders is missing columns present on source: ${missing.join(", ")}. ` +
            `Logical replication does not auto-create schema — DDL must be replayed manually ` +
            `(eg. \`pg_dump --schema-only --table=orders\` on source, then apply to target ` +
            `BEFORE CREATE PUBLICATION/SUBSCRIPTION). Without this, replication fails silently ` +
            `(check pg_subscription_rel.srsubstate on target and target's log).`,
        };
      }
      logger.info(`Schema aligned: source and target both have ${srcCols.length} columns on orders`);
      return { success: true };
    },
  },

  // Only checks orders_id_seq: source's items_id_seq keeps advancing post-cutover
  // because the CDC marker worker writes directly to source's items.
  {
    id: "sequences-aligned-on-target",
    name: "Sequence values aligned on target after cutover",
    weight: 3,
    description:
      "Target's orders_id_seq.last_value is within SEQ_TOLERANCE of source's.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const SEQ_TOLERANCE = 500;
      const src = await sourcePsql(`SELECT last_value FROM orders_id_seq`);
      if (src.exitCode !== 0) {
        return { success: false, error: `Could not read orders_id_seq on source: ${src.output}` };
      }
      const tgt = await targetPsql(`SELECT last_value FROM orders_id_seq`);
      if (tgt.exitCode !== 0) {
        return { success: false, error: `Could not read orders_id_seq on target: ${tgt.output}` };
      }
      const srcVal = parseInt(src.output.trim(), 10);
      const tgtVal = parseInt(tgt.output.trim(), 10);
      if (isNaN(srcVal) || isNaN(tgtVal)) {
        return { success: false, error: `Could not parse orders_id_seq values: source=${src.output} target=${tgt.output}` };
      }
      if (tgtVal < srcVal - SEQ_TOLERANCE) {
        return {
          success: false,
          error:
            `orders_id_seq: target last_value (${tgtVal}) < source last_value (${srcVal}) by more than ${SEQ_TOLERANCE}. ` +
            `New INSERTs on target will collide with already-migrated rows. ` +
            `Fix: \`SELECT setval('orders_id_seq', (SELECT max(id)+10000 FROM orders))\` on target ` +
            `at cutover time (NOT after initial copy — source keeps advancing). Logical replication ` +
            `doesn't sync sequence state; manual sync with a safety margin is required.`,
        };
      }
      logger.info(`orders_id_seq: target=${tgtVal}, source=${srcVal} (within tolerance ${SEQ_TOLERANCE})`);
      return { success: true };
    },
  },
];
