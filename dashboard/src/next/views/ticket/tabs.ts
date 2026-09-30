/** Which tab the ticket sheet opens on. The overlay only carries a task id, so a
 *  caller that wants a specific tab ("Why did it fail?" on a card) leaves a
 *  one-shot hint here before opening the sheet; any plain open clears it.
 *  Reading does not consume the hint, so StrictMode's double initialiser call
 *  sees the same answer both times. */

export type TicketTab = "story" | "why" | "raw";

let pending: { id: string; tab: TicketTab } | null = null;

export function requestTab(id: string, tab: TicketTab | null): void {
  pending = tab ? { id, tab } : null;
}

export function requestedTab(id: string): TicketTab | null {
  return pending && pending.id === id ? pending.tab : null;
}
