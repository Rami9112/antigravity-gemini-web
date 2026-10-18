export type GeminiRole = "user" | "model" | "system";

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface GeminiInlineData {
  mimeType: string;
  data: string;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  inlineData?: GeminiInlineData;
}

export interface GeminiContent {
  role?: GeminiRole | string;
  parts?: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  parametersJsonSchema?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: Record<string, unknown>;
  codeExecution?: Record<string, unknown>;
}

export interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: "AUTO" | "ANY" | "NONE" | string;
    allowedFunctionNames?: string[];
  };
}

export interface GeminiThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  thinkingConfig?: GeminiThinkingConfig;
}

export interface GeminiGenerateContentRequest {
  contents?: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: unknown[];
  cachedContent?: string;
}

export interface CloudCodeGenerateContentRequest {
  project?: string;
  requestId?: string;
  model?: string;
  userPromptId?: string;
  userAgent?: string;
  requestType?: string;
  enabledCreditTypes?: unknown[];
  request?: GeminiGenerateContentRequest;
  // Fallback fields when unwrapped Gemini request is sent directly
  contents?: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: GeminiGenerationConfig;
}

export interface GeminiCandidate {
  index?: number;
  content?: GeminiContent;
  finishReason?:
    | "STOP"
    | "MAX_TOKENS"
    | "SAFETY"
    | "RECITATION"
    | "OTHER"
    | "MALFORMED_FUNCTION_CALL"
    | string;
  finishMessage?: string;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
}

export interface CloudCodeGenerateContentResponse {
  response?: GeminiGenerateContentResponse;
  traceId?: string;
  consumedCredits?: unknown;
  remainingCredits?: unknown;
  metadata?: Record<string, unknown>;
}

export type GeminiWebModelTier = "fast" | "thinking" | "pro";

export interface CompiledGeminiWebTurn {
  mode: "bootstrap" | "incremental";
  sessionKey: string;
  inlinePrompt: string;
  attachmentFileName?: string;
  attachmentContent?: string;
  expectedToolNames: string[];
  contentsSnapshot: GeminiContent[];
  /**
   * For incremental turns: the same request compiled as a full bootstrap (system prompt,
   * tool catalog and history). Used when the session's Gemini Web chat cannot be restored.
   */
  bootstrapFallback?: CompiledGeminiWebTurn;
}

export interface ParsedGeminiWebToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawBlock: string;
}

export interface ParsedGeminiWebOutput {
  visibleText: string;
  thoughtText: string;
  toolCalls: ParsedGeminiWebToolCall[];
  /** Which compiled turn the driver actually sent (an incremental turn may fall back to bootstrap). */
  executedMode?: "bootstrap" | "incremental";
}

export type GeminiWebStreamEvent =
  | { type: "thought_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_calls"; toolCalls: ParsedGeminiWebToolCall[] }
  | {
      type: "completed";
      visibleText: string;
      thoughtText: string;
      toolCalls: ParsedGeminiWebToolCall[];
    };

export interface GeminiWebTurnExecutionOptions {
  model?: string;
  signal?: AbortSignal;
  onEvent?: (event: GeminiWebStreamEvent) => void;
}

export interface GeminiWebDriver {
  executeTurn(
    turn: CompiledGeminiWebTurn,
    options?: GeminiWebTurnExecutionOptions,
  ): Promise<ParsedGeminiWebOutput>;
}
