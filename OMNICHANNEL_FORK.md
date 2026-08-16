# CloudCLI Omnichannel Fork

This fork keeps CloudCLI close to official stable releases while adding the
provider-independent session transport required by external conversation
channels such as Telegram.

## Repository split

| Repository | Responsibility |
| --- | --- |
| `cloudcli-omnichannel` | CloudCLI fork: multi-client event fan-out, external channel input, shared queue, and server-authoritative session permission mode. |
| `cloudcli-plugin-telegram-bridge` | Installable plugin: Telegram bot, pairing, localization, silent mirroring, and persistent schedules. |

The plugin stays separate so Telegram-specific work can be released without
rebuilding the whole application. The core patch cannot currently be a normal
plugin because upstream's public plugin API does not expose chat interception
or a session event fan-out hook.

## Language support

CloudCLI `v1.37.1` includes English, French, Spanish, Korean, Simplified and
Traditional Chinese, Japanese, Russian, German, Turkish, and Italian. The
Telegram plugin currently provides English and Russian and falls back to
English for every other CloudCLI language.

## Git remotes

Use the conventional fork layout:

```text
origin    https://github.com/<github-user>/claudecodeui.git
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
6. Restart CloudCLI and verify HTTP, the plugin `/status`, database columns,
   Telegram/CloudCLI connectivity, and every systemd timer.

## Русская памятка

Форк обновляется так: забираем новый стабильный тег из `upstream`, сливаем его
в наш `main`, сохраняем обе группы полей БД (`effort` и `permission_mode`),
запускаем тесты и отправляем в `origin`. Telegram-плагин живёт в отдельном
репозитории и версионируется независимо. Это позволяет обновлять интерфейс и
бота без пересборки CloudCLI, а маленькую обязательную доработку транспорта —
аккуратно переносить на каждый новый официальный релиз.

