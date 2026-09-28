const CATEGORIES = [
  "Weltraum", "Tiere", "Biologie", "Mensch", "Geschichte",
  "Wissenschaft", "Technik", "Erde", "Kultur", "Kurioses"
];

const FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-z0-9_]{3,80}$" },
    fact: { type: "string", minLength: 10, maxLength: 500 },
    category: { type: "string", enum: CATEGORIES }
  },
  required: ["id", "fact", "category"]
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = createCorsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return originAllowed(origin, env.ALLOWED_ORIGIN)
        ? new Response(null, { status: 204, headers: corsHeaders })
        : json({ error: "Origin nicht erlaubt." }, 403, corsHeaders);
    }

    if (request.method !== "POST") return json({ error: "Methode nicht erlaubt." }, 405, corsHeaders);
    if (!originAllowed(origin, env.ALLOWED_ORIGIN)) return json({ error: "Origin nicht erlaubt." }, 403, corsHeaders);
    if (!env.OPENAI_API_KEY) return json({ error: "Server ist nicht konfiguriert." }, 500, corsHeaders);

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) return json({ error: "JSON erwartet." }, 415, corsHeaders);
    if (Number(request.headers.get("Content-Length") || 0) > 1024) return json({ error: "Anfrage zu groß." }, 413, corsHeaders);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Ungültiges JSON." }, 400, corsHeaders);
    }

    try {
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
        return json({ error: "Ungültige Anfrage." }, 400, corsHeaders);
      }

      const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
      const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-5-mini",
          instructions: "Du erstellst präzise, überprüfbare Random Facts und antwortest ausschließlich im verlangten JSON-Format.",
          input: `Erzeuge genau einen interessanten, überraschenden und nach bestem Wissen korrekten Random Fact aus der Kategorie ${category}.\n\nRegeln:\n- auf Deutsch\n- maximal 2 kurze Sätze\n- leicht verständlich\n- keine Meinung\n- keine erfundenen Behauptungen\n- keine extrem offensichtlichen Allgemeinplätze\n- bevorzugt interessante oder überraschende Fakten\n- id ist eine kurze, beschreibende, eindeutige englische snake_case-ID\n- category muss exakt \"${category}\" sein`,
          max_output_tokens: 180,
          text: {
            format: {
              type: "json_schema",
              name: "random_fact",
              strict: true,
              schema: FACT_SCHEMA
            }
          }
        })
      });

      if (!openAIResponse.ok) {
        console.error("OpenAI request failed", openAIResponse.status);
        return json({ error: "Fact konnte nicht erzeugt werden." }, 502, corsHeaders);
      }

      const responseData = await openAIResponse.json();
      const outputText = extractOutputText(responseData);
      let fact;
      try { fact = JSON.parse(outputText); } catch { return json({ error: "Ungültige KI-Antwort." }, 502, corsHeaders); }

      if (!isValidFact(fact, category)) return json({ error: "Ungültige KI-Antwort." }, 502, corsHeaders);
      return json(fact, 200, corsHeaders);
    } catch (error) {
      console.error("Worker error", error instanceof Error ? error.message : "Unknown error");
      return json({ error: "Interner Serverfehler." }, 500, corsHeaders);
    }
  }
};

function extractOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function isValidFact(value, category) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3
    && typeof value.id === "string" && /^[a-z0-9_]{3,80}$/.test(value.id)
    && typeof value.fact === "string" && value.fact.length >= 10 && value.fact.length <= 500
    && value.category === category;
}

function originAllowed(origin, allowedOrigin) {
  return Boolean(origin && allowedOrigin && origin === allowedOrigin);
}

function createCorsHeaders(origin, allowedOrigin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
  if (originAllowed(origin, allowedOrigin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), { status, headers });
}
