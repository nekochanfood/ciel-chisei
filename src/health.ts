import http from "node:http";

export function startHealthServer(
	port: number,
	isReady: () => boolean,
): http.Server {
	const server = http.createServer((request, response) => {
		if (request.url === "/healthz" || request.url === "/health") {
			const ready = isReady();
			const body = JSON.stringify({ ok: ready });
			response.writeHead(ready ? 200 : 503, {
				"content-type": "application/json",
			});
			response.end(body);
			return;
		}
		response.writeHead(404);
		response.end();
	});
	server.listen(port, () => {
		console.info(`[health] listening on :${port}`);
	});
	return server;
}
