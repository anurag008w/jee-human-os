/**
 * "[silence]" no-op token (user request).
 *
 * The app treats the EXACT token "[silence]" as "no message, no voice" in BOTH
 * chat and live: it is never shown (transcript/chat bubble), never persisted,
 * and the AI is told via the system prompt that writing it means a natural
 * pause rather than a spoken line. ONLY this token counts — any other text is
 * always shown and spoken normally.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SILENCE_TOKEN,
  SILENCE_TOKEN_RULE,
  isPureSilenceToken,
  stripSilenceToken,
} from '../chat';
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
  const client = new GeminiLiveClient(mockConfig) as any;
  return client;
}

describe('silence-token helpers', () => {
  it('strips every "[silence]" token (case-insensitive) from real text', () => {
    expect(stripSilenceToken('[silence] hi')).toBe('hi');
    expect(stripSilenceToken('hi [SILENCE] there')).toBe('hi there');
    expect(stripSilenceToken('[Silence] [silence] hi [silence]')).toBe('hi');
    expect(stripSilenceToken('hello [silence] world')).toBe('hello world');
  });

  it('flags ONLY text that is nothing but "[silence]" as pure', () => {
    expect(isPureSilenceToken('[silence]')).toBe(true);
    expect(isPureSilenceToken('[SILENCE] [silence]')).toBe(true);
    expect(isPureSilenceToken('')).toBe(true);
    expect(isPureSilenceToken('  [silence]  ')).toBe(true);
    expect(isPureSilenceToken('[silence] hi')).toBe(false);
    expect(isPureSilenceToken('hi [silence]')).toBe(false);
    // "anything else" must NOT match — a different bracket token is real text.
    expect(isPureSilenceToken('[quiet]')).toBe(false);
    expect(isPureSilenceToken('silence')).toBe(false);
  });

  it('writes the rule to mention ONLY the exact token, nothing else', () => {
    expect(SILENCE_TOKEN).toBe('[silence]');
    expect(SILENCE_TOKEN_RULE).toContain('[silence]');
    // The rule must make crystal-clear that other phrasings do NOT count.
    expect(SILENCE_TOKEN_RULE).toContain('does NOT count');
  });
});

describe('GeminiLiveClient: "[silence]" turns are never shown in live transcripts', () => {
  it('creates NO transcript item for a pure "[silence]" assistant turn', () => {
    const client = makeClient();
    client.updateTranscript('assistant', '[silence]', false);
    client.updateTranscript('assistant', '[SILENCE]', false);
    expect(client.transcripts).toHaveLength(0);
    // And the no-op must not corrupt the turn machine: no dangling active id.
    expect(client.activeAssistantTurnId).toBeNull();
  });

  it('strips embedded "[silence]" tokens from shown live text', () => {
    const client = makeClient();
    client.updateTranscript('assistant', 'okay [silence] let me think', false);
    expect(client.transcripts).toHaveLength(1);
    expect(client.transcripts[0].text).toBe('okay let me think');
  });

  it('drops silence-only reasoning but keeps the real turn', () => {
    const client = makeClient();
    // Simulate the handler: thinking part accumulates pendingReasoning, then
    // the text part commits it.
    client.pendingReasoning = '[silence] [silence]';
    client.updateTranscript('assistant', 'hmm okay', false);
    expect(client.transcripts).toHaveLength(1);
    expect(client.transcripts[0].text).toBe('hmm okay');
    // Silence-only thinking is not rendered:
    expect(client.transcripts[0].reasoning).toBeUndefined();
    expect(client.pendingReasoning).toBe('');
  });
});

describe('GeminiLiveClient: "[silence]" must never leak into audio or greeting state', () => {
  it('does NOT let a pure "[silence]" chunk populate currentAssistantMessage', () => {
    const client = makeClient();
    // Regression: appendAssistantText used to store the raw token, which made
    // the 500ms greeting guard at connect() see a non-empty message and skip
    // the opening greeting ("Misa chup reh jaati hai").
    client.currentAssistantMessage = '';
    client.appendAssistantText('[silence]');
    expect(client.currentAssistantMessage).toBe('');
    client.appendAssistantText('[SILENCE] [silence]');
    expect(client.currentAssistantMessage).toBe('');
    // Real text still appends normally.
    client.appendAssistantText('haan');
    expect(client.currentAssistantMessage).toBe('haan');
  });

  it('plays NO audio for a pure "[silence]" model turn (flush + skip)', () => {
    const client = makeClient();
    const playAudioChunk = vi.fn();
    const flushPlayback = vi.fn();
    client.audioStreamer = { playAudioChunk, flushPlayback };
    client.awaitingAssistantReply = true;
    client.status = 'listening';

    client.handleServerMessage({
      serverContent: {
        modelTurn: {
          parts: [
            { text: '[silence]' },
            { inlineData: { data: 'base64-audio-slice' } },
          ],
        },
      },
    });
    // The audio part of a silence turn must be voiced nowhere.
    expect(flushPlayback).toHaveBeenCalled();
    expect(playAudioChunk).not.toHaveBeenCalled();
    // And the transcript stays empty.
    expect(client.transcripts ?? []).toHaveLength(0);
  });

  it('still voices normal turns (silence detection does not over-suppress)', () => {
    const client = makeClient();
    const playAudioChunk = vi.fn();
    client.audioStreamer = { playAudioChunk, flushPlayback: vi.fn() };
    client.handleServerMessage({
      serverContent: {
        modelTurn: {
          parts: [
            { text: 'ek baat batao' },
            { inlineData: { data: 'base64-audio-slice' } },
          ],
        },
      },
    });
    expect(playAudioChunk).toHaveBeenCalledTimes(1);
    expect(client.transcripts).toHaveLength(1);
    expect(client.transcripts[0].text).toBe('ek baat batao');
  });
});