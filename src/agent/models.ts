import { createInterface } from "node:readline/promises";
import type { Api, AuthInteraction, CredentialStore, Model } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type Config, deviceId } from "../config.ts";

export type CoachModels = ReturnType<typeof builtinModels>;

export function createCoachModels(credentials: CredentialStore): CoachModels {
  return builtinModels({ credentials });
}

/**
 * The model the coach talks to, or undefined when the provider has no usable
 * credentials. A configured model the account cannot use falls back to the
 * provider's first available one.
 */
export async function resolveModel(
  models: CoachModels,
  config: Config,
): Promise<Model<Api> | undefined> {
  if (!models.getProvider(config.provider)) {
    throw new Error(`unknown provider "${config.provider}" in the configuration`);
  }
  let available = await models.getAvailable(config.provider);
  const auth = await models.checkAuth(config.provider);
  if (config.provider === "openai" && auth?.type === "oauth") {
    // A ChatGPT account only serves the models of the Codex catalog; OpenAI answers
    // "model_not_found" for the others, which pi-ai still lists as available.
    const served = new Set(getBuiltinModels("openai-codex").map((model) => model.id));
    available = available.filter((model) => served.has(model.id));
  }
  return available.find((model) => model.id === config.model) ?? available[0];
}

/** Sign in on the plain terminal: OAuth when the provider offers it, an API key otherwise. */
export async function loginOnTerminal(models: CoachModels, providerId: string): Promise<void> {
  const provider = models.getProvider(providerId);
  if (!provider) throw new Error(`unknown provider "${providerId}"`);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  readline.on("SIGINT", () => abort.abort());

  const interaction: AuthInteraction = {
    signal: abort.signal,
    prompt: async (prompt) => {
      // A prompt can be cancelled by the flow itself, e.g. when the browser callback wins.
      const signal = prompt.signal ? AbortSignal.any([prompt.signal, abort.signal]) : abort.signal;
      if (prompt.type === "select") {
        prompt.options.forEach((option, index) => {
          const detail = option.description ? ` - ${option.description}` : "";
          console.log(`  ${index + 1}. ${option.label}${detail}`);
        });
        for (;;) {
          const answer = await readline.question(
            `${prompt.message} [1-${prompt.options.length}]: `,
            {
              signal,
            },
          );
          const option = prompt.options[Number(answer.trim()) - 1];
          if (option) return option.id;
        }
      }
      return (await readline.question(`${prompt.message}: `, { signal })).trim();
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        console.log(`\nOpen this URL in a browser:\n\n  ${event.url}\n`);
        if (event.instructions) console.log(event.instructions);
      } else if (event.type === "device_code") {
        console.log(`\nOpen ${event.verificationUri} and enter the code ${event.userCode}\n`);
      } else {
        console.log(event.message);
        if (event.type === "info") {
          for (const link of event.links ?? [])
            console.log(`  ${link.label ?? "More"}: ${link.url}`);
        }
      }
    },
  };

  try {
    await models.login(providerId, provider.auth.oauth ? "oauth" : "api_key", interaction, {
      getDeviceId: deviceId,
      agentName: "brouillon",
    });
  } catch (error) {
    if (abort.signal.aborted) throw new Error("sign-in cancelled");
    throw error;
  } finally {
    readline.close();
  }
}
