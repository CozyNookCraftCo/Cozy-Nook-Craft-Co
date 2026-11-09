// Sheri's admin API: POST /api/hearts-admin  (header x-admin-key: ADMIN password)
import type { Config } from "@netlify/functions";
import {
  addAdjustment, allCustomers, cardFor, deleteAdjustment, env, getCode, getSettings, isEmail, json,
  cleanupLegacyKeys, newCode, normEmail, safeEqual, saveSettings, syncCustomer, syncSince,
} from "../lib/hearts.mts";

export default async (req: Request) => {
  const pw = env("HEARTS_ADMIN_PASSWORD");
  if (!pw) return json({ error: "HEARTS_ADMIN_PASSWORD isn't set in Netlify yet." }, 503);
  if (!safeEqual(req.headers.get("x-admin-key") || "", pw)) return json({ error: "Wrong password" }, 401);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const email = normEmail(b.email);
  const needEmail = () => { if (!isEmail(email)) throw new Error("Please enter a valid email"); };

  try {
    switch (b.action) {
      case "ping":
        return json({ ok: true, settings: await getSettings() });
      case "list":
        return json({ customers: await allCustomers(), settings: await getSettings() });
      case "customer": {
        needEmail();
        let syncError = "";
        try { await syncCustomer(email); } catch (e: any) { syncError = e.message; }
        const d = await cardFor(email);
        return json({ ...d, code: await getCode(email), syncError });
      }
      case "adjust":
        needEmail();
        return json({ added: await addAdjustment(email, b.kind, Number(b.amount), b.note) });
      case "undo":
        needEmail();
        await deleteAdjustment(email, String(b.id));
        return json({ ok: true });
      case "code":
        needEmail();
        return json({ code: await newCode(email) });
      case "settings":
        await saveSettings({ startDate: String(b.startDate) });
        return json({ settings: await getSettings() });
      case "sync": {
        const { startDate } = await getSettings();
        const cleaned = await cleanupLegacyKeys();
        return json({ synced: await syncSince(startDate), cleaned });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e: any) {
    return json({ error: e.message || "Something went wrong" }, 400);
  }
};

export const config: Config = {
  path: "/api/hearts-admin",
  method: "POST",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 60 },
};
