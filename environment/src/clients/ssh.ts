import { executeWithExitCode } from "@hyperfocal/env-base";

export interface SshResult {
  exitCode: number;
  output: string;
}

/** Execute a shell command on a remote host as `ec2-user`. */
export async function sshExec(
  host: string,
  keyPath: string,
  command: string,
  timeoutSecs = 10,
): Promise<SshResult> {
  const escaped = command.replace(/'/g, `'\\''`);
  const sshCmd =
    `ssh -i ${keyPath}` +
    ` -o StrictHostKeyChecking=no` +
    ` -o BatchMode=yes` +
    ` -o ConnectTimeout=${timeoutSecs}` +
    ` ec2-user@${host}` +
    ` '${escaped}'`;

  const result = await executeWithExitCode(sshCmd, { silent: true });
  return { exitCode: result.exitCode, output: result.output.trim() };
}
