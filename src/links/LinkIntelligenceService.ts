import { App, TFile } from "obsidian";
import type { LinkIntelligenceSuggestion } from "../commands/types";
import { LinkGraphService } from "./LinkGraphService";

function to_string_array(value: unknown): string[] {
	if (value == null) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.map((item) => String(item).toLowerCase());
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean);
	}
	return [];
}

export class LinkIntelligenceService {
	private app: App;
	private graph: LinkGraphService;

	constructor(app: App, graph: LinkGraphService) {
		this.app = app;
		this.graph = graph;
	}

	getTags(path: string): string[] {
		const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
		if (!file) {
			return [];
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const raw_tags: unknown[] = [];

		const cache_tags = (cache as any)?.tags;
		if (Array.isArray(cache_tags)) {
			for (const item of cache_tags) {
				if (typeof item === "string") {
					raw_tags.push(item);
					continue;
				}
				if (item && typeof item === "object" && "tag" in item) {
					raw_tags.push((item as { tag: unknown }).tag);
				}
			}
		}

		const frontmatter = (cache as any)?.frontmatter || {};
		raw_tags.push(...to_string_array(frontmatter.tags));
		return to_string_array(raw_tags);
	}

	private score_links(source_path: string, target_path: string): number {
		let score = 0.12;

		const source_tags = this.getTags(source_path);
		const target_tags = this.getTags(target_path);
		const shared_tags = source_tags.filter((tag) => target_tags.includes(tag));
		score += Math.min(shared_tags.length * 0.2, 0.6);

		const source_outgoing = this.graph.get_outgoing(source_path);
		const source_incoming = this.graph.get_incoming(source_path);
		const target_outgoing = this.graph.get_outgoing(target_path);
		const target_incoming = this.graph.get_incoming(target_path);

		if (source_outgoing.includes(target_path)) {
			score += 0.22;
		}
		if (source_incoming.includes(target_path)) {
			score += 0.15;
		}
		if (
			source_outgoing.includes(target_path) &&
			target_outgoing.includes(source_path)
		) {
			score += 0.25;
		}

		score += Math.min(target_incoming.length * 0.02, 0.15);
		return score;
	}

	private explanation(
		source_path: string,
		target_path: string,
		score: number
	): string {
		const source_outgoing = this.graph.get_outgoing(source_path);
		const target_incoming = this.graph.get_incoming(target_path);
		const target_outgoing = this.graph.get_outgoing(target_path);

		const source_tags = new Set(this.getTags(source_path));
		const target_tags = new Set(this.getTags(target_path));
		const shared_tags = [...source_tags].filter((tag) => target_tags.has(tag));

		const reason_parts: string[] = [];
		if (source_outgoing.includes(target_path)) {
			reason_parts.push("already outgoing");
		}
		if (target_outgoing.includes(source_path)) {
			reason_parts.push("already incoming");
		}
		if (shared_tags.length) {
			reason_parts.push(`shared tags: ${shared_tags.join(", ")}`);
		}
		reason_parts.push(
			`reciprocal score ${(Math.round(score * 100) / 100).toFixed(2)}`
		);
		return reason_parts.join(" - ");
	}

	get_suggestions(
		file_path: string,
		limit: number = 8,
		score_floor: number = 0
	): LinkIntelligenceSuggestion[] {
		const suggestions: LinkIntelligenceSuggestion[] = [];
		for (const path of this.graph.get_all_paths()) {
			if (path === file_path) {
				continue;
			}
			const score = this.score_links(file_path, path);
			if (score < score_floor) {
				continue;
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			const title =
				file && "basename" in file ? (file as TFile).basename : path.split("/").pop()!;
			suggestions.push({
				target_path: path,
				target_title: title,
				score,
				reason: this.explanation(file_path, path, score),
			});
		}

		return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}
