import type { Db, DbTransaction } from "../db.js";
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
	/** 0..1 overall novelty: drives bigram backoff + early stopping. */
	variety: number;
};

const DEFAULT_OPTIONS: MarkovOptions = {
	temperature: 1.4,
	seedBoost: 2,
	userBoost: 6,
	variety: 0.5,
};

export class MarkovModel {
	private readonly options: MarkovOptions;
	private readonly globalEdges = new Map<string, Map<string, number>>();
	private readonly userEdges = new Map<
		string,
		Map<string, Map<string, number>>
	>();
	private readonly startTokens = new Set<string>();
	private readonly endTokens = new Set<string>();

	constructor(options: Partial<MarkovOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	async load(db: Db): Promise<void> {
		this.globalEdges.clear();
		this.userEdges.clear();
		this.startTokens.clear();
		this.endTokens.clear();
		const [edges, labels] = await Promise.all([
			db.markovEdge.findMany(),
			db.markovTokenLabel.findMany(),
		]);
		for (const edge of edges) {
			this.addEdge(edge.prefix, edge.nextToken, edge.authorId, edge.count);
		}
		for (const label of labels) {
			if (label.canStart) this.startTokens.add(label.token);
			if (label.canEnd) this.endTokens.add(label.token);
		}
	}

	get edgeCount(): number {
		let total = 0;
		for (const nexts of this.globalEdges.values()) {
			total += nexts.size;
		}
		return total;
	}

	canStart(token: string): boolean {
		return this.startTokens.has(token);
	}

	canEnd(token: string): boolean {
		return this.endTokens.has(token);
	}

	ingest(
		tokens: string[],
		authorId = "",
	): Array<{ prefix: string; next: string }> {
		const edges = this.buildEdges(tokens);
		for (const { prefix, next } of edges) {
			this.addEdge(prefix, next, authorId, 1);
		}
		return edges;
	}

	async persist(
		db: DbTransaction,
		tokens: string[],
		authorId = "",
	): Promise<void> {
		if (tokens.length === 0) return;
		const edges = this.buildEdges(tokens);
		for (const edge of edges) {
			await db.markovEdge.upsert({
				where: {
					authorId_prefix_nextToken: {
						authorId,
						prefix: edge.prefix,
						nextToken: edge.next,
					},
				},
				create: { authorId, prefix: edge.prefix, nextToken: edge.next },
				update: { count: { increment: 1 } },
			});
		}
		const first = tokens[0] as string;
		const last = tokens.at(-1) as string;
		await db.markovTokenLabel.upsert({
			where: { token: first },
			create: { token: first, canStart: true, canEnd: first === last },
			update: { canStart: true, ...(first === last ? { canEnd: true } : {}) },
		});
		if (last !== first) {
			await db.markovTokenLabel.upsert({
				where: { token: last },
				create: { token: last, canEnd: true },
				update: { canEnd: true },
			});
		}
	}

	generate(seedTokens: string[] = [], authorId?: string): string[] {
		if (this.globalEdges.size === 0) {
			return [];
		}

		// Try up to 3 times to generate a non-empty sequence
		for (let attempt = 0; attempt < 3; attempt += 1) {
			let prefix = `${BOS}\t${BOS}`;
			const stopProbability = 0.3 * this.options.variety;
			const output: string[] = [];
			for (let i = 0; i < DEFAULT_MAX_TOKENS; i += 1) {
				const next = this.pickNext(prefix, seedTokens, authorId);
				if (!next || next === EOS) {
					break;
				}
				output.push(next);
				// Random early stop breaks verbatim reproduction of long
				// memorized passages while keeping short replies intact.
				if (
					output.length >= MIN_TOKENS_BEFORE_STOP &&
					this.canEnd(next) &&
					Math.random() < stopProbability
				) {
					break;
				}
				const parts: string[] = prefix.split("\t");
				prefix = `${parts[1] ?? BOS}\t${next}`;
			}
			if (output.length > 0 && this.canEnd(output.at(-1) as string)) {
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
		if (prefix === `${BOS}\t${BOS}` && next !== EOS) {
			this.startTokens.add(next);
		}
		if (next === EOS) {
			const last = prefix.split("\t")[1];
			if (last && last !== BOS) this.endTokens.add(last);
		}
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

	private buildEdges(
		tokens: string[],
	): Array<{ prefix: string; next: string }> {
		if (tokens.length === 0) return [];
		const padded = [BOS, BOS, ...tokens, EOS];
		return tokens
			.map((_, index) => ({
				prefix: `${padded[index]}\t${padded[index + 1]}`,
				next: padded[index + 2] ?? EOS,
			}))
			.concat({
				prefix: `${padded[tokens.length]}\t${padded[tokens.length + 1]}`,
				next: EOS,
			});
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
