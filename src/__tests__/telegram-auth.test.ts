import { describe, it, expect } from 'vitest';
// Import the leaf module directly, NOT '../telegram.js' — telegram.ts
// constructs a live Telegraf bot and calls boot() (real polling, HTTP health
// server, Supabase writes) at module import time, so it can never be
// imported from a unit test. telegram.ts re-exports the same symbol from
// this module so production code and this test share one source of truth.
import { isAuthorizedChat } from '../atlas/telegram-auth.js';

describe('isAuthorizedChat', () => {
  const ALLOWED = 123456789;

  it('returns true when sender id matches the allowed CEO id', () => {
    expect(isAuthorizedChat(ALLOWED, ALLOWED)).toBe(true);
  });

  it('returns false when sender id is a different chat', () => {
    expect(isAuthorizedChat(987654321, ALLOWED)).toBe(false);
  });

  it('returns false when sender id is undefined (no chat/from on update)', () => {
    expect(isAuthorizedChat(undefined, ALLOWED)).toBe(false);
  });

  it('returns false when allowed id is NaN (TELEGRAM_CEO_CHAT_ID unset), even if sender "matches" NaN', () => {
    expect(isAuthorizedChat(ALLOWED, NaN)).toBe(false);
    expect(isAuthorizedChat(NaN as unknown as number, NaN)).toBe(false);
  });

  it('returns false for a zero sender id against a real allowed id', () => {
    expect(isAuthorizedChat(0, ALLOWED)).toBe(false);
  });
});
