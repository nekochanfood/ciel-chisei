import type { Sql } from "../db.js";
import { BOS, EOS } from "./tokenizer.js";

const DEFAULT_MAX_TOKENS = 24;

export class MarkovModel {
	private readonly globalEdges = new Map<string, Map<string, number>>();
	private readonly userEdges = new Map<
		string,
		Map<string, Map<string, number>>
	>();

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
			const output: string[] = [];
			for (let i = 0; i < maxTokens; i += 1) {
				const next = this.pickNext(prefix, seedTokens, authorId);
				if (!next || next === EOS) {
					break;
				}
				output.push(next);
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
			userPrefixes.length > 0 && Math.random() < 0.75
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

		if (seeded.length > 0 && Math.random() < 0.8) {
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
		const globalNexts = this.globalEdges.get(prefix);
		if (!globalNexts || globalNexts.size === 0) {
			return undefined;
		}

		const userNexts = authorId
			? this.userEdges.get(authorId)?.get(prefix)
			: undefined;
		const seedSet = new Set(seedTokens);
		const weighted: Array<{ token: string; weight: number }> = [];

		for (const [token, count] of globalNexts) {
			let weight = count;
			// Boost tokens if in conversation seed
			if (seedSet.has(token)) {
				weight *= 3;
			}
			// Significant boost if this specific user used this transition
			if (userNexts?.has(token)) {
				weight += (userNexts.get(token) ?? 0) * 8;
			}
			weighted.push({ token, weight });
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
}
