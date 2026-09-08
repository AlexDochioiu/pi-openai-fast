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

describe("per-family fast mode", () => {
	it("applies overrides across model switches and providers, persists them, and reports every family", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);
			const { ctx, ui } = createMockContext(undefined, [], cwd);
			const command = getRegisteredCommand(mockPi, "fast");
			const start = getRegisteredHandler(mockPi, "session_start");
			const request = getRegisteredHandler(mockPi, "before_provider_request");
			await start({}, ctx);
			await command.handler("default on", ctx);
			await command.handler("  AsTrA   OFF  ", ctx);
			await command.handler("sol on", ctx);
			await command.handler("terra off", ctx);
			await command.handler("terra default", ctx);
			for (const provider of ["openai", "openai-codex"]) {
				for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.5"]) {
					ctx.model = { provider, id } as ExtensionContext["model"];
					const result = request({ payload: { input: "hello" } }, ctx);
					expect(result).toEqual(id === "gpt-6-astra" ? undefined : { input: "hello", service_tier: "priority" });
				}
			}
			ctx.model = undefined;
			await command.handler("status", ctx);
			expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining([
				"Default: on", "Luna: on (default)", "Terra: on (default)",
				"Astra: off (override)", "Sol: on (override)",
			].join("\n")), "info");

			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			expect(_test.readConfigFile(globalConfigPath)).toMatchObject({
				active: true, families: { astra: false, sol: true, terra: "default" },
			});
			// A fresh instance must restore family choices, not just the default.
			const restoredPi = createMockPi();
			piOpenAIFast(restoredPi as unknown as ExtensionAPI);
			await getRegisteredHandler(restoredPi, "session_start")({}, ctx);
			await getRegisteredCommand(restoredPi, "fast").handler("status", ctx);
			expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Astra: off (override)"), "info");

			// Legacy aliases and bare toggle change only the default.
			for (const input of ["off", "", "default off", "on", "off"]) await command.handler(input, ctx);
			ctx.model = { provider: "openai", id: "gpt-5.6-sol" } as ExtensionContext["model"];
			expect(request({ payload: {} }, ctx)).toEqual({ service_tier: "priority" });
			ctx.model = { provider: "openai", id: "gpt-5.6-terra" } as ExtensionContext["model"];
			expect(request({ payload: {} }, ctx)).toBeUndefined();
			await command.handler("astra on", ctx);
			ctx.model = { provider: "openai-codex", id: "gpt-6-astra" } as ExtensionContext["model"];
			expect(request({ payload: {} }, ctx)).toEqual({ service_tier: "priority" });
		} finally { cleanup(); }
	});

	it("merges families individually and persists project default resets without pinning global values", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const { globalConfigPath, projectConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			const globalConfig = { active: true, families: { terra: false, astra: false, sol: true } };
			writeFileSync(globalConfigPath, JSON.stringify(globalConfig));
			writeFileSync(projectConfigPath, JSON.stringify({ families: { astra: true } }));
			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);
			const { ctx } = createMockContext({ provider: "openai", id: "gpt-5.6-terra" } as ExtensionContext["model"], [], cwd);
			const start = getRegisteredHandler(mockPi, "session_start");
			const request = getRegisteredHandler(mockPi, "before_provider_request");
			await start({}, ctx);
			expect(request({ payload: {} }, ctx)).toBeUndefined();
			await getRegisteredCommand(mockPi, "fast").handler("terra default", ctx);
			await start({}, ctx);
			expect(request({ payload: {} }, ctx)).toEqual({ service_tier: "priority" });
			expect(_test.readConfigFile(projectConfigPath)).toEqual({ families: { astra: true, terra: "default" } });
			expect(_test.readConfigFile(globalConfigPath)).toEqual(globalConfig);
			expect(_test.resolveFastConfig(cwd, homeDir).families).toEqual({ astra: true, terra: "default", sol: true });
		} finally { cleanup(); }
	});

	it("keeps non-persistent overrides session-local and does not bypass supportedModels", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			const config = { persistState: false, active: true, families: { luna: true }, supportedModels: ["openai/gpt-5.6-luna"] };
			writeFileSync(globalConfigPath, JSON.stringify(config));
			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);
			const { ctx } = createMockContext({ provider: "openai", id: "gpt-5.6-luna" } as ExtensionContext["model"], [], cwd);
			const start = getRegisteredHandler(mockPi, "session_start");
			const request = getRegisteredHandler(mockPi, "before_provider_request");
			const command = getRegisteredCommand(mockPi, "fast");
			await start({}, ctx);
			expect(request({ payload: {} }, ctx)).toBeUndefined();
			await command.handler("luna on", ctx);
			await command.handler("status", ctx);
			expect(request({ payload: {} }, ctx)).toEqual({ service_tier: "priority" });
			ctx.model = { provider: "openai-codex", id: "gpt-5.6-luna" } as ExtensionContext["model"];
			expect(request({ payload: {} }, ctx)).toBeUndefined();
			ctx.model = { provider: "openai", id: "gpt-5.6-luna" } as ExtensionContext["model"];
			await start({}, ctx);
			expect(request({ payload: {} }, ctx)).toBeUndefined();
			expect(_test.readConfigFile(globalConfigPath)).toEqual(config);
		} finally { cleanup(); }
	});

	it("honors family overrides with --fast and stays silent on startup", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(globalConfigPath, JSON.stringify({ active: false, families: { astra: false } }));
			const mockPi = createMockPi(true);
			piOpenAIFast(mockPi as unknown as ExtensionAPI);
			const { ctx, ui } = createMockContext({ provider: "openai", id: "gpt-6-astra" } as ExtensionContext["model"], [], cwd);
			await getRegisteredHandler(mockPi, "session_start")({}, ctx);
			expect(ui.notify).not.toHaveBeenCalled();
			expect(getRegisteredHandler(mockPi, "before_provider_request")({ payload: {} }, ctx)).toBeUndefined();
			expect(_test.readConfigFile(globalConfigPath)).toEqual({ active: true, families: { astra: false } });
		} finally { cleanup(); }
	});

	it("completes targets and modes and rejects invalid commands without modifying state", async () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const mockPi = createMockPi();
			piOpenAIFast(mockPi as unknown as ExtensionAPI);
			const command = getRegisteredCommand(mockPi, "fast");
			const { ctx, ui } = createMockContext(undefined, [], cwd);
			await getRegisteredHandler(mockPi, "session_start")({}, ctx);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			const before = readFileSync(globalConfigPath, "utf8");
			for (const invalid of ["default", "default default", "astra", "astra maybe", "sol on extra", "unknown on", "status on"]) {
				await command.handler(invalid, ctx);
				expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage:"), "error");
			}
			expect(readFileSync(globalConfigPath, "utf8")).toBe(before);
			expect((await command.getArgumentCompletions?.(""))?.map((item) => item.value)).toEqual(_test.FAST_COMMAND_ARGS);
			expect((await command.getArgumentCompletions?.("astra "))?.map((item) => item.value)).toEqual(["astra on", "astra off", "astra default"]);
			expect((await command.getArgumentCompletions?.("default "))?.map((item) => item.value)).toEqual(["default on", "default off"]);
			expect(await command.getArgumentCompletions?.("Terra   d")).toEqual([{ value: "terra default", label: "terra default" }]);
			expect(await command.getArgumentCompletions?.("sol bad")).toBeNull();
		} finally { cleanup(); }
	});
});

describe("pi-openai-fast", () => {
	it("registers the fast command and flag", () => {
		const mockPi = createMockPi();
		piOpenAIFast(mockPi as unknown as ExtensionAPI);

		expect(mockPi.commands.has("fast")).toBe(true);
		expect(mockPi.flags.get("fast")).toEqual({
			description: "Start with the OpenAI fast-mode default enabled (family overrides still apply)",
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
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Fast mode is on for openai/gpt-5.4."), "info");

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
				expect.stringContaining(`Fast mode is on, but anthropic/claude-sonnet-4 does not support it. Supported models: ${_test.DEFAULT_SUPPORTED_MODEL_KEYS.join(", ")}.`),
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
				expect.stringContaining("Fast mode is on, but openai/gpt-5.5 does not support it. Supported models: openai/gpt-5.4."),
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
		expect(headers["User-Agent"]).toMatch(new RegExp(`^${_test.CODEX_ORIGINATOR}/${_test.CODEX_CLI_VERSION.replace(/\./g, "\\.")} \\(`));
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
