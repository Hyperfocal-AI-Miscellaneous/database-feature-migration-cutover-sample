# packages/

The environment imports four internal packages as git submodules. The
submodule refs in `.gitmodules` are kept so a reader can see what's
pinned, but the packages themselves are not publicly available — clones
will see the submodule pointers but `git submodule update` will fail
on auth.

| Path | Internal repo | What it is |
|---|---|---|
| `env-base/` | `Hyperfocal-AI-Packages/env-base` | Shared types (`SimpleTest`, `SimpleTestResult`, `Logger`, `EnvironmentDefinition`), the test runner, and the LLM-judge / rubric helpers. |
| `env-orchestrator/` | `Hyperfocal-AI-Packages/env-orchestrator` | CLI that loads a hyperfocal.yaml, sets up the problem, runs the agent, and runs the grader. |
| `env-builder/` | `Hyperfocal-AI-Packages/env-builder` | Tooling for authoring new environments — scaffolding, problem-shape validation, mock-MCP harness wiring. |
| `mock-mcp-services/` | `Hyperfocal-AI-Packages/mock-mcp-services` | In-process Linear / Sentry / GitHub MCP servers backed by JSON fixtures, used by the MCP-driven problem variants. |
