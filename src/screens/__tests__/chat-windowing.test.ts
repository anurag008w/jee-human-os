import { describe, expect, it } from 'vitest';
import {
  CHAT_WINDOW_SIZE,
  chatLoadOlderStart,
  chatTailStart,
  chatVisibleMessages,
} from '../ChatScreen';

describe('chat windowing helpers (hang-fix P1)', () => {
  it('tail start shows the newest window when history exceeds the window', () => {
    expect(chatTailStart(500)).toBe(500 - CHAT_WINDOW_SIZE);
    expect(chatTailStart(CHAT_WINDOW_SIZE)).toBe(0);
  });

  it('tail start is clamped at zero for small or empty histories', () => {
    expect(chatTailStart(0)).toBe(0);
    expect(chatTailStart(10)).toBe(0);
    expect(chatTailStart(50, 200)).toBe(0);
  });

  it('load-older moves the window back by the step, clamped at zero', () => {
    expect(chatLoadOlderStart(500 - CHAT_WINDOW_SIZE)).toBe(500 - CHAT_WINDOW_SIZE - 120);
    expect(chatLoadOlderStart(10)).toBe(0);
    expect(chatLoadOlderStart(0)).toBe(0);
  });

  it('visible messages slice starts at the window start', () => {
    const msgs = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}` }));
    const tail = chatVisibleMessages(msgs, chatTailStart(msgs.length));
    expect(tail).toHaveLength(CHAT_WINDOW_SIZE);
    expect(tail[0].id).toBe('m180');

    // Window start 0 renders everything (no-op slice).
    expect(chatVisibleMessages(msgs, 0)).toBe(msgs);
    expect(chatVisibleMessages([], 0)).toEqual([]);
  });

  it('older messages load in ascending order (scroll-up semantics)', () => {
    const msgs = Array.from({ length: 400 }, (_, i) => ({ id: `m${i}` }));
    const first = chatTailStart(msgs.length);
    const second = chatLoadOlderStart(first);
    const third = chatLoadOlderStart(second);
    const oldest = chatLoadOlderStart(third);
    expect(chatVisibleMessages(msgs, second)[0].id).toBe(`m${second}`);
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
    expect(oldest).toBe(0); // fully loaded at the top (clamped at zero)
    expect(chatVisibleMessages(msgs, oldest)).toHaveLength(msgs.length);
  });
});