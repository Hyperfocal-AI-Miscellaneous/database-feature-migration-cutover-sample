import * as path from "path";
import { fileURLToPath } from "url";
import { execute, executeWithExitCode } from "@hyperfocal/env-base";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const COMPOSE_DIR = path.resolve(__dirname, "..", "..", "..", "sandbox", "docker");
const COMPOSE_FILE = path.join(COMPOSE_DIR, "docker-compose.yml");

export interface DockerComposeOptions {
  silent?: boolean;
  timeout?: number;
}

export async function dockerCompose(
  args: string,
  opts: DockerComposeOptions = {},
): Promise<string> {
  return execute(
    `docker-compose -f "${COMPOSE_FILE}" ${args}`,
    { silent: opts.silent ?? true, timeout: opts.timeout },
  );
}

export async function dockerComposeWithExitCode(
  args: string,
  opts: DockerComposeOptions = {},
) {
  return executeWithExitCode(
    `docker-compose -f "${COMPOSE_FILE}" ${args}`,
    { silent: opts.silent ?? true, timeout: opts.timeout },
  );
}
