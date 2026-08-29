import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piOpenAIFast, { _test } from "../extensions/index.js";

type RegisteredFlag = {
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
};

type RegisteredHandlers = Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;

type MockPi = {
	commands: Map<string, Omit<RegisteredCommand, "name">>;
	flags: Map<string, RegisteredFlag>;
	handlers: RegisteredHandlers;
	appendEntry: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
};

type MockUi = {
	notify: ReturnType<typeof vi.fn>;
	theme: {
		fg: (color: string, text: string) => string;
	};
};

function createTempWorkspace(): { cwd: string; homeDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-openai-fast-"));
	const cwd = join(root, "workspace");
	const homeDir = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", join(homeDir, ".pi", "agent"));
	return {
		cwd,
		homeDir,
		cleanup: () => {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function createMockPi(flagValue?: boolean): MockPi {
	const commands = new Map<string, Omit<RegisteredCommand, "name">>();
	const flags = new Map<string, RegisteredFlag>();
	const handlers: RegisteredHandlers = new Map();

	return {
		commands,
		flags,
		handlers,
		appendEntry: vi.fn(),
		getFlag: vi.fn((name: string) => (name === _test.FAST_FLAG ? flagValue : undefined)),
		registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name">) => {
			commands.set(name, options);
		}),
		registerFlag: vi.fn((name: string, options: RegisteredFlag) => {
			flags.set(name, options);
		}),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		}),
	};
}

function createMockContext(
	model: ExtensionContext["model"],
	branch: unknown[] = [],
	cwd: string = process.cwd(),
): { ctx: ExtensionCommandContext; ui: MockUi } {
	const ui: MockUi = {
		notify: vi.fn(),
		theme: {
			fg: (color, text) => `${color}:${text}`,
		},
	};

	const ctx = {
		hasUI: true,
		cwd,
		sessionManager: {
			getBranch: () => branch,
		},
		modelRegistry: {},
		model,
		ui,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;

	return { ctx, ui };
}

function getRegisteredCommand(mockPi: MockPi, name: string): Omit<RegisteredCommand, "name"> {
	const command = mockPi.commands.get(name);
	expect(command).toBeDefined();
	if (!command) {
		throw new Error(`Missing command: ${name}`);
	}
	return command;
}

function getRegisteredHandler(mockPi: MockPi, eventName: string): (event: unknown, ctx: ExtensionContext) => unknown {
	const handler = mockPi.handlers.get(eventName);
	expect(handler).toBeDefined();
	if (!handler) {
		throw new Error(`Missing handler: ${eventName}`);
	}
	return handler;
}

describe("pi-openai-fast", () => {
	it("registers the fast command and flag", () => {
		const mockPi = createMockPi();
		piOpenAIFast(mockPi as unknown as ExtensionAPI);

		expect(mockPi.commands.has("fast")).toBe(true);
		expect(mockPi.flags.get("fast")).toEqual({
			description: "Start with OpenAI fast mode enabled",
			type: "boolean",
			default: false,
		});
		expect(mockPi.handlers.has("before_provider_request")).toBe(true);
		expect(mockPi.handlers.has("before_provider_headers")).toBe(true);
		expect(mockPi.handlers.has("session_start")).toBe(true);
	});

	it("enables fast mode for supported models and injects the priority service tier", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);

			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);

			const command = getRegisteredCommand(mockPi, "fast");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");

			const { ctx, ui } = createMockContext(
				{ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"],
				[],
				cwd,
			);
			await command.handler("on", ctx);

			expect(mockPi.appendEntry).not.toHaveBeenCalled();
			expect(ui.notify).toHaveBeenCalledWith("Fast mode is on for openai/gpt-5.4.", "info");

			const payload = beforeProviderRequest(
				{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
				ctx,
			);
			expect(payload).toEqual({ input: "hello", service_tier: "priority" });

			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			expect(JSON.parse(readFileSync(globalConfigPath, "utf-8"))).toEqual({
				persistState: true,
				active: true,
				supportedModels: [..._test.DEFAULT_SUPPORTED_MODEL_KEYS],
			});
		} finally {
			cleanup();
		}
	});

	it("keeps fast mode active but skips payload changes on unsupported models", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);

			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);

			const command = getRegisteredCommand(mockPi, "fast");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");

			const { ctx, ui } = createMockContext(
				{
					provider: "anthropic",
					id: "claude-sonnet-4",
				} as ExtensionContext["model"],
				[],
				cwd,
			);
			await command.handler("on", ctx);

			expect(ui.notify).toHaveBeenCalledWith(
				`Fast mode is on, but anthropic/claude-sonnet-4 does not support it. Supported models: ${_test.DEFAULT_SUPPORTED_MODEL_KEYS.join(", ")}.`,
				"info",
			);

			const payload = beforeProviderRequest(
				{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
				ctx,
			);
			expect(payload).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("restores persisted config and honors configured supported models", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(
				globalConfigPath,
				`${JSON.stringify({ persistState: true, active: true, supportedModels: ["openai/gpt-5.5"] }, null, 2)}\n`,
				"utf-8",
			);

			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);

			const sessionStart = getRegisteredHandler(mockPi, "session_start");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");

			const { ctx, ui } = createMockContext(
				{ provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"],
				[],
				cwd,
			);
			await sessionStart({ type: "session_start" }, ctx);

			expect(mockPi.appendEntry).not.toHaveBeenCalled();
			expect(ui.notify).not.toHaveBeenCalled();
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", service_tier: "priority" });
		} finally {
			cleanup();
		}
	});

	it("ignores resumed session state and uses config-backed startup state", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(globalConfigPath, `${JSON.stringify({ persistState: true, active: false }, null, 2)}\n`, "utf-8");

			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);

			const sessionStart = getRegisteredHandler(mockPi, "session_start");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const savedState = [
				{
					type: "custom",
					customType: "pi-openai-fast.state",
					data: { active: true },
				},
			];
			const { ctx, ui } = createMockContext(
				{ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"],
				savedState,
				cwd,
			);
			await sessionStart({ type: "session_start" }, ctx);

			expect(mockPi.appendEntry).not.toHaveBeenCalled();
			expect(ui.notify).not.toHaveBeenCalled();
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("uses cached config for provider requests and refreshes it on command execution", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(
				globalConfigPath,
				`${JSON.stringify({ persistState: true, active: true, supportedModels: ["openai/gpt-5.5"] }, null, 2)}\n`,
				"utf-8",
			);

			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);

			const sessionStart = getRegisteredHandler(mockPi, "session_start");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const command = getRegisteredCommand(mockPi, "fast");
			const { ctx, ui } = createMockContext(
				{ provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"],
				[],
				cwd,
			);

			await sessionStart({ type: "session_start" }, ctx);
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", service_tier: "priority" });

			writeFileSync(
				globalConfigPath,
				`${JSON.stringify({ persistState: true, active: true, supportedModels: ["openai/gpt-5.4"] }, null, 2)}\n`,
				"utf-8",
			);

			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", service_tier: "priority" });

			await command.handler("status", ctx);
			expect(ui.notify).toHaveBeenLastCalledWith(
				"Fast mode is on, but openai/gpt-5.5 does not support it. Supported models: openai/gpt-5.4.",
				"info",
			);
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("migrates the legacy ~/.pi/agent global config when PI_CODING_AGENT_DIR points elsewhere", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const customAgentDir = join(homeDir, "custom-agent");
			vi.stubEnv("PI_CODING_AGENT_DIR", customAgentDir);

			const legacyConfig = { persistState: true, active: true, supportedModels: ["openai/gpt-5.5"] };
			const legacyGlobalConfigPath = join(homeDir, ".pi", "agent", "extensions", _test.FAST_CONFIG_BASENAME);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(legacyGlobalConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf-8");

			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);

			const sessionStart = getRegisteredHandler(mockPi, "session_start");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx, ui } = createMockContext(
				{ provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"],
				[],
				cwd,
			);
			await sessionStart({ type: "session_start" }, ctx);

			expect(ui.notify).not.toHaveBeenCalled();
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", service_tier: "priority" });

			const migratedConfigPath = join(customAgentDir, "extensions", _test.FAST_CONFIG_BASENAME);
			expect(JSON.parse(readFileSync(migratedConfigPath, "utf-8"))).toEqual(legacyConfig);
			expect(JSON.parse(readFileSync(legacyGlobalConfigPath, "utf-8"))).toEqual(legacyConfig);
		} finally {
			cleanup();
		}
	});

	it("keeps values from the migrated global config underneath a partial project override", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const customAgentDir = join(homeDir, "custom-agent");
			vi.stubEnv("PI_CODING_AGENT_DIR", customAgentDir);

			const legacyGlobalConfigPath = join(homeDir, ".pi", "agent", "extensions", _test.FAST_CONFIG_BASENAME);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(
				legacyGlobalConfigPath,
				`${JSON.stringify({ persistState: true, active: true }, null, 2)}\n`,
				"utf-8",
			);
			const projectConfigPath = join(cwd, ".pi", "extensions", _test.FAST_CONFIG_BASENAME);
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				projectConfigPath,
				`${JSON.stringify({ supportedModels: ["openai/gpt-5.6-sol"] }, null, 2)}\n`,
				"utf-8",
			);

			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);

			const sessionStart = getRegisteredHandler(mockPi, "session_start");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx, ui } = createMockContext(
				{ provider: "openai", id: "gpt-5.6-sol" } as ExtensionContext["model"],
				[],
				cwd,
			);
			await sessionStart({ type: "session_start" }, ctx);

			expect(ui.notify).not.toHaveBeenCalled();
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", service_tier: "priority" });
		} finally {
			cleanup();
		}
	});

	it("does not overwrite an existing config in the new agent dir with the legacy one", () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const customAgentDir = join(homeDir, "custom-agent");
			vi.stubEnv("PI_CODING_AGENT_DIR", customAgentDir);

			const legacyGlobalConfigPath = join(homeDir, ".pi", "agent", "extensions", _test.FAST_CONFIG_BASENAME);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(
				legacyGlobalConfigPath,
				`${JSON.stringify({ persistState: true, active: true, supportedModels: ["openai/gpt-5.5"] }, null, 2)}\n`,
				"utf-8",
			);
			const newGlobalConfig = { persistState: true, active: false, supportedModels: ["openai/gpt-5.4"] };
			const newGlobalConfigPath = join(customAgentDir, "extensions", _test.FAST_CONFIG_BASENAME);
			mkdirSync(join(customAgentDir, "extensions"), { recursive: true });
			writeFileSync(newGlobalConfigPath, `${JSON.stringify(newGlobalConfig, null, 2)}\n`, "utf-8");

			const resolved = _test.resolveFastConfig(cwd);

			expect(resolved.configPath).toBe(newGlobalConfigPath);
			expect(resolved.active).toBe(false);
			expect(resolved.supportedModels).toEqual([{ provider: "openai", id: "gpt-5.4" }]);
			expect(JSON.parse(readFileSync(newGlobalConfigPath, "utf-8"))).toEqual(newGlobalConfig);
		} finally {
			cleanup();
		}
	});

	it("ignores resumed session state and still honors the --fast flag", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);

			const savedState = [
				{
					type: "custom",
					customType: "pi-openai-fast.state",
					data: { active: true },
				},
			];

			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(globalConfigPath, `${JSON.stringify({ persistState: true, active: false }, null, 2)}\n`, "utf-8");

			const restoredPi = createMockPi();
			piOpenAIFast(restoredPi as unknown as ExtensionAPI);

			const restoredSessionStart = getRegisteredHandler(restoredPi, "session_start");
			const restoredBeforeProviderRequest = getRegisteredHandler(restoredPi, "before_provider_request");

			const restoredContext = createMockContext(
				{ provider: "openai-codex", id: "gpt-5.4" } as ExtensionContext["model"],
				savedState,
				cwd,
			);
			await restoredSessionStart({ type: "session_start" }, restoredContext.ctx);
			expect(restoredContext.ui.notify).not.toHaveBeenCalled();
			expect(
				restoredBeforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					restoredContext.ctx,
				),
			).toBeUndefined();

			const flaggedPi = createMockPi(true);
			piOpenAIFast(flaggedPi as unknown as ExtensionAPI);

			const flaggedSessionStart = getRegisteredHandler(flaggedPi, "session_start");
			const flaggedBeforeProviderRequest = getRegisteredHandler(flaggedPi, "before_provider_request");
			const flaggedContext = createMockContext(
				{ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"],
				savedState,
				cwd,
			);
			await flaggedSessionStart({ type: "session_start" }, flaggedContext.ctx);

			expect(flaggedPi.appendEntry).not.toHaveBeenCalled();
			expect(flaggedContext.ui.notify).not.toHaveBeenCalled();
			// The --fast flag still enables fast mode for the session, silently.
			expect(
				flaggedBeforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					flaggedContext.ctx,
				),
			).toEqual({ input: "hello", service_tier: "priority" });
		} finally {
			cleanup();
		}
	});

	it("rewrites openai provider headers to match the codex CLI", () => {
		const mockPi = createMockPi();
		piOpenAIFast(mockPi as unknown as ExtensionAPI);

		const beforeProviderHeaders = getRegisteredHandler(mockPi, "before_provider_headers");
		const { ctx } = createMockContext({ provider: "openai-codex", id: "gpt-5.4" } as ExtensionContext["model"]);

		const headers: Record<string, string | null> = {
			"User-Agent": "pi/0.84",
			authorization: "Bearer token",
		};
		beforeProviderHeaders({ type: "before_provider_headers", headers }, ctx);

		expect(headers.originator).toBe(_test.CODEX_ORIGINATOR);
		expect(headers["User-Agent"]).toBeNull();
		expect(headers["user-agent"]).toMatch(new RegExp(`^${_test.CODEX_ORIGINATOR}/${_test.CODEX_CLI_VERSION.replace(/\./g, "\\.")} \\(`));
		expect(headers.authorization).toBe("Bearer token");
	});

	it("leaves non-openai provider headers untouched", () => {
		const mockPi = createMockPi();
		piOpenAIFast(mockPi as unknown as ExtensionAPI);

		const beforeProviderHeaders = getRegisteredHandler(mockPi, "before_provider_headers");
		const { ctx } = createMockContext({ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"]);

		const headers: Record<string, string | null> = { "User-Agent": "pi/0.84" };
		beforeProviderHeaders({ type: "before_provider_headers", headers }, ctx);

		expect(headers).toEqual({ "User-Agent": "pi/0.84" });
	});
});
