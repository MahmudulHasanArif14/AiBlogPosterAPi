// The platform's own timezone. Everything that means "a day" — the single daily
// generation slot, rotation fairness, article date display — resolves through
// this, never through the server's local time or UTC.
//
// Vercel cron schedules are UTC-only, so vercel.json carries a UTC trigger
// while the slot itself is keyed on the London calendar date in Postgres. That
// split is what makes the daily schedule survive BST transitions.
export const PLATFORM_TIMEZONE = "Europe/London";

export const PLATFORM_LOCALE = "en-GB";
