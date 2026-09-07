/**
 * Global "a live voice call is currently active" flag.
 *
 * The proactive agent consults this before dispatching incoming-call triggers /
 * nudges so a scheduled or inactivity call never lands on top of an ALREADY
 * running live call. Owned by the live overlay (set on open, cleared when no
 * overlay owns the call anymore) — a tiny module on purpose: services import
 * it without pulling in any component code.
 */
let liveCallActive = false;

export function setLiveCallActive(active: boolean): void {
  liveCallActive = active;
}

export function isLiveCallActive(): boolean {
  return liveCallActive;
}