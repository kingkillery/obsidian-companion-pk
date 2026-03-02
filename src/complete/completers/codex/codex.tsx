import { Notice } from "obsidian";
import { Completer, Model, Prompt } from "../../complete";
import {
	SettingsUI as ProviderSettingsUI,
	Settings as ProviderSettings,
	parse_settings as parse_provider_settings,
} from "./provider_settings";
import {
	SettingsUI as ModelSettingsUI,
	parse_settings as parse_model_settings,
	Settings as ModelSettings,
} from "./model_settings";
import { CodexWebSocket, CodexModelInfo } from "./codex_ws";
import Mustache from "mustache";

export default class CodexModel implements Model {
	id: string;
	name: string;
	description: string;
	Settings = ModelSettingsUI;

	provider_settings: ProviderSettings;
	manager: CodexWebSocket | null = null;

	constructor(
		provider_settings: string,
		id: string,
		name: string,
		description: string
	) {
		this.id = id;
		this.name = name;
		this.description = description;
		this.provider_settings = parse_provider_settings(provider_settings);
	}

	async load(): Promise<void> {
		this.manager = new CodexWebSocket();
		try {
			await this.manager.connect(this.provider_settings.endpoint);
		} catch {
			new Notice("Cannot connect to Codex server");
			this.manager = null;
		}
	}

	async unload(): Promise<void> {
		if (this.manager) {
			this.manager.disconnect();
			this.manager = null;
		}
	}

	async prepare(
		prompt: Prompt,
		settings: ModelSettings
	): Promise<{
		prefix: string;
		suffix: string;
		last_line: string;
		context: string;
	}> {
		const budget = settings.prompt_length || 6000;
		const cropped = {
			prefix: prompt.prefix.slice(-budget),
			suffix: prompt.suffix.slice(0, Math.ceil(budget / 10)),
		};
		const last_line = cropped.prefix
			.split("\n")
			.filter((x) => x.length > 0)
			.pop();
		return {
			...cropped,
			last_line: last_line || "",
			context: cropped.prefix
				.split("\n")
				.filter((x) => x !== last_line)
				.join("\n"),
		};
	}

	async complete(prompt: Prompt, settings: string): Promise<string> {
		const model_settings = parse_model_settings(settings);

		if (!this.manager) {
			throw new Error("Codex not connected");
		}

		await this.manager.ensureConnected();

		const prompt_data = await this.prepare(prompt, model_settings);
		const rendered = Mustache.render(model_settings.user_prompt, prompt_data);

		return new Promise<string>((resolve, reject) => {
			let result = "";
			const turn = this.manager!.startTurn(
				rendered,
				model_settings.system_prompt || undefined,
				this.id
			);

			turn.onDelta((delta) => {
				result += delta;
			});

			turn.onDone(() => {
				resolve(this.interpret(prompt, result));
			});

			turn.onError((msg) => {
				if (result.length > 0) {
					resolve(this.interpret(prompt, result));
				} else {
					reject(new Error(msg));
				}
			});
		});
	}

	async *iterate(prompt: Prompt, settings: string): AsyncGenerator<string> {
		const model_settings = parse_model_settings(settings);

		if (!this.manager) {
			return;
		}

		try {
			await this.manager.ensureConnected();
		} catch {
			return;
		}

		const prompt_data = await this.prepare(prompt, model_settings);
		const rendered = Mustache.render(
			model_settings.user_prompt,
			prompt_data
		);

		// Bridge callbacks to async generator using a promise queue
		const queue: { value: string; done: boolean }[] = [];
		let resolve: (() => void) | null = null;

		const turn = this.manager.startTurn(
			rendered,
			model_settings.system_prompt || undefined,
			this.id
		);

		turn.onDelta((delta) => {
			queue.push({ value: delta, done: false });
			if (resolve) {
				resolve();
				resolve = null;
			}
		});

		turn.onDone(() => {
			queue.push({ value: "", done: true });
			if (resolve) {
				resolve();
				resolve = null;
			}
		});

		turn.onError(() => {
			queue.push({ value: "", done: true });
			if (resolve) {
				resolve();
				resolve = null;
			}
		});

		// Anti-pregeneration: strip repeated prefix from local models
		let generated = "";
		let started = false;
		// Buffer early tokens so interpret() sees enough text for sanitize
		let buf = "";
		let flushed = false;

		while (true) {
			if (queue.length === 0) {
				await new Promise<void>((r) => {
					resolve = r;
				});
			}

			const item = queue.shift()!;
			if (item.done) break;

			let token = item.value;
			generated += token;

			if (prompt_data.last_line.includes(generated)) {
				continue;
			}

			if (!started) {
				for (let i = generated.length - 1; i >= 0; i--) {
					if (
						prompt_data.last_line.endsWith(
							generated.slice(0, i)
						)
					) {
						token = generated.slice(i);
						started = true;
						break;
					}
				}
			}

			if (!token) {
				continue;
			}

			if (!flushed) {
				buf += token;
				if (buf.length >= 30 || (buf.length >= 4 && !/^(Here|Sure|```)/i.test(buf))) {
					const cleaned = this.interpret(prompt, buf);
					if (cleaned.trim()) yield cleaned;
					flushed = true;
				}
			} else {
				yield token;
			}
		}
		if (!flushed && buf.length > 0) {
			const cleaned = this.interpret(prompt, buf);
			if (cleaned.trim()) yield cleaned;
		}
	}

	interpret(prompt: Prompt, completion: string) {
		// Strip common chat-model preamble (require colon to avoid false positives)
		completion = completion
			.replace(/^Here[''\u2019]?s?( is)?( the)?( completion| text| continuation)?:\s*/i, "")
			.replace(/^Sure[,!.]\s*/i, "")
			.replace(/^```[a-z]*\n?/, "")
			.replace(/\n?```\s*$/, "")
			.trimEnd();

		if (!completion) return "";

		const response_punctuation = " \n.,?!:;";
		const prompt_punctuation = " \n";

		if (
			prompt.prefix.length !== 0 &&
			!prompt_punctuation.includes(
				prompt.prefix[prompt.prefix.length - 1]
			) &&
			!response_punctuation.includes(completion[0])
		) {
			completion = " " + completion;
		}

		return completion;
	}
}

export class CodexComplete implements Completer {
	id: string = "codex";
	name: string = "Codex";
	description: string = "Codex app-server via WebSocket";

	async get_models(settings: string) {
		const provider_settings = parse_provider_settings(settings);
		try {
			const models = await CodexWebSocket.listModels(
				provider_settings.endpoint
			);
			if (models.length > 0) {
				return models.map(
					(m: CodexModelInfo) =>
						new CodexModel(
							settings,
							m.slug,
							m.display_name,
							m.description
						)
				);
			}
		} catch {
			// Fall through to hardcoded fallback
		}
		// Fallback if server is unreachable
		return [
			new CodexModel(
				settings,
				"gpt-5.3-codex",
				"GPT-5.3 Codex",
				"Latest frontier agentic coding model"
			),
		];
	}

	Settings = ProviderSettingsUI;
}
