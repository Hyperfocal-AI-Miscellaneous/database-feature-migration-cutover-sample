import {
  type EnvironmentDefinition,
  type Logger,
  type Problem,
  type TestResult,
  ConsoleLogger,
  loadProblemsFromDirectory,
  runSimpleTests,
} from "@hyperfocal/env-base";
import * as path from "path";
import { fileURLToPath } from "url";
import { setupProblem } from "./setup/index.js";
import { cleanupSandbox } from "./setup/cleanup.js";
import {
  type McpRuntime,
  newMcpRuntime,
  problemHasMcp,
  setupMcpServicesForProblem,
  cleanupMcpServices,
} from "./setup/mcp.js";
import { tests as postgresTests } from "./graders/grader.js";
import { getRegistryEntry } from "./graders/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE_DIR = path.resolve(__dirname, "..", "..", "workspace");
const ENVIRONMENT_ROOT = path.resolve(__dirname, "..");

const problems = loadProblemsFromDirectory(path.join(__dirname, ".."));

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
    const sandboxVariant = entry?.postgres;
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
    const tests = entry ? entry.build({ mcp: this.mcp }) : postgresTests;
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
