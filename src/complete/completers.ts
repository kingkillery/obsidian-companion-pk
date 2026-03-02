import { Completer } from "./complete";
import { OpenAIComplete } from "./completers/openai/openai";
import { ChatGPTComplete } from "./completers/chatgpt/chatgpt";
import { JurassicJ2Complete } from "./completers/ai21/ai21";
import { GooseAIComplete } from "./completers/gooseai/gooseai";
import { OobaboogaComplete } from "./completers/oobabooga/oobabooga";
import { OllamaComplete } from "./completers/ollama/ollama";
import { GroqComplete } from "./completers/groq/groq";
import { CodexComplete } from "./completers/codex/codex";
import { OpenRouterComplete } from "./completers/openrouter/openrouter";
import { MiniMaxComplete } from "./completers/minimax/minimax";
import { ZAIComplete } from "./completers/zai/zai";

export const available: Completer[] = [
	new ChatGPTComplete(),
	new OpenAIComplete(),
	new JurassicJ2Complete(),
	new GooseAIComplete(),
	new OobaboogaComplete(),
	new OllamaComplete(),
	new GroqComplete(),
	new CodexComplete(),
	new OpenRouterComplete(),
	new MiniMaxComplete(),
	new ZAIComplete(),
];
