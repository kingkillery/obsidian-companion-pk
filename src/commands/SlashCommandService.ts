import { normalizePath, Notice, TFile } from "obsidian";
import type { SlashContext, SlashSuggestion } from "./types";
import { LinkGraphService } from "../links/LinkGraphService";
import { LinkIntelligenceService } from "../links/LinkIntelligenceService";

const DEFAULT_DAILY_NOTE_PATH = "Daily";
type FileCommand = "open" | "link";

function clamp(v: number, min: number, max: number): number {
	return Math.min(Math.max(v, min), max);
}

function pick_token_range(ctx: SlashContext): {
	from: { line: number; ch: number };
	to: { line: number; ch: number };
} {
	return ctx.trigger_range;
}

function strip_markdown_links(text: string): string {
	return text
		.replace(/\[\[(.*?)\]\]/g, "$1")
		.replace(/\[(.*?)\]\(.*?\)/g, "$1")
		.trim();
}

export class SlashCommandService {
	private plugin: any;
	private graph: LinkGraphService;
	private linker: LinkIntelligenceService;

	constructor(plugin: any) {
		this.plugin = plugin;
		this.graph = plugin.link_graph_service;
		this.linker = new LinkIntelligenceService(plugin.app, this.graph);
	}

	private get_command_query(ctx: SlashContext): string {
		return (ctx.query || "").trim();
	}

	private get_todo_subject(ctx: SlashContext): string {
		const query = this.get_command_query(ctx);
		const tokens = query.split(/\s+/).filter(Boolean);
		if (tokens.length <= 1) {
			return "";
		}
		return tokens.slice(1).join(" ");
	}

	private parse_file_command(query: string): {
		command: FileCommand;
		file_query: string;
	} {
		const tokens = query.trim().split(/\s+/).filter(Boolean);
		const maybe_command = (tokens[0] || "").toLowerCase();
		if (maybe_command === "link") {
			return {
				command: "link",
				file_query: tokens.slice(1).join(" "),
			};
		}
		if (maybe_command === "open") {
			return {
				command: "open",
				file_query: tokens.slice(1).join(" "),
			};
		}
		return {
			command: "open",
			file_query: query.trim(),
		};
	}

	private get_file_candidates(file_query: string): TFile[] {
		const files = this.plugin.app.vault.getMarkdownFiles();
		const normalized = (file_query || "").toLowerCase();
		if (!normalized) {
			return files.sort((a: TFile, b: TFile) =>
				a.basename.localeCompare(b.basename)
			);
		}

		return files
			.filter((file: TFile) => {
				const haystack = `${file.path} ${file.basename}`.toLowerCase();
				return haystack.includes(normalized);
			})
			.sort((a: TFile, b: TFile) => a.basename.localeCompare(b.basename));
	}

	private build_file_suggestions(
		query: string,
		command: FileCommand
	): SlashSuggestion[] {
		const normalized = (query || "").toLowerCase();
		const candidates = this.get_file_candidates(query);
		return candidates.map((file) => {
			const base = file.basename.toLowerCase();
			let score = 0.7;
			if (normalized && base === normalized) {
				score = 0.98;
			} else if (normalized && base.startsWith(normalized)) {
				score = 0.92;
			} else if (normalized && base.includes(normalized)) {
				score = 0.84;
			}

			const command_label = command === "link" ? "Link" : "Open";
			return {
				id: `${command}::${encodeURIComponent(file.path)}`,
				title: `${command_label}: ${file.basename}`,
				description: file.path,
				score,
			};
		});
	}

	private get_daily_note_root(): string {
		const configured =
			typeof this.plugin.settings?.daily_note_path === "string"
				? this.plugin.settings.daily_note_path.trim()
				: "";
		return normalizePath(configured || DEFAULT_DAILY_NOTE_PATH);
	}

	private async run_summary(ctx: SlashContext): Promise<string> {
		const text = (ctx.selected_text || ctx.line_text).trim();
		if (!text) {
			new Notice("No text selected for summarize.");
			return "";
		}
		const prompt = [
			"Summarize this text in 3 concise bullets.",
			text,
			"",
			"Bullets:",
		].join("\n");
		return this.plugin.generate_text_snippet(prompt, 900);
	}

	private async replace_todo_section(
		editor: any,
		content: string
	): Promise<void> {
		editor.setValue(content);
	}

	private async collect_vault_todos(
		subject?: string
	): Promise<Array<{ file: TFile; text: string }>> {
		const files = this.plugin.app.vault.getMarkdownFiles();
		const out: Array<{ file: TFile; text: string }> = [];
		const task_regex = /^\s*[-*+]\s+\[\s\]\s+(.*?)\s*$/;
		const filter = subject?.trim().toLowerCase();

		for (const file of files) {
			const raw = await this.plugin.app.vault.cachedRead(file);
			for (const line of raw.split(/\r?\n/)) {
				const match = task_regex.exec(line);
				if (!match) {
					continue;
				}
				const task = (match[1] || "").trim();
				if (!task) {
					continue;
				}
				if (filter && !task.toLowerCase().includes(filter)) {
					continue;
				}
				out.push({ file, text: task });
			}
		}
		return out;
	}

	private async collect_local_todos(
		file: TFile,
		subject?: string
	): Promise<Array<{ file: TFile; text: string }>> {
		const filter = subject?.trim().toLowerCase();
		const task_regex = /^\s*[-*+]\s+\[\s\]\s+(.*?)\s*$/;
		const out: Array<{ file: TFile; text: string }> = [];
		const raw = await this.plugin.app.vault.cachedRead(file);
		for (const line of raw.split(/\r?\n/)) {
			const match = task_regex.exec(line);
			if (!match) {
				continue;
			}
			const task = (match[1] || "").trim();
			if (!task) {
				continue;
			}
			if (filter && !task.toLowerCase().includes(filter)) {
				continue;
			}
			out.push({ file, text: task });
		}
		return out;
	}

	private async todo_vault_scan(ctx: SlashContext): Promise<void> {
		const subject = this.get_todo_subject(ctx);
		const items = await this.collect_vault_todos(subject);
		const title = subject
			? `TODO Vault Scan (${subject})`
			: "TODO Vault Scan";
		const body =
			items.length > 0
				? items
						.map((item) => `- [[${item.file.basename}]] ${item.text}`)
						.join("\n")
				: "- No open TODO tasks found.";
		const current = ctx.editor.getValue();
		const updated = this.upsert_section(current, title, body);
		await this.replace_todo_section(ctx.editor, updated);
		new Notice(
			subject
				? `Vault TODO scan completed for "${subject}"`
				: "Vault TODO scan completed."
		);
	}

	private async todo_local_scan(ctx: SlashContext): Promise<void> {
		const subject = this.get_todo_subject(ctx);
		if (!ctx.file) {
			new Notice("No active note for local TODO scan.");
			return;
		}
		const items = await this.collect_local_todos(ctx.file, subject);
		const title = subject
			? `TODO Local Scan (${subject})`
			: "TODO Local Scan";
		const body =
			items.length > 0
				? items.map((item) => `- ${item.text}`).join("\n")
				: "- No open TODO tasks found.";
		const current = ctx.editor.getValue();
		const updated = this.upsert_section(current, title, body);
		await this.replace_todo_section(ctx.editor, updated);
		new Notice(
			subject
				? `Local TODO scan completed for "${subject}"`
				: "Local TODO scan completed."
		);
	}

	private extract_todos(text: string): string[] {
		const out: string[] = [];
		const pattern = /^\s*[-*]\s+\[[ x]\]\s+(.*)$/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			const item = match[1]?.trim();
			if (!item) continue;
			out.push(`- [ ] ${strip_markdown_links(item)}`);
		}
		return out;
	}

	private upsert_section(text: string, title: string, body: string): string {
		const lines = text.split("\n");
		let start = -1;
		let end = lines.length;

		for (let i = 0; i < lines.length; i++) {
			if (lines[i]?.trim() === `## ${title}`) {
				start = i;
				break;
			}
		}

		if (start >= 0) {
			for (let i = start + 1; i < lines.length; i++) {
				if (lines[i]?.startsWith("## ")) {
					end = i;
					break;
				}
			}
		}

		if (start >= 0) {
			lines.splice(start, end - start, `## ${title}`, body);
		} else {
			lines.push("", `## ${title}`, body);
		}

		return lines.join("\n");
	}

	private consume_trigger(ctx: SlashContext): void {
		const trigger = pick_token_range(ctx);
		ctx.editor.replaceRange("", trigger.from, trigger.to);
	}

	async get_suggestions(
		query: string,
		ctx?: SlashContext,
		trigger: "/" | "@" = "/"
	): Promise<SlashSuggestion[]> {
		const normalized_query = (query || "").trim().toLowerCase();
		if (trigger === "@") {
			const parsed = this.parse_file_command(query);
			const suggestions = this.build_file_suggestions(
				parsed.file_query,
				parsed.command
			);
			return suggestions
				.sort((a, b) => b.score - a.score)
				.slice(0, clamp(this.plugin.settings.slash_max_suggestions, 1, 24));
		}

		const command_query = normalized_query.split(/\s+/)[0] || "";
		const fm = ctx?.frontmatter || {};
		const type = String(fm?.type || "").toLowerCase();
		const score_base: { [id: string]: number } = {
			todo: 0.82,
			"todo-local": 0.8,
			"scan-todo": 0.78,
			"create-daily": 0.3,
			"summarize": 0.7,
			"todo-scan": 0.75,
			"sync-note": 0.6,
			"link-intelligence": 0.85,
			"reciprocal-link": 0.5,
		};

		const suggestions: SlashSuggestion[] = [
			{
				id: "todo",
				title: "TODO",
				description: "Create a vault-wide TODO list (optionally scoped by subject).",
				score: score_base["todo"] + (command_query === "todo" ? 0.2 : 0),
			},
			{
				id: "todo-local",
				title: "TODO local",
				description:
					"Create a TODO list from current note only (optionally scoped by subject).",
				score:
					score_base["todo-local"] +
					(command_query === "todo-local" ? 0.25 : 0),
			},
			{
				id: "scan-todo",
				title: "Scan TODO",
				description:
					"Alias for TODO local scan (current note only, optionally scoped by subject).",
				score:
					score_base["scan-todo"] +
					(command_query === "scan-todo" ? 0.25 : 0),
			},
			{
				id: "create-daily",
				title: "Create daily note",
				description: "Open or create today's note and link it back.",
				score:
					score_base["create-daily"] +
					(this.plugin.settings.enable_by_default ? 0.1 : 0),
			},
			{
				id: "summarize",
				title: "Summarize",
				description: "Generate a 3 bullet summary from selection.",
				score: score_base["summarize"] + (query.length > 1 ? 0.3 : 0),
			},
			{
				id: "todo-scan",
				title: "TODO scan",
				description: "Collect open task list items from this note.",
				score: score_base["todo-scan"] + (type === "project" ? 0.2 : 0),
			},
			{
				id: "sync-note",
				title: "Sync note section",
				description: "Refresh link summary and sync metadata in the note.",
				score: score_base["sync-note"] + (type === "meeting" ? 0.2 : 0),
			},
			{
				id: "link-intelligence",
				title: "Link intelligence",
				description: "Insert bidirectional link suggestions for this note.",
				score:
					score_base["link-intelligence"] +
					(type === "meeting" || type === "project" ? 0.25 : 0),
			},
			{
				id: "reciprocal-link",
				title: "Add reciprocal links",
				description: "Add inbound link(s) to notes that reference this one.",
				score: score_base["reciprocal-link"],
			},
		].filter((suggestion) => {
			if (!query) {
				return true;
			}
			return (
				suggestion.title
					.toLowerCase()
					.includes(command_query) ||
				suggestion.id.toLowerCase().includes(command_query)
			);
		});

		return suggestions
			.sort((a, b) => b.score - a.score)
			.slice(0, clamp(this.plugin.settings.slash_max_suggestions, 1, 24));
	}

	async execute_command(id: string, ctx: SlashContext): Promise<void> {
		this.consume_trigger(ctx);
		if (ctx.command_trigger === "@") {
			const parsed = /^(open|link)::(.+)$/.exec(id);
			if (parsed) {
				const command = parsed[1] as FileCommand;
				const file_path = decodeURIComponent(parsed[2] || "");
				if (command === "open") {
					await this.open_file_target(ctx, file_path);
					return;
				}
				if (command === "link") {
					await this.insert_file_link(ctx, file_path);
					return;
				}
			}
			new Notice("Unknown @ command.");
			return;
		}
		if (id === "create-daily") {
			await this.create_daily(ctx);
			return;
		}
		if (id === "todo") {
			await this.todo_vault_scan(ctx);
			return;
		}
		if (id === "todo-local") {
			await this.todo_local_scan(ctx);
			return;
		}
		if (id === "scan-todo") {
			await this.todo_local_scan(ctx);
			return;
		}
		if (id === "summarize") {
			const summary = await this.run_summary(ctx);
			if (!summary) return;
			const block = `\n\n## Summary\n${summary}\n`;
			const cursor = ctx.editor.getCursor();
			ctx.editor.replaceRange(block, cursor);
			return;
		}
		if (id === "todo-scan") {
			await this.todo_scan(ctx);
			return;
		}
		if (id === "sync-note") {
			await this.sync_note(ctx);
			return;
		}
		if (id === "link-intelligence") {
			await this.link_intelligence(ctx);
			return;
		}
		if (id === "reciprocal-link") {
			await this.reciprocal_link(ctx);
			return;
		}

		new Notice(`Unknown slash command: ${id}`);
	}

	private async open_file_target(
		ctx: SlashContext,
		file_path: string
	): Promise<void> {
		const target = this.plugin.app.vault.getAbstractFileByPath(file_path);
		if (!target || !(target instanceof TFile)) {
			new Notice(`Could not find file: ${file_path}`);
			return;
		}
		await this.plugin.app.workspace.getLeaf().openFile(target, {
			active: true,
		});
	}

	private async insert_file_link(
		ctx: SlashContext,
		file_path: string
	): Promise<void> {
		const target = this.plugin.app.vault.getAbstractFileByPath(file_path);
		if (!target || !(target instanceof TFile)) {
			new Notice(`Could not find file: ${file_path}`);
			return;
		}
		const link_target = target.path.replace(/\.md$/i, "");
		const cursor = ctx.editor.getCursor();
		await ctx.editor.replaceRange(`[[${link_target}]]`, cursor);
		new Notice(`Inserted link to ${target.basename}.`);
	}

	private async create_daily(ctx: SlashContext): Promise<void> {
		const note_path = this.get_daily_note_root();
		const target_path = `${note_path}/${new Date().toISOString().split("T")[0]}.md`;
		const vault = this.plugin.app.vault;

		const maybe_folder = vault.getAbstractFileByPath(note_path);
		if (!maybe_folder) {
			await vault.createFolder(note_path);
		}
		let note = vault.getAbstractFileByPath(target_path);
		if (!note) {
			note = await vault.create(
				target_path,
				`# ${new Date().toISOString().split("T")[0]}\n\n`
			);
		}
		if (ctx.file) {
			const link = `\n- [[${ctx.file.basename}]]\n`;
			const existing = await vault.cachedRead(note as TFile);
			if (!existing.includes(link.trim())) {
				const titleIndex = existing.indexOf("\n\n");
				if (titleIndex >= 0) {
					await vault.modify(
						note as TFile,
						[
							existing.slice(0, titleIndex + 2),
							link,
							existing.slice(titleIndex + 2),
						].join("")
					);
				}
			}
		}
		await this.plugin.app.workspace.getLeaf().openFile(note as TFile, {
			active: true,
		});
	}

	private async todo_scan(ctx: SlashContext): Promise<void> {
		const text = ctx.editor.getValue();
		const todos = this.extract_todos(text);
		const body =
			todos.length > 0
				? [`${todos.length} pending item(s):`, "", ...todos, ""].join("\n")
				: "No pending TODO items.";
		const current = ctx.editor.getValue();
		const updated = this.upsert_section(current, "TODO Scan", body);
		await this.replace_todo_section(ctx.editor, updated);
		new Notice(`TODO scan found ${todos.length} items.`);
	}

	private async sync_note(ctx: SlashContext): Promise<void> {
		const file = ctx.file;
		if (!file) {
			new Notice("No active note to sync.");
			return;
		}
		const incoming = this.graph.get_incoming(file.path).slice(0, 12);
		const outgoing = this.graph.get_outgoing(file.path).slice(0, 12);

		const incoming_md = incoming
			.map((item) => `- [[${this.path_to_title(item)}]]`)
			.join("\n");
		const outgoing_md = outgoing
			.map((item) => `- [[${this.path_to_title(item)}]]`)
			.join("\n");
		const body = [
			`Last synced: ${new Date().toLocaleString()}`,
			"",
			"### Incoming",
			incoming_md || "- (none)",
			"",
			"### Outgoing",
			outgoing_md || "- (none)",
			"",
		].join("\n");

		const current = ctx.editor.getValue();
		const updated = this.upsert_section(current, "Related (Local Sync)", body);
		await this.replace_todo_section(ctx.editor, updated);
		new Notice("Note sync section updated.");
	}

	private path_to_title(path: string): string {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (file && "basename" in file) {
			return file.basename;
		}
		return path.split("/").pop() || path;
	}

	private async link_intelligence(ctx: SlashContext): Promise<void> {
		const file = ctx.file;
		if (!file) {
			new Notice("No active note for link intelligence.");
			return;
		}
		const incoming = this.graph.get_incoming(file.path);
		const outgoing = this.graph.get_outgoing(file.path);
		const suggestions = this.linker.get_suggestions(
			file.path,
			10,
			clamp(this.plugin.settings.link_intelligence_min_score, 0, 1)
		);

		const top = suggestions.slice(0, 8);
		const incoming_md =
			incoming.length > 0
				? incoming.map((path) => `- [[${this.path_to_title(path)}]]`).join("\n")
				: "- (none)";
		const outgoing_md =
			outgoing.length > 0
				? outgoing.map((path) => `- [[${this.path_to_title(path)}]]`).join("\n")
				: "- (none)";
		const suggestion_md = top.length
			? top
					.map(
						(suggestion) =>
							`- [[${suggestion.target_title}]] - ${suggestion.reason}`
					)
					.join("\n")
			: "- (none)";

		const body = [
			`Last analyzed: ${new Date().toLocaleString()}`,
			"",
			"### Incoming links",
			incoming_md,
			"",
			"### Outgoing links",
			outgoing_md,
			"",
			"### Suggested reciprocal links",
			suggestion_md,
			"",
		].join("\n");

		const current = ctx.editor.getValue();
		const updated = this.upsert_section(current, "Link Intelligence", body);
		await this.replace_todo_section(ctx.editor, updated);
		new Notice("Link intelligence panel inserted.");
	}

	private async reciprocal_link(ctx: SlashContext): Promise<void> {
		const file = ctx.file;
		if (!file) {
			new Notice("No active note for reciprocal links.");
			return;
		}
		const suggestions = this.linker.get_suggestions(
			file.path,
			6,
			clamp(this.plugin.settings.link_intelligence_min_score, 0, 1)
		);
		if (!suggestions.length) {
			new Notice("No link candidates found.");
			return;
		}

		const target = suggestions[0];
		const target_file = this.plugin.app.vault.getAbstractFileByPath(
			target.target_path
		) as TFile | null;
		if (!target_file) {
			new Notice("Reciprocal target note not found.");
			return;
		}

		const title = file.basename;
		const existing = await this.plugin.app.vault.cachedRead(target_file);
		if (existing.includes(`[[${title}]]`)) {
			new Notice(`Reciprocal link already exists in ${target.target_title}.`);
			return;
		}
		const section = this.upsert_section(
			existing,
			"Backlinks (Companion)",
			`- [[${title}]]`
		);
		await this.plugin.app.vault.modify(target_file, section);
		this.graph.refresh_file(target_file);
		new Notice(
			`Added reciprocal link in ${target.target_title}: [[${title}]]`
		);
	}
}

