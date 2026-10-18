# USPTO Patents — Patent and Application Search

The US Patent and Trademark Office's patent database via the USPTO Open Data Portal (ODP, `data.uspto.gov`) — Pipeworx migrated off the legacy PatentsView API (`api.patentsview.org`, sunset 2025-05-01) on 2026-05-12. Search and retrieve granted US patents and published applications by keyword, assignee, inventor, or patent number. Free, no auth (platform key configured server-side; bring your own via `_apiKey` if you need your own quota — get one at https://data.uspto.gov/myodp).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1837+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

Patents are the public record of what's been invented and who claims to have invented it. For competitive intelligence, IP due diligence, freedom-to-operate research, or technology landscaping, the USPTO is the source. What this pack actually returns: title, inventors/applicants, classification, filing/grant status and dates, the granted patent number once issued, full prosecution/transaction history, parent/child continuity (priority chains), and recorded assignment/conveyance history — both for one application you already have (`get_patent_assignments`) and by searching assignee/assignor/patent/application number (`search_patent_assignments`). It does **not** return claims text or citation data; there is no `get_claims` or citation tool in this pack (the `epo-ops` pack's `get_claims` does return claims text, but only for EPO-published records).

Three core flows:

**1. Keyword search.** "What patents exist for CRISPR gene editing?" → `search_patents({query: "CRISPR gene editing"})` → matching applications/patents with title, application number, filing date, applicants, inventors, status, classification.

**2. Specific patent.** "What's the status of application 16/123,456?" → `get_patent({number: "16123456"})` → title, inventors, classification, status, and — once granted — `patent_number`/`grant_date`/`publication_number`/`publication_date`. If you already have a GRANTED patent number instead, pass it as `patent_number` (e.g. `get_patent({patent_number: "11646472"})`) rather than `number` — see the collision warning below. For the full prosecution timeline, use `get_patent_transactions`; for where the application came from (continuations, divisionals, provisionals) and what it later spawned, use `get_patent_continuity`. For who currently holds it, pair with `get_patent_assignments({application_number: "16123456"})` or search by name with `search_patent_assignments`.

**3. Ownership search.** "What has Amyris been assigned?" / "Who assigned patent 10,000,000?" → `search_patent_assignments({assignee: "Amyris"})` / `search_patent_assignments({patent_number: "10000000"})` → recorded assignments with reel/frame, conveyance, dates, assignors/assignees, and the covered application/patent numbers.

For company-level IP due diligence (combining patents with SEC IP risk disclosures and trademarks), see the [Patent Due Diligence](/docs/recipes/patent-due-diligence) recipe.

## Citable URI

```
pipeworx://uspto/patent/{number}
```

Patent numbers are stable forever. Embed in agent output as the canonical citation.

## What "patents" includes

| Type | Prefix | What it is |
|---|---|---|
| Utility patent | (none / numeric) | Standard invention patent (machines, processes, articles) |
| Design patent | D | Ornamental design (e.g., D123,456 = a chair design) |
| Plant patent | PP | Asexually reproduced plant variety |
| Reissue | RE | Corrected version of an earlier patent |
| Reexamination | (E numbers) | Validity-challenged patents under review |

There's no dedicated `type` input filter — every result carries a `type` field (application/patent type) you can filter on client-side to isolate design or plant patents from the utility-patent majority.

## Update cadence

- **Grants: measured, Tuesday.** Querying `granted_after` for the current week (2026-09-08) returns grant dates of only 2026-09-01 and 2026-09-08 — both Tuesdays — confirming USPTO's long-standing weekly grant-day cadence carried over from the PatentsView era. This is current data, not a stale mirror: the most recent grant date returned is today.
- **Applications: unverified — do not repeat the old Thursday claim.** ODP's `applicationMetaData` exposes `filingDate` and `grantDate` but no publication date field, so Pipeworx has no way to check when an application record actually becomes visible in ODP. The PatentsView-era "Thursday" figure was for `api.patentsview.org`'s `pgpub` publication feed, which this pack does not use and cannot confirm carried over. Treat application-corpus freshness as unmeasured rather than assuming a fixed weekday.
- **The default search looks old by construction, not because data is stale.** With no `granted_after`/`granted_before`, `search_patents` returns the application corpus sorted newest-**filed**-first. USPTO doesn't publish an application until ~18 months after filing and typically takes 2+ years to grant it, so the newest rows in an unfiltered search are recent filings with `grant_date: null` — that's expected. Pass `granted_after` (e.g. `"2024-01-01"`) to get issued patents with real grant dates instead. See the `search_patents` tool description for the full explanation.
- Pipeworx caches results with a 24-hour TTL. Given the measured Tuesday grant cadence, set `Cache-Control: no-cache` if you need same-day fresh-grant results.

## Common pitfalls

- **Keyword search ≠ freedom-to-operate.** `search_patents` finds patents whose text mentions your terms. It does not tell you whether a patent CLAIMS what you'd be doing, and this pack does not return claims text to check that yourself — FTO requires reading claims (the `epo-ops` pack's `get_claims` returns claims text, but only for EPO-published records) and, ultimately, a patent attorney.
- **Assignee normalization.** "Vertex Pharmaceuticals Inc.", "VERTEX PHARMACEUTICALS, INC.", "Vertex Pharmaceuticals" — all the same company. Group case-insensitive after stripping legal suffixes when aggregating.
- **No citation data.** This pack does not surface citation counts or citation lists at all — there is no way to rank "most-cited" or "foundational" patents within a result set through this pack.
- **This pack is US-only, but Pipeworx isn't.** USPTO covers US filings only. For European patents, the [`epo-ops`](../epo-ops/README.md) pack is live today — `epo_ops_search_patents`, `get_biblio`, `get_family`, `get_abstract`, `get_claims` against the EPO's worldwide register (verified live 2026-09-08: `epo_ops_search_patents({query:"lithium battery"})` returned current European filings, including publications dated this week). Japanese (JPO) and Chinese (CNIPA) national filings are not in Pipeworx yet — file via [`pipeworx_feedback`](/docs/concepts/meta-tools) if you need them.
- **Application vs. issued.** "Patent pending" applications are searchable but the date you care about is `grant_date`, not `filing_date`. Applications can be rejected or amended; the issued patent is what matters.
- **"Filed" wants `filed_after`/`filed_before`, not `granted_after`/`granted_before` (fleet #2418).** A question that says FILED or APPLIED FOR — even when it also says "recent" or "last N years" — wants the filing-date bound; the default application corpus already includes both pending and granted patents, so `filed_after` alone answers it. Using `granted_after` for a filing-activity question silently restricts to already-issued patents, and since grant typically lags filing by 2+ years, a recent granted-only window is usually empty even when real filing activity exists — `search_patents` returns a `date_field_hint` explaining this on a granted-only zero result.
- **Multi-phrase queries get one zero-result broadening retry (fleet #2418).** `{query: '"experimental phrase one" "experimental phrase two"'}` requires BOTH exact phrases to co-occur (ODP ANDs every clause), which can return 0 even when either phrase alone matches plenty. On a genuine zero with 2+ quoted phrases, `search_patents` automatically retries the same phrases OR'd together and marks the response `broadened: true` — treat those results as "mentions at least one phrase", not all of them. An ordinary bare multi-keyword AND (no quoted phrases) is left alone on zero, since that AND is usually doing real, intentional narrowing.
- **Known synonym/abbreviation groups are expanded before the search runs (fleet #2450/#2499).** `{query: 'cfRNA "residual cancer"'}` used to return 0 with no broadening at all — the #2418 retry above only sees a query with 2+ QUOTED phrases, and a bare abbreviation next to one quoted phrase never qualified, even though 23 real matches exist for the same two concepts phrased as `'"residual cancer" "cell-free RNA"'`. A short, curated list of production-observed synonym pairs (`cfRNA` / `cell-free RNA` / `cell free RNA` / `circulating RNA` / `circulating cell-free RNA` / `ccfRNA`; `MRD` / `minimal residual disease` / `molecular residual disease` / `residual cancer` / `residual disease`) is now recognized — quoted or bare, case-insensitive — and expanded to an OR group ANDed against the other concept in the query, on the FIRST attempt, marked `synonyms_expanded: true` in the response. This is deliberately a fixed, documented list, not general synonym invention: an unrelated OR silently answers a different question (a whole-query OR-broaden once returned 21,937 largely off-topic matches).
- **An 8-digit application number and an 8-digit granted patent number can be the SAME digit string for two unrelated inventions (fleet #3301 follow-up).** Application numbers are a 2-digit series code plus a 6-digit serial (e.g. "11" + "646472" = application 11/646,472, filed ~2006); granted patent numbers entered that same 10,000,000-12,999,999 range in 2018 and are still in it. `get_patent({number: "11646472"})` is genuinely ambiguous between a 2006 application and a 2023 patent grant. Pass `patent_number` instead of `number` whenever you specifically mean the patent — it is never ambiguous. If you only have `number` and it falls in the collision range, the tool checks both interpretations and returns `ambiguous: true` with both records summarized rather than silently guessing; re-call with the right argument once you know which one you meant.
- **`get_patent` surfaces `patent_number`/`grant_date` directly now (fleet #3301).** It used to only report `status` plus a guessed "grant event" scanned out of prosecution-history text — and that guess matched ANY event whose description contained the word "Granted", including routine extension-of-time approvals, so a patented application could come back with status "Patented Case" and a misattributed extension-of-time date instead of the actual patent number. Read `patent_number`/`grant_date`/`publication_number`/`publication_date` directly; if `status` is "Patented Case" but `patent_number` is null, the response carries a `patent_number_warning` (an upstream data gap) rather than silently reading as "not yet granted".
- **Two different sources answer assignment questions, and they are not interchangeable.** `get_patent_assignments` and `get_patent_transactions`/`get_patent_continuity` read the USPTO Open Data Portal's per-application file-wrapper data (needs the application number you already have). `search_patent_assignments` reads USPTO's separate public Assignment Search system and is the only one of the four that can search BY assignee, assignor, or patent number without already knowing the application. An assignee/assignor search on `search_patent_assignments` resolves each result's covered patent/application number via one follow-up lookup per row, so it costs more upstream calls than a direct patent/application-number search — keep `limit` modest for a name search.
- **No patent-family data in this pack.** Unlike `epo-ops`'s `get_family` (INPADOC family, worldwide), this USPTO pack does not return family-member data — `get_patent` covers a single US application/grant only. For "does this invention have foreign counterparts," go through `epo-ops` instead.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "patents": {
      "url": "https://gateway.pipeworx.io/patents/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/patents/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1837+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/patents_search_patents \
  -H 'Content-Type: application/json' \
  -d '{"query":"\"cell-free RNA\"","filed_after":"2023-09-25","filed_before":"2026-09-25"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/patents_search_patents`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "patents": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-patents"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-patents
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Patents data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
