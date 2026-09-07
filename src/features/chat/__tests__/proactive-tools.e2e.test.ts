import { describe, it, expect } from 'vitest';
import { createContainer } from '../../../di/container';

/**
 * Proactive tools end-to-end — SAME path jo live call (handleExecuteLiveTool)
 * use karta hai: ChatToolsService.runMany → runProactiveAction →
 * proactiveAgentService singleton. Ye poora chhain lock karta hai taaki
 * schedule/list/cancel/make-call kabhi regress na ho.
 */
describe('Proactive tools end-to-end via ChatToolsService (live-call path)', () => {
  const container = createContainer();
  const now = Date.now();
  const future = now + 60 * 60 * 1000; // +1h

  it('schedules, lists, then cancels a message with linkedEntity', async () => {
    const sched = await container.chatTools.runMany([
      { action: 'scheduleMessage', text: 'kya progress hai?', scheduledAtISO: new Date(future).toISOString(), linkedEntity: { type: 'todo', value: 'physics' } },
    ]);
    expect(sched.ok).toBe(true);
    const schedId = sched.summary.match(/\(id ([^)]+)\)/)?.[1];
    expect(schedId).toBeTruthy();

    const list = await container.chatTools.runMany([{ action: 'listScheduled' }]);
    expect(list.ok).toBe(true);
    expect(list.summary).toContain('kya progress hai?');

    const cancel = await container.chatTools.runMany([{ action: 'cancelScheduled', id: schedId! }]);
    expect(cancel.ok).toBe(true);
    expect(cancel.summary).toContain('cancelled');
  });

  it('rejects past-time scheduling', async () => {
    const past = await container.chatTools.runMany([
      { action: 'scheduleMessage', text: 'past', scheduledAtISO: new Date(now - 1000).toISOString() },
    ]);
    expect(past.ok).toBe(false);
  });

  it('schedules+lists+cancels a call', async () => {
    const sched = await container.chatTools.runMany([
      { action: 'scheduleCall', reason: 'revision check', scheduledAtISO: new Date(future).toISOString() },
    ]);
    expect(sched.ok).toBe(true);
    const id = sched.summary.match(/\(id ([^)]+)\)/)?.[1];

    const list = await container.chatTools.runMany([{ action: 'listScheduled' }]);
    expect(list.summary).toContain('revision check');

    const cancel = await container.chatTools.runMany([{ action: 'cancelScheduled', id: id! }]);
    expect(cancel.ok).toBe(true);
  });

  it('makeCall triggers an incoming call (proactive singleton reachable)', async () => {
    const res = await container.chatTools.runMany([{ action: 'makeCall', reason: 'progress talk' }]);
    expect(res.ok).toBe(true);
    expect(res.summary).toContain('IncomingCall');
  });

  it('scheduleMessage/makeCall/scheduleCall run immediately WITHOUT explicit confirmation (user asked explicitly)', async () => {
    // Permissions intent: ye tools sirf user ke EXPLICIT request par chalte hain,
    // isliye koi aur Yes/No permission step nahi. Bina confirmed ke directly run.
    const sched = await container.chatTools.runMany([
      { action: 'scheduleMessage', text: 'confirm me', scheduledAtISO: new Date(future).toISOString() },
    ]);
    expect(sched.ok).toBe(true);
    expect(sched.requiresConfirmation).not.toBe(true);
    expect(sched.summary).toContain('Message scheduled');

    const call = await container.chatTools.runMany([{ action: 'makeCall', reason: 'confirm me' }]);
    expect(call.ok).toBe(true);
    expect(call.requiresConfirmation).not.toBe(true);
    expect(call.summary).toContain('IncomingCall');

    const schedCall = await container.chatTools.runMany([
      { action: 'scheduleCall', reason: 'confirm me', scheduledAtISO: new Date(future).toISOString() },
    ]);
    expect(schedCall.ok).toBe(true);
    expect(schedCall.requiresConfirmation).not.toBe(true);
    expect(schedCall.summary).toContain('Call scheduled');

    // listScheduled / cancelScheduled are read/cleanup — still fire without confirm.
    const list = await container.chatTools.runMany([{ action: 'listScheduled' }]);
    expect(list.requiresConfirmation).not.toBe(true);
  });
});
