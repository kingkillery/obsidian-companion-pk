import { App, TFile } from "obsidian";

function ensure_set(map: Map<string, Set<string>>, key: string): Set<string> {
	if (!map.has(key)) {
		map.set(key, new Set());
	}
	return map.get(key)!;
}

export class LinkGraphService {
	private outgoing: Map<string, Set<string>>;
	private incoming: Map<string, Set<string>>;
	private app: App;

	constructor(app: App) {
		this.app = app;
		this.outgoing = new Map();
		this.incoming = new Map();
	}

	private normalize_target(source: TFile, raw_link: string): string | null {
		const target_file = this.app.metadataCache.getFirstLinkpathDest(
			raw_link,
			source.path
		);
		if (!target_file) {
			return null;
		}
		return target_file.path;
	}

	private remove_outgoing(source_path: string) {
		const existing = this.outgoing.get(source_path);
		if (!existing) {
			return;
		}

		for (const target of existing) {
			const sources = this.incoming.get(target);
			if (!sources) {
				continue;
			}
			sources.delete(source_path);
			if (sources.size === 0) {
				this.incoming.delete(target);
			}
		}
		this.outgoing.delete(source_path);
	}

	private add_outgoing(source_path: string, target_path: string) {
		if (source_path === target_path) {
			return;
		}
		ensure_set(this.outgoing, source_path).add(target_path);
		ensure_set(this.incoming, target_path).add(source_path);
	}

	private parse_file_links(file: TFile): Set<string> {
		const cache = this.app.metadataCache.getFileCache(file);
		const targets = new Set<string>();

		if (!cache?.links) {
			return targets;
		}

		for (const link of cache.links) {
			if (!link.link) {
				continue;
			}
			if (link.link.startsWith("http://") || link.link.startsWith("https://")) {
				continue;
			}
			const normalized = this.normalize_target(file, link.link);
			if (!normalized) {
				continue;
			}
			targets.add(normalized);
		}
		return targets;
	}

	refresh_file(file: TFile): void {
		this.remove_outgoing(file.path);
		const targets = this.parse_file_links(file);
		for (const target of targets) {
			this.add_outgoing(file.path, target);
		}
	}

	remove_file(path: string): void {
		this.remove_outgoing(path);
		this.incoming.delete(path);
		for (const targets of this.incoming.values()) {
			targets.delete(path);
		}
	}

	rename_file(old_path: string, new_path: string): void {
		const outgoing = this.outgoing.get(old_path) || new Set();
		this.remove_outgoing(old_path);
		this.outgoing.set(new_path, outgoing);
		const incoming = this.incoming.get(old_path) || new Set();
		this.incoming.delete(old_path);
		this.incoming.set(new_path, incoming);

		for (const [target, sources] of this.incoming.entries()) {
			const cloned = new Set(sources);
			sources.clear();
			for (const source of cloned) {
				sources.add(source === old_path ? new_path : source);
			}
		}
		for (const target of outgoing) {
			const sources = this.incoming.get(target);
			if (!sources) {
				continue;
			}
			if (sources.delete(old_path)) {
				sources.add(new_path);
			}
		}
	}

	async bootstrap(): Promise<void> {
		this.outgoing.clear();
		this.incoming.clear();
		const files = this.app.vault.getFiles();
		for (const file of files) {
			this.refresh_file(file);
		}
	}

	get_incoming(file_path: string): string[] {
		const incoming = this.incoming.get(file_path);
		if (!incoming) {
			return [];
		}
		return [...incoming].sort();
	}

	get_outgoing(file_path: string): string[] {
		const outgoing = this.outgoing.get(file_path);
		if (!outgoing) {
			return [];
		}
		return [...outgoing].sort();
	}

	get_all_paths(): string[] {
		const paths = new Set<string>();
		for (const path of this.outgoing.keys()) {
			paths.add(path);
		}
		for (const path of this.incoming.keys()) {
			paths.add(path);
		}
		for (const file of this.app.vault.getMarkdownFiles()) {
			paths.add(file.path);
		}
		return [...paths].sort();
	}
}
