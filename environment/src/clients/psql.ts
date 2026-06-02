import { executeWithExitCode } from "@hyperfocal/env-base";
import { SOURCE_CONTAINER } from "../config.js";
import { sshExec, type SshResult } from "./ssh.js";

export interface PsqlResult {
  exitCode: number;
  output: string;
}

/**
 * Run a query on source via `docker exec`. Pipes the query in via
 * base64-decoded stdin so $$-quoted SQL, single quotes, newlines, etc.
 * survive intact (heredoc/`-c` quoting otherwise mangles them).
 */
export async function sourcePsql(query: string): Promise<PsqlResult> {
  const b64 = Buffer.from(query, "utf-8").toString("base64");
  return executeWithExitCode(
    `echo ${b64} | base64 -d | docker exec -i -u postgres ${SOURCE_CONTAINER} psql -U postgres -tA`,
    { silent: true },
  );
}

/**
 * Run a query on target via ssh. Same base64-stdin trick as sourcePsql —
 * the base64 alphabet has no shell-special characters so nothing the
 * caller writes can break out through ssh + sh -c.
 */
export async function targetPsql(query: string): Promise<SshResult> {
  const keyPath = requireEnv("SSH_KEY_PATH");
  const targetIp = requireEnv("TARGET_PUBLIC_IP");
  const b64 = Buffer.from(query, "utf-8").toString("base64");
  return sshExec(
    targetIp,
    keyPath,
    `echo ${b64} | base64 -d | /usr/local/pgsql/bin/psql -h localhost -U postgres -tA`,
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}
