import assert from "node:assert/strict";
import test from "node:test";
import { completeExternal, extEndpoint, validExtBase } from "../external-ai.js";

const profile = { baseUrl: "https://example.invalid/v1", model: "test-model", apiKey: "test-only-not-a-real-secret" };
const messages = [{ role: "user", content: "Reply with OK" }];

test("external requests send credentials only to the chosen endpoint and omit cookies, redirects and referrers", async () => {
  let requests = 0;
  const result = await completeExternal(messages, { fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, "https://example.invalid/v1/chat/completions");
    assert.equal(options.headers.Authorization, `Bearer ${profile.apiKey}`);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.referrerPolicy, "no-referrer");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.messages, messages);
    assert.equal(JSON.stringify(body).includes(profile.apiKey), false);
    return Response.json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens_details: { cached_tokens: 7 } } });
  } }, profile);
  assert.equal(requests, 1);
  assert.deepEqual(result, { content: "OK", cacheRead: 7 });
});

test("unsafe endpoint URLs are rejected before transmitting a key", async () => {
  for (const baseUrl of ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid?key=secret", "https://example.invalid/#fragment", "file:///tmp/test", "javascript:alert(1)"]) {
    assert.equal(validExtBase(baseUrl), false);
    await assert.rejects(completeExternal(messages, { fetchImpl: () => { throw new Error("must not fetch"); } }, { ...profile, baseUrl }), /valid HTTPS/);
  }
  for (const baseUrl of ["http://localhost:1234/v1", "http://127.0.0.1:1234", "http://[::1]:1234", profile.baseUrl]) assert.equal(validExtBase(baseUrl), true);
  assert.equal(extEndpoint({ baseUrl: "https://example.invalid/v1/chat/completions/" }).url, "https://example.invalid/v1/chat/completions");
});

test("Anthropic requests preserve separate system instructions, images and cache markers", async () => {
  const conversation = [{ role: "system", content: "Stable rules" }, { role: "user", content: "Hello" },
    { role: "assistant", content: "Previous answer" }, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,YQ==" } }] }];
  const result = await completeExternal(conversation, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(options.headers["x-api-key"], profile.apiKey);
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.system[0], { type: "text", text: "Stable rules", cache_control: { type: "ephemeral" } });
    assert.equal(body.messages[0].content[0].cache_control.type, "ephemeral");
    assert.equal(body.messages[1].content[0].cache_control, undefined);
    assert.deepEqual(body.messages[2].content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "YQ==" } });
    return Response.json({ content: [{ type: "text", text: "OK" }], usage: { cache_read_input_tokens: 11 } });
  } }, { ...profile, baseUrl: "https://api.anthropic.com" });
  assert.deepEqual(result, { content: "OK", cacheRead: 11 });
});

test("provider errors and failed fetches cannot echo keys into the displayed error", async () => {
  for (const fetchImpl of [
    async () => new Response(JSON.stringify({ key: profile.apiKey }), { status: 401 }),
    async () => { throw new Error(`Failed request with key ${profile.apiKey}`); },
    async () => new Response(profile.apiKey),
  ]) {
    await assert.rejects(completeExternal(messages, { fetchImpl }, profile), (error) => !error.message.includes(profile.apiKey));
  }
});

test("browser network failures explain CORS without blaming a valid key or model", async () => {
  await assert.rejects(completeExternal(messages, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }, profile),
    /CORS.*preflight.*does not by itself mean the key or model is wrong/);
});

test("successful provider replies redact an exact echoed API key before display or move parsing", async () => {
  const result = await completeExternal(messages, { fetchImpl: async () => Response.json({
    choices: [{ message: { content: `{"move":"e2","say":"${profile.apiKey}"}` } }],
  }) }, profile);
  assert.equal(result.content.includes(profile.apiKey), false);
  assert.match(result.content, /\[API key redacted\]/);
});

test("oversized responses and empty replies fail safely", async () => {
  for (const response of [new Response("x".repeat(256 * 1024 + 1)), Response.json({ choices: [] })]) {
    await assert.rejects(completeExternal(messages, { fetchImpl: async () => response }, profile), /256 KiB|no message content/);
  }
});

test("a cancelled request sends nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await assert.rejects(completeExternal(messages, { signal: controller.signal, fetchImpl: () => { requests++; } }, profile), { name: "AbortError" });
  assert.equal(requests, 0);
});

test("endpoint format selection preserves full paths and never routes to a second provider", () => {
  for (const [protocol, suffix] of [["chat", "chat/completions"], ["responses", "responses"], ["anthropic", "messages"]]) {
    assert.equal(extEndpoint({ ...profile, protocol }).url, `https://example.invalid/v1/${suffix}`);
    assert.equal(extEndpoint({ ...profile, protocol, baseUrl: "https://example.invalid" }).url, `https://example.invalid/v1/${suffix}`);
    const explicit = extEndpoint({ ...profile, baseUrl: `https://example.invalid/v1/${suffix}` });
    assert.equal(explicit.protocol, protocol);
    assert.equal(explicit.url, `https://example.invalid/v1/${suffix}`);
  }
  assert.equal(extEndpoint({ ...profile, baseUrl: "https://example.invalid/custom/message", protocol: "anthropic" }).url, "https://example.invalid/custom/message");
  assert.equal(extEndpoint({ ...profile, baseUrl: "https://example.invalid/custom/response", protocol: "responses" }).url, "https://example.invalid/custom/response");
  assert.equal(extEndpoint({ ...profile, baseUrl: "https://example.invalid/gateway/invoke", protocol: "responses", fullEndpoint: true }).url, "https://example.invalid/gateway/invoke");
  assert.throws(() => extEndpoint({ ...profile, protocol: "unknown" }), /supported API protocol/);
  assert.throws(() => extEndpoint({ ...profile, baseUrl: "https://example.invalid/v1/messages", protocol: "responses" }), /disagree/);
});

test("Responses preserves instructions, history, images and cache counts without provider conversation storage", async () => {
  const conversation = [
    { role: "system", content: "Stable rules" },
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: [{ type: "text", text: "Current board" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,YQ==" } }] },
  ];
  let calls = 0;
  const result = await completeExternal(conversation, { maxTokens: 512, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://example.invalid/v1/responses");
    assert.equal(options.headers.Authorization, `Bearer ${profile.apiKey}`);
    assert.equal(options.headers["x-api-key"], undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.instructions, undefined);
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.equal(body.max_output_tokens, 512);
    for (const field of ["messages", "previous_response_id", "conversation", "max_tokens", "temperature"]) assert.equal(field in body, false);
    assert.deepEqual(body.input, [
      { role: "developer", content: "Stable rules" },
      { role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" },
      { role: "user", content: [{ type: "input_text", text: "Current board" }, { type: "input_image", image_url: "data:image/jpeg;base64,YQ==", detail: "auto" }] },
    ]);
    return Response.json({ status: "completed", output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"move":"e2",' }, { type: "output_text", text: '"say":"Advance"}' }] },
    ], usage: { input_tokens_details: { cached_tokens: 23 } } });
  } }, { ...profile, protocol: "responses" });
  assert.equal(calls, 1);
  assert.deepEqual(result, { content: '{"move":"e2","say":"Advance"}', cacheRead: 23 });
});

test("Responses rejects partial, failed and empty outputs without leaking provider errors or keys", async () => {
  for (const data of [
    { status: "incomplete", output_text: "A partial answer" },
    { status: "failed", error: { message: profile.apiKey } },
    { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] }] },
  ]) {
    await assert.rejects(completeExternal(messages, { fetchImpl: async () => Response.json(data) }, { ...profile, protocol: "responses" }),
      (error) => /did not complete|no message content/.test(error.message) && !error.message.includes(profile.apiKey));
  }
  const result = await completeExternal(messages, { fetchImpl: async () => Response.json({ output_text: `OK ${profile.apiKey}` }) }, { ...profile, protocol: "responses" });
  assert.equal(result.content, "OK [API key redacted]");
});

test("optional Effort is mapped per API format and Auto omits it", async () => {
  const cases = [
    { protocol: "chat", field: "reasoning_effort", effort: "low", reply: { choices: [{ message: { content: "OK" } }] } },
    { protocol: "responses", field: "reasoning", effort: "xhigh", reply: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] } },
    { protocol: "anthropic", field: "output_config", effort: "max", reply: { content: [{ type: "text", text: "OK" }] } },
  ];
  for (const item of cases) {
    let payload;
    const request = async (effort) => {
      await completeExternal(messages, { fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return Response.json(item.reply);
      } }, { ...profile, protocol: item.protocol, effort });
      return payload;
    };
    const automatic = await request("auto");
    assert.equal(item.field in automatic, false, `${item.protocol} Auto must omit its Effort field`);
    const selected = await request(item.effort);
    assert.deepEqual(selected[item.field], item.protocol === "responses" ? { effort: item.effort }
      : item.protocol === "anthropic" ? { effort: item.effort } : item.effort);
    if (item.protocol === "responses") assert.equal(selected.max_output_tokens, 8192);
    if (item.protocol === "anthropic") assert.equal(selected.max_tokens, 16384);
  }
});

test("even Extra high requests wait for the provider and accept in-flight cancellation", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout", () => { throw Error("Unexpected client timeout"); });
  const controller = new AbortController();
  const request = completeExternal(messages, { signal: controller.signal, fetchImpl: async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    return new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  } }, { ...profile, effort: "xhigh" });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(timeout.mock.callCount(), 0);
});
