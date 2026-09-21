/** models.yml fixture writer for the M1 experiments (local fake provider only). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Write an isolated models.yml that points at a local fake provider.
 * Returns the `provider/model` selector to pass as `--model`.
 */
export function writeModelsConfig(agentDir, { providerId = "m1fake", baseUrl, modelId = "local-model" }) {
  const yaml = `providers:
  ${providerId}:
    baseUrl: ${baseUrl}
    api: openai-completions
    auth: none
    models:
      - id: ${modelId}
        api: openai-completions
        contextWindow: 200000
        supportsTools: true
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`;
  writeFileSync(join(agentDir, "models.yml"), yaml);
  return `${providerId}/${modelId}`;
}
