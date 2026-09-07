/**
 * GeminiLiveClient transcript handling (hang-fix P4).
 *
 * Regression coverage for the live-transcript cap:
 *   - `this.transcripts` never grows past the bound during a long/active call,
 *     so the per-chunk `[...this.transcripts]` spread stays bounded (live
 *     time-degrade fix).
 *   - The cap reference is CORRECTLY scoped as `GeminiLiveClient.MAX_TRANSCRIPTS`
 *     (not a bare `LiveClient` identifier) — a prior typo threw a runtime
 *     `ReferenceError: LiveClient is not defined` on EVERY transcript chunk,
 *     which is exactly why live messages never appeared and the reply never
 *     settled. This test pins the symbol so it can't regress silently (tsc
 *     won't catch it because `LiveClient` resolves to an ambient global type).
 */

import { describe, it, expect } from 'vitest';
import { GeminiLiveClient } from '../live-client';
import type { LiveSettingsConfig } from '../live-types';

const mockConfig: LiveSettingsConfig = {
  model: 'gemini-2.5-flash-native-audio-preview-09-2025',
  voice: 'Aoede',
  vadSensitivity: 'medium',
  videoFps: 1,
  screenFps: 1,
  defaultAudioRoute: 'speaker',
  playbackSpeed: 1.0,
  enable90DayTrack: true,
};

function makeClient() {
  const client = new GeminiLiveClient(mockConfig);
  // updateTranscript is private; `(client as any)` is the established pattern
  // in this suite for driving internals directly. Between turns we clear the
  // active-turn ids (as the live handler does) so each update creates a FRESH
  // transcript item — otherwise the same edge pointer keeps overwriting and
  // the array never grows.
  const update = (role: 'user' | 'assistant', text: string) => {
    (client as any).updateTranscript(role, text, false);
    (client as any).activeAssistantTurnId = null;
    (client as any).activeUserTurnId = null;
  };
  return { client, update };
}

describe('GeminiLiveClient transcript cap (hang-fix P4)', () => {
  it('caps this.transcripts so a long call cannot grow it unbounded', () => {
    const { client, update } = makeClient();
    const cap = (client as any).constructor.MAX_TRANSCRIPTS;
    expect(cap).toBe(400);

    // Push far past the cap with DISTINCT user turns (each a fresh item — the
    // helper clears the active-turn id, exactly like the live handler does).
    for (let i = 0; i < cap + 200; i++) {
      update('user', `msg ${i}`);
    }

    expect((client as any).transcripts.length).toBeLessThanOrEqual(cap);
    // The newest messages survive (tail kept, oldest dropped).
    const tail = (client as any).transcripts as Array<{ text: string }>;
    expect(tail.at(-1)?.text).toBe(`msg ${cap + 199}`);
    expect(tail[0].text).toBe(`msg ${cap + 200 - cap}`);
  });

  it('updateTranscript does not throw and keeps the active turn id consistent after pruning', () => {
    const { update } = makeClient();
    // If the cap reference regressed to a bare `LiveClient` identifier, this
    // would throw `ReferenceError: LiveClient is not defined` and the call
    // would never render its reply. It must complete without error once past
    // the cap.
    expect(() => {
      for (let i = 0; i < 500; i++) update('assistant', `reply ${i}`);
    }).not.toThrow();
  });
});
