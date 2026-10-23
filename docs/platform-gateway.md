# Databento за общей MCP-платформой

2026-10-23 пользователь поручил подключить существующий коннектор к единому авторизованному MCP Gateway. Локальный stdio и прежний single-user remote HTTP сохраняются. Новый compiled entrypoint `dist/mcp/mcp/platform.js` предназначен только для private RPC внутри платформы; он не публикует собственный MCP endpoint и не заменяет внешний OAuth Gateway.

Служба предоставляет `GET /healthz`, `POST /v1/tools` и `POST /v1/call` на внутреннем порту 8002. `HOST` задаётся `0.0.0.0` внутри контейнера, `PORT=8002`. `DATABENTO_PLATFORM_SIGNING_KEY_FILE` указывает на отдельный raw-ключ ровно 32 байта. Запросы связаны с короткоживущим HS256-контекстом Gateway, workspace, действием и SHA-256 тела. Ключ поставщика поступает по private RPC из зашифрованного личного профиля, а не из глобального `.env`.

Каждая операция создаёт отдельный дочерний процесс с очищенным окружением и собственными HOME/XDG/TMP. Дедлайн 120 секунд, максимум четыре операции одновременно. Доступны metadata, symbology и session info; historical/quote/bars/smile допускаются только после нулевого cost preflight фактического запроса. Live/reference/batch не предоставляются. Временный профиль удаляется; общего пользовательского дискового volume нет.

Native MCP-ответ и захваченные decoded HTTP bodies с хешами передаются Gateway в независимый Research Storage. CSV сохраняет строки/происхождение; неизвестное покрытие не объявляется полным. Provider-ошибки/ключи/пути не выводятся в публичные ошибки. Хранение результатов и продолжение исследования не требуют включённого Databento-коннектора.

`deploy/Dockerfile.platform` выполняет multi-stage Node 24 build с `npm ci` по существующему lock и production dependencies. Dockerfile-specific allowlist исключает `.env`, Git, пользовательские базы и локальный `node_modules`. Runtime непривилегированный и read-only, `/tmp` временный; внешние порты не публикуются, provider HTTPS доступен через egress-сеть.

Поддерживаемая сборка выполняется платформенным `deploy/build_image.py` из `git archive` точного Databento source SHA. Генерируемый `SOURCE_MANIFEST.json` включается в runtime и проверяется против Git-архива, затем используется immutable image ID или repository digest. Прямой `docker build` из изменяемой рабочей папки не объявляется подтверждённой source-сборкой. Source manifest не является независимым ревью/подписью. Существующие незакоммиченные пользовательские изменения не сбрасываются и не подмешиваются в snapshot автоматически.

Полная инструкция, Compose overlay/profile, bootstrap и ограничения: [Databento Platform в COT Research](https://github.com/dqdp/cot-research/blob/main/docs/DATABENTO_PLATFORM.md); доступ требует прав к приватному репозиторию. Авторизация, секреты и Storage принадлежат общей платформе. Успешные offline-тесты/CI не заменяют реальное HTTPS-развёртывание, независимые ревью и облачные ChatGPT Work/Claude Cowork проверки. Реальные Databento-загрузки и расходы данным документом не разрешаются.

## Проверка переноса 2026-10-23

В изолированной ветке сохранены версия пакета 1.3.0 и диапазоны зависимостей; runtime lock обновлён в пределах совместимых версий SDK 1.x. На Node 24.22.1 прошли 704 теста, сборка MCP/skills, stdio/HTTP/skills/private-entrypoint smoke и npm pack dry-run. Реальные Databento API не вызывались. `npm audit --omit=dev` после установки показывает 0 уязвимостей; полный audit с dev-зависимостями содержит 5 замечаний (faker/adm-zip/Vitest dependency chain), требующих отдельной проверки обновления диапазонов. Это не объявляется нулём уязвимостей всего дерева. Исходная пользовательская папка с незакоммиченными изменениями сохранена. Реальные облачные клиенты, целевой HTTPS/OIDC и обязательное Anthropic-ревью остаются отдельными условиями.
