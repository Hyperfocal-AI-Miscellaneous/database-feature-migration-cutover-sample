import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { sourcePsql, targetPsql } from "../clients/psql.js";

export const tests: SimpleTest[] = [
  {
    id: "stale-replication-slot-cleaned",
    name: "Stale replication slot from prior cutover was cleaned up",
    weight: 3,
    description:
      "Setup plants 'abandoned_cutover_slot' on source; agent should drop it during pre-flight.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await sourcePsql(
        "SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'abandoned_cutover_slot'"
      );
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not query pg_replication_slots on source: ${result.output}` };
      }
      if (result.output.trim() === "") {
        logger.info("'abandoned_cutover_slot' is absent — agent dropped the stale slot");
        return { success: true };
      }
      return {
        success: false,
        error:
          `'abandoned_cutover_slot' is still present on source after rollout. ` +
          `The agent didn't drop the stale replication slot during pre-flight. ` +
          `Logical replication slots retain WAL indefinitely; leaving one means ` +
          `source disk pressure grows unboundedly until someone notices and cleans up. ` +
          `Fix: \`SELECT pg_drop_replication_slot('abandoned_cutover_slot')\` on source ` +
          `before starting the cutover.`,
      };
    },
  },

  {
    id: "subscription-dropped-after-cutover",
    name: "Agent's subscription on target was dropped after cutover",
    weight: 3,
    description:
      "pg_subscription on target is empty (disabling alone is not sufficient — the slot on source persists).",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await targetPsql("SELECT count(*) FROM pg_subscription");
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not query pg_subscription on target: ${result.output}` };
      }
      const count = parseInt(result.output.trim(), 10);
      if (isNaN(count)) {
        return { success: false, error: `Could not parse subscription count: ${result.output}` };
      }
      if (count === 0) {
        logger.info("No subscriptions remain on target — agent dropped subscription cleanly");
        return { success: true };
      }
      const detail = await targetPsql(
        "SELECT subname || '|' || subenabled::text FROM pg_subscription"
      );
      return {
        success: false,
        error:
          `Target still has ${count} subscription(s) after cutover: ${detail.output.trim()}. ` +
          `After cutover completes, the agent should run \`DROP SUBSCRIPTION <subname>\` ` +
          `on target to: (a) stop consuming source's WAL, (b) release the corresponding ` +
          `slot on source so WAL can be reclaimed, (c) prevent split-brain replay if any ` +
          `writes leak back to source. Disabling the subscription isn't sufficient — the ` +
          `slot on source persists.`,
      };
    },
  },

  // Symmetric to subscription-dropped-after-cutover: publication on source is an
  // independent catalog object and survives subscription drop on target.
  {
    id: "publication-dropped-on-source",
    name: "Publication on source was dropped after cutover",
    weight: 3,
    description: "pg_publication on source is empty.",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await sourcePsql("SELECT count(*) FROM pg_publication");
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not query pg_publication on source: ${result.output}` };
      }
      const count = parseInt(result.output.trim(), 10);
      if (isNaN(count)) {
        return { success: false, error: `Could not parse publication count: ${result.output}` };
      }
      if (count === 0) {
        logger.info("No publications remain on source — agent dropped publication cleanly");
        return { success: true };
      }
      const detail = await sourcePsql("SELECT pubname FROM pg_publication");
      return {
        success: false,
        error:
          `Source still has ${count} publication(s) after cutover: ${detail.output.trim()}. ` +
          `After cutover, the agent should run \`DROP PUBLICATION <pubname>\` on source. ` +
          `Dropping the subscription on target is not sufficient — the publication is an ` +
          `independent catalog object on source and persists until explicitly dropped.`,
      };
    },
  },
];
