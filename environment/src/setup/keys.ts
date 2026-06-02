import * as fs from "fs";
import * as path from "path";
import { execute, executeWithExitCode } from "@hyperfocal/env-base";
import type { Logger } from "@hyperfocal/env-base";

export async function createSshKeyPair(workspacePath: string, logger: Logger): Promise<string> {
  const keyPath = path.join(workspacePath, "hyperfocal-key.pem");
  for (const f of [keyPath, `${keyPath}.pub`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  logger.info("Generating SSH key pair...");
  await execute(
    `ssh-keygen -t rsa -b 2048 -f "${keyPath}" -N "" -q`,
    { silent: true },
  );
  fs.chmodSync(keyPath, 0o600);
  logger.info(`SSH key pair generated: ${keyPath}`);
  return keyPath;
}

export async function injectSshKey(keyPath: string, containers: string[], logger: Logger): Promise<void> {
  const pubKeyPath = keyPath + ".pub";
  const pubKey = fs.readFileSync(pubKeyPath, "utf-8").trim();

  for (const container of containers) {
    const tmpPub = `/tmp/hf-pubkey-${container}.pub`;
    fs.writeFileSync(tmpPub, pubKey + "\n");
    await executeWithExitCode(
      `docker cp "${tmpPub}" ${container}:/tmp/hyperfocal-key.pub`,
      { silent: true },
    );
    await executeWithExitCode(
      `docker exec ${container} bash -c 'mkdir -p /home/ec2-user/.ssh && cp /tmp/hyperfocal-key.pub /home/ec2-user/.ssh/authorized_keys && chmod 600 /home/ec2-user/.ssh/authorized_keys && chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys'`,
      { silent: true },
    );
    fs.unlinkSync(tmpPub);
  }
  logger.info(`SSH public key injected into ${containers.length} containers.`);
}
