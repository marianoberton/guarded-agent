import type { ConversationState } from "../core/types.js";
import type { Store, StoredTurn } from "./types.js";

/**
 * In-process store. Real for examples and tests, not for production — a restart
 * loses everything and two processes share nothing.
 *
 * State is cloned on the way in and out so a caller mutating what it got back
 * cannot corrupt what is stored. That has bitten every in-memory store ever
 * written.
 */
export class MemoryStore implements Store {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly turns = new Map<string, StoredTurn>();

  async load(conversationId: string): Promise<ConversationState | null> {
    const found = this.conversations.get(conversationId);
    return found ? clone(found) : null;
  }

  async save(state: ConversationState): Promise<void> {
    this.conversations.set(state.id, clone(state));
  }

  async recordTurn(turn: StoredTurn): Promise<void> {
    this.turns.set(turn.id, clone(turn));
  }

  async getTurn(turnId: string): Promise<StoredTurn | null> {
    const found = this.turns.get(turnId);
    return found ? clone(found) : null;
  }

  /** Test helper: every turn recorded for a conversation, oldest first. */
  turnsFor(conversationId: string): StoredTurn[] {
    return [...this.turns.values()]
      .filter((turn) => turn.conversationId === conversationId)
      .sort((a, b) => a.at - b.at)
      .map(clone);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
