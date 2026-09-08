# pi-openai-fast

`/fast` controls OpenAI priority service tier by model family, with a shared default.

This is a fork of [@benvargas/pi-openai-fast](https://github.com/ben-vargas/pi-packages/tree/main/packages/pi-openai-fast) with these changes:

1. **Silent session start** — no notifications are sent when fast mode is enabled or disabled by session startup (persisted state or the `--fast` flag). Commands still report their updated settings.
2. **Codex CLI headers** — for `openai` and `openai-codex` providers, requests identify themselves like the official Rust codex CLI ([openai/codex](https://github.com/openai/codex)):
   - `originator: codex_cli_rs`
   - `User-Agent: codex_cli_rs/0.151.0 (<os> <version>; <arch>) <terminal>` — the format matches `codex-rs/login/src/auth/default_client.rs`, and terminal detection mirrors `codex-rs/terminal-detection/src/lib.rs`.

   The `before_provider_headers` hook wins for the API-key `openai` provider, but pi's `openai-codex` provider force-sets its own `originator: pi` and `User-Agent` *after* the hook runs. To win there too, the extension also patches `globalThis.fetch` and `globalThis.WebSocket` and rewrites the headers of any request carrying the codex backend marker header `chatgpt-account-id` — the last point before the request leaves the process. Other requests (and other providers) are never touched.

   The codex version is a constant in `extensions/index.ts` (`CODEX_CLI_VERSION`); bump it there to track new codex releases. Other providers keep their own headers.

3. **Per-family fast mode** — configure Luna, Terra, Astra, and Sol independently, or let each inherit the shared default. `/fast status` reports all families, not just the current model.

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

- `/fast default on` or `/fast default off` sets the fallback for families without an override, and models outside these families.
- `/fast <luna|terra|astra|sol> on` or `off` sets that family's override.
- `/fast <luna|terra|astra|sol> default` makes that family use the shared default again.
- `/fast status` reports the default, all four families (effective on/off and override/default source), current model applicability, persistence, and config path.
- `/fast` toggles the default; `/fast on` and `/fast off` are aliases for setting the default. None clears family overrides.
- `--fast` starts with the default enabled, still respecting family overrides.
- By default, fast mode persists across new pi sessions via a JSON config file.
- Startup state comes from the selected config file, not from resumed session/thread history.

Example:

```text
/fast default on
/fast astra off
/fast sol on
/fast terra default
/fast status
```

The status includes:

```text
Default: on
Luna: on (default)
Terra: on (default)
Astra: off (override)
Sol: on (override)
```

Or enable the default at startup:

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
    "openai/gpt-6-astra",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-6-astra"
  ]
}
```

Settings:

- `persistState`: when `true`, commands persist the default and family choices for new sessions. Default: `true`. When `false`, sessions start with the default off and no family overrides; commands apply only until the next session start. `--fast` can still enable the session's default.
- `active`: persisted **default** fast-mode state. Existing configs retain their previous behavior when no families are configured.
- `families`: optional object with lowercase `luna`, `terra`, `astra`, and `sol` keys. Values are `true` (on), `false` (off), or `"default"` (inherit `active`). Missing families also inherit `active`.
- `supportedModels`: exact list of `provider/model-id` strings eligible for `service_tier=priority`. Family overrides never bypass this list.

For example, the commands above persist `"active": true` and:

```json
"families": {
  "astra": false,
  "sol": true,
  "terra": "default"
}
```

Project config overrides global config, merging `families` per key. An explicit `"default"` in the project masks a global family override and uses the resolved `active` value instead. Commands write only their changed setting to the selected file (project if it exists, otherwise global), without pinning unrelated inherited values.

Families are recognized from GPT model IDs such as `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, and `gpt-6-astra`, including hyphenated variants if explicitly allowed in `supportedModels`. Other supported models use the default. Unsupported models remain untouched even when their family is on.

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
