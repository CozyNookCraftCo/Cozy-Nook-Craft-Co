// Cozy Hearts loyalty program: shared logic.
//
// Rules
//   * Every full $10 of product subtotal (after discounts, before tax and
//     shipping) earns one heart. Spending adds up across orders, so a $6 order
//     and a $4 order together earn a heart.
//   * Ten hearts fill a card = one free altered composition notebook + pen.
//   * Only orders placed on/after the program start date count (editable in
//     the admin page).
//   * Sheri can add/remove hearts, log spending that didn't go through
//     Shopify (e.g. a TikTok LIVE cash/Venmo sale), and mark rewards redeemed.
//
// Storage (Netlify Blobs, site-wide store "cozy-hearts"). Everything is
// written as its own key, so nothing is ever read-modify-written:
//   orders/<email>/<orderId>   one record per Shopify order (overwritten by sync)
//   adj/<email>/<id>           one record per manual edit (append / delete only)
//   codes/<email>              optional card code for customers without orders
//   meta/settings              { startDate }
//   meta/shopify-token         cached Admin API token (client credentials)

import { getStore } from "@netlify/blobs";

export const DOLLARS_PER_HEART = 10;
export const HEARTS_PER_CARD = 10;
export const REWARD = "a free altered composition notebook + pen";
const DEFAULT_START = "2026-11-09";
const COUNTED_STATUSES = new Set(["PAID", "PARTIALLY_REFUNDED", "PARTIALLY_PAID", "REFUNDED"]);

// ---------- types ----------
export type OrderRec = {
  id: string; name: string; email: string; customerName: string;
  createdAt: string; subtotal: number; status: string; cancelled: boolean;
};
export type AdjRec = {
  id: string; email: string; kind: "hearts" | "spend" | "redeem";
  amount: number; note: string; at: string;
};
export type Settings = { startDate: string };

// ---------- helpers ----------
export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
export const isEmail = (e: string) => /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(e);
const ek = (email: string) => encodeURIComponent(normEmail(email));
const money = (n: number) => Math.round(n * 100) / 100;

let storeOverride: any = null;
export function _setStoreForTests(s: any) { storeOverride = s; }
export function store() {
  return storeOverride ?? getStore({ name: "cozy-hearts", consistency: "strong" });
}

const env = (k: string) => {
  try { return (globalThis as any).Netlify?.env?.get(k) ?? process.env[k]; }
  catch { return process.env[k]; }
};

export async function getSettings(): Promise<Settings> {
  const s = (await store().get("meta/settings", { type: "json" })) as Settings | null;
  return { startDate: s?.startDate || env("HEARTS_START_DATE") || DEFAULT_START };
}
export async function saveSettings(s: Settings) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate)) throw new Error("Start date must look like 2026-11-09");
  await store().setJSON("meta/settings", { startDate: s.startDate });
}

// ---------- the math (pure) ----------
export function computeCard(orders: OrderRec[], adjs: AdjRec[], startDate: string) {
  // Start of the start date in the shop's timezone (Pacific). Using 08:00Z keeps
  // it simple and errs on the side of counting an order placed that evening.
  const startMs = Date.parse(startDate + "T08:00:00Z");
  const counted = orders.filter(o =>
    !o.cancelled && COUNTED_STATUSES.has(o.status) && Date.parse(o.createdAt) >= startMs);
  const orderSpend = counted.reduce((t, o) => t + o.subtotal, 0);
  const manualSpend = adjs.filter(a => a.kind === "spend").reduce((t, a) => t + a.amount, 0);
  const spend = money(orderSpend + manualSpend);
  const heartsFromSpend = Math.max(0, Math.floor((spend + 1e-9) / DOLLARS_PER_HEART));
  const bonus = adjs.filter(a => a.kind === "hearts").reduce((t, a) => t + a.amount, 0);
  const redeemed = adjs.filter(a => a.kind === "redeem").reduce((t, a) => t + a.amount, 0);
  const earned = heartsFromSpend + bonus;
  const available = Math.max(0, earned - redeemed * HEARTS_PER_CARD);
  const rewardsReady = Math.floor(available / HEARTS_PER_CARD);
  const onCard = rewardsReady > 0 ? HEARTS_PER_CARD : available % HEARTS_PER_CARD;
  const toNextHeart = money(DOLLARS_PER_HEART - (spend % DOLLARS_PER_HEART || 0)) || DOLLARS_PER_HEART;
  return {
    spend, heartsFromSpend, bonusHearts: bonus, earned, rewardsRedeemed: redeemed,
    available, rewardsReady, onCard, extraHearts: Math.max(0, available - HEARTS_PER_CARD),
    toNextHeart, countedOrders: counted.map(o => o.name),
  };
}

// ---------- blob reads ----------
async function listJSON<T>(prefix: string): Promise<T[]> {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const out = await Promise.all(blobs.map((b: any) => s.get(b.key, { type: "json" })));
  return out.filter(Boolean) as T[];
}
export const ordersFor = (email: string) => listJSON<OrderRec>(`orders/${ek(email)}/`);
export const adjsFor = (email: string) => listJSON<AdjRec>(`adj/${ek(email)}/`);

export async function cardFor(email: string) {
  const [orders, adjs, settings] = await Promise.all([ordersFor(email), adjsFor(email), getSettings()]);
  return { orders, adjs, settings, card: computeCard(orders, adjs, settings.startDate) };
}

export async function addAdjustment(email: string, kind: AdjRec["kind"], amount: number, note: string) {
  if (!isEmail(normEmail(email))) throw new Error("Please enter a valid email");
  if (!["hearts", "spend", "redeem"].includes(kind)) throw new Error("Unknown edit type");
  if (!Number.isFinite(amount) || amount === 0) throw new Error("Amount can't be zero");
  if (kind === "redeem" && !Number.isInteger(amount)) throw new Error("Redeem a whole number of cards");
  if (kind === "hearts" && !Number.isInteger(amount)) throw new Error("Hearts must be a whole number");
  const at = new Date().toISOString();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rec: AdjRec = { id, email: normEmail(email), kind, amount: money(amount), note: String(note || "").slice(0, 300), at };
  await store().setJSON(`adj/${ek(email)}/${id}`, rec);
  return rec;
}
export async function deleteAdjustment(email: string, id: string) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Bad id");
  await store().delete(`adj/${ek(email)}/${id}`);
}

export async function getCode(email: string): Promise<string | null> {
  return (await store().get(`codes/${ek(email)}`)) as string | null;
}
export async function newCode(email: string) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = "HEART-" + Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
  await store().set(`codes/${ek(email)}`, code);
  return code;
}

// Everyone who has an order or an edit on file.
export async function allCustomers() {
  const s = store();
  const [o, a] = await Promise.all([s.list({ prefix: "orders/" }), s.list({ prefix: "adj/" })]);
  const emails = new Set<string>();
  for (const b of [...o.blobs, ...a.blobs]) emails.add(decodeURIComponent(b.key.split("/")[1]));
  const settings = await getSettings();
  const rows = await Promise.all([...emails].map(async email => {
    const [orders, adjs] = await Promise.all([ordersFor(email), adjsFor(email)]);
    const name = orders.find(x => x.customerName)?.customerName || "";
    return { email, name, ...computeCard(orders, adjs, settings.startDate) };
  }));
  return rows.sort((x, y) => y.available - x.available || x.email.localeCompare(y.email));
}

// ---------- Shopify ----------
const API_VERSION = "2025-10";
let memToken: { token: string; exp: number } | null = null;

async function shopifyToken(): Promise<string> {
  const fixed = env("SHOPIFY_ADMIN_TOKEN");
  if (fixed) return fixed;
  if (memToken && memToken.exp > Date.now() + 60_000) return memToken.token;
  const cached = (await store().get("meta/shopify-token", { type: "json" })) as typeof memToken;
  if (cached && cached.exp > Date.now() + 60_000) return (memToken = cached).token;
  const id = env("SHOPIFY_CLIENT_ID"), secret = env("SHOPIFY_CLIENT_SECRET");
  if (!id || !secret) throw new Error("Shopify isn't connected yet (missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)");
  const res = await fetch(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Shopify token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as { access_token: string; expires_in?: number };
  memToken = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 86_000) * 1000 };
  await store().setJSON("meta/shopify-token", memToken);
  return memToken.token;
}
const shopDomain = () => env("SHOPIFY_STORE_DOMAIN") || "cozy-nook-craft-co-2.myshopify.com";

async function gql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await shopifyToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) { memToken = null; await store().delete("meta/shopify-token"); }
  if (!res.ok) throw new Error(`Shopify API error ${res.status}`);
  const j = await res.json() as any;
  if (j.errors?.length) throw new Error("Shopify: " + j.errors.map((e: any) => e.message).join("; "));
  return j.data;
}

const ORDERS_Q = `query($q:String!,$after:String){
  orders(first:100, after:$after, query:$q, sortKey:CREATED_AT){
    pageInfo{hasNextPage endCursor}
    nodes{ id name email createdAt cancelledAt displayFinancialStatus
      customer{ displayName email: defaultEmailAddress{ emailAddress } }
      currentSubtotalPriceSet{ shopMoney{ amount } } }
  }}`;

export function toOrderRec(n: any): OrderRec | null {
  const email = normEmail(n.email || n.customer?.email?.emailAddress);
  if (!email) return null;
  return {
    id: String(n.id).split("/").pop()!, name: n.name, email,
    customerName: n.customer?.displayName || "",
    createdAt: n.createdAt,
    subtotal: money(parseFloat(n.currentSubtotalPriceSet?.shopMoney?.amount ?? "0")),
    status: n.displayFinancialStatus || "", cancelled: !!n.cancelledAt,
  };
}

export async function fetchOrders(search: string): Promise<OrderRec[]> {
  const out: OrderRec[] = [];
  let after: string | null = null;
  for (let page = 0; page < 30; page++) {
    const d: any = await gql(ORDERS_Q, { q: search, after });
    for (const n of d.orders.nodes) { const r = toOrderRec(n); if (r) out.push(r); }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

export async function saveOrders(orders: OrderRec[]) {
  const s = store();
  await Promise.all(orders.map(o => s.setJSON(`orders/${ek(o.email)}/${o.id}`, o)));
  return orders.length;
}

// Pull a customer's orders fresh from Shopify (used at lookup time).
export async function syncCustomer(email: string) {
  const safe = normEmail(email).replace(/["\\]/g, "");
  return saveOrders(await fetchOrders(`email:"${safe}"`));
}
// Pull every order updated since a date (scheduled + admin "sync now").
export async function syncSince(isoDate: string) {
  return saveOrders(await fetchOrders(`updated_at:>='${isoDate}'`));
}

// ---------- HTTP helpers ----------
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export function safeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
export { env };
