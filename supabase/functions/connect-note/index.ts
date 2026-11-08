// Supabase Edge Function: connect-note
// Writes ONE short connecting note for a lesson section whose passages are scattered
// across books/chapters. Optional: if ANTHROPIC_API_KEY is not set, the app falls back
// to a plain template note that only lists the cited pages.
//
// Deploy:  supabase functions deploy connect-note
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//          (optional) supabase secrets set CLAUDE_MODEL=claude-opus-5-5

import Anthropic from "npm:@anthropic-ai/sdk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Passage = { cite: string; text: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ note: null, reason: "no_api_key" });

  // Supabase verifies the user's JWT before invoking (verify_jwt defaults to true),
  // so only the signed-in owner can call this.
  let body: { topic: string; section: string; level?: string; passages: Passage[] };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!body?.topic || !Array.isArray(body.passages) || body.passages.length === 0) {
    return json({ error: "missing topic/passages" }, 400);
  }

  // Keep the prompt small: the first ~120 words of each passage is enough to bridge them.
  const excerpts = body.passages.slice(0, 8).map((p, i) =>
    `[${i + 1}] (${p.cite})\n${p.text.split(/\s+/).slice(0, 120).join(" ")}`
  ).join("\n\n");

  const client = new Anthropic({ apiKey: key });
  try {
    const response = await client.beta.messages.create({
      model: Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system:
        "You write a single short connecting note (1-3 sentences, max 60 words) that helps a medical student " +
        "move between textbook passages that were gathered from different books or chapters. " +
        "Do not teach new facts and do not restate the passages; only orient the reader (what each passage " +
        "contributes and how they relate). Use only information present in the excerpts. " +
        "Cite pages inline exactly as given in parentheses, e.g. (Harrison's p. 312). Plain text only.",
      messages: [{
        role: "user",
        content: `Topic: ${body.topic}\nLesson section: ${body.section}\nReader level: ${body.level ?? "general medical student"}\n\nExcerpts:\n${excerpts}`,
      }],
    // deno-lint-ignore no-explicit-any
    } as any);

    if (response.stop_reason === "refusal") return json({ note: null, reason: "refusal" });
    const note = response.content
      // deno-lint-ignore no-explicit-any
      .filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
    return json({ note: note || null });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ note: null, reason: "rate_limited" });
    if (err instanceof Anthropic.AuthenticationError) return json({ note: null, reason: "bad_api_key" });
    if (err instanceof Anthropic.APIError) return json({ note: null, reason: `api_${err.status}` });
    return json({ note: null, reason: "network" });
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
