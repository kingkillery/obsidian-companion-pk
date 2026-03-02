import { requestUrl } from "obsidian";
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
import Mustache from "mustache";

export default class OllamaModel implements Model {
	id: string;
	name: string;
	description: string;
	rate_limit_notice: Notice | null = null;
	rate_limit_notice_timeout: number | null = null;
	Settings = ModelSettingsUI;

	provider_settings: ProviderSettings;

	cancel_generations: (() => void)[];

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
		this.cancel_generations = [];
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

		const response = await requestUrl({
			url: this.provider_settings.endpoint + "/api/generate",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prompt: Mustache.render(
					model_settings.user_prompt,
					await this.prepare(prompt, model_settings)
				),
				system: model_settings.system_prompt,
				model: this.id,
				stream: false,
				options: {
					temp: model_settings.temperature,
				},
			}),
			throw: true,
		});
		return this.interpret(prompt, (await response.json).response);
	}

	async *iterate(prompt: Prompt, settings: string): AsyncGenerator<string> {
		try {
			const model_settings = parse_model_settings(settings);

			for (const cancel_generation of this.cancel_generations) {
				cancel_generation();
			}

			const textGenerator: {
				state: string;
				next: () => Promise<string>;
				registerItem: (() => void) | null;
			} = {
				state: "",
				next: async (): Promise<string> => {
					if (textGenerator.state.length === 0) {
						await new Promise((resolve) => {
							textGenerator.registerItem = () => {
								textGenerator.registerItem = null;
								resolve(null);
							};
						});
					}
					const state = textGenerator.state;
					// Get the first pre-newline part
					const index = state.indexOf("\n");
					const part = state.slice(0, index);
					textGenerator.state = state.slice(index + 1);
					return JSON.parse(part).response;
				},
				registerItem: null,
			};

			const { remote } = require("electron");

			const request = remote.net.request({
				url: this.provider_settings.endpoint + "/api/generate",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
			});

			const prompt_data = await this.prepare(prompt, model_settings);
			const body = JSON.stringify({
				prompt: Mustache.render(
					model_settings.user_prompt,
					prompt_data
				),
				system: model_settings.system_prompt,
				model: this.id,
				stream: true,
				options: {
					temp: model_settings.temperature,
				},
			});
			request.write(body);

			this.cancel_generations.push(() => {
				request.abort();
			});

			request.on("response", (response: any) => {
				response.on("data", (chunk: any) => {
					textGenerator.state += chunk;
					if (textGenerator.registerItem) {
						textGenerator.registerItem();
					}
				});

				response.on("end", () => {
					this.cancel_generations = this.cancel_generations.filter(
						(x) => x !== request.abort
					);
				});
			});
			request.end();

			// Anti-pregeneration: strip repeated prefix from local models
			let generated = "";
			let started = false;
			// Buffer early tokens so interpret() sees enough text for sanitize
			let buf = "";
			let flushed = false;
			while (true) {
				let token = await textGenerator.next();
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
		} catch {
			// A lot can go wrong - e.g., electron is not available on
			// mobile. In that case, we just fall back to the non-streaming
			// version.
			yield this.complete(prompt, settings);
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

export class OllamaComplete implements Completer {
	id: string = "ollama";
	name: string = "Ollama";
	description: string = "Ollama's API, for local models";

	async get_models(settings: string) {
		const provider_settings = parse_provider_settings(settings);
		const response = await requestUrl({
			url: `${provider_settings.endpoint}/api/tags`,
			method: "GET",
			headers: {
				"Content-Type": "application/json",
			},
			throw: true,
		}).then((response) => response.json);

		return response.models.map((model: any) => {
			return new OllamaModel(
				settings,
				model.name,
				model.name,
				model.name
			);
		});
	}

	Settings = ProviderSettingsUI;
}
