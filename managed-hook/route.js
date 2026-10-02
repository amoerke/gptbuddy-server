#!/usr/bin/env node
"use strict";

// Deploy this file plus the environment variables below through device management.
// It deliberately contains no provider API key.
const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

const routerUrl = process.env.GPTBUDDY_ROUTER_URL || "https://gptbuddy.dataminer.cloud/v1/route";
const clientId = process.env.GPTBUDDY_CLIENT_ID || "";
const clientSecret = process.env.GPTBUDDY_CLIENT_SECRET || "";
const maxPromptCharacters = Number(process.env.GPTBUDDY_MAX_PROMPT_CHARACTERS || 12000);

function fallback() {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "gptbuddy routing decision: keep_root. No delegation recommendation." } };
}

function requestRoute(prompt) {
  const body = JSON.stringify({ prompt: prompt.slice(0, maxPromptCharacters) });
  const timestamp = String(Date.now());
  const signature = crypto.createHmac("sha256", clientSecret).update(`${timestamp}.${body}`).digest("hex");
  const target = new URL(routerUrl);
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Gptbuddy-Client-Id": clientId, "X-Gptbuddy-Timestamp": timestamp, "X-Gptbuddy-Signature": signature } }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error("router_error"));
        try { resolve(JSON.parse(responseBody)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  if (!clientId || !clientSecret || typeof event.prompt !== "string" || event.prompt.trim().startsWith("/")) return console.log(JSON.stringify(fallback()));
  const route = await requestRoute(event.prompt);
  if (!route.delegate || !["fast", "standard"].includes(route.target)) return console.log(JSON.stringify(fallback()));
  const context = `gptbuddy routing decision: delegate the entire task exactly once to the \`${route.target}\` subagent role. confidence=${route.confidence.toFixed(2)}; context_need=${route.needs_context.toFixed(2)}. This route is eligible specifically because the task is self-contained; use the root session only if no subagent is available.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
}

main().catch(() => console.log(JSON.stringify(fallback())));
