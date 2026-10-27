// Tiny HTTP router used by the diff-ask fixture suite.
// Marker words: alpha (routes), bravo (middleware), charlie (errors).

interface Route {
  method: string;
  path: string;
  handler: (req: Request) => Promise<Response>;
}

const routes: Route[] = [];

function register(method: string, path: string, handler: Route["handler"]): void {
  routes.push({ method, path, handler });
}

register("GET", "/health", async () => {
  return new Response("ok", { status: 200 });
});

register("GET", "/alpha", async () => {
  const payload = { status: "running", uptime: 12345 };
  return Response.json(payload);
});

register("POST", "/bravo", async (req: Request) => {
  const body = await req.json();
  return Response.json({ received: body }, { status: 201 });
});

register("GET", "/charlie", async () => {
  return new Response("missing", { status: 404 });
});

export function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const match = routes.find((r) => r.method === req.method && r.path === url.pathname);
  if (!match) return Promise.resolve(new Response("not found", { status: 404 }));
  return match.handler(req);
}
