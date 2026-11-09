// Customer-facing: POST /api/hearts { email, proof }
// proof = any of their Shopify order numbers (e.g. 1013 or #1013) or a HEART- card code.
import type { Config } from "@netlify/functions";
import {
  cardFor, getCode, isEmail, json, normEmail, syncCustomer, REWARD, HEARTS_PER_CARD, DOLLARS_PER_HEART,
} from "../lib/hearts.mts";

export default async (req: Request) => {
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const email = normEmail(body?.email);
  const proof = String(body?.proof ?? "").trim().toUpperCase().replace(/^#/, "");
  if (!isEmail(email) || !proof) return json({ error: "Please enter your email and an order number." }, 400);

  // Refresh this customer's orders from Shopify; if Shopify is briefly
  // unreachable, fall back to what's already saved.
  let synced = true;
  try { await syncCustomer(email); } catch (e) { synced = false; console.error("sync failed", e); }

  const { orders, card } = await cardFor(email);
  const code = await getCode(email);
  const ok = orders.some(o => o.name.replace(/^#/, "").toUpperCase() === proof) || (!!code && code === proof);
  if (!ok) {
    return json({ error: "We couldn't match that email and order number. Check your order confirmation email, or message us and we'll help!" }, 404);
  }
  const firstName = (orders.find(o => o.customerName)?.customerName || "").split(" ")[0];
  return json({
    firstName, synced,
    heartsPerCard: HEARTS_PER_CARD, dollarsPerHeart: DOLLARS_PER_HEART, reward: REWARD,
    onCard: card.onCard, available: card.available, rewardsReady: card.rewardsReady,
    extraHearts: card.extraHearts, toNextHeart: card.toNextHeart, rewardsRedeemed: card.rewardsRedeemed,
  });
};

export const config: Config = {
  path: "/api/hearts",
  method: "POST",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 10 },
};
