import WebSocket from "ws";
import type { Config } from "../config.js";
import type { components } from "../generated/api.js";
import type { Post } from "./client.js";

export type RealtimeEvent = components["schemas"]["RealtimeEvent"];

export type TimelineListener = {
	onPost(post: Post): Promise<void> | void;
	onError?(error: unknown): void;
};

export function connectRealtime(
	config: Config,
	listener: TimelineListener,
): () => void {
	let closed = false;
	let socket: WebSocket | undefined;
	let attempts = 0;
	let timer: NodeJS.Timeout | undefined;

	const connect = () => {
		if (closed) {
			return;
		}
		socket = new WebSocket(config.wsUrl, {
			headers: {
				Origin: config.wsOrigin,
				Cookie: `ciel_auth=${config.accessToken}`,
			},
		});

		socket.on("open", () => {
			attempts = 0;
			console.info(`[ws] connected ${config.wsUrl}`);
		});

		socket.on("message", (raw) => {
			try {
				const event = JSON.parse(String(raw)) as RealtimeEvent;
				if (
					event &&
					typeof event === "object" &&
					event.type === "post_created" &&
					"post" in event
				) {
					void listener.onPost(event.post);
				}
			} catch (error) {
				listener.onError?.(error);
			}
		});

		socket.on("error", (error) => {
			listener.onError?.(error);
		});

		socket.on("close", () => {
			if (closed) {
				return;
			}
			const delay = Math.min(1000 * 2 ** attempts, 30_000);
			attempts += 1;
			console.warn(`[ws] disconnected; retry in ${delay}ms`);
			timer = setTimeout(connect, delay);
		});
	};

	connect();

	return () => {
		closed = true;
		if (timer) {
			clearTimeout(timer);
		}
		socket?.close();
	};
}
