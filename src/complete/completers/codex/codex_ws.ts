import { Notice } from "obsidian";

interface TurnHandle {
	onDelta: (cb: (delta: string) => void) => void;
	onDone: (cb: () => void) => void;
	onError: (cb: (msg: string) => void) => void;
	cancel: () => void;
}

export interface CodexModelInfo {
	slug: string;
	display_name: string;
	description: string;
}

type Phase = "connecting" | "initializing" | "initialized" | "ready";

export class CodexWebSocket {
	private ws: WebSocket | null = null;
	private endpoint: string = "";
	private nextId: number = 1;
	private threadId: string | null = null;
	private phase: Phase = "connecting";

	private pendingDelta: ((delta: string) => void) | null = null;
	private pendingDone: (() => void) | null = null;
	private pendingError: ((msg: string) => void) | null = null;

	private pendingResponses: Map<
		number,
		{
			resolve: (result: any) => void;
			reject: (err: Error) => void;
		}
	> = new Map();

	private connectResolve: (() => void) | null = null;
	private connectReject: ((err: Error) => void) | null = null;
	private connectTimeout: number | null = null;

	// --- public API ---

	async connect(endpoint: string): Promise<void> {
		this.endpoint = endpoint;
		return this.doConnect(true);
	}

	disconnect(): void {
		this.cleanup("Disconnected");
	}

	isReady(): boolean {
		return this.phase === "ready";
	}

	async ensureConnected(): Promise<void> {
		if (
			this.phase === "ready" &&
			this.ws &&
			this.ws.readyState === WebSocket.OPEN
		) {
			return;
		}
		await this.doConnect(true);
	}

	startTurn(prompt: string, system?: string, model?: string): TurnHandle {
		let deltaCallback: ((delta: string) => void) | null = null;
		let doneCallback: (() => void) | null = null;
		let errorCallback: ((msg: string) => void) | null = null;
		let cancelled = false;

		const timeout = window.setTimeout(() => {
			if (!cancelled) {
				cancelled = true;
				this.clearTurnCallbacks();
				this.send("turn/interrupt", {});
				if (errorCallback) errorCallback("Request timed out");
			}
		}, 30000);

		this.pendingDelta = (delta: string) => {
			if (!cancelled && deltaCallback) deltaCallback(delta);
		};
		this.pendingDone = () => {
			if (!cancelled) {
				window.clearTimeout(timeout);
				this.clearTurnCallbacks();
				if (doneCallback) doneCallback();
			}
		};
		this.pendingError = (msg: string) => {
			if (!cancelled) {
				window.clearTimeout(timeout);
				this.clearTurnCallbacks();
				if (errorCallback) errorCallback(msg);
			}
		};

		const input: any[] = [];
		if (system) {
			input.push({ type: "text", text: `[System] ${system}\n\n` });
		}
		input.push({ type: "text", text: prompt });

		const turnParams: any = {
			threadId: this.threadId,
			input,
			approvalPolicy: "never",
		};
		if (model) {
			turnParams.model = model;
		}
		this.send("turn/start", turnParams);

		return {
			onDelta: (cb) => {
				deltaCallback = cb;
			},
			onDone: (cb) => {
				doneCallback = cb;
			},
			onError: (cb) => {
				errorCallback = cb;
			},
			cancel: () => {
				if (!cancelled) {
					cancelled = true;
					window.clearTimeout(timeout);
					this.clearTurnCallbacks();
					this.send("turn/interrupt", {});
				}
			},
		};
	}

	async fetchModels(): Promise<CodexModelInfo[]> {
		const result = await this.request("model/list", {
			includeHidden: false,
		});
		if (!result?.data) return [];
		return result.data.map((m: any) => ({
			slug: m.id || m.model || m.slug,
			display_name: m.displayName || m.display_name || m.id,
			description: m.description || "",
		}));
	}

	/**
	 * One-shot: open a temporary connection, fetch models, close.
	 * Only does initialize + initialized — no thread needed for model/list.
	 */
	static async listModels(endpoint: string): Promise<CodexModelInfo[]> {
		const mgr = new CodexWebSocket();
		try {
			// Light connect — skip thread/start
			await mgr.doConnect(false);
			const models = await mgr.fetchModels();
			mgr.disconnect();
			return models;
		} catch (e) {
			console.warn("Codex listModels failed:", e);
			mgr.disconnect();
			return [];
		}
	}

	// --- private ---

	private request(method: string, params: any): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("WebSocket not connected"));
				return;
			}
			const id = this.nextId++;
			this.pendingResponses.set(id, { resolve, reject });
			this.ws.send(
				JSON.stringify({ jsonrpc: "2.0", id, method, params })
			);
			window.setTimeout(() => {
				if (this.pendingResponses.has(id)) {
					this.pendingResponses.delete(id);
					reject(new Error(`Request ${method} timed out`));
				}
			}, 10000);
		});
	}

	private send(method: string, params: any): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: this.nextId++,
				method,
				params,
			})
		);
	}

	private notify(method: string): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify({ jsonrpc: "2.0", method }));
	}

	private doConnect(startThread: boolean): Promise<void> {
		// Clean up any prior state
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.onmessage = null;
			this.ws.close();
			this.ws = null;
		}
		this.phase = "connecting";
		this.threadId = null;
		this.nextId = 1;

		return new Promise<void>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;

			// Global timeout so connect never hangs forever
			this.connectTimeout = window.setTimeout(() => {
				this.resolveConnect(
					new Error("Connection timed out"),
					startThread
				);
			}, 15000);

			try {
				this.ws = new WebSocket(this.endpoint);
			} catch (e: any) {
				this.resolveConnect(
					new Error(`WebSocket creation failed: ${e.message}`),
					startThread
				);
				return;
			}

			this.ws.onopen = () => {
				this.phase = "initializing";
				// Step 1: send initialize request
				this.send("initialize", {
					clientInfo: {
						name: "obsidian-companion",
						version: "1.0.0",
					},
					capabilities: {},
				});
			};

			this.ws.onmessage = (event: MessageEvent) => {
				this.handleMessage(event.data as string, startThread);
			};

			this.ws.onerror = () => {
				this.resolveConnect(
					new Error("WebSocket connection failed"),
					startThread
				);
			};

			this.ws.onclose = () => {
				// Reject pending init
				this.resolveConnect(
					new Error("Connection closed unexpectedly"),
					startThread
				);

				// Reject any pending RPC responses
				for (const [, pending] of this.pendingResponses) {
					pending.reject(new Error("Connection lost"));
				}
				this.pendingResponses.clear();

				// Reject any pending turn
				if (this.pendingError) {
					this.pendingError("Connection lost");
				}
				this.clearTurnCallbacks();

				this.phase = "connecting";
				this.threadId = null;
				this.ws = null;
			};
		});
	}

	private resolveConnect(error?: Error, startThread?: boolean): void {
		if (this.connectTimeout) {
			window.clearTimeout(this.connectTimeout);
			this.connectTimeout = null;
		}
		if (error) {
			if (this.connectReject) {
				this.connectReject(error);
			}
		} else {
			if (this.connectResolve) {
				this.connectResolve();
			}
		}
		this.connectResolve = null;
		this.connectReject = null;
	}

	private handleMessage(data: string, startThread: boolean): void {
		if (!data || data.trim().length === 0) return;

		let msg: any;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}

		// --- JSON-RPC responses (have id + result/error) ---
		if (
			msg.id !== undefined &&
			(msg.result !== undefined || msg.error !== undefined)
		) {
			// Tracked request/response
			const pending = this.pendingResponses.get(msg.id);
			if (pending) {
				this.pendingResponses.delete(msg.id);
				if (msg.error) {
					pending.reject(
						new Error(msg.error.message || "RPC error")
					);
				} else {
					pending.resolve(msg.result);
				}
				return;
			}

			// Untracked response during init phase
			if (this.phase === "initializing" && msg.result) {
				// This is the initialize response
				// Step 2: send initialized notification
				this.notify("initialized");
				this.phase = "initialized";

				if (startThread) {
					// Step 3: start a thread
					const threadId = crypto.randomUUID();
					this.threadId = threadId;
					this.send("thread/start", {
						threadId,
						ephemeral: true,
					});
				} else {
					// No thread needed (e.g. just fetching models)
					this.resolveConnect();
				}
				return;
			}

			// Untracked response to thread/start — ignore it,
			// we wait for the thread/started notification instead
			return;
		}

		// --- JSON-RPC notifications (have method, no id) ---
		const method = msg.method;
		if (!method) return;

		switch (method) {
			case "thread/started":
				this.phase = "ready";
				this.resolveConnect();
				break;

			case "item/agentMessage/delta":
				if (msg.params?.delta && this.pendingDelta) {
					this.pendingDelta(msg.params.delta);
				}
				break;

			case "turn/completed":
				if (this.pendingDone) {
					this.pendingDone();
				}
				break;

			case "turn/errored":
				if (this.pendingError) {
					const errorMsg =
						msg.params?.message ||
						msg.params?.error ||
						"Turn error";
					this.pendingError(errorMsg);
					new Notice(`Codex error: ${errorMsg}`);
				}
				break;

			// Ignore known notifications we don't care about
			case "turn/started":
			case "codex/event/mcp_startup_complete":
			default:
				break;
		}
	}

	private clearTurnCallbacks(): void {
		this.pendingDelta = null;
		this.pendingDone = null;
		this.pendingError = null;
	}

	private cleanup(reason: string): void {
		if (this.connectTimeout) {
			window.clearTimeout(this.connectTimeout);
			this.connectTimeout = null;
		}
		if (this.connectReject) {
			this.connectReject(new Error(reason));
			this.connectResolve = null;
			this.connectReject = null;
		}
		for (const [, pending] of this.pendingResponses) {
			pending.reject(new Error(reason));
		}
		this.pendingResponses.clear();
		this.clearTurnCallbacks();
		this.phase = "connecting";
		this.threadId = null;
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.onmessage = null;
			this.ws.close();
			this.ws = null;
		}
	}
}
