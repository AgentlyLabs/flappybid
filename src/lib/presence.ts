// Presence math, shared by the public /api/presence route and the admin
// dashboard.

// Online = heartbeated within the last 90s. The client only pings while its
// tab is visible (every 30s), so this means "looking at the page just now" —
// the window is 3 ping intervals wide to forgive one delayed or dropped beat
// without flickering someone offline.
export const ONLINE_WINDOW_MS = 90_000;
