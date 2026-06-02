import * as fs from "fs";
import * as path from "path";

export interface McpHttpServerEntry {
  type: "http";
  url: string;
}

export function mcpConfigPath(workspace: string): string {
  return path.join(workspace, ".hyperfocal", "mcp-config.json");
}

export function upsertMcpServer(
  workspace: string,
  name: string,
  entry: McpHttpServerEntry,
): string {
  const config = readConfig(workspace);
  config.mcpServers[name] = entry;
  return writeConfig(workspace, config);
}

export function removeMcpServer(workspace: string, name: string): void {
  const configPath = mcpConfigPath(workspace);
  if (!fs.existsSync(configPath)) return;
  const config = readConfig(workspace);
  if (!(name in config.mcpServers)) return;
  delete config.mcpServers[name];
  if (Object.keys(config.mcpServers).length === 0) {
    try {
      fs.unlinkSync(configPath);
    } catch {
      writeConfig(workspace, config);
    }
    return;
  }
  writeConfig(workspace, config);
}

interface McpConfigFile {
  mcpServers: Record<string, McpHttpServerEntry>;
}

function readConfig(workspace: string): McpConfigFile {
  const configPath = mcpConfigPath(workspace);
  if (!fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<McpConfigFile>;
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    return { mcpServers: {} };
  }
}

function writeConfig(workspace: string, config: McpConfigFile): string {
  const configPath = mcpConfigPath(workspace);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
