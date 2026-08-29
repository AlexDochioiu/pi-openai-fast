/**
 * OpenAI fast mode for pi.
 *
 * `/fast` and `--fast` toggle `service_tier=priority` for configured models.
 * This extension does not change the selected model, thinking level, tools, or prompts.
 *
 * Startup state comes from `pi-openai-fast.json`, not resumed session history.
 * Config precedence is project `.pi/extensions/pi-openai-fast.json` over
 * global `<agent dir>/extensions/pi-openai-fast.json`, where the agent dir is
 * pi's getAgentDir() (typically `~/.pi/agent`, honoring PI_CODING_AGENT_DIR).
 * Releases before 0.84 always used `~/.pi/agent`; when the agent dir differs
 * and holds no config yet, the legacy global file is copied there once.
 *
 * `supportedModels` controls which `provider/model-id` pairs receive the flag.
 *
 * This fork adds two behaviors:
 * - Session startup is silent: no notifications are sent when fast mode is
 *   enabled or disabled by session start (or by the `--fast` flag).
 * - For `openai` and `openai-codex` providers, requests identify themselves as
 *   the official codex CLI: the `originator` header and `User-Agent` are
 *   rewritten to match what the Rust codex CLI sends
 *   (https://github.com/openai/codex, see
 *   `codex-rs/login/src/auth/default_client.rs` and
 *   `codex-rs/terminal-detection/src/lib.rs`).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch as osArch, homedir, release as osRelease } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const FAST_COMMAND = "fast";
const FAST_FLAG = "fast";
const FAST_CONFIG_BASENAME = "pi-openai-fast.json";
const FAST_COMMAND_ARGS = ["on", "off", "status"] as const;
const FAST_SERVICE_TIER = "priority";
// `openai/gpt-5.4-mini` has an official Fast-mode price and is API-key only: the
// ChatGPT (openai-codex) catalog exposes no priority tier for gpt-5.4-mini.
const DEFAULT_SUPPORTED_MODEL_KEYS = [
	"openai/gpt-5.4",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.5",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-5.6-luna",
] as const;
const LEGACY_DEFAULT_SUPPORTED_MODEL_KEY_SETS = [
	["openai/gpt-5.4", "openai-codex/gpt-5.4"],
	["openai/gpt-5.4", "openai/gpt-5.5", "openai-codex/gpt-5.4", "openai-codex/gpt-5.5"],
	[
		"openai/gpt-5.4",
		"openai/gpt-5.5",
		"openai/gpt-5.6-sol",
		"openai/gpt-5.6-terra",
		"openai/gpt-5.6-luna",
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.5",
		"openai-codex/gpt-5.6-sol",
		"openai-codex/gpt-5.6-terra",
		"openai-codex/gpt-5.6-luna",
	],
] as const;

// Codex CLI impersonation for OpenAI backends. These values mirror the Rust
// codex CLI (https://github.com/openai/codex):
// - `originator` header: codex-rs/login/src/auth/default_client.rs
// - User-Agent format:
//   `{originator}/{version} ({osType} {osVersion}; {arch}) {terminal}`
//   built in `get_codex_user_agent()` of the same file, with the terminal token
//   from codex-rs/terminal-detection/src/lib.rs.
const CODEX_ORIGINATOR = "codex_cli_rs";
// Latest codex CLI release at the time of this fork (rust-v0.151.0).
const CODEX_CLI_VERSION = "0.151.0";
// Only OpenAI backends understand these headers; other providers keep their
// own identity.
const CODEX_HEADER_PROVIDERS = ["openai", "openai-codex"] as const;

interface CodexOsInfo {
	osType: string;
	osVersion: string;
	arch: string;
}

function nonEmptyCodexValue(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeCodexHeaderToken(value: string): string {
	// Mirror codex-rs `sanitize_header_value`: printable ASCII only.
	return value.replace(/[^\x20-\x7e]/g, "_");
}

function getCodexOsInfo(): CodexOsInfo {
	const osType =
		process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : process.platform;
	// `process.getSystemVersion()` reports the OS version (e.g. "15.4" on
	// macOS, "10.0.22631" on Windows) on Node >= 22.11; fall back to the
	// kernel release otherwise.
	const getSystemVersion = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion;
	const osVersion = nonEmptyCodexValue(typeof getSystemVersion === "function" ? getSystemVersion() : undefined) ?? osRelease();
	const arch = osArch() === "x64" ? "x86_64" : osArch();
	return { osType, osVersion, arch };
}

function getCodexTerminalToken(env: NodeJS.ProcessEnv = process.env): string {
	// Detection order mirrors codex-rs/terminal-detection/src/lib.rs.
	const termProgram = nonEmptyCodexValue(env.TERM_PROGRAM);
	if (termProgram) {
		const version = nonEmptyCodexValue(env.TERM_PROGRAM_VERSION);
		return version ? `${termProgram}/${version}` : termProgram;
	}
	if (env.WEZTERM_VERSION !== undefined) {
		const version = nonEmptyCodexValue(env.WEZTERM_VERSION);
		return version ? `WezTerm/${version}` : "WezTerm";
	}
	if (env.ITERM_SESSION_ID !== undefined || env.ITERM_PROFILE !== undefined || env.ITERM_PROFILE_NAME !== undefined) {
		return "iTerm.app";
	}
	if (env.TERM_SESSION_ID !== undefined) {
		return "Apple_Terminal";
	}
	if (env.VSCODE_PID !== undefined || env.VSCODE_INJECTION !== undefined) {
		return "vscode";
	}
	if (env.WT_SESSION !== undefined) {
		return "WindowsTerminal";
	}
	if (env.KITTY_WINDOW_ID !== undefined) {
		return "kitty";
	}
	if (env.ALACRITTY_WINDOW_ID !== undefined) {
		return "Alacritty";
	}
	const konsoleVersion = nonEmptyCodexValue(env.KONSOLE_VERSION);
	if (konsoleVersion !== undefined) {
		return `Konsole/${konsoleVersion}`;
	}
	if (env.GNOME_TERMINAL_SCREEN !== undefined || env.GNOME_TERMINAL_SERVICE !== undefined) {
		return "gnome-terminal";
	}
	const vteVersion = nonEmptyCodexValue(env.VTE_VERSION);
	if (vteVersion !== undefined) {
		return `VTE/${vteVersion}`;
	}
	const term = nonEmptyCodexValue(env.TERM);
	return term ?? "unknown";
}

function buildCodexUserAgent(env: NodeJS.ProcessEnv = process.env, osInfo: CodexOsInfo = getCodexOsInfo()): string {
	const base = `${CODEX_ORIGINATOR}/${CODEX_CLI_VERSION} (${osInfo.osType} ${osInfo.osVersion}; ${osInfo.arch})`;
	const terminal = sanitizeCodexHeaderToken(getCodexTerminalToken(env));
	return `${base} ${terminal}`;
}

function isCodexHeaderProvider(model: ExtensionContext["model"]): boolean {
	if (!model) {
		return false;
	}
	return (CODEX_HEADER_PROVIDERS as readonly string[]).includes(model.provider);
}

function applyCodexHeaders(headers: Record<string, string | null>, env: NodeJS.ProcessEnv = process.env): void {
	headers.originator = CODEX_ORIGINATOR;
	// Replace any existing user-agent header variant: HTTP header names are
	// case-insensitive, and pi's provider dispatcher consumes the map as-is.
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === "user-agent") {
			headers[key] = null;
		}
	}
	headers["user-agent"] = buildCodexUserAgent(env);
}

interface FastModeState {
	active: boolean;
}

interface FastSupportedModel {
	provider: string;
	id: string;
}

interface FastConfigFile {
	persistState?: boolean;
	active?: boolean;
	supportedModels?: string[];
}

interface ResolvedFastConfig {
	configPath: string;
	persistState: boolean;
	active: boolean | undefined;
	supportedModels: FastSupportedModel[];
}

type FastPayload = {
	service_tier?: string;
	[key: string]: unknown;
};

const DEFAULT_CONFIG_FILE: FastConfigFile = {
	persistState: true,
	active: false,
	supportedModels: [...DEFAULT_SUPPORTED_MODEL_KEYS],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getConfigCwd(ctx: ExtensionContext): string {
	return ctx.cwd || process.cwd();
}

function getConfigPaths(
	cwd: string,
	homeDir?: string,
): {
	projectConfigPath: string;
	globalConfigPath: string;
	legacyGlobalConfigPath: string;
} {
	const agentDir = homeDir === undefined ? getAgentDir() : join(homeDir, ".pi", "agent");
	// Pre-0.84 releases always wrote the global config under ~/.pi/agent, ignoring PI_CODING_AGENT_DIR.
	const legacyAgentDir = join(homeDir ?? homedir(), ".pi", "agent");
	return {
		projectConfigPath: join(cwd, ".pi", "extensions", FAST_CONFIG_BASENAME),
		globalConfigPath: join(agentDir, "extensions", FAST_CONFIG_BASENAME),
		legacyGlobalConfigPath: join(legacyAgentDir, "extensions", FAST_CONFIG_BASENAME),
	};
}

function parseSupportedModelKey(value: string): FastSupportedModel | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
		return undefined;
	}
	const provider = trimmed.slice(0, slashIndex).trim();
	const id = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !id) {
		return undefined;
	}
	return { provider, id };
}

function normalizeSupportedModelKeys(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const normalized: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			continue;
		}
		const parsed = parseSupportedModelKey(entry);
		if (!parsed) {
			continue;
		}
		normalized.push(`${parsed.provider}/${parsed.id}`);
	}
	return normalized;
}

function parseSupportedModels(value: readonly string[]): FastSupportedModel[];
function parseSupportedModels(value: unknown): FastSupportedModel[] | undefined;
function parseSupportedModels(value: unknown): FastSupportedModel[] | undefined {
	const normalized = normalizeSupportedModelKeys(value);
	if (normalized === undefined) {
		return undefined;
	}
	const models: FastSupportedModel[] = [];
	for (const entry of normalized) {
		const parsed = parseSupportedModelKey(entry);
		if (!parsed) {
			continue;
		}
		models.push(parsed);
	}
	return models;
}

function sameModelKeys(left: readonly string[] | undefined, right: readonly string[]): boolean {
	if (!left || left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}

function migrateSupportedModelKeys(value: string[] | undefined): string[] | undefined {
	if (LEGACY_DEFAULT_SUPPORTED_MODEL_KEY_SETS.some((legacyKeys) => sameModelKeys(value, legacyKeys))) {
		return [...DEFAULT_SUPPORTED_MODEL_KEYS];
	}
	return value;
}

function readConfigFile(filePath: string): FastConfigFile | null {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) {
			return {};
		}
		const config: FastConfigFile = {};
		if (typeof parsed.persistState === "boolean") {
			config.persistState = parsed.persistState;
		}
		if (typeof parsed.active === "boolean") {
			config.active = parsed.active;
		}
		const supportedModels = normalizeSupportedModelKeys(parsed.supportedModels);
		if (supportedModels !== undefined) {
			config.supportedModels = supportedModels;
		}
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-fast] Failed to read ${filePath}: ${message}`);
		return null;
	}
}

function writeConfigFile(filePath: string, config: FastConfigFile): void {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-fast] Failed to write ${filePath}: ${message}`);
	}
}

function ensureDefaultConfigFile(projectConfigPath: string, globalConfigPath: string): void {
	if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) {
		return;
	}
	writeConfigFile(globalConfigPath, DEFAULT_CONFIG_FILE);
}

function migrateLegacyGlobalConfigFile(legacyGlobalConfigPath: string, globalConfigPath: string): void {
	if (resolve(legacyGlobalConfigPath) === resolve(globalConfigPath)) {
		return;
	}
	if (existsSync(globalConfigPath) || !existsSync(legacyGlobalConfigPath)) {
		return;
	}
	try {
		mkdirSync(dirname(globalConfigPath), { recursive: true });
		copyFileSync(legacyGlobalConfigPath, globalConfigPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-fast] Failed to migrate ${legacyGlobalConfigPath} to ${globalConfigPath}: ${message}`);
	}
}

function resolveFastConfig(cwd: string, homeDir?: string): ResolvedFastConfig {
	const { projectConfigPath, globalConfigPath, legacyGlobalConfigPath } = getConfigPaths(cwd, homeDir);
	migrateLegacyGlobalConfigFile(legacyGlobalConfigPath, globalConfigPath);
	ensureDefaultConfigFile(projectConfigPath, globalConfigPath);

	const globalConfig = readConfigFile(globalConfigPath) ?? {};
	const projectConfig = readConfigFile(projectConfigPath) ?? {};
	const selectedConfigPath = existsSync(projectConfigPath) ? projectConfigPath : globalConfigPath;
	const merged = { ...globalConfig, ...projectConfig };
	const supportedModels =
		parseSupportedModels(migrateSupportedModelKeys(merged.supportedModels)) ??
		parseSupportedModels(DEFAULT_SUPPORTED_MODEL_KEYS);

	return {
		configPath: selectedConfigPath,
		persistState: merged.persistState ?? DEFAULT_CONFIG_FILE.persistState ?? true,
		active: typeof merged.active === "boolean" ? merged.active : undefined,
		supportedModels,
	};
}

function getCurrentModelKey(model: ExtensionContext["model"]): string | undefined {
	if (!model) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

function isFastSupportedModel(model: ExtensionContext["model"], supportedModels: FastSupportedModel[]): boolean {
	if (!model) {
		return false;
	}
	return supportedModels.some((supported) => supported.provider === model.provider && supported.id === model.id);
}

function describeSupportedModels(supportedModels: FastSupportedModel[]): string {
	if (supportedModels.length === 0) {
		return "none configured";
	}
	return supportedModels.map((supported) => `${supported.provider}/${supported.id}`).join(", ");
}

function describeCurrentState(ctx: ExtensionContext, active: boolean, supportedModels: FastSupportedModel[]): string {
	const model = getCurrentModelKey(ctx.model) ?? "none";
	if (!active) {
		return `Fast mode is off. Current model: ${model}.`;
	}
	if (!ctx.model) {
		return `Fast mode is on. No model is selected. Supported models: ${describeSupportedModels(supportedModels)}.`;
	}
	if (isFastSupportedModel(ctx.model, supportedModels)) {
		return `Fast mode is on for ${model}.`;
	}
	return `Fast mode is on, but ${model} does not support it. Supported models: ${describeSupportedModels(supportedModels)}.`;
}

function applyFastServiceTier(payload: unknown): unknown {
	if (!isRecord(payload)) {
		return payload;
	}

	const nextPayload: FastPayload = { ...payload };
	nextPayload.service_tier = FAST_SERVICE_TIER;
	return nextPayload;
}

export default function piOpenAIFast(pi: ExtensionAPI): void {
	let state: FastModeState = { active: false };
	let cachedConfig: ResolvedFastConfig | undefined;

	function refreshConfig(ctx: ExtensionContext): ResolvedFastConfig {
		cachedConfig = resolveFastConfig(getConfigCwd(ctx));
		return cachedConfig;
	}

	function getConfig(ctx: ExtensionContext): ResolvedFastConfig {
		return cachedConfig ?? refreshConfig(ctx);
	}

	function persistState(config: ResolvedFastConfig): void {
		cachedConfig = { ...config, active: state.active };
		if (!config.persistState) {
			return;
		}
		const nextConfig = { ...(readConfigFile(config.configPath) ?? {}), active: state.active };
		writeConfigFile(config.configPath, nextConfig);
	}

	async function enableFastMode(ctx: ExtensionContext, options?: { notify?: boolean }): Promise<void> {
		const config = refreshConfig(ctx);
		if (state.active) {
			if (options?.notify !== false) {
				ctx.ui.notify("Fast mode is already on.", "info");
			}
			return;
		}

		state = { active: true };
		persistState(config);

		if (options?.notify !== false) {
			ctx.ui.notify(describeCurrentState(ctx, state.active, config.supportedModels), "info");
		}
	}

	async function disableFastMode(ctx: ExtensionContext, options?: { notify?: boolean }): Promise<void> {
		const config = refreshConfig(ctx);
		if (!state.active) {
			if (options?.notify !== false) {
				ctx.ui.notify("Fast mode is already off.", "info");
			}
			return;
		}

		state = { active: false };
		persistState(config);

		if (options?.notify !== false) {
			ctx.ui.notify("Fast mode disabled.", "info");
		}
	}

	async function toggleFastMode(ctx: ExtensionContext): Promise<void> {
		if (state.active) {
			await disableFastMode(ctx);
			return;
		}
		await enableFastMode(ctx);
	}

	pi.registerFlag(FAST_FLAG, {
		description: "Start with OpenAI fast mode enabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand(FAST_COMMAND, {
		description: "Toggle fast mode (priority service tier for configured models)",
		getArgumentCompletions: (prefix) => {
			const items = FAST_COMMAND_ARGS.filter((value) => value.startsWith(prefix)).map((value) => ({
				value,
				label: value,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command.length === 0) {
				await toggleFastMode(ctx);
				return;
			}

			switch (command) {
				case "on":
					await enableFastMode(ctx);
					return;
				case "off":
					await disableFastMode(ctx);
					return;
				case "status":
					ctx.ui.notify(describeCurrentState(ctx, state.active, refreshConfig(ctx).supportedModels), "info");
					return;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status]", "error");
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const config = getConfig(ctx);
		if (!state.active || !isFastSupportedModel(ctx.model, config.supportedModels)) {
			return;
		}
		return applyFastServiceTier(event.payload);
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isCodexHeaderProvider(ctx.model)) {
			return;
		}
		applyCodexHeaders(event.headers);
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = refreshConfig(ctx);
		state = config.persistState && typeof config.active === "boolean" ? { active: config.active } : { active: false };

		// Session startup is intentionally silent: enabling/disabling fast mode
		// here does not send notifications.
		if (pi.getFlag(FAST_FLAG) === true && !state.active) {
			state = { active: true };
			persistState(config);
		}
	});
}

export const _test = {
	FAST_COMMAND,
	FAST_FLAG,
	FAST_CONFIG_BASENAME,
	FAST_COMMAND_ARGS,
	FAST_SERVICE_TIER,
	DEFAULT_SUPPORTED_MODEL_KEYS,
	LEGACY_DEFAULT_SUPPORTED_MODEL_KEY_SETS,
	DEFAULT_CONFIG_FILE,
	CODEX_ORIGINATOR,
	CODEX_CLI_VERSION,
	CODEX_HEADER_PROVIDERS,
	getConfigPaths,
	parseSupportedModelKey,
	parseSupportedModels,
	migrateSupportedModelKeys,
	migrateLegacyGlobalConfigFile,
	readConfigFile,
	resolveFastConfig,
	isFastSupportedModel,
	describeSupportedModels,
	describeCurrentState,
	applyFastServiceTier,
	getCodexTerminalToken,
	buildCodexUserAgent,
	isCodexHeaderProvider,
	applyCodexHeaders,
};
