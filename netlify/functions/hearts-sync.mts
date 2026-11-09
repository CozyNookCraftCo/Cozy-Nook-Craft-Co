// Every hour, save any Shopify orders created or changed in the last 3 days, so
// hearts stay on file permanently (Shopify's API only shows recent orders) and
// refunds/cancellations are reflected.
import type { Config } from "@netlify/functions";
import { syncSince } from "../lib/hearts.mts";

export default async () => {
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const n = await syncSince(since);
  console.log(`Cozy Hearts: synced ${n} orders updated since ${since}`);
};

// Minute 17 of every hour (UTC; hourly so no timezone conversion needed).
export const config: Config = { schedule: "17 * * * *" };
