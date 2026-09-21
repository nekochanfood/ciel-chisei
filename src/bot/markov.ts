import type { Sql } from "../db.js";
import { BOS, EOS } from "./tokenizer.js";

const DEFAULT_MAX_TOKENS = 24;
const MIN_TOKENS_BEFORE_STOP = 3;

export type MarkovOptions = {
	/** >1 flattens the distribution (more surprising picks). */
	temperature: number;
	/** Multiplier for tokens appearing in the conversation seed. */
	seedBoost: number;
	/** Additive weight per count of the author's own transitions. */
	userBoost: number;
	/** Probability to start generation from the author's own prefixes. */
	userStartBias: number;
	/** Probability to prefer seed-matching start prefixes. */
	seededStartBias: number;
	/** 0..1 overall novelty: drives bigram backoff + early stopping. */
	variety: number;
};

const DEFAULT_OPTIONS: MarkovOptions = {
	temperature: 1.4,
	seedBoost: 2,
	userBoost: 6,
	userStartBias: 0.6,
	seededStartBias: 0.7,
	variety: 0.5,
};

export class MarkovModel {
	private readonly options: MarkovOptions;
	private readonly globalEdges = new Map<string, Map<string, number>>();
	private readonly userEdges = new Map<
		string,
		Map<string, Map<string, number>>
	>();

	constructor(options: Partial<MarkovOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	async load(sql: Sql): Promise<void> {
		this.globalEdges.clear();
		this.userEdges.clear();
		const rows = await sql<
			{
				author_id: string;
				prefix: string;
				next: string;
				count: number;
			}[]
		>`
      SELECT author_id, prefix, next, count FROM markov_edges
    `;
		for (const row of rows) {
			this.addEdge(row.prefix, row.next, row.author_id, row.count);
		}
	}

	get edgeCount(): number {
		let total = 0;
		for (const nexts of this.globalEdges.values()) {
			total += nexts.size;
		}
		return total;
	}

	ingest(
		tokens: string[],
		authorId = "",
	): Array<{ prefix: string; next: string }> {
		if (tokens.length === 0) {
			return [];
		}
		const edges: Array<{ prefix: string; next: string }> = [];
		const padded = [BOS, BOS, ...tokens, EOS];
		for (let i = 0; i < padded.length - 2; i += 1) {
			const prefix = `${padded[i]}\t${padded[i + 1]}`;
			const next = padded[i + 2] ?? EOS;
			this.addEdge(prefix, next, authorId, 1);
			edges.push({ prefix, next });
		}
		return edges;
	}

	async learn(sql: Sql, tokens: string[], authorId = ""): Promise<void> {
		for (const edge of this.ingest(tokens, authorId)) {
			await sql`
        INSERT INTO markov_edges (author_id, prefix, next, count)
        VALUES (${authorId}, ${edge.prefix}, ${edge.next}, 1)
        ON CONFLICT (author_id, prefix, next)
        DO UPDATE SET count = markov_edges.count + 1
      `;
		}
	}

	generate(
		seedTokens: string[] = [],
		authorId?: string,
		maxTokens = DEFAULT_MAX_TOKENS,
	): string[] {
		if (this.globalEdges.size === 0) {
			return [];
		}

		// Try up to 3 times to generate a non-empty sequence
		for (let attempt = 0; attempt < 3; attempt += 1) {
			let prefix = this.pickStartPrefix(seedTokens, authorId, attempt > 0);
			if (!prefix) {
				prefix = `${BOS}\t${BOS}`;
			}
			const stopProbability = 0.3 * this.options.variety;
			const output: string[] = [];
			for (let i = 0; i < maxTokens; i += 1) {
				const next = this.pickNext(prefix, seedTokens, authorId);
				if (!next || next === EOS) {
					break;
				}
				output.push(next);
				// Random early stop breaks verbatim reproduction of long
				// memorized passages while keeping short replies intact.
				if (
					output.length >= MIN_TOKENS_BEFORE_STOP &&
					Math.random() < stopProbability
				) {
					break;
				}
				const parts: string[] = prefix.split("\t");
				prefix = `${parts[1] ?? BOS}\t${next}`;
			}
			if (output.length > 0) {
				return output;
			}
		}
		return [];
	}

	private addEdge(
		prefix: string,
		next: string,
		authorId = "",
		count = 1,
	): void {
		// Global edges
		const nexts = this.globalEdges.get(prefix) ?? new Map<string, number>();
		nexts.set(next, (nexts.get(next) ?? 0) + count);
		this.globalEdges.set(prefix, nexts);

		// User specific edges
		if (authorId) {
			const userMap =
				this.userEdges.get(authorId) ?? new Map<string, Map<string, number>>();
			const userNexts = userMap.get(prefix) ?? new Map<string, number>();
			userNexts.set(next, (userNexts.get(next) ?? 0) + count);
			userMap.set(prefix, userNexts);
			this.userEdges.set(authorId, userMap);
		}
	}

	private pickStartPrefix(
		seedTokens: string[],
		authorId?: string,
		fallbackToBos = false,
	): string | undefined {
		if (fallbackToBos && this.globalEdges.has(`${BOS}\t${BOS}`)) {
			return `${BOS}\t${BOS}`;
		}

		// Check if target user has specific prefixes
		const userPrefixes =
			authorId && this.userEdges.has(authorId)
				? [...(this.userEdges.get(authorId)?.keys() ?? [])]
				: [];

		const candidatePrefixes =
			userPrefixes.length > 0 && Math.random() < this.options.userStartBias
				? userPrefixes
				: [...this.globalEdges.keys()];

		if (candidatePrefixes.length === 0) {
			return undefined;
		}

		const seedSet = new Set(seedTokens);
		const seeded = candidatePrefixes.filter((prefix) => {
			const [w1, w2] = prefix.split("\t");
			if (w2 === EOS) {
				return false;
			}
			return (
				(w1 !== undefined && seedSet.has(w1)) ||
				(w2 !== undefined && seedSet.has(w2))
			);
		});

		if (seeded.length > 0 && Math.random() < this.options.seededStartBias) {
			return seeded[Math.floor(Math.random() * seeded.length)];
		}
		if (this.globalEdges.has(`${BOS}\t${BOS}`) && Math.random() < 0.4) {
			return `${BOS}\t${BOS}`;
		}
		return candidatePrefixes[
			Math.floor(Math.random() * candidatePrefixes.length)
		];
	}

	private pickNext(
		prefix: string,
		seedTokens: string[],
		authorId?: string,
	): string | undefined {
		const backoffRate = 0.7 * this.options.variety;
		let globalNexts = this.globalEdges.get(prefix);
		let userNexts = authorId
			? this.userEdges.get(authorId)?.get(prefix)
			: undefined;

		// Bigram backoff: when the trigram prefix has at most one
		// continuation (the common case in a small corpus), sometimes
		// recombine via all transitions sharing the last token instead of
		// walking the single memorized path.
		if (
			(!globalNexts || globalNexts.size <= 1) &&
			Math.random() < backoffRate
		) {
			const fallback = this.bigramFallback(prefix, authorId);
			if (fallback.global.size > 0) {
				globalNexts = fallback.global;
				userNexts = fallback.user;
			}
		}
		if (!globalNexts || globalNexts.size === 0) {
			return undefined;
		}

		const seedSet = new Set(seedTokens);
		const weighted: Array<{ token: string; weight: number }> = [];

		for (const [token, count] of globalNexts) {
			let weight = count;
			// Boost tokens if in conversation seed
			if (seedSet.has(token)) {
				weight *= this.options.seedBoost;
			}
			// Boost if this specific user used this transition
			if (userNexts?.has(token)) {
				weight += (userNexts.get(token) ?? 0) * this.options.userBoost;
			}
			// Temperature flattens the distribution so rare alternatives
			// surface instead of always taking the memorized winner.
			weighted.push({
				token,
				weight: weight ** (1 / this.options.temperature),
			});
		}

		const total = weighted.reduce((sum, item) => sum + item.weight, 0);
		let roll = Math.random() * total;
		for (const item of weighted) {
			roll -= item.weight;
			if (roll <= 0) {
				return item.token;
			}
		}
		return weighted.at(-1)?.token;
	}

	/**
	 * Aggregate every known transition whose prefix ends with the same
	 * token, i.e. order-1 view derived from the trigram table.
	 * Needs no schema change: it is computed from loaded edges.
	 */
	private bigramFallback(
		prefix: string,
		authorId?: string,
	): { global: Map<string, number>; user?: Map<string, number> } {
		const last = prefix.split("\t")[1] ?? BOS;
		const global = new Map<string, number>();
		for (const [key, nexts] of this.globalEdges) {
			if (key.split("\t")[1] !== last) {
				continue;
			}
			for (const [token, count] of nexts) {
				global.set(token, (global.get(token) ?? 0) + count);
			}
		}
		let user: Map<string, number> | undefined;
		if (authorId) {
			const userMap = this.userEdges.get(authorId);
			if (userMap) {
				user = new Map<string, number>();
				for (const [key, nexts] of userMap) {
					if (key.split("\t")[1] !== last) {
						continue;
					}
					for (const [token, count] of nexts) {
						user.set(token, (user.get(token) ?? 0) + count);
					}
				}
				if (user.size === 0) {
					user = undefined;
				}
			}
		}
		return { global, user };
	}
}
