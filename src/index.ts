// --- core ---------------------------------------------------------------------
export { runTurn, emptyConversation } from "./core/turn.js";
export { TraceBuilder } from "./core/trace.js";
export { explain, explainTurn } from "./core/explain.js";
export { coalesce, createWorker } from "./core/worker.js";
export type { Deliver, Worker, WorkerOptions } from "./core/worker.js";
export {
  acceptHandoff,
  appendHumanMessage,
  releaseHandoff,
  releaseIfInactive,
  requestHandoff,
} from "./core/takeover.js";
export type { Transition } from "./core/takeover.js";
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

// --- policies -----------------------------------------------------------------
export * as policies from "./policies/index.js";
export { allow, block, escalate, rewrite } from "./policies/types.js";
export type {
  ActionContext,
  AfterContext,
  BeforeContext,
  Policy,
  Verdict,
} from "./policies/types.js";

// --- channels -----------------------------------------------------------------
export { WebChannel, WhatsAppChannel } from "./channels/index.js";
export { DEFAULT_WINDOW_HOURS, hoursToMs, isWindowOpen, windowState } from "./channels/index.js";
export type {
  Channel,
  PlanInput,
  SendPlan,
  WhatsAppChannelOptions,
  WhatsAppTemplates,
  WindowState,
} from "./channels/index.js";

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
export type { Answer, Answers, Classifier, Question, QuestionMap } from "./classify/types.js";
export * as jev from "./jev/index.js";

// --- stores -------------------------------------------------------------------
export { MemoryStore } from "./stores/memory.js";
export { PostgresStore, schemaSql } from "./stores/postgres/store.js";
export type { PgQueryable } from "./stores/postgres/store.js";
export type {
  DequeueOptions,
  EnqueueOptions,
  FailOptions,
  Job,
  PendingMessage,
  Queue,
  Store,
  StoredTurn,
} from "./stores/types.js";
