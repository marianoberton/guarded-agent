import type { Action, ConversationState, TraceEntry } from "../core/types.js";

export interface StoredTurn {
  id: string;
  conversationId: string;
  at: number;
  inbound: string;
  actions: Action[];
  trace: TraceEntry[];
}

/**
 * Persistence boundary. M0 covers conversations and turn records; the job queue
 * that backs debounce and the worker arrives with PostgresStore (M4) and is
 * added to this interface then.
 */
export interface Store {
  load(conversationId: string): Promise<ConversationState | null>;
  save(state: ConversationState): Promise<void>;
  recordTurn(turn: StoredTurn): Promise<void>;
  getTurn(turnId: string): Promise<StoredTurn | null>;
}
