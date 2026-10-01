"use strict";

const crypto = require("crypto");
const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const JEV_API_KEY = process.env.JEV_API_KEY || "";
const JEV_API_URL = process.env.JEV_API_URL || "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = process.env.JEV_MODEL || "jev-latest";
const CLIENT_SECRETS = parseClientSecrets();
const MAX_PROMPT_CHARACTERS = Number(process.env.MAX_PROMPT_CHARACTERS || 12000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 4000);
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 120);
const replayCache = new Map();
const rateLimits = new Map();

const routeQuestion = {
  type: "choice",
  instructions: "Choose the cheapest safe handling tier for this coding-agent prompt. Choose expert whenever uncertain, when the task needs earlier conversation or repository exploration, is broad or ambiguous, requires security, privacy, production judgment, user decisions, or coordination with concurrent edits.",
  criteria: {
    fast: "Short, fully self-contained explanation, analysis, lookup, or mechanical task.",
    standard: "Bounded task with explicit scope that can be completed independently.",
    expert: "Keep the task in the root agent session because it is context-dependent, risky, broad, ambiguous, or otherwise unsuitable for delegation.",
  },
};

const contextQuestion = {
  type: "noul",
  instructions: "Does this prompt require prior conversation, repository context, or clarification from the user to complete safely? Answer yes whenever uncertain.",
};

function parseClientSecrets() {
  const clientId = process.env.ROUTER_CLIENT_ID || "";
  const clientSecret = process.env.ROUTER_CLIENT_SECRET || "";
  if (clientId || clientSecret) {
    if (clientId && clientSecret) return { [clientId]: clientSecret };
    console.error("ROUTER_CLIENT_ID and ROUTER_CLIENT_SECRET must be set together.");
    process.exit(1);
  }

  const encodedValue = process.env.ROUTER_CLIENTS_B64 || "";
  const value = encodedValue
    ? Buffer.from(encodedValue, "base64").toString("utf8")
    : process.env.ROUTER_CLIENTS_JSON || "{}";
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    console.error("Set ROUTER_CLIENT_ID plus ROUTER_CLIENT_SECRET, ROUTER_CLIENTS_B64, or ROUTER_CLIENTS_JSON.");
    process.exit(1);
  }
}

function routeFallback(reason) {
  return { target: "expert", confidence: 0, needs_context: 1, reason, delegate: false };
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function readBody(request, limit = 16000) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > limit) {
        reject(Object.assign(new Error("body_too_large"), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safeEqual(left, right) {
  const a = Buffer.from(left || "", "utf8");
  const b = Buffer.from(right || "", "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticate(request, rawBody) {
  const clientId = request.headers["x-gptbuddy-client-id"];
  const timestamp = request.headers["x-gptbuddy-timestamp"];
  const signature = request.headers["x-gptbuddy-signature"];
  const secret = CLIENT_SECRETS[clientId];
  if (typeof clientId !== "string" || typeof timestamp !== "string" || typeof signature !== "string" || typeof secret !== "string") return null;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) return null;
  const canonical = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  if (!safeEqual(signature, expected)) return null;
  const replayKey = `${clientId}:${signature}`;
  if (replayCache.has(replayKey)) return null;
  replayCache.set(replayKey, Date.now() + 60_000);
  return clientId;
}

function allowRequest(clientId) {
  const now = Date.now();
  const bucket = rateLimits.get(clientId) || [];
  const fresh = bucket.filter((timestamp) => timestamp > now - 60_000);
  if (fresh.length >= RATE_LIMIT_PER_MINUTE) {
    rateLimits.set(clientId, fresh);
    return false;
  }
  fresh.push(now);
  rateLimits.set(clientId, fresh);
  return true;
}

function validateJevAnswers(answers) {
  const route = answers && answers.route;
  const context = answers && answers.needs_context;
  if (!route || !["fast", "standard", "expert"].includes(route.choice)) throw new Error("invalid_route_choice");
  if (typeof context.noul !== "number" || context.noul < 0 || context.noul > 1) throw new Error("invalid_context_score");
  const confidence = typeof route.confidence === "number" ? route.confidence : route.probabilities && route.probabilities[route.choice];
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) throw new Error("invalid_route_confidence");
  return { target: route.choice, confidence, needs_context: context.noul, reason: "jev" };
}

async function routePrompt(prompt, requestId) {
  if (!JEV_API_KEY) return routeFallback("router_misconfigured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const apiResponse = await fetch(JEV_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${JEV_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: prompt,
        questions: { route: routeQuestion, needs_context: contextQuestion },
      }),
    });
    if (!apiResponse.ok) throw new Error(`jev_${apiResponse.status}`);
    const response = await apiResponse.json();
    const route = validateJevAnswers(response.answers);
    const delegate = route.target === "fast"
      ? route.confidence >= 0.94 && route.needs_context <= 0.45
      : route.target === "standard" && route.confidence >= 0.9 && route.needs_context <= 0.45;
    const finalRoute = { ...route, delegate };
    if (!delegate) finalRoute.target = "expert";
    return finalRoute;
  } catch (error) {
    return routeFallback(`router_unavailable:${error.name || "Error"}`);
  } finally {
    clearTimeout(timeout);
  }
}

function cleanCaches() {
  const now = Date.now();
  for (const [key, expiresAt] of replayCache.entries()) if (expiresAt <= now) replayCache.delete(key);
  for (const [key, timestamps] of rateLimits.entries()) {
    const fresh = timestamps.filter((timestamp) => timestamp > now - 60_000);
    if (fresh.length) rateLimits.set(key, fresh); else rateLimits.delete(key);
  }
}

async function handler(request, response) {
  if (request.method === "GET" && request.url === "/healthz") return writeJson(response, 200, { status: "ok" });
  if (request.method !== "POST" || request.url !== "/v1/route") return writeJson(response, 404, { error: "not_found" });
  try {
    const rawBody = await readBody(request);
    const clientId = authenticate(request, rawBody);
    if (!clientId) return writeJson(response, 401, { error: "unauthorized" });
    if (!allowRequest(clientId)) return writeJson(response, 429, { error: "rate_limited" });
    const payload = JSON.parse(rawBody);
    if (!payload || typeof payload.prompt !== "string") return writeJson(response, 400, { error: "invalid_prompt" });
    const prompt = payload.prompt.slice(0, MAX_PROMPT_CHARACTERS);
    const requestId = crypto.randomUUID();
    const route = await routePrompt(prompt, requestId);
    console.log(JSON.stringify({ event: "route", request_id: requestId, client_id: clientId, prompt_sha256: crypto.createHash("sha256").update(prompt).digest("hex"), prompt_length: prompt.length, target: route.target, delegate: route.delegate }));
    return writeJson(response, 200, { ...route, request_id: requestId });
  } catch (error) {
    return writeJson(response, error.status || 400, { error: "bad_request" });
  }
}

if (require.main === module) {
  if (!JEV_API_KEY) console.warn("JEV_API_KEY is not set; all requests will safely remain in the root session.");
  if (!Object.keys(CLIENT_SECRETS).length) console.warn("ROUTER_CLIENTS_JSON is empty; all router requests will be rejected.");
  http.createServer(handler).listen(PORT, "0.0.0.0", () => console.log(`gptbuddy router listening on ${PORT}`));
  setInterval(cleanCaches, 60_000).unref();
}

module.exports = { handler, routeFallback, validateJevAnswers };
