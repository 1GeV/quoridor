const ROUTE = /^\/v1\/rooms\/([\w-]{43})\/(host|guest)$/;

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("quoridor-room-relay/v1", { headers: { "Cache-Control": "no-store" } });
    }
    const room = url.pathname.match(ROUTE);
    if (!room || url.search || request.method !== "GET") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const origin = request.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim());
    if (!origin || !allowed.includes(origin)) return new Response("Origin not allowed", { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
  },
};
