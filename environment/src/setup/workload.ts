import type { Logger } from "@hyperfocal/env-base";
import { sshExec } from "../clients/ssh.js";
import { pollUntil, sleep } from "../clients/poll.js";
import { WORKLOAD_IP, SSH_READY_TIMEOUT_MS, POLL_INTERVAL_MS } from "../config.js";

export async function waitForSsh(
  ips: [string, string][],
  keyPath: string,
  logger: Logger,
): Promise<void> {
  logger.info("Waiting for SSH on containers...");
  for (const [ip, label] of ips) {
    await pollUntil(
      async () => {
        const r = await sshExec(ip, keyPath, "echo ok", 5);
        return r.exitCode === 0 && r.output === "ok";
      },
      SSH_READY_TIMEOUT_MS,
      POLL_INTERVAL_MS,
      `SSH on ${label} (${ip})`,
    );
    logger.info(`SSH available on ${label}.`);
  }
}

export async function startWorkload(keyPath: string, logger: Logger): Promise<void> {
  logger.info("Starting continuous workload...");
  await sshExec(
    WORKLOAD_IP,
    keyPath,
    "nohup /home/ec2-user/workload-driver.sh > /dev/null 2>&1 &",
  );

  await sleep(3000);

  const wlRunning = await sshExec(
    WORKLOAD_IP,
    keyPath,
    "pgrep -f workload-driver.sh > /dev/null && echo active || echo inactive",
  );
  if (wlRunning.output !== "active") {
    throw new Error(`Workload not running: ${wlRunning.output}`);
  }

  const wlTest = await sshExec(WORKLOAD_IP, keyPath, "bash /home/ec2-user/workload-check.sh");
  if (wlTest.exitCode !== 0) {
    throw new Error(`Workload check failed: ${wlTest.output}`);
  }
  logger.info("Workload is running.");
}
