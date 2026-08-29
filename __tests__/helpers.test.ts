import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { _test } from "../extensions/index.js";

function createContext(model: ExtensionContext["model"]): ExtensionContext {
	return {
		model,
	} as unknown as ExtensionContext;
}

function createTempConfigPaths(): { cwd: string; homeDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-openai-fast-"));
	const cwd = join(root, "workspace");
	const homeDir = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	return {
		cwd,
		homeDir,
		cleanup: () => {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("pi-openai-fast helpers", () => {
	it("parses supported model keys and recognizes supported fast models", () => {
		const supportedModels = _test.parseSupportedModels(_test.DEFAULT_SUPPORTED_MODEL_KEYS) ?? [];
		expect(_test.parseSupportedModelKey("openai/gpt-5.4")).toEqual({ provider: "openai", id: "gpt-5.4" });
		expect(_test.parseSupportedModelKey("openai/gpt-5.5")).toEqual({ provider: "openai", id: "gpt-5.5" });
		expect(_test.parseSupportedModelKey("openai/gpt-5.6-sol")).toEqual({
			provider: "openai",
			id: "gpt-5.6-sol",
		});
		expect(_test.parseSupportedModelKey("invalid-model")).toBeUndefined();
		expect(
			_test.isFastSupportedModel({ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"], supportedModels),
		).toBe(true);
		expect(
			_test.isFastSupportedModel({ provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"], supportedModels),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.4" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai", id: "gpt-5.6-luna" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai", id: "gpt-5.4-mini" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.4-mini" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(false);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.6-terra" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(false);
		expect(_test.isFastSupportedModel(undefined, supportedModels)).toBe(false);
		expect(_test.describeSupportedModels([])).toBe("none configured");
	});

	it("writes a default config and resolves project overrides", () => {
		const { cwd, homeDir, cleanup } = createTempConfigPaths();
		try {
			const defaultConfig = _test.resolveFastConfig(cwd, homeDir);
			expect(defaultConfig.persistState).toBe(true);
			expect(defaultConfig.active).toBe(false);
			expect(defaultConfig.supportedModels).toEqual([
				{ provider: "openai", id: "gpt-5.4" },
				{ provider: "openai", id: "gpt-5.4-mini" },
				{ provider: "openai", id: "gpt-5.5" },
				{ provider: "openai", id: "gpt-5.6-sol" },
				{ provider: "openai", id: "gpt-5.6-terra" },
				{ provider: "openai", id: "gpt-5.6-luna" },
				{ provider: "openai-codex", id: "gpt-5.4" },
				{ provider: "openai-codex", id: "gpt-5.5" },
				{ provider: "openai-codex", id: "gpt-5.6-sol" },
				{ provider: "openai-codex", id: "gpt-5.6-terra" },
				{ provider: "openai-codex", id: "gpt-5.6-luna" },
			]);

			const { projectConfigPath, globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			expect(_test.readConfigFile(globalConfigPath)).toEqual(_test.DEFAULT_CONFIG_FILE);

			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				projectConfigPath,
				`${JSON.stringify({ persistState: false, supportedModels: ["openai/gpt-5.5"] }, null, 2)}\n`,
				"utf-8",
			);

			const overriddenConfig = _test.resolveFastConfig(cwd, homeDir);
			expect(overriddenConfig.configPath).toBe(projectConfigPath);
			expect(overriddenConfig.persistState).toBe(false);
			expect(overriddenConfig.active).toBe(false);
			expect(overriddenConfig.supportedModels).toEqual([{ provider: "openai", id: "gpt-5.5" }]);
			expect(_test.readConfigFile(projectConfigPath)).toEqual({
				persistState: false,
				supportedModels: ["openai/gpt-5.5"],
			});
		} finally {
			cleanup();
		}
	});

	it("resolves the global config from PI_CODING_AGENT_DIR when no homeDir override is given", () => {
		const { cwd, homeDir, cleanup } = createTempConfigPaths();
		try {
			const agentDir = join(homeDir, "relocated-agent");
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

			const { globalConfigPath } = _test.getConfigPaths(cwd);
			expect(globalConfigPath).toBe(join(agentDir, "extensions", _test.FAST_CONFIG_BASENAME));

			const config = _test.resolveFastConfig(cwd);
			expect(config.configPath).toBe(globalConfigPath);
			expect(existsSync(globalConfigPath)).toBe(true);

			const explicitPaths = _test.getConfigPaths(cwd, homeDir);
			expect(explicitPaths.globalConfigPath).toBe(
				join(homeDir, ".pi", "agent", "extensions", _test.FAST_CONFIG_BASENAME),
			);
		} finally {
			vi.unstubAllEnvs();
			cleanup();
		}
	});

	it("migrates legacy default supported models without changing custom supported models", () => {
		for (const legacyKeys of _test.LEGACY_DEFAULT_SUPPORTED_MODEL_KEY_SETS) {
			expect(_test.migrateSupportedModelKeys([...legacyKeys])).toEqual([..._test.DEFAULT_SUPPORTED_MODEL_KEYS]);
		}
		expect(_test.migrateSupportedModelKeys(["openai/gpt-5.4"])).toEqual(["openai/gpt-5.4"]);
		expect(_test.migrateSupportedModelKeys(undefined)).toBeUndefined();
	});

	it("describes the current state and injects the priority service tier", () => {
		const supportedModels = _test.parseSupportedModels(_test.DEFAULT_SUPPORTED_MODEL_KEYS) ?? [];
		expect(_test.describeCurrentState(createContext(undefined), false, supportedModels)).toBe(
			"Fast mode is off. Current model: none.",
		);
		expect(
			_test.describeCurrentState(
				createContext({ provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"]),
				true,
				supportedModels,
			),
		).toBe("Fast mode is on for openai/gpt-5.5.");
		expect(
			_test.describeCurrentState(
				createContext({ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"]),
				true,
				supportedModels,
			),
		).toContain("does not support it");

		expect(_test.applyFastServiceTier({ model: "gpt-5.4" })).toEqual({
			model: "gpt-5.4",
			service_tier: "priority",
		});
		expect(_test.applyFastServiceTier("not-an-object")).toBe("not-an-object");
	});

	it("detects terminals in the same order as the codex CLI", () => {
		expect(_test.getCodexTerminalToken({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.11" })).toBe(
			"iTerm.app/3.5.11",
		);
		expect(_test.getCodexTerminalToken({ TERM_PROGRAM: "tmux" })).toBe("tmux");
		expect(_test.getCodexTerminalToken({ WEZTERM_VERSION: "20240203-110809-5046fc22" })).toBe(
			"WezTerm/20240203-110809-5046fc22",
		);
		expect(_test.getCodexTerminalToken({ ITERM_SESSION_ID: "w0t0p1" })).toBe("iTerm.app");
		expect(_test.getCodexTerminalToken({ TERM_SESSION_ID: "abc" })).toBe("Apple_Terminal");
		expect(_test.getCodexTerminalToken({ VSCODE_PID: "123" })).toBe("vscode");
		expect(_test.getCodexTerminalToken({ WT_SESSION: "guid" })).toBe("WindowsTerminal");
		expect(_test.getCodexTerminalToken({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
		expect(_test.getCodexTerminalToken({ ALACRITTY_WINDOW_ID: "1" })).toBe("Alacritty");
		expect(_test.getCodexTerminalToken({ KONSOLE_VERSION: "240400" })).toBe("Konsole/240400");
		expect(_test.getCodexTerminalToken({ GNOME_TERMINAL_SERVICE: "org.gnome.Terminal" })).toBe("gnome-terminal");
		expect(_test.getCodexTerminalToken({ VTE_VERSION: "7800" })).toBe("VTE/7800");
		expect(_test.getCodexTerminalToken({ TERM: "xterm-256color" })).toBe("xterm-256color");
		expect(_test.getCodexTerminalToken({})).toBe("unknown");
	});

	it("builds a codex CLI style user agent", () => {
		const osInfo = { osType: "macOS", osVersion: "15.4.0", arch: "arm64" };
		expect(_test.buildCodexUserAgent({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.11" }, osInfo)).toBe(
			"codex_cli_rs/0.151.0 (macOS 15.4.0; arm64) iTerm.app/3.5.11",
		);
		expect(_test.buildCodexUserAgent({}, osInfo)).toBe("codex_cli_rs/0.151.0 (macOS 15.4.0; arm64) unknown");
		expect(_test.buildCodexUserAgent({ TERM_PROGRAM: "bad\u0007terminal" }, osInfo)).toBe(
			"codex_cli_rs/0.151.0 (macOS 15.4.0; arm64) bad_terminal",
		);
	});

	it("recognizes codex header providers and applies codex headers", () => {
		expect(_test.isCodexHeaderProvider({ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"])).toBe(true);
		expect(_test.isCodexHeaderProvider({ provider: "openai-codex", id: "gpt-5.4" } as ExtensionContext["model"])).toBe(
			true,
		);
		expect(
			_test.isCodexHeaderProvider({ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"]),
		).toBe(false);
		expect(_test.isCodexHeaderProvider(undefined)).toBe(false);

		const headers: Record<string, string | null> = {
			"User-Agent": "pi/0.84",
			authorization: "Bearer token",
		};
		_test.applyCodexHeaders(headers, { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.11" });

		expect(headers).toEqual({
			"User-Agent": expect.stringMatching(/^codex_cli_rs\/0\.151\.0 \(/),
			authorization: "Bearer token",
			originator: "codex_cli_rs",
		});
	});

	it("rewrites transport headers only for requests carrying the codex backend marker", () => {
		const codex = new Headers({ "chatgpt-account-id": "account-123", originator: "pi", "User-Agent": "pi/0.84" });
		expect(_test.rewriteCodexTransportHeaders(codex, { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.11" })).toBe(
			true,
		);
		expect(codex.get("originator")).toBe("codex_cli_rs");
		expect(codex.get("user-agent")).toMatch(/^codex_cli_rs\/0\.151\.0 \(/);
		expect(codex.get("chatgpt-account-id")).toBe("account-123");

		const unrelated = new Headers({ authorization: "Bearer token" });
		expect(_test.rewriteCodexTransportHeaders(unrelated)).toBe(false);
		expect(unrelated.get("originator")).toBeNull();
		expect(unrelated.get("user-agent")).toBeNull();
	});

	it("patches fetch to rewrite codex backend headers before the request goes out", async () => {
		const seen: Array<{ input: unknown; init: RequestInit | undefined }> = [];
		const originalFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
			seen.push({ input, init });
			return new Response("ok");
		});
		const patched = _test.createPatchedFetch(originalFetch as unknown as typeof globalThis.fetch);

		await patched("https://chatgpt.com/backend-api/codex/responses", {
			headers: { "chatgpt-account-id": "account-123", originator: "pi", "User-Agent": "pi/0.84" },
		});
		const codexHeaders = new Headers(seen[0].init?.headers);
		expect(codexHeaders.get("originator")).toBe("codex_cli_rs");
		expect(codexHeaders.get("user-agent")).toMatch(/^codex_cli_rs\/0\.151\.0 /);

		await patched("https://api.openai.com/v1/responses", {
			headers: { authorization: "Bearer token", "User-Agent": "pi/0.84" },
		});
		const openaiHeaders = new Headers(seen[1].init?.headers);
		expect(openaiHeaders.get("User-Agent")).toBe("pi/0.84");
		expect(openaiHeaders.get("originator")).toBeNull();
	});

	it("patches the WebSocket constructor to rewrite codex handshake headers", () => {
		const constructed: Array<{ url: string | URL; options?: unknown }> = [];
		class FakeWebSocket {
			constructor(url: string | URL, options?: unknown) {
				constructed.push({ url, options });
			}
		}
		const Patched = _test.createPatchedWebSocketClass(
			FakeWebSocket as unknown as new (url: string | URL, options?: unknown) => unknown,
		);

		new Patched("wss://chatgpt.com/backend-api/codex/responses", {
			headers: { "chatgpt-account-id": "account-123", originator: "pi", "user-agent": "pi/0.84" },
		});
		const codexHeaders = new Headers((constructed[0].options as { headers: unknown }).headers as HeadersInit);
		expect(codexHeaders.get("originator")).toBe("codex_cli_rs");
		expect(codexHeaders.get("user-agent")).toMatch(/^codex_cli_rs\/0\.151\.0 /);

		new Patched("wss://example.com/socket", { headers: { authorization: "Bearer token" } });
		const unrelatedHeaders = new Headers((constructed[1].options as { headers: unknown }).headers as HeadersInit);
		expect(unrelatedHeaders.get("originator")).toBeNull();
	});

	it("installs the transport patch once and only once", () => {
		const globalRecord = globalThis as Record<PropertyKey, unknown>;
		const originalFetch = globalThis.fetch;
		const originalWebSocket = globalThis.WebSocket;
		try {
			_test.installCodexTransportPatch();
			const patchedFetch = globalThis.fetch;
			const patchedWebSocket = globalThis.WebSocket;
			expect(patchedFetch).not.toBe(originalFetch);
			expect(patchedWebSocket).not.toBe(originalWebSocket);

			_test.installCodexTransportPatch();
			expect(globalThis.fetch).toBe(patchedFetch);
			expect(globalThis.WebSocket).toBe(patchedWebSocket);
		} finally {
			globalThis.fetch = originalFetch;
			globalRecord.WebSocket = originalWebSocket;
			delete globalRecord[_test.CODEX_TRANSPORT_PATCH_KEY];
		}
	});
});
