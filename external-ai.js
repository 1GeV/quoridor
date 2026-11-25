// Browser-direct, opt-in AI requests. No project relay or embedded credentials.
export const EXTERNAL_PROTOCOLS = ["auto", "chat", "responses", "anthropic"];
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const REASONING_TOKENS = { xhigh: 8192, max: 16384 };
export const EXTERNAL_EFFORTS = ["auto", ...EFFORT_LEVELS];
export function validExtBase(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.hash || url.search) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

export function extEndpoint(profile) {
  if (!validExtBase(profile.baseUrl)) throw new Error("Use an HTTPS or localhost endpoint without credentials, a query or a fragment");
  const url = new URL(profile.baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  const requested = profile.protocol || "auto";
  if (!EXTERNAL_PROTOCOLS.includes(requested)) throw new Error("Choose a supported API protocol");
  const detected = /\/messages?$/i.test(pathname) ? "anthropic"
    : /\/responses?$/i.test(pathname) ? "responses"
    : /\/chat\/completions?$/i.test(pathname) ? "chat" : null;
  const protocol = requested === "auto" ? detected || (url.hostname === "api.anthropic.com" ? "anthropic" : "chat") : requested;
  if (detected && requested !== "auto" && protocol !== detected) throw new Error("The endpoint path and API protocol disagree");
  const suffix = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" }[protocol];
  if (!profile.fullEndpoint) {
    url.pathname = detected ? pathname : pathname + (/\/v\d+(?:beta)?$/i.test(pathname) ? "" : "/v1") + suffix;
  }
  return { url: url.href, protocol, anthropic: protocol === "anthropic" };
}

function reasoningTokenLimit(maxTokens, effort) {
  // Reasoning and visible text can share the same output limit.
  return Math.max(maxTokens, REASONING_TOKENS[effort] ?? 2048);
}

export function responsesBody(messages, profile, maxTokens) {
  const hasEffort = EFFORT_LEVELS.includes(profile.effort);
  // Keep reusable rules at the start of input. Top-level instructions can
  // sit beyond cacheable prefix boundaries on newer Responses models.
  const input = messages.map((m) => {
    const role = m.role === "system" ? "developer" : m.role;
    if (typeof m.content === "string") return { role, content: m.content };
    const content = (Array.isArray(m.content) ? m.content : []).map((part) => {
      if (role === "user" && part?.type === "image_url") return { type: "input_image", image_url: part.image_url?.url, detail: "auto" };
      return { type: role === "assistant" ? "output_text" : "input_text", text: typeof part === "string" ? part : String(part?.text || "") };
    });
    return { role, content };
  });
  // Keep the selected conversation in browser memory; do not request a stored provider conversation.
  // Temperature is omitted because some reasoning models reject it.
  return { model: profile.model, input,
    max_output_tokens: hasEffort ? reasoningTokenLimit(maxTokens, profile.effort) : maxTokens, stream: false, store: false,
    ...(hasEffort ? { reasoning: { effort: profile.effort } } : {}) };
}

function anthropicContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content || "") }];
  return content.map((part) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (part?.type === "image_url") {
      const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url?.url || "");
      return match ? { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }
        : { type: "text", text: "[image omitted]" };
    }
    return { type: "text", text: String(part?.text || "") };
  });
}

export function anthropicBody(messages, profile, temperature, maxTokens) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).filter(Boolean).join("\n\n");
  const rest = messages.filter((message) => message.role !== "system");
  // Advance the checkpoint with the conversation. An image follow-up uses the
  // last text request, since only its text is carried into the next turn.
  const checkpoint = system ? rest.findLastIndex((message) =>
    message.role === "user" && typeof message.content === "string") : -1;
  const body = { model: profile.model, max_tokens: maxTokens, temperature,
    messages: rest.map((message, index) => {
      const content = anthropicContent(message.content);
      if (index === checkpoint) content[0].cache_control = { type: "ephemeral" };
      return { role: message.role === "assistant" ? "assistant" : "user", content };
    }),
  };
  if (EFFORT_LEVELS.includes(profile.effort)) {
    body.output_config = { effort: profile.effort };
    body.max_tokens = reasoningTokenLimit(maxTokens, profile.effort);
  }
  if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  return body;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
class EndpointError extends Error {}

function externalEventStream(protocol) {
  let pending = "", content = "", usage, result, finished = false;
  const invalid = () => new EndpointError("The endpoint returned an invalid or incomplete event stream");
  function consume(text, end) {
    pending += text;
    const frames = pending.split(/\r?\n\r?\n/);
    pending = end ? "" : frames.pop();
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const raw = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!raw) continue;
      if (raw === "[DONE]") {
        if (protocol !== "chat") throw invalid();
        result = { choices: [{ message: { content } }], usage };
        break;
      }
      let data;
      try { data = JSON.parse(raw); }
      catch { throw invalid(); }
      const type = data?.type ?? lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      if (data?.error || ["error", "response.failed", "response.incomplete", "response.cancelled"].includes(type)) throw invalid();
      if (protocol === "responses") {
        if (type === "response.completed" && data.response) { result = data.response; break; }
      } else if (protocol === "anthropic") {
        if (type === "message_start") usage = data.message?.usage;
        if (type === "content_block_start" && data.content_block?.type === "text") content += data.content_block.text ?? "";
        if (type === "content_block_delta" && data.delta?.type === "text_delta") content += data.delta.text ?? "";
        if (type === "message_delta") usage = { ...usage, ...data.usage };
        if (type === "message_stop") { result = { content: [{ type: "text", text: content }], usage }; break; }
      } else {
        const choices = Array.isArray(data?.choices) ? data.choices : [];
        const choice = choices.find((item) => item?.index === 0) ?? choices[0];
        if (!finished && typeof choice?.delta?.content === "string") content += choice.delta.content;
        if (choice?.finish_reason === "stop") finished = true;
        usage = data?.usage ?? usage;
      }
    }
    if (end && !result) {
      if (protocol === "chat" && finished) result = { choices: [{ message: { content } }], usage };
      else throw invalid();
    }
    return result;
  }
  return consume;
}

async function responseData(response, protocol) {
  const tooLarge = () => new EndpointError("The endpoint response exceeds 256 KiB");
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EndpointError("The endpoint returned no response body");
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const decoder = new TextDecoder();
  let readEvents = type === "text/event-stream" ? externalEventStream(protocol) : null;
  let text = "", length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      length += value?.byteLength ?? 0;
      if (length > MAX_RESPONSE_BYTES) throw tooLarge();
      const chunk = decoder.decode(value, { stream: !done });
      if (readEvents) {
        const result = readEvents(chunk, done);
        if (result) return result;
      } else {
        text += chunk;
        // Some compatible endpoints send SSE with a generic content type.
        if (/^(?::|(?:data|event|id|retry):)/.test(text.trimStart())) {
          readEvents = externalEventStream(protocol);
          const result = readEvents(text.trimStart(), done);
          if (result) return result;
          text = "";
        }
      }
      if (done) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try { return JSON.parse(text); }
  catch {
    if (type === "text/html" || /^\s*(?:<!doctype html\b|<html\b)/i.test(text)) {
      throw new EndpointError("The endpoint returned an HTML page instead of an API response. Check the Base URL and API format.");
    }
    if (!text.trim()) throw new EndpointError("The endpoint returned an empty response");
    throw new EndpointError("The endpoint returned a response that could not be parsed as JSON. Check the Base URL and API format.");
  }
}

export async function completeExternal(messages, {
  temperature = 0.2, maxTokens = 420, signal, fetchImpl = globalThis.fetch,
} = {}, profile) {
  if (typeof profile?.model !== "string" || !profile.model.trim() || !validExtBase(profile.baseUrl)) {
    throw new EndpointError("Use a valid HTTPS or localhost endpoint and model");
  }
  const { url, protocol, anthropic } = extEndpoint(profile);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (profile.apiKey) headers[anthropic ? "x-api-key" : "Authorization"] = anthropic ? profile.apiKey : `Bearer ${profile.apiKey}`;
  if (anthropic) {
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  let stage = "prepare";
  try {
    signal?.throwIfAborted();
    const payload = anthropic ? anthropicBody(messages, profile, temperature, maxTokens)
      : protocol === "responses" ? responsesBody(messages, profile, maxTokens)
      : { model: profile.model, messages, stream: false,
        ...(EFFORT_LEVELS.includes(profile.effort)
          ? { reasoning_effort: profile.effort, max_completion_tokens: reasoningTokenLimit(maxTokens, profile.effort) }
          : { temperature, max_tokens: maxTokens }) };
    const body = JSON.stringify(payload);
    stage = "connect";
    const response = await fetchImpl(url, {
      method: "POST", headers, signal, credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", body,
    });
    stage = "read";
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // An arbitrary provider can echo the submitted API key in its error body.
      throw new EndpointError(`Endpoint returned HTTP ${response.status}. Check the endpoint, model and key.`);
    }
    const data = await responseData(response, protocol);
    signal?.throwIfAborted();
    if (protocol === "responses" && (data?.error || ["failed", "cancelled", "incomplete"].includes(data?.status))) {
      throw new EndpointError("The Responses request did not complete. Check the model and output token limit.");
    }
    let content = anthropic
      ? (Array.isArray(data?.content) ? data.content.filter((part) => part?.type === "text").map((part) => part.text).join("") : "")
      : protocol === "responses" ? (Array.isArray(data?.output) ? data.output
        .filter((item) => item?.type === "message" && item.role === "assistant")
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .filter((part) => part?.type === "output_text").map((part) => part.text).join("") : data?.output_text)
      : data?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) content = content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
    if (typeof content !== "string" || !content.trim()) throw new EndpointError("Endpoint returned no message content");
    if (profile.apiKey) content = content.split(profile.apiKey).join("[API key redacted]");
    const cacheRead = Number(anthropic ? data?.usage?.cache_read_input_tokens : protocol === "responses"
      ? data?.usage?.input_tokens_details?.cached_tokens : data?.usage?.prompt_tokens_details?.cached_tokens) || 0;
    return { content, cacheRead };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (error instanceof EndpointError) throw error;
    if (stage === "connect") {
      throw new EndpointError("The browser could not connect. Check the endpoint URL, redirects and CORS/preflight in the browser Network panel.");
    }
    if (stage === "read") throw new EndpointError("Could not read the endpoint response. The connection may have been interrupted.");
    throw new EndpointError("Could not prepare the request to the endpoint.");
  }
}
