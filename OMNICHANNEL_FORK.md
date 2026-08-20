# CloudCLI Omnichannel Fork

This fork keeps CloudCLI close to official stable releases while adding the
provider-independent session transport required by external conversation
channels such as Telegram, plus native Kimi Code CLI support.

## Repository split

| Repository | Responsibility |
| --- | --- |
| `cloudcli-omnichannel` | CloudCLI fork: native Kimi Code provider, multi-client event fan-out, external channel input, shared queue, and server-authoritative session settings. |
| `cloudcli-plugin-telegram-bridge` | Installable plugin: Telegram bot, pairing, localization, silent mirroring, and persistent schedules. |

The plugin stays separate so Telegram-specific work can be released without
rebuilding the whole application. The core patch cannot currently be a normal
plugin because upstream's public plugin API does not expose chat interception
or a session event fan-out hook.

## Signed runtime and plugin processes

The unattended macOS deployment runs CloudCLI through a dedicated signed
`CloudCLI Runtime.app` instead of a Homebrew `node` process. Its stable bundle
identifier and code signature give macOS one durable identity for privacy
permissions across restarts and Homebrew upgrades.

The runtime uses the Lebedushka-owned reverse-DNS bundle identifier
`com.lebedushka.cloudcli.runtime`. Do not restore the historical
`ru.poison-studio.cloudcli.runtime` identifier in local builds or deployment
automation.

Launch the runtime directly from a macOS `LaunchAgent`; do not place PM2,
Homebrew Node, or another interpreter above it in the process tree. macOS TCC
inherits the responsible code identity from that launcher, so a PM2 parent
causes privacy requests to be attributed to Homebrew `node` even when the
accessing binary is the signed runtime.

Upstream starts plugin server entries with `spawn('node', ...)`. That resolves a
second runtime through `PATH`, escaping the signed application identity. A
plugin that reads another application's data, such as Codex usage history, can
then trigger a blocking macOS TCC "data from other apps" prompt and make an
unattended CloudCLI host appear offline.

This fork starts plugin servers with `process.execPath`. CLI installations keep
using the same Node executable as their parent, while desktop and local-server
bundles keep every plugin backend under the embedded signed runtime. The server
bundle requires no separate patch: `npm run build` compiles this behavior into
`dist-server`, and `scripts/release/build-server-bundle.js` includes that output
in the archive.

When merging an upstream release, verify that
`server/modules/plugins/plugin-process.service.ts` still launches the plugin
entry with `process.execPath`; reverting to a PATH-resolved `node` reintroduces
the unattended macOS permission prompt.

## Native Kimi Code provider

Install the official CLI and authenticate it on the same account that runs
CloudCLI:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
kimi login
```

CloudCLI then discovers Kimi sessions from `~/.kimi-code`, reads the live model
catalog, resumes the same provider-native thread, exposes Kimi MCP servers and
skills, and maps `low`, `high`, and `max` reasoning effort onto
`KIMI_MODEL_THINKING_EFFORT`. Telegram and scheduled runs use the provider,
model, effort, and history stored on the selected CloudCLI session.

## Language support

The fork currently tracks CloudCLI `v1.37.1`, the latest upstream stable tag.
CloudCLI includes English, French, Spanish, Korean, Simplified and
Traditional Chinese, Japanese, Russian, German, Turkish, and Italian. The
Telegram plugin currently provides English and Russian and falls back to
English for every other CloudCLI language.

## Git remotes

Use the conventional fork layout:

```text
origin    https://github.com/n4ela/claudecodeui.git
upstream  https://github.com/siteboon/claudecodeui.git
```

`main` is the deployable custom branch. Official CloudCLI is fetched from
`upstream`; do not develop directly on an upstream tracking branch.

## Updating from an official release

Prefer signed/released stable tags over a floating upstream `main`:

```bash
git fetch upstream --tags
git switch main
git merge vNEXT_STABLE_VERSION
npm ci
npm run typecheck
npm run lint
npm run build
./node_modules/.bin/tsx --tsconfig server/tsconfig.json --test \
  server/modules/database/tests/provider-models.db.integration.test.ts \
  server/modules/database/tests/sessions-provider-mapping.test.ts \
  server/modules/database/tests/sessions.db.integration.test.ts \
  server/modules/providers/tests/session-permission-mode.service.test.ts \
  server/modules/websocket/tests/chat-permission-mode.test.ts \
  server/modules/websocket/tests/chat-run-registry.test.ts
git push origin main --follow-tags
```

If database or chat files conflict, retain both the upstream session model /
reasoning-effort fields and this fork's `permission_mode` plus omnichannel
transport. Never resolve those conflicts by choosing one whole side.

## Releasing

1. Merge an official stable tag and run the verification above.
2. Increment the Telegram plugin version independently when its code changes.
3. Tag the fork as `vUPSTREAM-omnichannel.N` and the plugin as `vX.Y.Z`.
4. Deploy the official package for the target release first, then overlay this
   fork's `dist/` and `dist-server/` artifacts.
5. Ensure the CloudCLI CLI entry remains executable after overlaying locally
   built artifacts.
6. Verify plugin server processes use the bundled host executable rather than a
   PATH-resolved Homebrew `node` on macOS.
7. Restart CloudCLI and verify HTTP, the plugin `/status`, database columns,
   Telegram/CloudCLI connectivity, and every systemd timer.

## Русская памятка

Форк обновляется так: забираем новый стабильный тег из `upstream`, сливаем его
в наш `main`, сохраняем обе группы полей БД (`effort` и `permission_mode`),
запускаем тесты и отправляем в `origin`. Telegram-плагин живёт в отдельном
репозитории и версионируется независимо. Это позволяет обновлять интерфейс и
бота без пересборки CloudCLI, а маленькую обязательную доработку транспорта —
аккуратно переносить на каждый новый официальный релиз.
