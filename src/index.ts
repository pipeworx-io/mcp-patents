/**
 * Patents MCP — wraps PatentsView API (https://api.patentsview.org/)
 *
 * Tools:
 * - search_patents: Search US patents by keyword (matches patent abstract)
 * - get_patent: Get full details for a specific patent by number
 * - search_inventors: Search inventors by last name
 */

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const BASE_URL = 'https://api.patentsview.org';

// --- Raw API types ---

type RawPatent = {
  patent_number: string;
  patent_title: string;
  patent_abstract?: string;
  patent_date?: string;
  patent_type?: string;
  inventors?: RawInventor[];
  assignees?: RawAssignee[];
};

type RawInventor = {
  inventor_first_name?: string;
  inventor_last_name?: string;
  inventor_city?: string;
  inventor_state?: string;
};

type RawAssignee = {
  assignee_organization?: string;
};

type RawPatentsResponse = {
  patents: RawPatent[] | null;
  total_patent_count: number;
};

type RawInventorEntry = {
  inventor_first_name?: string;
  inventor_last_name?: string;
  inventor_city?: string;
  inventor_state?: string;
  patents?: { patent_number: string }[];
};

type RawInventorsResponse = {
  inventors: RawInventorEntry[] | null;
  total_inventor_count: number;
};

// --- Tool definitions ---

const tools: McpToolExport['tools'] = [
  {
    name: 'search_patents',
    description:
      'Search US patents by keyword. Matches against patent abstracts. Returns patent number, title, date, inventors, and assignee organization.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Keyword or phrase to search in patent abstracts',
        },
        per_page: {
          type: 'number',
          description: 'Number of results to return (default 10, max 25)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_patent',
    description:
      'Get full details for a specific US patent by patent number. Returns title, abstract, date, type, inventors, and assignee.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: {
          type: 'string',
          description: 'Patent number (e.g. "7654321")',
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'search_inventors',
    description:
      'Search US patent inventors by last name. Returns inventor name, location, and associated patent numbers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Inventor last name to search for',
        },
        per_page: {
          type: 'number',
          description: 'Number of results to return (default 10, max 25)',
        },
      },
      required: ['query'],
    },
  },
];

// --- callTool dispatcher ---

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_patents':
      return searchPatents(args.query as string, (args.per_page as number | undefined) ?? 10);
    case 'get_patent':
      return getPatent(args.number as string);
    case 'search_inventors':
      return searchInventors(args.query as string, (args.per_page as number | undefined) ?? 10);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Formatters ---

function formatPatentSummary(patent: RawPatent) {
  return {
    patent_number: patent.patent_number,
    title: patent.patent_title,
    date: patent.patent_date ?? null,
    inventors: (patent.inventors ?? []).map((inv) => ({
      first_name: inv.inventor_first_name ?? null,
      last_name: inv.inventor_last_name ?? null,
    })),
    assignee_organization: patent.assignees?.[0]?.assignee_organization ?? null,
  };
}

function formatPatentDetail(patent: RawPatent) {
  return {
    patent_number: patent.patent_number,
    title: patent.patent_title,
    abstract: patent.patent_abstract ?? null,
    date: patent.patent_date ?? null,
    type: patent.patent_type ?? null,
    inventors: (patent.inventors ?? []).map((inv) => ({
      first_name: inv.inventor_first_name ?? null,
      last_name: inv.inventor_last_name ?? null,
      city: inv.inventor_city ?? null,
      state: inv.inventor_state ?? null,
    })),
    assignee_organization: patent.assignees?.[0]?.assignee_organization ?? null,
  };
}

// --- Tool implementations ---

async function searchPatents(query: string, perPage: number) {
  const body = {
    q: { _text_any: { patent_abstract: query } },
    f: [
      'patent_number',
      'patent_title',
      'patent_date',
      'inventor_first_name',
      'inventor_last_name',
      'assignee_organization',
    ],
    o: { per_page: perPage },
  };

  const res = await fetch(`${BASE_URL}/patents/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PatentsView error: ${res.status}`);

  const data = (await res.json()) as RawPatentsResponse;
  const patents = data.patents ?? [];

  return {
    query,
    total_results: data.total_patent_count,
    returned: patents.length,
    patents: patents.map(formatPatentSummary),
  };
}

async function getPatent(number: string) {
  const body = {
    q: { patent_number: number },
    f: [
      'patent_number',
      'patent_title',
      'patent_abstract',
      'patent_date',
      'patent_type',
      'inventor_first_name',
      'inventor_last_name',
      'assignee_organization',
    ],
  };

  const res = await fetch(`${BASE_URL}/patents/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PatentsView error: ${res.status}`);

  const data = (await res.json()) as RawPatentsResponse;
  const patents = data.patents ?? [];

  if (patents.length === 0) throw new Error(`Patent not found: ${number}`);

  return formatPatentDetail(patents[0]);
}

async function searchInventors(query: string, perPage: number) {
  const body = {
    q: { _text_any: { inventor_last_name: query } },
    f: [
      'inventor_first_name',
      'inventor_last_name',
      'inventor_city',
      'inventor_state',
      'patent_number',
    ],
    o: { per_page: perPage },
  };

  const res = await fetch(`${BASE_URL}/inventors/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PatentsView error: ${res.status}`);

  const data = (await res.json()) as RawInventorsResponse;
  const inventors = data.inventors ?? [];

  return {
    query,
    total_results: data.total_inventor_count,
    returned: inventors.length,
    inventors: inventors.map((inv) => ({
      first_name: inv.inventor_first_name ?? null,
      last_name: inv.inventor_last_name ?? null,
      city: inv.inventor_city ?? null,
      state: inv.inventor_state ?? null,
      patent_numbers: (inv.patents ?? []).map((p) => p.patent_number),
    })),
  };
}

export default { tools, callTool } satisfies McpToolExport;
