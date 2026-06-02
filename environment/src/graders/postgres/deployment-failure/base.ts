import { executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import {
  APP_IP,
  APP_PORT,
  GITEA_IP,
  GITEA_ADMIN_USER,
  GITEA_ADMIN_PASS,
  GITEA_REPO_NAME,
  ORDERS_ROW_COUNT,
  SOURCE_CONTAINER,
} from "../../../config.js";
import { sourcePsql } from "../../../clients/psql.js";

export const deploymentFailureTests: SimpleTest[] = [
  {
    id: "api-returns-correct-totals",
    name: "API returns correct order totals matching seed formula",
    description: "Computes expected totals from seed formula and compares to API response",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const apiResult = await executeWithExitCode(
        `curl -sf "http://${APP_IP}:${APP_PORT}/orders/totals?customer_id=1"`,
        { silent: true },
      );
      if (apiResult.exitCode !== 0) {
        return { success: false, error: `API call failed: ${apiResult.output}` };
      }

      let data: any;
      try {
        data = JSON.parse(apiResult.output);
      } catch {
        return { success: false, error: `Could not parse API response: ${apiResult.output}` };
      }

      const grossTotal = parseFloat(data.gross_total);
      const netTotal = parseFloat(data.net_total);

      if (isNaN(grossTotal) || isNaN(netTotal)) {
        return {
          success: false,
          error: `Invalid totals: gross=${data.gross_total}, net=${data.net_total}`,
        };
      }

      const expectedGross = await getExpectedGrossTotal(1);
      if (expectedGross === null) {
        return { success: false, error: "Could not compute expected totals from seed formula" };
      }

      logger.info(`API: gross=${grossTotal}, net=${netTotal}. Expected gross=${expectedGross}`);

      const grossTolerance = expectedGross * 0.02;
      if (Math.abs(grossTotal - expectedGross) > grossTolerance) {
        const pctOff = (((grossTotal - expectedGross) / expectedGross) * 100).toFixed(1);
        return {
          success: false,
          error: `gross_total (${grossTotal}) differs from expected (${expectedGross}) by ${pctOff}%, item values may be corrupted`,
        };
      }

      const netTolerance = grossTotal * 0.001;
      if (Math.abs(grossTotal - netTotal) > netTolerance) {
        const discountPct = ((1 - netTotal / grossTotal) * 100).toFixed(1);
        return {
          success: false,
          error: `net_total (${netTotal}) differs from gross_total (${grossTotal}) by ~${discountPct}%, phantom discounts present`,
        };
      }

      return { success: true };
    },
  },

  {
    id: "data-integrity-restored",
    name: "Order discounts and item values are in correct state",
    description: "DB-level check: no phantom discounts, item values match seed formula",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const discountResult = await sourcePsql("SELECT count(*) FROM orders WHERE discount != 0");
      if (discountResult.exitCode !== 0) {
        return { success: false, error: `DB query failed: ${discountResult.output}` };
      }
      const badDiscounts = parseInt(discountResult.output.trim(), 10);
      if (badDiscounts > 0) {
        logger.info(`Orders with non-zero discount: ${badDiscounts}`);
        return { success: false, error: `${badDiscounts} orders have non-zero discount values` };
      }

      const valueResult = await executeWithExitCode(
        `docker exec ${SOURCE_CONTAINER} su - postgres -c "psql -tAc \\"SELECT count(*) FROM items WHERE value != (id * 7) % 1000 AND name NOT LIKE '%_hf_cdc_marker_%'\\""`,
        { silent: true },
      );
      if (valueResult.exitCode !== 0) {
        return { success: false, error: `Could not check item values: ${valueResult.output}` };
      }
      const badValues = parseInt(valueResult.output.trim(), 10);
      if (badValues > 0) {
        logger.info(`Items with incorrect values: ${badValues}`);
        return {
          success: false,
          error: `${badValues} items have values that don't match expected formula`,
        };
      }

      logger.info("All discounts are 0, all item values match seed formula");
      return { success: true };
    },
  },

  {
    id: "pipeline-green-after-fix",
    name: "Latest CI pipeline run is successful",
    description: "The fix was deployed through the CI/CD pipeline, not applied directly to the DB",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await executeWithExitCode(
        `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" "http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/commits/main/status"`,
        { silent: true },
      );
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not check pipeline status: ${result.output}` };
      }

      let data: any;
      try {
        data = JSON.parse(result.output);
      } catch {
        return { success: false, error: `Could not parse status response: ${result.output}` };
      }

      logger.info(`Pipeline state: ${data.state}`);

      if (data.state !== "success") {
        return {
          success: false,
          error: `Pipeline state is '${data.state}', expected 'success'`,
        };
      }

      const commitsResult = await executeWithExitCode(
        `curl -sf -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" "http://${GITEA_IP}:3000/api/v1/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/commits?limit=5"`,
        { silent: true },
      );
      if (commitsResult.exitCode === 0) {
        try {
          const commits = JSON.parse(commitsResult.output);
          logger.info(`Latest commit: ${commits[0]?.commit?.message?.split("\n")[0]}`);
          logger.info(`Total commits: ${commits.length}+`);
        } catch {
          /* non-critical */
        }
      }

      return { success: true };
    },
  },

  {
    id: "no-data-loss",
    name: "Orders and items table row counts are preserved",
    description: "Fix must not delete rows",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const ordersResult = await sourcePsql("SELECT count(*) FROM orders");
      if (ordersResult.exitCode !== 0) {
        return { success: false, error: `Could not count orders: ${ordersResult.output}` };
      }
      const orderCount = parseInt(ordersResult.output.trim(), 10);

      const itemsResult = await sourcePsql("SELECT count(*) FROM items");
      if (itemsResult.exitCode !== 0) {
        return { success: false, error: `Could not count items: ${itemsResult.output}` };
      }
      const itemCount = parseInt(itemsResult.output.trim(), 10);

      logger.info(
        `Orders: ${orderCount} (expected >= ${ORDERS_ROW_COUNT}), Items: ${itemCount} (expected 1000)`,
      );

      if (orderCount < ORDERS_ROW_COUNT * 0.95) {
        return {
          success: false,
          error: `Orders count ${orderCount} below expected ${ORDERS_ROW_COUNT}`,
        };
      }
      if (itemCount < 1000) {
        return { success: false, error: `Items count ${itemCount} below expected 1000` };
      }

      return { success: true };
    },
  },

  {
    id: "migrations-sequential",
    name: "Corrective migration applied through pipeline",
    description: "schema_migrations shows the bad migration(s) plus a corrective one applied after",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await sourcePsql("SELECT version FROM schema_migrations ORDER BY version");
      if (result.exitCode !== 0) {
        return { success: false, error: `Could not query schema_migrations: ${result.output}` };
      }

      const versions = result.output.trim().split("\n").filter(Boolean).map(Number);
      logger.info(`Applied migrations: ${versions.join(", ")}`);

      if (!versions.includes(1) || !versions.includes(2)) {
        return { success: false, error: `Missing base migrations. Found: ${versions.join(", ")}` };
      }

      const beyondBase = versions.filter((v) => v > 2);
      if (beyondBase.length === 0) {
        return { success: true };
      }

      const setupMigrations = versions.includes(5) ? [3, 4, 5] : [3];
      const maxSetupMigration = Math.max(...setupMigrations);

      const corrective = versions.filter((v) => v > maxSetupMigration);
      if (corrective.length === 0) {
        return {
          success: false,
          error: `Setup migrations present (${setupMigrations.join(", ")}) but no corrective migration found after version ${maxSetupMigration}. Found: ${versions.join(", ")}`,
        };
      }

      for (let i = 1; i < versions.length; i++) {
        if (versions[i] <= versions[i - 1]) {
          return { success: false, error: `Migrations not in order: ${versions.join(", ")}` };
        }
      }

      logger.info(`Corrective migration(s): ${corrective.join(", ")}`);
      return { success: true };
    },
  },
];

async function getExpectedGrossTotal(customerId: number): Promise<number | null> {
  const result = await sourcePsql(
    `SELECT sum(o.quantity * ((o.item_id * 7) % 1000)) FROM orders o WHERE o.customer_id = ${customerId}`,
  );
  if (result.exitCode !== 0) return null;
  const val = parseInt(result.output.trim(), 10);
  return isNaN(val) ? null : val;
}
