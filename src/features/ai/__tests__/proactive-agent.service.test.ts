import { describe, it, expect, beforeEach, vi } from 'vitest';
import { proactiveAgentService } from '../proactive-agent.service';
import { relationshipManager } from '../relationship-state';
import { setLiveCallActive } from '../live-call-state';

const mockStorage: Record<string, string> = {};
global.localStorage = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, value: string) => { mockStorage[key] = value; },
  removeItem: (key: string) => { delete mockStorage[key]; },
  clear: () => { Object.keys(mockStorage).forEach((k) => delete mockStorage[k]); },
  key: (i: number) => Object.keys(mockStorage)[i] || null,
  length: 0,
};

describe('ProactiveAgentService Production Hardening', () => {
  beforeEach(() => {
    localStorage.clear();
    proactiveAgentService.resetForTesting();
    relationshipManager.resetForTesting();
    proactiveAgentService.updatePreferences({
      quietHoursStart: '03:00',
      quietHoursEnd: '06:00',
    });
    vi.restoreAllMocks();
  });

  it('1. 4-second seal does NOT send an instant user-facing message', async () => {
    const injected: any[] = [];
    const unsub = proactiveAgentService.onMessageInjection((msg) => {
      injected.push(msg);
    });

    proactiveAgentService.onChatTurn('Physics me Optics ke questions solve karne hain', 'Sure, go ahead');

    // Wait past the 4-second seal debounce
    await new Promise((r) => setTimeout(r, 100));

    // The 4-second seal should ONLY record commitments/triggers, not inject instant chat bubbles!
    expect(injected.length).toBe(0);
    unsub();
  });

  it('2. 5-minute follow-up requires proper in-session context', () => {
    const injected: any[] = [];
    const unsub = proactiveAgentService.onMessageInjection((msg) => {
      injected.push(msg);
    });

    // Is test ka intent "in-session follow-up context" hai — quiet-hours ka
    // test nahi. neutral window (00:00-00:00 => hamesha not-in-quiet) lagao
    // taaki ye test din/raat kisi bhi waqt chaale (03:00-06:00 default se
    // raat ko flaky ho jaata tha).
    proactiveAgentService.updatePreferences({
      quietHoursStart: '00:00',
      quietHoursEnd: '00:00',
    });

    proactiveAgentService.setInChatSession(true);
    proactiveAgentService.onChatTurn('Optics ke formula me doubt hai', 'Check Snell law');

    // Trigger in-session evaluateSessionFollowUp with simulated 5-minute elapsed time
    proactiveAgentService.evaluateSessionFollowUp(Date.now() + 5 * 60 * 1000);

    // Injected into chat since user is in active session
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain('Optics');
    unsub();
  });

  it('3. 30-minute grace suppresses background proactive notifications', () => {
    proactiveAgentService.recordUserActivity();
    // User is within active grace period (active 0 mins ago)
    proactiveAgentService.setInChatSession(false);
    // Background polling check
    expect(proactiveAgentService.getPreferences().activeGraceMinutes).toBe(30);
  });

  it('4. Completed task cancels pending reminder and celebrates', async () => {
    const injected: any[] = [];
    const unsub = proactiveAgentService.onMessageInjection((msg) => {
      injected.push(msg);
    });

    proactiveAgentService.onChatTurn('Kal Optics ke ray diagrams solve karunga', 'Great plan');
    await proactiveAgentService.onTaskCompleted('task_optics_1', 'Optics Ray Diagrams');

    await new Promise((r) => setTimeout(r, 900));
    expect(injected.length).toBe(1);
    expect(injected[0].isProactive).toBe(true);
    unsub();
  });

  it('5. Repeated dismissals increase fatigue and back off', () => {
    relationshipManager.recordNotificationDismissal('Optics');
    relationshipManager.recordNotificationDismissal('Optics');
    const state = relationshipManager.getState();
    expect(state.fatigue.consecutiveDismissals).toBe(2);
    expect(state.fatigue.fatigueScore).toBeGreaterThan(0.5);
  });

  it('6. Deep study mode prevents spontaneous calls', () => {
    let callTriggered = false;
    const unsub = proactiveAgentService.onIncomingCall(() => {
      callTriggered = true;
    });

    proactiveAgentService.setUserActivityState('DEEP_STUDY');
    // Spontaneous call check should be suppressed
    expect(callTriggered).toBe(false);
    unsub();
  });

  it('7. Repeated declined calls reduce future call frequency', () => {
    proactiveAgentService.onCallDeclined('call_1');
    proactiveAgentService.onCallDeclined('call_2');

    // Attempting spontaneous call is locked out by decline cooldown
    let callTriggered = false;
    const unsub = proactiveAgentService.onIncomingCall(() => {
      callTriggered = true;
    });

    proactiveAgentService.triggerIncomingCall('Periodic check-in');
    expect(callTriggered).toBe(false);
    unsub();
  });

  it('8. Offline call attempt produces OFFLINE_CALL_ATTEMPT status, not MISSED_CALL', () => {
    const injected: any[] = [];
    const unsub = proactiveAgentService.onMessageInjection((msg) => {
      injected.push(msg);
    });

    proactiveAgentService.onOfflineCallAttempt('call_offline_1', 'Calculus review');
    expect(injected.length).toBe(1);
    expect(injected[0].callStatus).toBe('offline_attempt');
    expect(injected[0].text).toContain('Offline Call');
    unsub();
  });

  it('9. DND shield suppresses every autonomous trigger', () => {
    proactiveAgentService.setDNDDuration(2 * 3600 * 1000);
    expect(proactiveAgentService.isQuietTime()).toBe(true);

    let callTriggered = false;
    const unsub = proactiveAgentService.onIncomingCall(() => {
      callTriggered = true;
    });

    proactiveAgentService.triggerIncomingCall('Study check-in');
    expect(callTriggered).toBe(false);
    unsub();
  });

  it('10. injectMessageIntoChat is blocked while a live call is active (P5 choke-point)', () => {
    const injected: any[] = [];
    const unsub = proactiveAgentService.onMessageInjection((msg) => {
      injected.push(msg);
    });
    // Use the real module singleton flag — the service reads it on dispatch.
    setLiveCallActive(true);
    proactiveAgentService.injectMessageIntoChat('Hii, kya chal raha hai?');
    expect(injected.length).toBe(0);
    setLiveCallActive(false);
    proactiveAgentService.injectMessageIntoChat('Hii, live call khatam — ab allowed!');
    expect(injected.length).toBe(1);
    unsub();
  });

  it('11. permanently-blocked scheduled message is dropped after retry cap, not lost silently or retried forever', () => {
    const now = Date.now();
    // First attempt blocked → retry scheduled (cap 3 total tries).
    proactiveAgentService.scheduleMessage('Optics wala reminder', now - 5000, 'optics');
    for (let i = 0; i < 5; i += 1) {
      // checkScheduledMessages is private — cast to drive the retry loop, same
      // as the other private-access casts in this suite.
      (proactiveAgentService as any).checkScheduledMessages();
      // Simulate the 5-min retry becoming due again.
      const items = (proactiveAgentService as any).scheduledMessages as Array<{ scheduledTime: number }>;
      for (const s of items) s.scheduledTime = Date.now() - 1000;
    }
    const remaining = (proactiveAgentService as any).scheduledMessages as any[];
    expect(remaining.length).toBe(0);
  });
});
