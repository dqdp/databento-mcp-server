# Standard CME Entitlement Plan

Last updated: 2026-11-17.

## Уточнение local и platform — 2026-11-17

Документ ниже описывает исходный **локальный stdio/single-user HTTP** профиль. Его правила hard rejection вне Standard и default zero-cost preflight для batch сохраняются. Они не означают, что private platform entrypoint за Marengo Gateway предоставляет batch или принимает локальные environment-переменные как подтверждение персонального плана.

Для платформы пользователь отменил прежние пороги $10/$50. CME/CBOT/NYMEX/COMEX в `GLBX.MDP3` внутри таблицы Standard ниже разрешены без автоматического `get_cost` и денежных лимитов **при подтверждении текущего ключа**. Вне покрытия или без назначения плана сохраняется оценка поставщика; любая положительная сумма требует разового подтверждения владельца. Gateway по умолчанию использует `historical_cost_mode=confirm_extra` для новых и прежних policy. Технические ограничения и запрет platform Reference/batch остаются. [Полный platform contract](platform-gateway.md).

Назначение Standard вручную фиксирует администратор по заявлению пользователя; это не автоматическая проверка подписки API поставщика. Оно привязано к ключу и ревизии credentials, сбрасывается при сохранении/удалении ключа и не переносится на новый ключ. Node получает строго проверяемое поле `subscription` в подписанном private body и классифицирует каждый фактический historical подзапрос, а не весь outer tool одним решением. Новая platform-политика находится в реализации; её развёртывание этим документом не подтверждается.

Публичная таблица Standard подтверждает L0 full available history, L1 rolling 12 месяцев и L2/L3 rolling 1 месяц. «16+ years» описывает доступную L0 историю, а не максимальную давность ровно 16 лет. [Databento Pricing](https://databento.com/pricing). `get_cost` вне platform-покрытия учитывает flat-rate скидки и остаётся оценкой, не итоговым net списанием. [Metadata get_cost](https://databento.com/docs/api-historical/metadata/metadata-get-cost).

Пользователь отдельно разрешил ограниченную реальную приёмку нескольких фьючерсов/опционов и типов данных. Она не добавляется в обычный CI, не разрешает покупать подписки/автоматически подтверждать доплаты и не разрешает публиковать ключи или лицензированные ответы/выгрузки. Historical Standard не подменяет Live-права: текущий облачный Live-инструмент получает одно `mbp-1` обновление и закрывает соединение; остальных Live schemas и постоянного потока он не предоставляет.

## Local baseline status — 2026-06-16

Implementation in progress. The core entitlement policy, MCP schema enforcement,
direct response guard, batch `end` requirement, and batch zero-cost preflight
are implemented with offline tests. Live Databento checks remain opt-in only.

This plan replaces the earlier dollar-budget framing for Databento guardrails.
For the intended deployment, the server enforces the Databento Standard
CME subscription contract instead of an arbitrary `max_cost_usd` gate.

The plan is based on the user-provided Databento portal screenshot for CME
Standard plan entitlements and on Databento documentation that historical stream
and batch requests have no built-in size limit. Batch is allowed when a request
is inside the Standard CME entitlement window, but direct MCP responses must
still stay bounded because MCP is not a bulk file-transfer channel.

## Goal

Allow an agent to use all historical data included in the Databento Standard CME
plan, including batch jobs, while preventing accidental out-of-plan requests and
giant direct MCP responses.

The desired contract:

- Do not block covered Standard CME historical data merely because it is large.
- Prefer batch for large exports.
- Keep `timeseries_get_range` suitable for bounded interactive queries.
- Keep `get_historical_bars` convenient for ES/NQ bars, including long daily
  history.
- Reject requests outside the Standard CME entitlement windows before calling
  Databento.

## Non-Goals

- Do not add a `max_cost_usd` approval workflow as the primary guard.
- Do not scrape the Databento portal at runtime.
- Do not build multi-plan or multi-user billing attribution.
- Do not add live Databento API calls to the default test or CI gate.
- Do not rely on Claude Desktop approval UI as a server-side safety guarantee.
- Do not turn MCP into a file download transport for gigabyte-scale data.

## Standard CME Entitlement Contract

Use a static policy profile for the Standard CME plan.

Initial profile name:

```text
MCP_DATABENTO_ENTITLEMENT_PROFILE=standard-cme
```

Covered venue family:

- CME
- CBOT
- NYMEX
- COMEX

Initial dataset allowlist:

```text
MCP_DATABENTO_ALLOWED_DATASETS=GLBX.MDP3
```

Historical entitlements:

| Level | Schemas | Standard CME window |
| --- | --- | --- |
| L0 | `ohlcv-1s`, `ohlcv-1m`, `ohlcv-1h`, `ohlcv-1d`, `definition`, `statistics`, `status` | 16+ years |
| L1 | `mbp-1`, `tbbo`, `bbo-1s`, `bbo-1m`, `trades` | Last 12 months |
| L2 | `mbp-10` | Last 1 month |
| L3 | `mbo` | Last 1 month |

Implementation should compute entitlement windows relative to the current UTC
instant through an injectable clock so tests are deterministic. The L1/L2/L3
windows are rolling time windows, not calendar-month buckets:

- L1 starts 12 months before the current UTC instant.
- L2/L3 start 1 month before the current UTC instant.
- Date-only requests compare at UTC day boundaries so the earliest allowed date
  is accepted for the whole day.

## Resolved Decisions

- Direct `timeseries_get_range` uses a response-size cap, not a subscription
  cap. If `limit` is omitted, the server should apply
  `MCP_DIRECT_MAX_RECORDS=10000`; explicit `limit` values above that cap are
  rejected with a message to use batch.
- Databento `metadata.get_cost` preflight is required only for
  `batch_submit_job`, not for direct `timeseries_get_range`.
- `ALL_SYMBOLS` is allowed only through `batch_submit_job`; direct
  `timeseries_get_range` must reject it.
- `batch_submit_job` requires an explicit `end`.
- Remote examples should keep batch exposure as an explicit
  `MCP_REMOTE_ENABLE_BATCH=true` operator opt-in.
- `ohlcv-eod` is not included in the first Standard CME policy because the
  portal entitlement lists OHLCV `1s/1m/1h/1d`, not `eod`.
- Databento exposes Standard CME BBO as `bbo-1s` and `bbo-1m` for GLBX.MDP3.
  Use those schema names rather than a generic `bbo` schema.
- Start with a hard-coded `standard-cme` profile plus tests. Move to JSON config
  only when another plan/profile is needed.

## Replaced Behavior

The previous detailed historical range guard was too strict for Standard CME:

- `trades`, `tbbo`, `mbp-1`, `mbp-10`, `mbo`, and `ohlcv-1s` are capped at 1
  explicit day.
- `ohlcv-1m` is capped at 31 days.
- `ohlcv-1h` is capped at 366 days.

Under Standard CME this changed to:

- L0 schemas should allow the full available historical window.
- L1 schemas should allow the rolling last 12 months.
- L2/L3 schemas should allow the rolling last 1 month.
- Batch should be allowed for any request inside the entitlement window.
- Direct streaming should remain bounded by response-size policy, not by
  entitlement policy.

## Proposed Architecture

Add a small entitlement policy layer, separate from transport and client code:

```text
src/api/entitlement-policy.ts
```

Responsibilities:

- Normalize schema names.
- Validate dataset allowlist.
- Map schemas to Standard CME entitlement levels.
- Compute earliest allowed start date for each schema.
- Validate `start`/`end` against the entitlement window.
- Optionally perform Databento `metadata.get_cost` preflight checks for
  covered batch requests to catch account/plan mismatches.
- Distinguish entitlement validation from direct-response safety validation.
- Return clear MCP/tool errors before any Databento API call.

The existing `historical-range-guard` can either be replaced by this module or
kept as a small compatibility wrapper. Prefer one source of truth after the
first implementation slice.

## Tool Contracts

### `get_historical_bars`

Keep the current special-purpose behavior:

- `1h` and `H4`: max 100 bars.
- `1d`: max 10,000 bars.
- ES/NQ only.

This is not the bulk export path. Full arbitrary daily date ranges should use
`timeseries_get_range` or batch.

### `timeseries_get_range`

Apply two independent checks:

1. Entitlement check:
   - Dataset must be allowed by the Standard CME profile.
   - Schema must be included in Standard CME.
   - Requested range must fit the schema entitlement window.

2. Direct MCP response check:
   - Reject requests likely to return bulk data directly through MCP.
   - Apply `MCP_DIRECT_MAX_RECORDS=10000` when `limit` is omitted.
   - Reject explicit `limit` values above `MCP_DIRECT_MAX_RECORDS`.
   - Reject `ALL_SYMBOLS` style requests and tell the agent to use batch.
   - Return a clear error telling the agent to use `batch_submit_job` for large
     covered exports.
   - Do not call `metadata.get_cost` for direct preview requests.

The direct response guard must not prevent batch export of covered Standard CME
data.

### `batch_submit_job`

Allow batch for covered Standard CME requests:

- No `max_cost_usd` gate.
- No arbitrary 1-day detailed-schema cap.
- Reject requests outside the Standard CME entitlement window.
- Reject datasets outside the allowlist.
- Require explicit `end`.
- Perform a Databento `metadata.get_cost` preflight before submission when
  `MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH=true`.
- Treat a covered request with a non-negligible estimated cost as a plan/account
  mismatch and fail closed instead of submitting automatically.
- Return job metadata only; do not stream files through MCP.

Batch remains the intended path for large covered exports.

Remote exposure can keep an operator-level enable flag such as
`MCP_REMOTE_ENABLE_BATCH=true`; that flag controls public remote tool exposure,
not Databento entitlement. Local stdio and remote deployment documentation
should be explicit about this distinction.

### `batch_download`

Keep the current behavior:

- Return API-provided file metadata and download URLs.
- Do not download the actual files through MCP.
- Include total size/record count when Databento returns it.

### Reference And Metadata Tools

Do not mix reference tools into the CME historical entitlement policy in the
first slice.

Keep `metadata_get_cost` as an informational preview/audit tool. It should not
be the primary authorization gate for Standard CME coverage.

For `batch_submit_job`, the server can also call Databento
`metadata.get_cost` internally as a preflight sanity check. This does not
replace the Standard CME entitlement policy. It verifies that Databento's
account-side flat-rate/discount view agrees with the request being treated as
covered.

Suggested defaults:

```text
MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH=true
MCP_ZERO_COST_EPSILON_USD=0
```

If the preflight cost is positive for a request that passed the Standard CME
entitlement policy, return a tool error such as:

```text
Databento estimated this covered Standard CME request as billable. Refusing to
submit batch job automatically; verify the account plan or entitlement policy.
```

This preflight is intentionally a mismatch detector, not a budget mechanism.
`MCP_ZERO_COST_EPSILON_USD` exists only as an explicit operator override.
Databento documents that `get_cost` respects flat-rate plan discounts, but it
can over-report for some non-discrete time ranges. Prefer normalizing batch
`start`/`end` to clean boundaries where possible.

## TDD Implementation Slices

### Slice 1 - Entitlement Policy Unit Tests

Add tests first for a deterministic `standard-cme` policy:

- Allows `ohlcv-1d` for a long historical range.
- Rejects `ohlcv-eod` in the first Standard CME policy.
- Allows `definition`, `statistics`, and `status` for long historical ranges.
- Allows `trades`, `tbbo`, `bbo-1s`, `bbo-1m`, and `mbp-1` inside the rolling last 12
  months.
- Rejects `trades`, `tbbo`, `bbo-1s`, `bbo-1m`, and `mbp-1` older than the rolling last 12
  months.
- Allows `mbp-10` and `mbo` inside the rolling last 1 month.
- Rejects `mbp-10` and `mbo` older than the rolling last 1 month.
- Rejects unknown schemas.
- Rejects datasets outside `MCP_DATABENTO_ALLOWED_DATASETS`.
- Handles ISO timestamps and date-only values consistently.

Then implement `src/api/entitlement-policy.ts`.

### Slice 2 - MCP And Client Enforcement

Add tests showing invalid requests do not call injected clients:

- `timeseries_get_range` rejects out-of-entitlement L1/L2/L3 ranges.
- `batch_submit_job` rejects out-of-entitlement L1/L2/L3 ranges.
- `timeseries_get_range` allows covered L0 long ranges when direct response
  safety conditions are met.
- `batch_submit_job` allows covered L0/L1/L2/L3 requests.
- `batch_submit_job` rejects missing `end`.
- `batch_submit_job` calls metadata cost preflight when
  `MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH=true`.
- `batch_submit_job` rejects a covered request when preflight cost is positive
  by default.
- `batch_submit_job` allows a covered request when preflight cost is zero.
- Errors are returned as MCP tool errors with `isError: true`.

Then wire the policy into:

- `mcp/tool-contracts.ts`
- `src/api/timeseries-client.ts`
- `src/api/batch-client.ts`
- batch submission path access to `MetadataClient.getCost` or a small preflight
  service shared by MCP and client tests.

Keep validation duplicated at MCP boundary and client boundary so direct client
imports cannot bypass the policy.

### Slice 3 - Direct Response Safety

Add tests for direct `timeseries_get_range` safety:

- Reject direct `ALL_SYMBOLS` requests.
- Applies `MCP_DIRECT_MAX_RECORDS` when `limit` is omitted.
- Reject `limit` above a configured direct-response cap.
- Allow small, bounded interactive requests.
- Do not call `MetadataClient.getCost` for direct preview requests.
- Error message should suggest batch for large covered exports.

Proposed default:

```text
MCP_DIRECT_MAX_RECORDS=10000
```

This value is intentionally a response-size guard, not a subscription guard.

### Slice 4 - Batch Enablement And Documentation

Update docs and skill contract:

- Explain that Standard CME allows covered batch requests.
- Explain that large exports should use batch, not direct MCP CSV responses.
- Document the static entitlement profile and dataset allowlist env vars.
- Document that remote batch tool exposure may still require
  `MCP_REMOTE_ENABLE_BATCH=true`.
- Remove language implying detailed Standard-covered data is globally capped at
  1 day.
- Document that `ALL_SYMBOLS` and full exports use batch, while direct
  `timeseries_get_range` is a capped preview path.

Update `AGENTS.md` after implementation to make the new baseline explicit.

### Slice 5 - Verification

Run targeted tests first:

```bash
npm run test:once -- tests/unit/api/entitlement-policy.test.ts
npm run test:once -- tests/unit/api/timeseries-client.test.ts tests/unit/api/batch-client.test.ts tests/integration/mcp-server.test.ts
```

Then run the full local gate:

```bash
npm run test:once
npm run build
npm run smoke:mcp
npm run smoke:mcp:http
npm run smoke:skills
npm audit --omit=dev
npm pack --dry-run --ignore-scripts --json --cache /tmp/databento-mcp-npm-cache
git diff --check
```

Do not run live Databento API tests in the default gate.

## Implementation Verification Notes

- Databento's `mbo`, `bbo-1s`, and `bbo-1m` schema names are exposed in the
  public MCP schema enums and covered by offline tests.
- Keep `metadata.get_cost` preflight behind
  `MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH=true` so tests can inject a mock
  cost client and default CI stays offline.

## Acceptance Criteria

- Covered Standard CME historical requests are allowed by entitlement policy.
- Covered Standard CME batch jobs are allowed.
- Out-of-window L1/L2/L3 requests are rejected before calling Databento.
- `ALL_SYMBOLS` is rejected for direct `timeseries_get_range` and allowed only
  through batch.
- `batch_submit_job` requires explicit `end`.
- Batch submit performs zero-cost preflight by default and fails closed when
  Databento estimates a covered request as billable.
- Direct `timeseries_get_range` applies `MCP_DIRECT_MAX_RECORDS=10000` by
  default and rejects larger direct responses.
- Direct MCP responses cannot accidentally carry bulk/gigabyte-scale data.
- Batch download still returns metadata/URLs only.
- Docs clearly distinguish subscription entitlement from transport/resource
  safety.
- Full local gate passes.
