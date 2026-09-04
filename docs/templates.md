# xp-thermal-service — Template Types & Full HTTP API Reference

> Source-analysed 2026-09-02 from `src/templates/` (engine + 5 templates + layout-utils), `src/types/index.ts`, `src/escpos/builder.ts`, `src/api/server.ts` (1912 lines, 37 routes), `config.example.json`, and `README.md`. All file:line citations are to that snapshot.

---

## 1. Purpose & Architecture

`xp-thermal-service` is a production-grade **local Windows service** (Node 18+, Express 4, runs via `node-windows` + SCM recovery) that owns every aspect of thermal printing for the XP POS restaurant stack. It replaces QZ Tray / browser-extension printing with a zero-maintenance loopback HTTP API.

```
POS (browser / native) ──POST /api/print──►  Express API  ──►  JobQueue (sql.js, persisted to data/jobs.db)
   ▲  GET /api/events (SSE) ◄──────────────────────────────┘         │
   │  GET /health  ───────── confirm identity + port                 ▼
                                                            TemplateEngine ──► EscPosBuilder ──► PrinterManager
                                                                 (5 types)       (GS v 0 raster,       ├── USB (winspool RAW)
                                                                                 ESC p cash drawer,     └── Network (TCP 9100)
                                                                                 QR/barcode)
```

* **One snapshot, shared** — every printer-related read refreshes a cached `WindowsPrintSystemSnapshot` (single-flight, 4 s TTL) so a health check across N printers costs one PowerShell process, not 2N.
* **Corroborated status** — `WorkOffline` alone never means offline; unknown `PrinterStatus` codes mean *ready*. Ground truth is a successful write.
* **Port & spooler resilience** — four independent discovery paths (`Get-CimInstance` → `Get-WmiObject` → `winspool.drv EnumPrinters` → `Get-Printer`), USB port migration detection via `HKLM\SYSTEM\CurrentControlSet\Enum\…\PortName`, stale offline flag auto-cleared, event-driven via `Win32_DeviceChangeEvent` (~1 s) + SSE push. Falls back to polling and reports `printerEvents.mode`.
* **Durability** — batch-flushed `sql.js` store; restart drains in-flight receipts (≤ 8 s); PID lock prevents double-instance config corruption; corrupt `config.json` is backed up, never overwritten; UTF-8 BOM handled.

Smart port: if `9100` is busy the service tries `9101…9109`, publishes the real port in `active_port.txt` / `data/service-endpoint.json` / `C:\ProgramData\XPThermalService\…`, in every `X-Service-Port` header, and in `/health {port, configuredPort, service}`.

---

## 2. Template Engine

`src/templates/engine.ts:32`

```ts
interface TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer;
  validate(payload: Record<string, unknown>): boolean;
}
class TemplateEngine {
  registerRenderer(type: TemplateType, renderer: TemplateRenderer): void;
  render(type: TemplateType, payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer;
  validate(type: TemplateType, payload: Record<string, unknown>): boolean;
}
```

Registered defaults (`engine.ts:37`):

| `TemplateType` (`src/types/index.ts:154`) | Renderer class | File |
|---|---|---|
| `receipt` | `ReceiptTemplate` | `receipt-template.ts:383` |
| `kot` | `KOTTemplate` | `kot-template.ts:11` |
| `invoice` | `InvoiceTemplate` | `invoice-template.ts:11` |
| `test` | `TestTemplate` | `test-template.ts:12` |
| `raw` | `RawTemplate` | `raw-template.ts:9` |

`render()` (`engine.ts:54`) looks up the renderer, throws `PrintServiceError(400, JOB_INVALID_PAYLOAD)` on unknown type or failed `validate()`, then delegates. `registerRenderer` allows POS or tests to override/extend types without touching the engine. Re-exports: `ReceiptTemplate`, `KOTTemplate`, `InvoiceTemplate`, `TestTemplate`, `RawTemplate`, `LayoutCalculator`, `PAPER_WIDTHS`.

### 2.1 LayoutCalculator — the single layout truth

`src/templates/layout-utils.ts:28` — every helper guarantees output `≤ width` chars (final `clip()` safety net). Imported by `receipt` (via in-file `Layout` clone), `kot`, `invoice`, `test`.

```ts
class LayoutCalculator {
  readonly width: number;            // printer width
  readonly labelWidth: number;       // ≈25% width, clamped 8..14 (48→12, 32→9, 64→14)
  readonly qtyColW = 3;              // item table, fixed
  readonly amtColW: number;          // ≈20% width, clamped 8..12
  readonly nameColW: number;         // remainder ≥6
  divider(char='-'): string;         // char.repeat(width)
  doubleDivider(): string;            // '='.repeat(width)
  labelValue(label, value): string[]; // "Label    : value" with word-wrap indent
  totalsRow(label, value): string;    // "Label          Value" right-aligned, exactly width
  itemsHeader(col1,col2,col3): string;
  itemRow(name, qty, amount): string[]; // fixed columns; right side built first, name gets remainder; overflow word-wraps
  wordWrap(text, maxWidth?): string[];
  truncate(text, maxWidth, suffix='..'): string;
  indented(text, indent=2, prefix=''): string[]; // "  + modifier" / "  ** note"
}
PAPER_WIDTHS = { PAPER_58MM: 32, PAPER_80MM: 48, PAPER_112MM: 64 }
```

Rules: never `padStart/padEnd` without truncation; item rows build right side (`qty`+`amount`) first; if a single value exceeds its fixed column that column grows for that row only and the name column shrinks.

### 2.2 PrinterCapabilities (per-printer, in `config.json`)

`src/types/index.ts:78`

```ts
interface PrinterCapabilities {
  maxWidth: number;            // chars/line — 32 (58 mm), 48 (80 mm), 64 (112 mm)
  supportsBold, supportsUnderline, supportsBarcode, supportsQRCode: boolean;
  supportsImage: boolean;      // false = logo/QR raster silently skipped (would print as text)
  supportsCut, supportsPartialCut, supportsCashDrawer, supportsDensity: boolean;
  codepage: number;            // EscPos CodePages (0=PC437 … 255=UTF8)
}
CashDrawerConfig { enabled, pin: 2|5, onTimeMs, offTimeMs, openOnPrint }
```

`EscPosBuilder` (`src/escpos/builder.ts:159`) respects `supports*` — a capability `false` makes that feature a no-op rather than garbage output.

---

## 3. Template Types — Fields, Validation & Rendering

### 3.1 `receipt` — Customer Receipt

`src/templates/receipt-template.ts:383` — **most complex template.** Byte-for-byte port of XP POS `pos_modules/orders/printing-facility/receiptLayout.ts`; comment at `receipt-template.ts:4` says change one → change both. Uses local `StyledLine` model (`text/align/bold/size/kind`) built by `buildLines()` then emitted via `EscPosBuilder`.

#### Validation

`receipt-template.ts:484`

```ts
orderNumber && orderDate && Array.isArray(items) && items.length>0
&& typeof subtotal==='number' && typeof total==='number'
```

#### Payload — `ReceiptPayload` (`types/index.ts:162`)

| Field | Type | Req | Notes |
|---|---|---|---|
| `orderNumber` | `string` | ✓ | Printed as `Order #…` (or centered in minimal) |
| `orderDate` | `string` | ✓ | Free-form, printed as Date |
| `orderTime` | `string` |  | Printed as Time on next labelValue line |
| `items` | `ReceiptItem[]` | ✓ | `items.length>0` |
| `items[].name` | `string` | ✓ | Word-wraps; second line indented |
| `items[].quantity` | `number` | ✓ | Right col `qtyColW=3` |
| `items[].price` | `number` | ✓ | `unitPrice` — printed only if `unitPriceLine && fields.unitPrice` |
| `items[].total` | `number` | ✓ | Right col `amtColW` |
| `items[].modifiers` | `string[]` |  | Each printed as `  + modifier` if `fields.itemModifiers` |
| `items[].notes` | `string` |  | Printed as `  ** note` if `fields.itemNotes` |
| `subtotal` | `number` | ✓ | |
| `discount` / `discountName` | `number` / `string` |  | Printed as `Discount:` / custom name if `fields.discount && >0`, as `-amount` |
| `tax` / `taxRate` / `taxLabel` | `number` / `number` / `string` |  | `fields.taxBreakdown && >0`; label `Tax (X%):` if `taxRate` |
| `serviceCharge` / `serviceChargeName` | `number` / `string` |  | `fields.serviceCharge` |
| `tip` | `number` |  | `fields.tip && >0` |
| `adjustments` | `{name, amount, isDeduction}[]` |  | Each prints signed: `-amount` if deduction |
| `total` | `number` | ✓ | Hero total (centered large) if `elegant` preset, else `TOTAL:` right-aligned |
| `paymentMethod` | `string` |  | `fields.paymentMethod` — single-method path |
| `amountPaid` | `number` |  | `fields.amountPaid` |
| `change` | `number` |  | `fields.change && >0` |
| `payments` | `{label, amount}[]` |  | `label` is tenant's own method name. If `fields.amountPaid && payments.length>1` prints itemised Paid section (replaces single-method lines) |
| `customerName` | `string` |  | `fields.customer` |
| `tableName` | `string` |  | `fields.table` |
| `serverName` | `string` |  | `fields.server` |
| `orderMode` | `string` |  | `fields.orderMode` |
| `header` | `ReceiptHeader` |  | `storeName`, `storeAddress?[]`, `storePhone?`, `storeEmail?`, `taxId?`, `logo?: RasterLogo` |
| `header.logo` | `RasterLogo {data: base64, width, height}` |  | Row-major MSB-first 1-bit; printed via `GS v 0` if `supportsImage`, else skipped |
| `footer` | `ReceiptFooter {message?: string[], thankYouMessage?}` |  | `footer.message[0]` used; `fields.footerMessage` |
| `barcode` | `string` |  | (reserved; not rendered by receipt — use test/raw) |
| `qrCode` | `string` |  | Printed as centered QR raster if `fields.qrCode && supportsImage` (rasterised via `qrcode` lib, `scale=5, quiet=3`), else native `GS ( k` if `supportsQRCode` |
| `options` | `ReceiptRenderOptions` |  | **Tenant render contract** — when present drives everything below; must stay in sync with POS `types/settings.types.ts` |

#### `ReceiptRenderOptions` (`types/index.ts:238`)

```ts
interface ReceiptRenderOptions {
  template: ReceiptTemplateId; // 'classic'|'compact'|'elegant'|'minimal'
  paperWidth: number;           // chars/line — THIS drives layout width (receipt-template.ts:398), NOT capabilities.maxWidth
  currency: { symbol: string; decimals: number; position: 'before'|'after' };
  fields: ReceiptRenderFields;
  qr?: { content: string };
}
type ReceiptTemplateId = 'classic'|'compact'|'elegant'|'minimal'
interface ReceiptRenderFields {
  logo, businessName, address, phone, email, website, taxId,
  orderNumber, dateTime, table, server, customer, orderMode,
  itemModifiers, itemNotes, unitPrice,
  taxBreakdown, discount, serviceCharge, tip,
  paymentMethod, amountPaid, change,
  qrCode, footerMessage, thankYou, poweredBy: boolean;
}
```

**Width rule** (`receipt-template.ts:398`): `options.paperWidth` drives `Layout` width; legacy callers with no `options` fall back to `DEFAULT_OPTIONS` (`classic`, 48, `symbol='' decimals=2 position=before`, most fields true except `email/website/orderMode/qrCode` false) with `legacyWidth = capabilities.maxWidth || 48`.

#### Presets (`receipt-template.ts:232`)

| `template` | `spacer` | `div` | `unitPriceLine` | `heroTotal` | `title` | `minimal` | Effect |
|---|---|---|---|---|---|---|---|
| `classic` | ✓ | `-` | ✓ |  | — |  | Full receipt, spacers |
| `compact` |  | `-` |  |  | — |  | No spacers, no unitPriceLine |
| `elegant` | ✓ | `=` | ✓ | ✓ | `RECEIPT` |  | Hero centered large total, `=` dividers |
| `minimal` |  | `-` |  |  | — | ✓ | Order#, items `nameAmountRow`, total, thankYou, poweredBy only |

#### `buildLines` flow (`receipt-template.ts:253`): logo → businessName centered bold → address/phone/email/website/taxId (unless minimal) → title → blank → minimal short-circuit or divider → Order/Date/Time/Table/Mode/Server/Customer labelValues → divider → items header → each item `itemRow` + optional `unitPriceLine` indented + modifiers `+` + notes `**` → divider → Subtotal/Discount/Service/Tax/adjustments/Tip `totalsRow` → divider → hero or normal TOTAL → divider → split-payment Paid section (`isSplit = amountPaid && payments.length>1`) or single payment lines → divider → QR raster → blank → footerMessage → Thank you! → Powered By.

`formatMoney` (`receipt-template.ts:110`) rounds to `currency.decimals`, drops trailing `.00` (5→"5", 5.5→"5.5"), then `before: $5` / `after: 5 $`.

#### Example — classic 80 mm dine-in

```json
{
  "templateType": "receipt",
  "idempotencyKey": "ord_2026-09-02_42",
  "printerId": "receipt",
  "payload": {
    "orderNumber": "42",
    "orderDate": "2026-09-02",
    "orderTime": "19:31",
    "tableName": "T7",
    "serverName": "Ana",
    "customerName": "Acme Corp",
    "orderMode": "Dine-In",
    "items": [
      { "name": "Grilled Salmon with Seasonal Vegetables and Herb Butter", "quantity": 1, "price": 18.5, "total": 18.5, "modifiers": ["Extra sauce"], "notes": "No salt" },
      { "name": "Latte", "quantity": 2, "price": 5, "total": 10 }
    ],
    "subtotal": 28.5, "discount": 2, "discountName": "Happy Hour",
    "tax": 2.28, "taxRate": 8, "taxLabel": "ITBIS",
    "tip": 3, "total": 31.78,
    "paymentMethod": "Cash", "amountPaid": 40, "change": 8.22,
    "payments": [{ "label": "Cash", "amount": 20 }, { "label": "Card", "amount": 11.78 }],
    "header": { "storeName": "Xenith Bistro", "storeAddress": ["Av. Independencia 123", "Santo Domingo"], "storePhone": "809-555-0123", "taxId": "1-23-45678-9" },
    "footer": { "message": ["Gracias por su visita"] },
    "qrCode": "https://xenithpulse.com/r/42",
    "options": {
      "template": "classic", "paperWidth": 48,
      "currency": { "symbol": "$", "decimals": 2, "position": "before" },
      "fields": { "logo": true, "businessName": true, "address": true, "phone": true, "email": false, "website": false, "taxId": true, "orderNumber": true, "dateTime": true, "table": true, "server": true, "customer": true, "orderMode": true, "itemModifiers": true, "itemNotes": true, "unitPrice": true, "taxBreakdown": true, "discount": true, "serviceCharge": true, "tip": true, "paymentMethod": true, "amountPaid": true, "change": true, "qrCode": true, "footerMessage": true, "thankYou": true, "poweredBy": true }
    }
  }
}
```

---

### 3.2 `kot` — Kitchen Order Ticket

`src/templates/kot-template.ts:11` — large + bold for kitchen readability. No currency formatting.

#### Validation

`kot-template.ts:114`: `orderNumber && orderTime && Array.isArray(items) && items.length>0`

#### Payload — `KOTPayload` (`types/index.ts:278`)

| Field | Type | Req | Notes |
|---|---|---|---|
| `orderNumber` | `string` | ✓ | Printed as `Order #…` large bold |
| `orderTime` | `string` | ✓ | LabelValue Time |
| `tableName` | `string` |  | Bold LabelValue |
| `serverName` | `string` |  | |
| `category` | `string` |  | Upper-cased LabelValue |
| `notes` | `string` |  | Under `NOTES:` divider, bold label |
| `isVoid` / `isReprint` | `boolean` |  | Big centered banner `*** VOID ***` / `** REPRINT **` before `KITCHEN ORDER` |
| `items` | `KOTItem[]` | ✓ | `>0` |
| `items[].name` | `string` | ✓ | Rendered as `"{qty}x {name}"` bold double-width; wrap width = `floor(W/2)` |
| `items[].quantity` | `number` | ✓ | |
| `items[].modifiers` | `string[]` |  | Each `  + mod` indented 3 |
| `items[].notes` | `string` |  | Bold `  ** note` indented 3 |
| `items[].isVoid` | `boolean` |  | Appends ` [VOID]` to item line |

Flow: centered `KITCHEN ORDER` banner → divider → Order (large) / Time / Table bold / Server / Category → divider → each item large bold word-wrapped → modifiers → notes → order notes → divider → centered `Powered By` → `feedAndCut(3)`.

Example:
```json
{ "templateType": "kot", "idempotencyKey": "kot_42_fire", "payload": {
  "orderNumber": "42", "orderTime": "19:31", "tableName": "T7", "serverName": "Ana", "category": "Grill",
  "items": [
    { "name": "Salmon", "quantity": 1, "modifiers": ["Well done"], "notes": "Allergy: nuts" },
    { "name": "Fries", "quantity": 2, "isVoid": true }
  ], "notes": "Fire immediately", "isReprint": true
}}
```

---

### 3.3 `invoice` — Business Invoice

`src/templates/invoice-template.ts:11`

#### Validation

`invoice-template.ts:149`: `invoiceNumber && invoiceDate && customer?.name && Array.isArray(items) && items.length>0 && typeof subtotal==='number' && typeof total==='number'`

#### Payload — `InvoicePayload` (`types/index.ts:298`)

| Field | Type | Req | Notes |
|---|---|---|---|
| `invoiceNumber` | `string` | ✓ | LabelValue `Invoice #` |
| `invoiceDate` | `string` | ✓ | LabelValue `Date` |
| `dueDate` | `string` |  | LabelValue `Due Date` |
| `customer` | `InvoiceCustomer` | ✓ | `name` required; `address?[]`, `phone?`, `email?`, `taxId?` — each word-wrapped / labeled |
| `customer.name` | `string` | ✓ | Under bold `Bill To:` |
| `items` | `InvoiceItem[]` | ✓ | |
| `items[].description` | `string` | ✓ | Col 1; amount col `formatCurrency(total)` |
| `items[].quantity` | `number` | ✓ | Col 2 |
| `items[].unitPrice` | `number` | ✓ | Detail line `  {qty} x {unitPrice}` indented 2 |
| `items[].total` | `number` | ✓ | Col 3 |
| `items[].sku` | `string` |  | `  SKU: …` |
| `subtotal` | `number` | ✓ | `totalsRow` |
| `discount` | `number` |  | `Discount: -…` if `>0` |
| `tax` / `taxRate` | `number` / `number` |  | `Tax (X%):` if `taxRate`, else `Tax:`; printed if `>0` |
| `total` | `number` | ✓ | Bold `TOTAL DUE:` divider-framed |
| `notes` / `terms` | `string` |  | Sections under totals |
| `header` | `ReceiptHeader` |  | Same as receipt: `storeName`, `storeAddress[]`, `storePhone`, `taxId` — centered |

Flow: centered `storeName` large bold → addresses word-wrapped → Tel/TaxId → `INVOICE` centered bold → divider → Invoice#/Date/Due → divider → `Bill To:` block → divider → `Description Qty Amount` header → items + unitPrice detail + SKU → divider → Subtotal/Discount/Tax dividers → `TOTAL DUE:` bold → Notes/Terms → centered `Powered By` → `feedAndCut(4)`. Currency via `EscPosUtils.formatCurrency(amount, 0)` (no decimals — supply integer cents if needed).

---

### 3.4 `test` — Printer Test Page

`src/templates/test-template.ts:12` — comprehensive diagnostics. Validate always `true` (`test-template.ts:151`).

`TestPayload` (`types/index.ts:330`): `{ message?: string, includeBarcode?: boolean, includeQR?: boolean, includeAllFonts?: boolean }`

Prints: `PRINTER TEST` large bold → double divider → `Printer Width: W`, timestamp → optional Message word-wrapped → if `includeAllFonts`: Normal/Bold/Underline/Inverse/Double Width/Height/Both → Alignment Left/Center/Right → Column test: Label:Value + `Item Qty Amount` header + `Long Label` wrap demo → charset 0-9/A-Z/a-z/symbols → width verification box (`|----|`, centered `<-- W chars -->`) → if `includeBarcode && supportsBarcode`: CODE128 `123456789012` centered → if `includeQR && supportsQRCode`: QR `https://example.com/test` → double divider → `TEST COMPLETE` bold centered → `Powered By` → `feedAndCut(4)`.

Triggered also by `POST /api/printers/:printerId/test` (creates a `test` job with `HIGH` priority).

---

### 3.5 `raw` — Raw ESC/POS Passthrough

`src/templates/raw-template.ts:9` — no layout, no capabilities check; bytes forwarded verbatim via the OS spooler.

Validate: `!!commands` (`raw-template.ts:44`).

`RawPayload` (`types/index.ts:337`): `{ commands: number[]|Buffer|string, encoding?: 'hex'|'base64'|'raw' }`

* `Buffer` → returned as-is.
* `number[]` → `Buffer.from(array)`.
* `string` + `encoding='hex'` → `Buffer.from(str.replace(/\s/g,''), 'hex')` (whitespace tolerant).
* `string` + `encoding='base64'` or `'raw'` or missing → `Buffer.from(str, 'base64')` (so a string defaults to base64).
* Missing/falsy `commands` → `Buffer.alloc(0)`.

Use for driver-generated ESC/POS, label dumps, or any bytes the templates can't express.

### 3.6 Adding a custom template

```ts
import { TemplateEngine, TemplateType } from './templates/engine';
engine.registerRenderer(TemplateType.RAW, new MyLabelTemplate()); // or any string enum extension
```

---

## 4. Printer Capabilities & ESC/POS Builder

`EscPosBuilder` (`src/escpos/builder.ts:159`) is the only place ESC/POS bytes are produced. Templates never write bytes directly.

Constructor defaults (`builder.ts:164`): `maxWidth 48`, all `supports*` true except `supportsImage false`, `codepage 0`. `EscPosBuilder.create(capabilities)` calls `init()` (`ESC @`).

Key methods: `init`, `setCodePage`, `raw`, `text(line)`, `newline`, `feed`, `align(LEFT/CENTER/RIGHT)`, `fontSize(NORMAL/DOUBLE_WIDTH/DOUBLE_HEIGHT/DOUBLE_BOTH)`, `bold/underline/inverse/font(A|B|C)/lineSpacing/separator/columns/threeColumns/textWrapped`, `barcode(data, {type: BarcodeType, width 2..6, height, position none|above|below|both})`, `qrCode(data, {moduleSize, errorCorrection QRErrorCorrection L/M/Q/H})`, `raster({data: base64, width, height})` → `GS v 0` (gated on `supportsImage`, validates `bytesPerRow*height`), `cut(partial)`, `feedAndCut(lines=3)`, `openCashDrawer(pin 2|5, onTimeMs, offTimeMs)` → `ESC p m t1 t2` via `cashDrawerPulse(pin, onTime, offTime)` (`builder.ts:117`, clamps `ms/2` → `1..255`, so `10..510 ms`).

Utilities `EscPosUtils`: `formatCurrency(amount, decimals=0)`, `formatDate/Time/DateTime`, `truncate`, `pad`, `getStatusCommand/parseStatus`.

---

## 5. Full HTTP API Reference

Base: `http://<host>:<port>` (default `http://127.0.0.1:9100`, smart fallback `9101…9109`). All responses carry `X-Service-Port`. JSON body limit = `security.maxPayloadSize` (default 1 048 576). Helmet CSP, PNA header (`Access-Control-Allow-Private-Network`), `POST`/`PUT`/`DELETE` with 30 s timeout (except `/api/logs/stream`, `/api/events`, `/api/backup/restore`).

### 5.1 Global middleware (order matters — `server.ts:132`)

1. **Helmet** (CSP allows `cdn.jsdelivr.net` + `fonts.googleapis.com`, `crossOriginEmbedderPolicy: false`).
2. **PNA** — reflects `Access-Control-Request-Private-Network`.
3. **CORS** (`OriginPolicy` `origin-policy.ts`) — loopback always allowed on any port; `allowedOrigins` supports `*` wildcards; `allowPrivateNetwork` opens `10/172.16-31/192.168`. Rejected origins get **no** CORS headers (browser blocks) + `enforceOrigin` turns `OPTIONS`-not-preflight into `403 {error:"Forbidden", message: reason, origin}` rather than opaque 500.
4. **`X-Service-Port`**, **`enforceOrigin`** (skips `OPTIONS`), **`express.json`**, **`checkShutdown` (503 if draining)**, **`requestTimeout` (408)**, request logging, **`validateHost`** (against `allowedHosts` → 403), **`validateApiKey`** (if `enableApiKey`, skipped for `/health`, `/api/health`, `/dashboard`, `/`, `/api/auth/local-token`; `/api/events` also accepts `?key=`), **`rateLimit`** (per-minute `rateLimitPerMinute` + burst 20/s, both via `rate-limiter-flexible`; loopback `127.0.0.1/::1` and health/events are exempt).

### 5.2 Auth & identity

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/auth/local-token` | Loopback IP only | Returns `{apiKey, authRequired}`. Non-loopback → 403. (`server.ts:563`) |
| `GET` | `/_health` alias `GET /health` + `GET /api/health` | No (API key skipped) | `decideHealth` capability check (see 5.3). Always 200 unless store crash → 503 `unhealthy`. Includes `service`, `port`, `configuredPort`. |

Send API key as `X-API-Key` (or `?key=` for `/api/events` EventSource).

### 5.3 Health & system

#### `GET /health` / `GET /api/health` (`server.ts:483`)

Response `HealthResponse` (`types/index.ts:454`):

```json
{
  "status": "healthy|degraded|unhealthy|initializing",
  "reasons": ["No printers online — …", "…"],
  "uptime": 12345, "version": "1.0.0",
  "service": "xp-thermal-service", "port": 9100, "configuredPort": 9100,
  "printers": { "total": 2, "online": 2, "offline": 0, "error": 1, "initializing": false },
  "queue": { "pending": 3, "processing": 1, "failed": 0, "deadLetter": 7, "oldestPendingAgeMs": 42000 }
}
```

* `healthy` = can accept & complete work; `degraded` = accepting work it can't complete (no online printer, printer in `error`, queue not draining); `unhealthy` = cannot accept work (store crash); `initializing` = transient startup.
* Crash catch (`server.ts:542`) returns `503 {status:"unhealthy", reasons:["The health check itself failed…"]}` — never `degraded` (Layer 5 distinction).

#### Other system endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/metrics` | `{uptime, queue: JobQueueStats, processor: ProcessorMetrics, printers: Summary, printerEvents:{watching, mode:"event-driven"|"polling"}}` (`server.ts:1124`) |
| `GET` | `/api/system/info` | `{platform, arch, nodeVersion, pid, uptime, memory{heapUsed,heapTotal,external,rss MB}, cpu{user,system ms}, cwd}` (`server.ts:972`) |
| `GET` | `/api/system/connections` | `{activeConnections, maxConnections:100, isShuttingDown}` (`server.ts:1000`) |
| `GET` | `/api/system/print-system` | Raw `WindowsPrintSystemSnapshot` (refresh) for support — printers, ports, usbDevices, spooler, warnings, host (`server.ts:1582`) |
| `POST` | `/api/service/restart` | **Loopback-only** 202. Drains queue (`onRestartRequested`) then `process.exit(1)` for `node-windows` respawn; without handler exits after 500 ms (`server.ts:1021`) |

### 5.4 Printing — the template-driven path

#### `POST /api/print` + `POST /api/print/:printerId` (`server.ts:582`)

`:printerId` in path overwrites `body.printerId`. If neither, uses default printer → `503 PRINTER_NOT_FOUND` if none.

**Request** `PrintRequest` (`types/index.ts:402`, validated by `PrintRequestSchema` `server.ts:42` with `zod`):

```ts
{
  idempotencyKey: string(1..255) required,
  printerId?: string,
  templateType: TemplateType enum('receipt'|'kot'|'invoice'|'test'|'raw') required,
  payload: Record<string,unknown> required,   // validated per template above
  priority?: JobPriority enum(0 LOW|1 NORMAL|2 HIGH|3 CRITICAL),
  copies?: number(1..10),
  metadata?: Record<string,unknown>
}
```

Invalid schema → `PrintServiceError(400, INVALID_REQUEST)` with zod message.

**Enqueue** (`server.ts:624`): `copies` defaults 1; each copy gets `idempotencyKey = "{key}_copy_{i}"` and a separate job via `queue.enqueue()`. Duplicate key returns existing job (`{created:false}`) — **idempotent**, never double-prints.

**Response**

* Single copy: `201` if new, `200` if duplicate → `{success:true, jobId, status: JobStatus, message:"Job created"|"Duplicate job (idempotent)"}` (`PrintResponse` `types/index.ts:412`).
* Multiple copies: `201 {jobs: PrintResponse[]}`.

`JobStatus` (`types/index.ts:10`): `pending|queued|processing|printing|completed|failed|retry_scheduled|cancelled|dead_letter`.

#### Errors

* Unknown `templateType` / failed `validate()` → `400 {error:"JOB_INVALID_PAYLOAD", message:"Invalid payload for template: …"}` from `TemplateEngine`.
* Unknown `printerId` → `404 PRINTER_NOT_FOUND`.
* No default printer → `503 PRINTER_NOT_FOUND`.

#### Examples

```bash
# Receipt (80 mm) — idempotent key prevents double-print on retry
curl -X POST http://127.0.0.1:9100/api/print \
  -H 'Content-Type: application/json' -H 'X-API-Key: $KEY' \
  -d '{"idempotencyKey":"ord_42_receipt","printerId":"receipt","templateType":"receipt","priority":2,
       "payload":{"orderNumber":"42","orderDate":"2026-09-02","orderTime":"19:31","items":[{"name":"Latte","quantity":2,"price":5,"total":10}],"subtotal":10,"total":10}}'

# KOT to kitchen, high priority, 2 copies
curl -X POST http://127.0.0.1:9100/api/print/kitchen \
  -H 'Content-Type: application/json' -H 'X-API-Key: $KEY' \
  -d '{"idempotencyKey":"kot_42","templateType":"kot","copies":2,"priority":3,
       "payload":{"orderNumber":"42","orderTime":"19:31","items":[{"name":"Salmon","quantity":1}]}}'

# Raw passthrough — hex
curl -X POST http://127.0.0.1:9100/api/print \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"raw_1","templateType":"raw","payload":{"commands":"1B 40 1B 61 01 48 65 6C 6C 6F 0A 1D 56 00","encoding":"hex"}}'
# Raw — base64 (default for string)
curl -X POST http://127.0.0.1:9100/api/print \
  -d '{"idempotencyKey":"raw_2","templateType":"raw","payload":{"commands":"G0hAC0hlbGxvCg=="}}'
```

### 5.5 Jobs & Queue

| Method | Path | Query / Body | Response |
|---|---|---|---|
| `GET` | `/api/jobs` | `?status=JobStatus & printerId & limit(1..100, default 50)` — validates `status` (`server.ts:731`) | `{jobs: PrintJob[], total}` — `getJobsByStatus` if `status`, else `getJobsByPrinter` if `printerId`, else `pending` |
| `GET` | `/api/jobs/:jobId` |  | `{job: PrintJob, found:true}` or `404 JOB_NOT_FOUND` |
| `GET` | `/api/jobs/:jobId/status` |  | `{found, job: PrintJob|null, history}` — history from `queue.getJobHistory` (`server.ts:681`) |
| `DELETE` | `/api/jobs/:jobId` |  | `{success, message:"Job cancelled"}` or `400 JOB_CANCELLED` |
| `POST` | `/api/jobs/:jobId/retry` |  | `{success, message:"Job scheduled for retry", jobId}` or `404` if not retryable |
| `POST` | `/api/jobs/clear-failed` |  | `{success, message:"Cleared N failed jobs", count}` |
| `GET` | `/api/queue/stats` |  | `{queue: JobQueueStats, processor: ProcessorMetrics, isPaused}` |
| `POST` | `/api/queue/pause` |  | `{success, message:"Queue paused"}` |
| `POST` | `/api/queue/resume` |  | `{success, message:"Queue resumed"}` |

`PrintJob` shape (`types/index.ts:29`): `{id, idempotencyKey, printerId, templateType, payload, priority, status, attempts, maxAttempts, createdAt, updatedAt, scheduledAt|null, startedAt|null, completedAt|null, error|null, rawCommands? Buffer, metadata?}`.

### 5.6 Printers

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/printers` | `{printers: PrinterInfo[]}` (`PrinterInfo = PrinterConfig + PrinterState`) |
| `GET` | `/api/printers/:printerId` | Single `PrinterInfo` or `404` |
| `GET` | `/api/printers/:printerId/status` | Checks existence → `404` if unknown; returns `{printerId, status: PrinterStatus, reason?, healable?}` (`server.ts:779`) |
| `POST` | `/api/printers/:printerId/test` | Enqueues `test` job `HIGH` with `payload {message?, includeBarcode?, includeQR?, includeAllFonts?}` → `{success, jobId}` (`server.ts:806`) |
| `POST` | `/api/printers/:printerId/reconnect` | `printerManager.reconnect(id)` → `{success, message}` (`server.ts:888`) |
| `POST` | `/api/printers/:printerId/cash-drawer` | Pulses drawer. `:printerId` may be `default` (resolved). Body `{pin? 2|5, onTimeMs?, offTimeMs?}` — request values win, else `printer.config.cashDrawer`. Returns `200` or `502` with `pin/onTimeMs/offTimeMs` echo and `message` hinting to try other pin/longer pulse. `400` if `!supportsCashDrawer` or `cashDrawer.enabled===false` (`server.ts:908`) |
| `GET` | `/api/printers/discover` | `?network=1 & all=1 & timeout=800`. Returns `{printers: DiscoveredPrinter[] (ranked, virtual filtered unless all), needsDriver: UninstalledDevice[], summary{total,recommended,alreadyConfigured,needsDriver}, system{snapshot}}` (`server.ts:1235`) |
| `GET` | `/api/printers/roles` | `{roles: PrinterRole[]}` — `receipt|kitchen|bar|label` (`server.ts:1281`) |
| `POST` | `/api/printers/setup` | **Whole add-a-printer flow** — body `{role: PrinterRole, windowsName, test? (!==false)}`. Derives id/caps/paper/cashDrawer/breadcrumbs; repoints if role exists; optional test receipt → `{success, replaced, printer, status, ready, reason?, testPrinted, message}` (`server.ts:1295`) |
| `POST` | `/api/printers/auto-setup` | Configures every **recommended** thermal printer not already known; first added becomes default if none existed → `{success, added[], failed[], message, printers}` (`server.ts:1383`) |
| `GET` | `/api/printers/:printerId/diagnose` | Full reasoning: queue found/bound, WorkOffline, presence, port migration, faults, spooler, repair plan + manualHint (`server.ts:1462`) |
| `POST` | `/api/printers/:printerId/repair` | Runs repair ladder (port → offline flag → queue → spooler) → `{success, statusBefore/After, attempted[], succeeded[], reason, manualHint, message}` (`server.ts:1476`) |
| `GET` | `/api/system/print-system` | Raw snapshot for support (`server.ts:1582`) |

`PrinterStatus` (`types/index.ts:68`): `online|offline|error|paper_out|cover_open|busy|unknown`. `PrinterState` adds `reason` (human), `boundPrinterName`, `healable`, `consecutiveFailures`, `totalJobsPrinted`.

### 5.7 Live updates

`GET /api/events` (`server.ts:1509`) — **Server-Sent Events**. Headers `text/event-stream, no-cache, no-transform, keep-alive, X-Accel-Buffering: no`. Immediately sends `event: printers\ndata: {printers, summary}\n\n`. Coalesces multi-event bursts (150 ms), heartbeat `: keep-alive` every 25 s. Closes cleanly on `req/res close/error`. Accepts API key via `?key=` because EventSource can't set headers.

### 5.8 Config & system printers

| Method | Path | Body / Response |
|---|---|---|
| `GET` | `/api/config` | Returns `{server:{…activePort}, security, queue, logging, printers}` — `activePort` may differ from `configuredPort` (`server.ts:1150`) |
| `PUT` | `/api/config/server` | `updateServerConfig(body)` → `{success, message:"…Restart for host/port…", server}` |
| `PUT` | `/api/config/security` | Validates + live-applies: updates `config.security`, `originPolicy`, recreates `RateLimiterMemory` → `{success, message:"…applied immediately", security}` (`server.ts:1182`) |
| `GET` | `/api/system/printers` | Legacy alias for `USBPrinterAdapter.listPrinters()` (`server.ts:1220`) |
| `POST` | `/api/config/printers` | `409` if `body.id` already exists; live-registers + connects → `201 {success, message, printers}` (`server.ts:1591`) |
| `PUT` | `/api/config/printers/:printerId` | Live-unregister → register → connect → `{success, printer}` (`server.ts:1629`) |
| `DELETE` | `/api/config/printers/:printerId` | Live-unregister → `removePrinter` → `{success, printers}` (`server.ts:1659`) |

### 5.9 Backup (POS-integrated)

Policy owned by POS Server Management dashboard (polled via `backup.posBaseUrl`); these endpoints are on-box control/inspection.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/backup/status` |  | `backupScheduler.getStatus()` or `503` if disabled (`server.ts:1063`) |
| `GET` | `/api/backup/list` |  | `{paths}` from `listBackups()` |
| `POST` | `/api/backup/run` |  | Fire-and-forget `triggerNow()` → `202 {success:"Backup started"}` (poll status) |
| `POST` | `/api/backup/restore` | Loopback-only (403 otherwise) | Body `{path, file}` → `backupScheduler.restore(join(path,file))` → `200|400 {success}`. Timeout-exempt. |

`BackupConfig` (`types/index.ts:594`): `{enabled, posBaseUrl, pollIntervalMs, timeoutMs, filenamePrefix, mongo:{binDir, host, port, database, gzip}}`.

### 5.10 Metrics

`GET /api/metrics` → `{uptime, queue, processor, printers: Summary, printerEvents:{watching, mode}}` (`server.ts:1124`) — `watching` tells whether WMI events are live.

### 5.11 Dashboard & 404

`GET /dashboard` → serves `public/dashboard.html` (searches `process.cwd()/public`, `__dirname/../public`, `../../public`), injects `window.__XP_API_KEY__` before `</head>` (`server.ts:1682`). `GET /` → `302 /dashboard`. Unknown route → `404 {error:"Not Found"}`; unhandled error → `500 INTERNAL_ERROR` with `error.message` preserved if validation, else generic.

### 5.12 Error model

`PrintServiceError(code, statusCode, details)` (`types/index.ts:676`), `PrinterError`, `JobError`. `ErrorCodes` (`types/index.ts:711`): `PRINTER_NOT_FOUND/OFFLINE/BUSY/ERROR/PAPER_OUT/TIMEOUT/CONNECTION_FAILED`, `JOB_NOT_FOUND/DUPLICATE/CANCELLED/TIMEOUT/INVALID_PAYLOAD`, `QUEUE_FULL/ERROR`, `INVALID_REQUEST/UNAUTHORIZED/RATE_LIMITED/INTERNAL_ERROR`. Non-`PrintServiceError` `Invalid …` messages become `400 VALIDATION_ERROR`; everything else `500` (`server.ts:1709`).

### 5.13 Timeouts, shutdown & discovery on disk

* `SERVER_CONFIG` (`server.ts:66`): `keepAliveTimeout 65000`, `headersTimeout 66000`, `requestTimeout 30000`, `maxConnections 100`, `gracefulShutdownTimeout 10000`. `stop()` stops accepting, polls `activeConnections` every 100 ms, force-destroys after 10 s.
* Endpoint discovery without scanning: `active_port.txt` + `data/service-endpoint.json` + `C:\ProgramData\XPThermalService\…` (same).
* Dashboard port banner, `/health` and every `X-Service-Port` confirm the real port.

---

## 6. Configuration (`config.json` / `config.example.json`)

Merged from `src/utils/config.ts` defaults + file. See `config.example.json:131` for full example (also `README.md:314`).

Top-level `ServiceConfig` (`types/index.ts:536`):

* `server: {host, port, enableHttps, certPath?, keyPath?}` — `host 127.0.0.1` loopback by default.
* `security: {allowedOrigins[], allowedHosts[], rateLimitPerMinute (120), enableApiKey (true), apiKey?, maxPayloadSize (1 MB), allowPrivateNetwork (true)}` — wildcards allowed, loopback exempt from rate-limit/CORS strictness.
* `queue: {maxConcurrentJobs 3, maxRetries 5, retryDelayMs 1000, retryBackoffMultiplier 2, maxRetryDelayMs 60000, jobTimeoutMs 30000, cleanupIntervalMs 3600000, maxJobAgeMs 604800000 (7 d), persistPath "./data/jobs.db"}`.
* `logging: {level trace|debug|info|warn|error|fatal, file?, maxFiles?, maxSize?, console}`.
* `backup: {enabled, posBaseUrl ("http://127.0.0.1:8080"), pollIntervalMs, timeoutMs, filenamePrefix, mongo:{binDir, host, port, database, gzip}}`.
* `printers: PrinterConfig[]` — `id` is the **role** (`receipt|kitchen|bar|label`), `name`, `type usb|network|serial`, `enabled`, `isDefault`, `printerName` (Windows queue, usb), `vendorId/productId`, `host/port` (network), `timeout 10000`, `maxRetries 3`, `capabilities`, `cashDrawer?`, `metadata` (breadcrumbs `role, windowsPort, windowsDriver, usbHardwareId` — auto-maintained, do not edit).

Role printers: `buildRoleConfig` derives everything so POS always addresses `receipt`/`kitchen`.

---

## 7. End-to-end request examples

```bash
BASE=http://127.0.0.1:$(cat active_port.txt 2>/dev/null || echo 9100)
KEY=$(curl -s $BASE/api/auth/local-token | jq -r .apiKey)  # loopback only

# Health — confirm identity when scanning ports
curl -s $BASE/health | jq '{service,port,configuredPort,status,printers,queue}'

# Discovery → setup → test → print → poll
curl -s $BASE/api/printers/discover | jq
curl -s -X POST $BASE/api/printers/setup \
  -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"role":"receipt","windowsName":"XP-80C","test":true}' | jq

curl -s -X POST $BASE/api/print \
  -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"idempotencyKey":"inv_1001","templateType":"invoice","priority":1,
       "payload":{"invoiceNumber":"INV-1001","invoiceDate":"2026-09-02","customer":{"name":"Acme LLC","address":["Calle Hostos 101"]},"items":[{"description":"POS Setup","quantity":1,"unitPrice":500,"total":500}],"subtotal":500,"total":500}}' | jq
JOB=$(curl -s -X POST $BASE/api/print -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"idempotencyKey":"ord_999","templateType":"receipt","payload":{"orderNumber":"999","orderDate":"2026-09-02","items":[{"name":"Test","quantity":1,"price":1,"total":1}],"subtotal":1,"total":1}}' | jq -r .jobId)
curl -s $BASE/api/jobs/$JOB/status | jq

# Cash drawer — try saved pulse, then test other pin
curl -s -X POST $BASE/api/printers/receipt/cash-drawer -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"pin":2,"onTimeMs":100,"offTimeMs":200}' | jq

# Invoice with full totals
curl -s -X POST $BASE/api/print -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"idempotencyKey":"inv_full","templateType":"invoice","payload":{
        "invoiceNumber":"INV-2026-09","invoiceDate":"2026-09-02","dueDate":"2026-09-09",
        "customer":{"name":"Acme LLC","phone":"809-555-0100","taxId":"1-23-45678"},
        "items":[{"description":"Consulting","quantity":10,"unitPrice":80,"total":800,"sku":"CONS-10"}],
        "subtotal":800,"discount":50,"tax":46.2,"taxRate":6,"total":796.2,
        "notes":"Net 7","terms":"Late fee 1.5%","header":{"storeName":"XenithPulse SRL"}}}' | jq

# SSE stream (key as query — EventSource can't set headers)
curl -N "$BASE/api/events?key=$KEY"
```

POS integration pattern — always verify identity when scanning `9100…9109`:

```ts
async function findService(): Promise<string|null> {
  for (let port=9100; port<=9109; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(800)});
      if (!r.ok) continue;
      const b = await r.json();
      if (b.service && b.service !== 'xp-thermal-service') continue;
      return `http://127.0.0.1:${port}`;
    } catch {}
  }
  return null;
}
```

---

## 8. Field & API quick index

* **Template fields** — §3 per template (tables + JSON examples). Receipt is field-toggle driven via `options.fields`; KOT is minimal; Invoice has Bill-To + line items with SKU; Test is fixed diagnostics; Raw is bytes.
* **Print path** — `POST /api/print` §5.4 (idempotency, copies, priority, typed TemplateType, per-template validate).
* **Jobs/queue/config/printers/system/backup/SSE/dashboard** — §5.5–5.12 (37 routes total, all listed with methods, auth, request/response shapes).
* **Middleware & security** — §5.1 + `config.json` §6 (Helmet, PNA, OriginPolicy wildcards, host check, API key, burst+minute rate-limit loopback-exempt).
* **Discovery & self-repair** — `discover/setup/auto-setup/diagnose/repair/print-system` (§5.6) + health degraded/unhealthy semantics (§5.3).

Canonical doc: this file. Wiki mirror: `GPPos/docs/wiki/integrations/xp-thermal-templates.md` (short).
