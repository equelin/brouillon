import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../config.ts";
import type { CoachModels } from "./models.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { coachTools, type Workspace } from "./tools.ts";

export type CoachEvent =
  | { type: "start" }
  /** The coach's reply so far; replaces the previous text of the same reply. */
  | { type: "reply"; text: string }
  | { type: "tool"; label: string }
  | { type: "error"; message: string }
  | { type: "end" };

export interface CoachOptions {
  models: CoachModels;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  workspace: Workspace;
}

/** The writing coach: one conversation with a model that can only read, comment and suggest. */
export class Coach {
  readonly modelName: string;
  private readonly agent: Agent;
  private readonly listeners = new Set<(event: CoachEvent) => void>();

  constructor(options: CoachOptions) {
    this.modelName = options.model.name ?? options.model.id;
    this.agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: options.model,
        thinkingLevel: options.model.reasoning ? options.thinkingLevel : "off",
        tools: coachTools(options.workspace),
      },
      streamFn: options.models.streamSimple.bind(options.models),
      sessionId: randomUUID(),
      // Comments and suggestions reach the author in the order the coach made them.
      toolExecution: "sequential",
    });

    this.agent.subscribe((event) => {
      if (event.type === "message_update" || event.type === "message_end") {
        const message = event.message;
        if (message.role !== "assistant") return;
        const text = message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
        if (text) this.emit({ type: "reply", text });
        if (event.type === "message_end" && message.stopReason === "error") {
          this.emit({ type: "error", message: message.errorMessage ?? "the model request failed" });
        }
      } else if (event.type === "tool_execution_start") {
        const tool = this.agent.state.tools.find((candidate) => candidate.name === event.toolName);
        this.emit({ type: "tool", label: tool?.label ?? event.toolName });
      }
    });
  }

  get busy(): boolean {
    return this.agent.state.isStreaming;
  }

  subscribe(listener: (event: CoachEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CoachEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Send the author's message; resolves when the coach has finished answering. */
  async send(message: string): Promise<void> {
    if (this.busy) throw new Error("the coach is still answering");
    this.emit({ type: "start" });
    try {
      await this.agent.prompt(message);
    } catch (error) {
      this.emit({ type: "error", message: (error as Error).message });
    } finally {
      this.emit({ type: "end" });
    }
  }

  abort(): void {
    this.agent.abort();
  }

  /** Stop any answer in progress and forget the conversation, for another article. */
  async reset(): Promise<void> {
    this.agent.abort();
    await this.agent.waitForIdle();
    this.agent.reset();
  }
}
