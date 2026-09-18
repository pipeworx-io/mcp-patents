# USPTO Patents — Patent and Application Search

The US Patent and Trademark Office's patent database via the PatentsView API. Search and retrieve granted US patents (and published applications) by keyword, assignee, inventor, or patent number. ~12 million issued patents going back to 1976. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

Patents are the public record of what's been invented and who claims to have invented it. For competitive intelligence, IP due diligence, freedom-to-operate research, or technology landscaping, the USPTO is the source. The data is structured: claims, citations, family members, prosecution history, assignment changes.

Two core flows:

**1. Keyword search.** "What patents exist for CRISPR gene editing?" → `search_patents({query: "CRISPR gene editing"})` → top patents by relevance with title, abstract, assignee, filing date, patent number.

**2. Specific patent.** "What's in patent US 10,123,456?" → `get_patent({number: "US10123456"})` → full record: claims, citations, family, current owner.

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

The default search returns utility patents. For design or plant patents, filter by `type` in results.

## Update cadence

- New patents publish on Tuesdays (USPTO's grant-day cadence).
- New applications publish on Thursdays.
- Pipeworx caches results with 24-hour TTL — fine for almost all use cases. For Tuesday-morning fresh-grant news, set `Cache-Control: no-cache`.

## Common pitfalls

- **Keyword search ≠ freedom-to-operate.** `search_patents` finds patents whose text mentions your terms. It does not tell you whether a patent CLAIMS what you'd be doing. FTO requires reading claims carefully — Pipeworx returns them, but interpretation needs a patent attorney.
- **Assignee normalization.** "Vertex Pharmaceuticals Inc.", "VERTEX PHARMACEUTICALS, INC.", "Vertex Pharmaceuticals" — all the same company. Group case-insensitive after stripping legal suffixes when aggregating.
- **Citation density signal.** Most-cited patents within a search result are usually the foundational ones. Their citation count is in the patent record — sort by it for "what are the canonical patents in this area."
- **Foreign filings absent.** USPTO is US-only. For European, Japanese, or Chinese patents, you need EPO, JPO, or CNIPA — not currently in Pipeworx. File via [`pipeworx_feedback`](/docs/concepts/meta-tools) if you need them.
- **Application vs. issued.** "Patent pending" applications are searchable but the date you care about is `grant_date`, not `filing_date`. Applications can be rejected or amended; the issued patent is what matters.
- **Patent family.** Most patents have foreign counterparts (the "family"). The full record lists family members. For a complete picture of a single invention's protection, look at the family across all jurisdictions.

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/patents_search_patents \
  -H 'Content-Type: application/json' \
  -d '{"query":"machine learning neural networks"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/patents_search_patents`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
