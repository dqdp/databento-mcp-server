# Простая установка Market Data для Claude Desktop

Эта инструкция нужна человеку, который не работает с кодом. Нужно установить
три вещи:

1. Market Data Skill - объясняет Claude, какой источник данных выбирать.
2. Databento MCP - дает Claude доступ к CME futures data через Databento.
3. Alpha Vantage MCP - дает Claude доступ к акциям, ETF, equity options,
   fundamentals, indicators, news, macro, FX, crypto и spot/benchmark
   commodities.

## Что подготовить

Понадобятся:

- Claude Desktop.
- Файл скилла: `market-data-skill.zip`
- Файл Databento MCP: `databento-mcp-desktop-extension.mcpb`
- Файл с Databento API key: `databento_api_key.txt`
- Файл с Alpha Vantage API key: `alphavantage_api_key.txt`

Для установки скилла не нужен терминал и не нужен установочный скрипт. Claude
Desktop импортирует `market-data-skill.zip` через интерфейс и сам распаковывает
его как скилл.

Ожидаемый путь установки Databento MCP на macOS и Windows одинаковый: открыть
файл `.mcpb` двойным кликом. На Windows иногда нужно дополнительно объяснить
системе, что `.mcpb` файлы открываются через Claude Desktop.

Не вставляйте API keys в обычный чат с Claude. Ключи вводятся только в поля
настройки MCP или в URL подключения Alpha Vantage MCP.

В текущем Claude Desktop скиллы и remote connectors открываются через кнопку
`+` под полем ввода, но это два разных пути:

- Для Alpha Vantage MCP connector: `+` -> `Connectors` ->
  `Manage Connectors` -> `+`.
- Для скиллов: `+` -> `Skills` -> `Manage Skills` -> `+`.

Важно: в первом меню выбирайте именно `Manage Connectors` или `Manage Skills`,
а не обычные кнопки `Add...`. Кнопки `Add...` могут открыть встроенный магазин,
а нам нужно установить свои файлы.

## Шаг 1. Установить Databento MCP

1. Закройте Claude Desktop, если он открыт.
2. Дважды кликните по файлу `databento-mcp-desktop-extension.mcpb`.
3. Дождитесь, пока откроется Claude Desktop и появится установка Databento MCP.
4. Claude попросит Databento API key.
5. Откройте файл `databento_api_key.txt`.
6. Скопируйте ключ из файла.
7. Вставьте ключ в защищенное поле Claude.
8. Нажмите Save.
9. После сохранения включите тумблер Enable для Databento MCP.

Если Windows не знает, чем открыть `.mcpb` файл:

1. Нажмите правой кнопкой на `databento-mcp-desktop-extension.mcpb`.
2. Выберите Open with.
3. Выберите Choose another app.
4. Выберите Claude Desktop.
5. Включите галочку Always use this app to open `.mcpb` files, если она есть.
6. Нажмите Open.

Если Claude Desktop нет в списке:

1. Нажмите More apps.
2. Нажмите Look for another app on this PC.
3. Найдите и выберите файл `Claude.exe`.
4. Если не знаете, где он находится, откройте Start, найдите Claude,
   нажмите правой кнопкой и выберите Open file location. Если откроется ярлык,
   нажмите правой кнопкой на ярлык Claude, выберите Properties, затем Open File
   Location. Там выберите `Claude.exe`.
5. После этого снова дважды кликните
   `databento-mcp-desktop-extension.mcpb`.

## Шаг 2. Подключить Alpha Vantage MCP

1. Откройте Claude Desktop.
2. Нажмите кнопку `+` под полем ввода сообщения.
3. Выберите `Connectors`.
4. Нажмите именно `Manage Connectors`, а не `Add`.
5. В открывшейся форме нажмите `+`.
6. Выберите добавление connector, MCP server или integration.
7. Если Claude спросит тип подключения, выберите Remote или URL.
8. Откройте файл `alphavantage_api_key.txt`.
9. Скопируйте ключ из файла.
10. В поле URL вставьте:

```text
https://mcp.alphavantage.co/mcp?apikey=YOUR_ALPHA_VANTAGE_KEY
```

11. Замените `YOUR_ALPHA_VANTAGE_KEY` на ключ из
   `alphavantage_api_key.txt`.
12. Назовите подключение `Alpha Vantage MCP`.
13. Нажмите Save.
14. Если Claude показывает тумблер Enable, включите его.

Важно: URL уже содержит ключ. Не отправляйте этот URL в обычный чат.

## Шаг 3. Установить Market Data Skill

1. Откройте Claude Desktop.
2. Нажмите кнопку `+` под полем ввода сообщения.
3. Выберите `Skills`.
4. Нажмите именно `Manage Skills`, а не `Add`.
5. В открывшейся форме нажмите `+`.
6. Перетащите файл `market-data-skill.zip` мышкой в поле установки скилла.
7. Если перетаскивание недоступно, выберите импорт или загрузку локального
   файла и укажите `market-data-skill.zip`.
8. Включите скилл, если Claude показывает переключатель Enable.

Скилл сам не подключается к Databento или Alpha Vantage. Он только объясняет
Claude правила: когда использовать Databento, а когда Alpha Vantage.

## Шаг 4. Проверить, что все работает

Откройте новый чат в Claude Desktop и напишите:

```text
Проверь подключенные MCP tools. Используй Market Data skill.
Сначала вызови безопасную проверку Databento get_session_info.
Потом проверь, что доступен Alpha Vantage MCP, но не делай больших выгрузок.
```

Ожидаемый результат:

- Claude видит Databento MCP.
- Claude может вызвать безопасный Databento tool `get_session_info`.
- Claude видит Alpha Vantage MCP.
- Claude понимает, что:
  - CME/CBOT/NYMEX/COMEX futures и futures options идут через Databento.
  - Акции, ETF, equity options, fundamentals, indicators, news, macro, FX,
    crypto и spot/benchmark/non-CME commodities идут через Alpha Vantage.

## Если что-то не работает

Если Databento MCP не подключается:

1. Отключите Databento MCP extension.
2. Полностью закройте Claude Desktop.
3. Откройте Claude Desktop снова.
4. Включите Databento MCP extension.
5. Если ошибка осталась, удалите extension и установите `.mcpb` файл заново.

Если Alpha Vantage MCP не подключается:

1. Проверьте, что URL начинается с:
   `https://mcp.alphavantage.co/mcp?apikey=`
2. Проверьте, что после `apikey=` стоит настоящий Alpha Vantage API key.
3. Не добавляйте пробелы в URL.
4. Сохраните подключение заново.

Если скилл не виден:

1. Проверьте, что установлен именно `market-data-skill.zip`.
2. Отключите и включите skill.
3. Откройте новый чат.

## Самая короткая версия

1. Дважды кликнуть `.mcpb` файл Databento MCP и вставить Databento key.
2. Добавить Alpha Vantage MCP URL:
   `https://mcp.alphavantage.co/mcp?apikey=YOUR_ALPHA_VANTAGE_KEY`
3. Импортировать `market-data-skill.zip`.
4. В новом чате попросить Claude проверить Databento `get_session_info` и
   наличие Alpha Vantage MCP.
