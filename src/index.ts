// --- core ---------------------------------------------------------------------
export { runTurn, emptyConversation } from "./core/turn.js";
export { TraceBuilder } from "./core/trace.js";
export { explain, explainTurn } from "./core/explain.js";
export type {
  Action,
  ConversationState,
  ConversationStatus,
  Decider,
  Inbound,
  LlmFn,
  Message,
  Role,
  TraceEntry,
  TurnConfig,
  TurnDeps,
  TurnResult,
} from "./core/types.js";

// --- tools --------------------------------------------------------------------
export { defineTool, toInputSchema, ToolInputError } from "./tools/defineTool.js";
export type { Tool, ToolContext, ToolDefinition } from "./tools/defineTool.js";

// --- guards -------------------------------------------------------------------
export {
  debounce,
  humanTakeover,
  killSwitch,
  paused,
  preCheck,
  rateLimit,
  standardGuards,
} from "./guards/index.js";
export type { Guard, GuardContext, GuardVerdict } from "./guards/types.js";

// --- providers ----------------------------------------------------------------
export { OpenRouterProvider } from "./providers/openrouter.js";
export { JevProvider } from "./providers/jev.js";
export { RateLimiter } from "./providers/rateLimit.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { ProviderError } from "./providers/types.js";
export type {
  Completion,
  CompletionRequest,
  Provider,
  ProviderMessage,
  StopReason,
  ToolCall,
  ToolSpec,
  Usage,
} from "./providers/types.js";

// --- classify -----------------------------------------------------------------
export { LlmClassifier } from "./classify/LlmClassifier.js";
export { JevClassifier } from "./classify/JevClassifier.js";
export { readChoice, readNoul, readScore } from "./classify/types.js";
export type {
  Answer,
  Answers,
  Classifier,
  Question,
  QuestionMap,
} from "./classify/types.js";
export * as jev from "./jev/index.js";

// --- stores -------------------------------------------------------------------
export { MemoryStore } from "./stores/memory.js";
export type { Store, StoredTurn } from "./stores/types.js";
