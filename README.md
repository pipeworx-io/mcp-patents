# USPTO Patents — Patent and Application Search

The US Patent and Trademark Office's patent database via the USPTO Open Data Portal (ODP, `data.uspto.gov`) — Pipeworx migrated off the legacy PatentsView API (`api.patentsview.org`, sunset 2025-05-01) on 2026-05-12. Search and retrieve granted US patents and published applications by keyword, assignee, inventor, or patent number. Free, no auth (platform key configured server-side; bring your own via `_apiKey` if you need your own quota — get one at https://data.uspto.gov/myodp).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Why this matters for AI agents

Patents are the public record of what's been invented and who claims to have invented it. For competitive intelligence, IP due diligence, freedom-to-operate research, or technology landscaping, the USPTO is the source. What this pack actually returns: title, inventors/applicants, classification, filing/grant status and dates, prosecution events, and — via `get_patent_assignments` — recorded assignment/conveyance history. It does **not** return claims text or citation data; there is no `get_claims` or citation tool in this pack (the `epo-ops` pack's `get_claims` does return claims text, but only for EPO-published records).

Two core flows:

**1. Keyword search.** "What patents exist for CRISPR gene editing?" → `search_patents({query: "CRISPR gene editing"})` → matching applications/patents with title, application number, filing date, applicants, inventors, status, classification.

**2. Specific patent.** "What's the status of application 16/123,456?" → `get_patent({number: "16123456"})` → title, inventors, classification, status, and prosecution events (including the grant event/date if it has been granted). For who currently holds it, pair with `get_patent_assignments({application_number: "16123456"})`.

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

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/patents_search_patents \
  -H 'Content-Type: application/json' \
  -d '{"query":"machine learning neural networks"}'
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
