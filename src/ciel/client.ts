import createClient, { type Client } from "openapi-fetch";
import type { Config } from "../config.js";
import type { components, paths } from "../generated/api.js";

export type Post = components["schemas"]["Post"];
export type User = components["schemas"]["User"];
export type TimelinePage = components["schemas"]["TimelinePage"];
export type CielClient = {
	raw: Client<paths>;
	me(): Promise<User>;
	timeline(params?: {
		limit?: number;
		cursor?: string | null;
	}): Promise<TimelinePage>;
	createPost(body: { content: string; parentId?: string }): Promise<Post>;
	addReaction(postId: string, emoji: string): Promise<void>;
	updateBio(bio: string): Promise<User>;
};

export function createCielClient(config: Config): CielClient {
	const raw = createClient<paths>({
		baseUrl: config.apiBaseUrl,
		headers: {
			Authorization: `Bearer ${config.accessToken}`,
			Cookie: `ciel_auth=${config.accessToken}`,
		},
	});

	return {
		raw,
		async me() {
			const { data, error, response } = await raw.GET("/me");
			if (error || !data) {
				throw httpError("GET /me", response.status, error);
			}
			return data;
		},
		async timeline(params = {}) {
			const { data, error, response } = await raw.GET("/timeline", {
				params: {
					query: {
						limit: params.limit,
						cursor: params.cursor ?? undefined,
					},
				},
			});
			if (error || !data) {
				throw httpError(
					"GET /timeline",
					(response as Response)?.status ?? 500,
					error,
				);
			}
			return data;
		},
		async createPost(body) {
			const { data, error, response } = await raw.POST("/posts", {
				body: {
					content: body.content,
					parentId: body.parentId,
				},
			});
			if (error || !data) {
				throw httpError("POST /posts", response.status, error);
			}
			return data;
		},
		async addReaction(postId, emoji) {
			const { data, error, response } = await raw.POST(
				"/posts/{postId}/reactions",
				{
					params: {
						path: { postId },
					},
					body: {
						emoji,
					},
				},
			);
			if (response.status === 409) {
				return;
			}
			if (error || !data) {
				throw httpError(
					`POST /posts/${postId}/reactions`,
					response.status,
					error,
				);
			}
		},
		async updateBio(bio) {
			const { data, error, response } = await raw.PATCH("/me/profile", {
				body: {
					bio,
				},
			});
			if (error || !data) {
				throw httpError("PATCH /me/profile", response.status, error);
			}
			return data;
		},
	};
}

function httpError(label: string, status: number, error: unknown): Error {
	return new Error(`${label} failed (${status}): ${JSON.stringify(error)}`);
}
