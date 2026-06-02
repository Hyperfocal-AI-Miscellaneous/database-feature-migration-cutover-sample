import type { Logger, SimpleTest, SimpleTestResult } from "@hyperfocal/env-base";
import { executeWithExitCode } from "@hyperfocal/env-base";
import { GITEA_IP, GITEA_ADMIN_USER, GITEA_ADMIN_PASS, GITEA_REPO_NAME, GITEA_RUNNER_CONTAINER, SOURCE_CONTAINER } from "../../config.js";
import { pollUntil } from "../../clients/poll.js";
import { giteaApiGet } from "../../clients/gitea.js";

const CICD_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

export const cicdTests: SimpleTest[] = [
  {
    id: "gitea-reachable",
    name: "Gitea is reachable and healthy",
    description: "GET http://gitea:3000/api/v1/version returns 200",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const { status, body } = await giteaApiGet("/version");
            if (status !== 200) {
              lastError = `HTTP ${status}`;
              return false;
            }
            try {
              const parsed = JSON.parse(body);
              if (!parsed.version) {
                lastError = `No version field in response`;
                return false;
              }
              logger.info(`Gitea version: ${parsed.version}`);
            } catch {
              lastError = `Could not parse response: ${body}`;
              return false;
            }
            return true;
          },
          CICD_TIMEOUT_MS,
          POLL_INTERVAL_MS,
          "Gitea healthy"
        );
        return { success: true };
      } catch {
        return { success: false, error: `Gitea not reachable: ${lastError}` };
      }
    },
  },

  {
    id: "app-repo-exists",
    name: "Application repository exists in Gitea with commits",
    description: "Gitea API confirms the app repo exists and has at least one commit",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const { status, body } = await giteaApiGet(
              `/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}`
            );
            if (status !== 200) {
              lastError = `HTTP ${status}`;
              return false;
            }
            try {
              const repo = JSON.parse(body);
              if (!repo.full_name) {
                lastError = "Repo response missing full_name";
                return false;
              }
              logger.info(`Repo: ${repo.full_name}, default_branch: ${repo.default_branch}`);
            } catch {
              lastError = `Could not parse response: ${body}`;
              return false;
            }
            return true;
          },
          CICD_TIMEOUT_MS,
          POLL_INTERVAL_MS,
          "App repo exists"
        );

        const { status, body } = await giteaApiGet(
          `/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/commits?limit=1`
        );
        if (status !== 200) {
          return { success: false, error: `Could not list commits: HTTP ${status}` };
        }
        const commits = JSON.parse(body);
        if (!Array.isArray(commits) || commits.length === 0) {
          return { success: false, error: "Repository has no commits" };
        }
        logger.info(`Latest commit: ${commits[0].commit?.message?.split("\n")[0]}`);
        return { success: true };
      } catch {
        return { success: false, error: `App repo check failed: ${lastError}` };
      }
    },
  },

  {
    id: "runner-online",
    name: "Gitea Actions runner container is running",
    description: "The gitea-runner container is running and able to execute pipelines",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await executeWithExitCode(
        `docker ps --filter "name=${GITEA_RUNNER_CONTAINER}" --format "{{.Status}}"`,
        { silent: true }
      );
      if (result.exitCode !== 0 || !result.output.trim()) {
        return { success: false, error: `Runner container not found or not running` };
      }
      const status = result.output.trim();
      if (!status.startsWith("Up")) {
        return { success: false, error: `Runner container status: ${status}` };
      }
      logger.info(`Runner container status: ${status}`);
      return { success: true };
    },
  },

  {
    id: "pipeline-green",
    name: "Most recent CI pipeline run is green",
    description: "Commit status for HEAD of main branch shows success",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      let lastError = "";
      try {
        await pollUntil(
          async () => {
            const { status, body } = await giteaApiGet(
              `/repos/${GITEA_ADMIN_USER}/${GITEA_REPO_NAME}/commits/main/status`
            );
            if (status !== 200) {
              lastError = `HTTP ${status}`;
              return false;
            }
            try {
              const data = JSON.parse(body);
              const state = data.state;
              if (state === "success") {
                logger.info("Pipeline state: success");
                return true;
              }
              if (state === "failure" || state === "error") {
                lastError = `Pipeline state is '${state}'`;
                return false;
              }
              lastError = `Pipeline state is '${state}' (waiting for completion)`;
              return false;
            } catch {
              lastError = `Could not parse status response`;
              return false;
            }
          },
          5 * 60_000,
          10_000,
          "Pipeline green"
        );
        return { success: true };
      } catch {
        return { success: false, error: `Pipeline not green: ${lastError}` };
      }
    },
  },

  {
    id: "migrations-applied",
    name: "All expected migrations are applied in the database",
    description: "Query schema_migrations table to confirm migrations 1 and 2 are applied",
    run: async (logger: Logger): Promise<SimpleTestResult> => {
      const result = await executeWithExitCode(
        `docker exec ${SOURCE_CONTAINER} su - postgres -c "psql -tAc 'SELECT version FROM schema_migrations ORDER BY version'"`,
        { silent: true }
      );

      if (result.exitCode !== 0) {
        logger.info("schema_migrations not found, checking tables and indexes directly");

        const tablesResult = await executeWithExitCode(
          `docker exec ${SOURCE_CONTAINER} su - postgres -c "psql -tAc \\"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\\""`,
          { silent: true }
        );
        if (tablesResult.exitCode !== 0) {
          return { success: false, error: `Could not query tables: ${tablesResult.output}` };
        }

        const tables = tablesResult.output.trim().split("\n").filter(Boolean);
        if (!tables.includes("items") || !tables.includes("orders")) {
          return { success: false, error: `Missing expected tables. Found: ${tables.join(", ")}` };
        }

        const indexResult = await executeWithExitCode(
          `docker exec ${SOURCE_CONTAINER} su - postgres -c "psql -tAc \\"SELECT indexname FROM pg_indexes WHERE tablename='orders'\\""`,
          { silent: true }
        );
        if (indexResult.exitCode !== 0) {
          return { success: false, error: `Could not query indexes: ${indexResult.output}` };
        }

        const indexes = indexResult.output.trim().split("\n").filter(Boolean);
        const hasCustomerIndex = indexes.some(idx =>
          idx.includes("customer") || idx.includes("status") || idx.includes("created")
        );

        if (!hasCustomerIndex) {
          return { success: false, error: `No customer/status/created index found. Indexes: ${indexes.join(", ")}` };
        }

        logger.info(`Tables: ${tables.join(", ")}, Indexes on orders: ${indexes.join(", ")}`);
        return { success: true };
      }

      const versions = result.output.trim().split("\n").filter(Boolean).map(Number);
      logger.info(`Applied migrations: ${versions.join(", ")}`);

      if (!versions.includes(1) || !versions.includes(2)) {
        return { success: false, error: `Expected migrations 1 and 2, found: ${versions.join(", ")}` };
      }

      return { success: true };
    },
  },
];
