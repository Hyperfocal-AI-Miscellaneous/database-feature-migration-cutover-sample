import {
  type EnvironmentDefinition,
  type Logger,
  type Problem,
  type PromptTemplateValues,
  type TestResult,
  ConsoleLogger,
  generateSchemaDescription,
  loadProblemsFromDirectory,
  loadSchema,
  runSimpleTests,
} from "@hyperfocal/env-base";
import * as path from "path";
import { fileURLToPath } from "url";
import * as cfg from "./config.js";
import { setupProblem } from "./setup/index.js";
import { cleanupSandbox } from "./setup/cleanup.js";
import {
  type McpRuntime,
  newMcpRuntime,
  problemHasMcp,
  setupMcpServicesForProblem,
  cleanupMcpServices,
} from "./setup/mcp.js";
import { getTestsForProblem } from "./graders/postgres/index.js";
import { getRegistryEntry, isPurePostgresProblem } from "./graders/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE_DIR = path.resolve(__dirname, "..", "..", "workspace");
const ENVIRONMENT_ROOT = path.resolve(__dirname, "..");

const problems = loadProblemsFromDirectory(
  path.join(__dirname, ".."),
  buildPromptTemplateValues(),
);

class Environment implements EnvironmentDefinition {
  private mcp: McpRuntime = newMcpRuntime();
  private sandboxUp = false;

  async listProblems(): Promise<Problem[]> {
    return problems;
  }

  async setupProblem(problemId?: string, logger?: Logger): Promise<void> {
    const log = logger ?? new ConsoleLogger();
    const problem = problems.find((p) => p.id === problemId);

    const entry = problemId ? getRegistryEntry(problemId) : undefined;
    const sandboxVariant =
      entry?.postgres ??
      (isPurePostgresProblem(problemId) ? problemId : undefined);
    if (sandboxVariant) {
      await setupProblem(log, sandboxVariant);
      this.sandboxUp = true;
    } else if (!problem) {
      await setupProblem(log, problemId);
      this.sandboxUp = true;
    }

    if (problem && problemHasMcp(problem)) {
      this.mcp = await setupMcpServicesForProblem({
        problem,
        environmentRoot: ENVIRONMENT_ROOT,
        workspace: WORKSPACE_DIR,
        logger: log,
      });
    }
  }

  async runTests(problemId: string, logger: Logger): Promise<TestResult[]> {
    const entry = getRegistryEntry(problemId);
    if (entry) {
      const tests = entry.build({ mcp: this.mcp });
      logger.info(`Running ${tests.length} registered tests for '${problemId}'`);
      return runSimpleTests(tests, logger);
    }
    const tests = getTestsForProblem(problemId);
    logger.info(`Running ${tests.length} tests for problem '${problemId}'`);
    return runSimpleTests(tests, logger);
  }

  async cleanup(logger?: Logger): Promise<void> {
    const log = logger ?? new ConsoleLogger();

    await cleanupMcpServices({
      runtime: this.mcp,
      workspace: WORKSPACE_DIR,
      logger: log,
    });
    this.mcp = newMcpRuntime();

    if (this.sandboxUp) {
      await cleanupSandbox(log);
      this.sandboxUp = false;
    } else {
      log.info("Skipping Postgres sandbox teardown (sandbox was not started)");
    }
  }
}

export default new Environment();

function buildPromptTemplateValues(): PromptTemplateValues {
  const schema = loadSchema(path.join(ENVIRONMENT_ROOT, "manifest-schema.json"));
  return {
    apiHost: `${cfg.APP_IP}:${cfg.APP_PORT}`,
    pgHost: `${cfg.SOURCE_IP}:5432`,
    grafanaHost: `${cfg.GRAFANA_IP}:3000`,
    prometheusHost: `${cfg.PROMETHEUS_IP}:9090`,
    giteaHost: `${cfg.GITEA_IP}:3000`,
    sourceIp: cfg.SOURCE_IP,
    targetIp: cfg.TARGET_IP,
    workloadIp: cfg.WORKLOAD_IP,
    sourceContainer: cfg.SOURCE_CONTAINER,
    targetContainer: cfg.TARGET_CONTAINER,
    workloadContainer: cfg.WORKLOAD_CONTAINER,
    giteaUser: cfg.GITEA_ADMIN_USER,
    giteaRepo: `${cfg.GITEA_ADMIN_USER}/${cfg.GITEA_REPO_NAME}`,
    deployRepo: cfg.DEPLOY_REPO,
    pgVersion: cfg.PG_VERSION,
    manifestDoc: generateSchemaDescription(schema),
  };
}
