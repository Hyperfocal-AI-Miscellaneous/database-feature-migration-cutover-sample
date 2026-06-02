import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { executeWithExitCode } from "@hyperfocal/env-base";
import { PROMETHEUS_IP, GRAFANA_IP, SOURCE_CONTAINER } from "../../config.js";
import { pollUntil } from "../../clients/poll.js";
import { httpGet } from "../../clients/http.js";

const OBSERVABILITY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

export const observabilityTests: SimpleTest[] = [
  {
    id: "prometheus-reachable",
    name: "Prometheus is reachable and healthy",
    description: "GET http://prometheus:9090/-/healthy returns 200",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const { status } = await httpGet(`http://${PROMETHEUS_IP}:9090/-/healthy`);
            if (status !== 200) {
              lastError = `HTTP ${status}`;
              return false;
            }
            return true;
          },
          OBSERVABILITY_TIMEOUT_MS,
          POLL_INTERVAL_MS,
          "Prometheus healthy"
        );
        return { success: true };
      } catch {
        return { success: false, error: `Prometheus not reachable: ${lastError}` };
      }
    },
  },

  {
    id: "postgres-exporter-up",
    name: "Prometheus is scraping postgres_exporter successfully",
    description: "Prometheus target for postgres_exporter shows state=up",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const { status, body } = await httpGet(
              `http://${PROMETHEUS_IP}:9090/api/v1/query?query=up%7Bjob%3D%22postgres_exporter%22%7D`
            );
            if (status !== 200) {
              lastError = `HTTP ${status}`;
              return false;
            }
            const data = JSON.parse(body);
            const results = data?.data?.result;
            if (!results || results.length === 0) {
              lastError = "No results for up{job='postgres_exporter'}";
              return false;
            }
            const value = results[0]?.value?.[1];
            if (value !== "1") {
              lastError = `Target value is ${value}, expected 1`;
              return false;
            }
            return true;
          },
          OBSERVABILITY_TIMEOUT_MS,
          POLL_INTERVAL_MS,
          "postgres_exporter target up"
        );
        return { success: true };
      } catch {
        return { success: false, error: `postgres_exporter not up in Prometheus: ${lastError}` };
      }
    },
  },

  {
    id: "grafana-reachable",
    name: "Grafana is reachable and healthy",
    description: "GET http://grafana:3000/api/health returns database ok",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const { status, body } = await httpGet(`http://${GRAFANA_IP}:3000/api/health`);
            if (status !== 200) {
              lastError = `HTTP ${status}`;
              return false;
            }
            try {
              const parsed = JSON.parse(body);
              if (parsed.database !== "ok") {
                lastError = `database field is "${parsed.database}", expected "ok"`;
                return false;
              }
            } catch {
              lastError = `Could not parse response: ${body}`;
              return false;
            }
            return true;
          },
          OBSERVABILITY_TIMEOUT_MS,
          POLL_INTERVAL_MS,
          "Grafana healthy"
        );
        return { success: true };
      } catch {
        return { success: false, error: `Grafana not reachable: ${lastError}` };
      }
    },
  },

  {
    id: "dashboard-provisioned",
    name: "At least one Grafana dashboard is provisioned",
    description: "Grafana API returns at least one dashboard via /api/search",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const { status, body } = await httpGet(`http://${GRAFANA_IP}:3000/api/search?type=dash-db`);
            if (status !== 200) {
              lastError = `HTTP ${status}`;
              return false;
            }
            try {
              const dashboards = JSON.parse(body);
              if (!Array.isArray(dashboards) || dashboards.length === 0) {
                lastError = "No dashboards found";
                return false;
              }
              logger.info(`Found ${dashboards.length} dashboard(s): ${dashboards.map((d: any) => d.title).join(", ")}`);
            } catch {
              lastError = `Could not parse response: ${body}`;
              return false;
            }
            return true;
          },
          OBSERVABILITY_TIMEOUT_MS,
          POLL_INTERVAL_MS,
          "Dashboard provisioned"
        );
        return { success: true };
      } catch {
        return { success: false, error: `No dashboards provisioned: ${lastError}` };
      }
    },
  },

  {
    id: "pg-stat-statements-active",
    name: "pg_stat_statements has collected query statistics",
    description: "SELECT count(*) FROM pg_stat_statements returns > 0 on source DB",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const result = await executeWithExitCode(
              `docker exec ${SOURCE_CONTAINER} su - postgres -c "psql -tAc 'SELECT count(*) FROM pg_stat_statements'"`,
              { silent: true }
            );
            if (result.exitCode !== 0) {
              lastError = `psql failed (exit ${result.exitCode}): ${result.output}`;
              return false;
            }
            const count = parseInt(result.output.trim(), 10);
            if (isNaN(count) || count <= 0) {
              lastError = `pg_stat_statements count is ${result.output.trim()}, expected > 0`;
              return false;
            }
            logger.info(`pg_stat_statements has ${count} entries`);
            return true;
          },
          OBSERVABILITY_TIMEOUT_MS,
          POLL_INTERVAL_MS,
          "pg_stat_statements active"
        );
        return { success: true };
      } catch {
        return { success: false, error: `pg_stat_statements not active: ${lastError}` };
      }
    },
  },
];
