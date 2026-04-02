# @pipeworx/mcp-patents

MCP server for US patent search and inventor lookup via the [PatentsView API](https://api.patentsview.org/). Free, no authentication required.

## Tools

| Tool | Description |
|------|-------------|
| `search_patents` | Search US patents by keyword (matches patent abstracts) |
| `get_patent` | Get full details for a specific patent by number |
| `search_inventors` | Search patent inventors by last name |

## Quickstart via Pipeworx Gateway

```bash
curl -X POST https://gateway.pipeworx.io/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "patents__search_patents",
      "arguments": { "query": "machine learning", "per_page": 5 }
    },
    "id": 1
  }'
```

## License

MIT
