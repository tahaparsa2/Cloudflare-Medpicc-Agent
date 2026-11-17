/**
 * The one place a model runs: Workers AI, called through AI Gateway so every
 * call is logged there. A recorded answer can stand in for the live call, so
 * tests and rehearsals spend none of the daily free allocation.
 */

import { EXTRACTION_SCHEMA, type Message } from "./extraction";

export interface ModelRequest {
  messages: Message[];
  transcriptId: string;
  /** Shown on the AI Gateway log entry. At most five entries. */
  metadata?: Record<string, string>;
}

export interface ModelAnswer {
  /** The model's answer, not yet checked against the schema. */
  output: unknown;
  /** Prefixed with "replay:" when a recording was used. */
  modelId: string;
  gatewayLogId: string | null;
  /** Tokens the live call used, as Workers AI reports them. Absent on a replay. */
  usage?: { promptTokens: number; completionTokens: number } | null;
}

export interface ModelClient {
  /** The model this client asks, for the record when a call fails before it answers. */
  readonly id: string;
  extract(request: ModelRequest): Promise<ModelAnswer>;
}

/** The part of the Workers AI binding this file uses. */
interface AiBinding {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
  aiGatewayLogId?: string | null;
}

export function workersAiModel(ai: unknown, modelId: string, gatewayId: string): ModelClient {
  const binding = ai as AiBinding;
  return {
    id: modelId,
    async extract(request) {
      const result = await binding.run(
        modelId,
        {
          messages: request.messages,
          response_format: { type: "json_schema", json_schema: EXTRACTION_SCHEMA },
          max_tokens: 1500,
          temperature: 0,
        },
        { gateway: { id: gatewayId, metadata: request.metadata ?? {} } },
      );
      // JSON Mode answers under `response`, as an object or as a JSON string.
      const body = typeof result === "object" && result !== null ? (result as { response?: unknown; usage?: Record<string, unknown> }) : null;
      const output = body ? body.response : result;
      const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = body?.usage ?? {};
      const usage = typeof promptTokens === "number" && typeof completionTokens === "number" ? { promptTokens, completionTokens } : null;
      return { output, modelId, gatewayLogId: binding.aiGatewayLogId ?? null, usage };
    },
  };
}

/** One saved model answer for one fixture call. Written by `npm run eval:record`. */
export interface Recording {
  transcriptId: string;
  transcriptHash: string;
  contextHash: string;
  modelId: string;
  recordedAt: string;
  output: unknown;
}

export function replayModel(recordings: Record<string, Recording | undefined>): ModelClient {
  return {
    id: "replay:none",
    async extract(request) {
      const recording = recordings[request.transcriptId];
      if (!recording) throw new Error(`no recorded model answer for ${request.transcriptId}`);
      return { output: recording.output, modelId: `replay:${recording.modelId}`, gatewayLogId: null };
    },
  };
}
