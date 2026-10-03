// stdlib-only reverse proxy: the jump-cannon Sessions UI is compiled against
// 127.0.0.1:8765, but the graph-api serving that data is the same process the
// graph view already talks to. Forward paths verbatim rather than
// reimplementing them, so the upstream contract stays the real one and there is
// nothing here to drift. Loopback only.
import http from "node:http";

const listenPort = Number(process.env.OMP_GRAPH_PROXY_PORT ?? 8765);
const upstreamHost = process.env.OMP_GRAPH_UPSTREAM_HOST ?? "127.0.0.1";
const upstreamPort = Number(process.env.OMP_GRAPH_UPSTREAM_PORT ?? 8799);

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${upstreamHost}:${upstreamPort}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `upstream ${upstreamHost}:${upstreamPort} unreachable`, detail: String(err) }));
  });
  req.pipe(upstream);
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`[omp-graph-proxy] 127.0.0.1:${listenPort} -> ${upstreamHost}:${upstreamPort}`);
});