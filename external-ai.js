// Browser-direct, opt-in AI requests. No project relay or embedded credentials.
export const EXTERNAL_PROTOCOLS = ["auto", "chat", "responses", "anthropic"];
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const EXTENDED_EFFORT = { xhigh: { tokens: 8192, seconds: 90 }, max: { tokens: 16384, seconds: 180 } };
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
  url.pathname = detected || profile.fullEndpoint ? pathname
    : pathname + (/\/v\d+(?:beta)?$/i.test(pathname) ? "" : "/v1") + suffix;
  return { url: url.href, protocol, anthropic: protocol === "anthropic" };
}

function reasoningTokenLimit(maxTokens, effort) {
  // Reasoning and visible text can share the same output limit.
  return Math.max(maxTokens, EXTENDED_EFFORT[effort]?.tokens ?? 2048);
}

export function responsesBody(messages, profile, maxTokens) {
  const hasEffort = EFFORT_LEVELS.includes(profile.effort);
  const instructions = messages.filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => m.content).filter(Boolean).join("\n\n");
  const input = messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") return { role, content: m.content };
    const content = (Array.isArray(m.content) ? m.content : []).map((part) => {
      if (role === "user" && part?.type === "image_url") return { type: "input_image", image_url: part.image_url?.url, detail: "auto" };
      return { type: role === "assistant" ? "output_text" : "input_text", text: typeof part === "string" ? part : String(part?.text || "") };
    });
    return { role, content };
  });
  // Keep the selected conversation in browser memory; do not request a stored provider conversation.
  // Temperature is omitted because some reasoning models reject it.
  return { model: profile.model, ...(instructions ? { instructions } : {}), input,
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
  const body = { model: profile.model, max_tokens: maxTokens, temperature,
    messages: rest.map((message, index) => {
      const content = anthropicContent(message.content);
      if (index === rest.length - 2 && message.role === "assistant" && content.length) {
        content[content.length - 1] = { ...content.at(-1), cache_control: { type: "ephemeral" } };
      }
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

async function responseJson(response) {
  const tooLarge = () => new EndpointError("The endpoint response exceeds 256 KiB");
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EndpointError("The endpoint returned no response body");
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new EndpointError("The endpoint did not return valid JSON"); }
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
  const timeoutSeconds = EXTENDED_EFFORT[profile.effort]?.seconds ?? 30;
  const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    abort.throwIfAborted();
    const payload = anthropic ? anthropicBody(messages, profile, temperature, maxTokens)
      : protocol === "responses" ? responsesBody(messages, profile, maxTokens)
      : { model: profile.model, messages, stream: false,
        ...(EFFORT_LEVELS.includes(profile.effort)
          ? { reasoning_effort: profile.effort, max_completion_tokens: reasoningTokenLimit(maxTokens, profile.effort) }
          : { temperature, max_tokens: maxTokens }) };
    const response = await fetchImpl(url, {
      method: "POST", headers, signal: abort, credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", body: JSON.stringify(payload),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // An arbitrary provider can echo the submitted API key in its error body.
      throw new EndpointError(`Endpoint returned HTTP ${response.status}. Check the endpoint, model and key.`);
    }
    const data = await responseJson(response);
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
    if (timeout.aborted) throw new EndpointError(`Endpoint timed out after ${timeoutSeconds} seconds`);
    if (error instanceof EndpointError) throw error;
    throw new EndpointError("The browser could not reach the endpoint. This may be CORS/preflight, DNS/TLS, network or endpoint availability; it does not by itself mean the key or model is wrong.");
  }
}
