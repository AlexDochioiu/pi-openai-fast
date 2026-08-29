# pi-openai-fast

`/fast` toggle for pi that enables OpenAI priority service tier on configured models.

This is a fork of [@benvargas/pi-openai-fast](https://github.com/ben-vargas/pi-packages/tree/main/packages/pi-openai-fast) with two changes:

1. **Silent session start** — no notifications are sent when fast mode is enabled or disabled by session startup (persisted state or the `--fast` flag). Toggle notifications from `/fast`, `/fast on`, `/fast off`, and `/fast status` are unchanged.
2. **Codex CLI headers** — for `openai` and `openai-codex` providers, requests identify themselves like the official Rust codex CLI ([openai/codex](https://github.com/openai/codex)):
   - `originator: codex_cli_rs`
   - `User-Agent: codex_cli_rs/0.151.0 (<os> <version>; <arch>) <terminal>` — the format matches `codex-rs/login/src/auth/default_client.rs`, and terminal detection mirrors `codex-rs/terminal-detection/src/lib.rs`.

   The `before_provider_headers` hook wins for the API-key `openai` provider, but pi's `openai-codex` provider force-sets its own `originator: pi` and `User-Agent` *after* the hook runs. To win there too, the extension also patches `globalThis.fetch` and `globalThis.WebSocket` and rewrites the headers of any request carrying the codex backend marker header `chatgpt-account-id` — the last point before the request leaves the process. Other requests (and other providers) are never touched.

   The codex version is a constant in `extensions/index.ts` (`CODEX_CLI_VERSION`); bump it there to track new codex releases. Other providers keep their own headers.

This extension does not change the model, thinking level, tools, or prompts. It only adds `service_tier=priority` to provider requests when fast mode is active and the current model matches the configured supported-model list.

Requires pi `0.80.4` or newer (for the `before_provider_headers` hook).

## Install

```bash
pi install git:github.com/AlexDochioiu/pi-openai-fast
```

Or try without installing:

```bash
pi -e git:github.com/AlexDochioiu/pi-openai-fast
```

The repo is private: HTTPS clones need a GitHub credential (e.g. `gh auth setup-git`), and `pi update --extensions` reconciles the local clone.

## Usage

- `/fast` toggles fast mode on or off.
- `/fast on` explicitly enables fast mode.
- `/fast off` explicitly disables fast mode.
- `/fast status` reports the current fast-mode state.
- `--fast` starts the session with fast mode enabled.
- By default, fast mode persists across new pi sessions via a JSON config file.
- Startup state comes from the selected config file, not from resumed session/thread history.

Example:

```bash
pi -e git:github.com/AlexDochioiu/pi-openai-fast --fast
```

## Config

Config files follow the same project-over-global pattern as the other packages:

- Project: `<repo>/.pi/extensions/pi-openai-fast.json`
- Global: `<agent dir>/extensions/pi-openai-fast.json`

The global path uses pi's agent directory — typically `~/.pi/agent`, but it follows `PI_CODING_AGENT_DIR` when that is set, matching where pi itself reads and writes config.

Releases before this one always used `~/.pi/agent`, even with `PI_CODING_AGENT_DIR` set. If the agent directory differs from `~/.pi/agent` and has no config yet, an existing `~/.pi/agent/extensions/pi-openai-fast.json` is copied there once so previous settings carry over; a config already present in the agent directory is never overwritten.

If neither exists, the extension writes a default global config on first run.

Default config:

```json
{
  "persistState": true,
  "active": false,
  "supportedModels": [
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
    "openai-codex/gpt-5.6-luna"
  ]
}
```

Settings:

- `persistState`: when `true`, `/fast` writes the current on/off state to config so it resumes in new pi sessions. Default: `true`.
- `active`: persisted fast-mode state used on startup when `persistState` is enabled.
- `supportedModels`: list of `provider/model-id` strings that should receive `service_tier=priority`.

Project config overrides global config. `/fast on` and `/fast off` write to the selected config file, so if a project config exists the remembered state is project-specific. If fast mode is enabled on a model that is not in `supportedModels`, the setting stays on but requests are left unchanged until you switch back to a configured model.

## Notes

- When `persistState` is enabled, the last `/fast` setting also carries across brand-new pi sessions.
- Resumed sessions do not override the config-backed startup state.
- On configured models, fast mode maps to OpenAI `service_tier=priority`.
- `openai/gpt-5.4-mini` is in the defaults for the API-key provider only: OpenAI publishes Fast-mode pricing for it, but the ChatGPT (`openai-codex`) side offers no fast tier for gpt-5.4-mini. `gpt-5.4-nano`, `gpt-5.4-pro`, and `gpt-5.5-pro` have no published Fast-mode pricing and are left out.
- If a default set from an older release is found in your config, it is upgraded to the current defaults automatically; customized `supportedModels` lists are left untouched.

## Development

```bash
npm install
npm test
npm run typecheck
```

Or run the package in pi without installing:

```bash
pi -e .
```

## Uninstall

```bash
pi remove git:github.com/AlexDochioiu/pi-openai-fast
```

## License

MIT. Based on `@benvargas/pi-openai-fast` by Ben Vargas.
