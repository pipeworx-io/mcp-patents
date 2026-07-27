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
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Patents MCP — wraps the USPTO Open Data Portal (ODP) Patent File Wrapper API
 *
 * Migrated from the sunset PatentsView Legacy API (api.patentsview.org →
 * deprecated 2025-05-01) to data.uspto.gov ODP on 2026-05-12.
 *
 * Auth: X-Api-Key header. Platform key required (PLATFORM_USPTO_KEY) or
 * BYO via _apiKey.
 *
 * Tools:
 * - search_patents: keyword search across patent applications + grants
 * - get_patent:     fetch a single application/grant by application number
 * - search_inventors: search by inventor name
 */


const BASE_URL = 'https://api.uspto.gov/api/v1/patent';

// ── Raw API types ────────────────────────────────────────────────────

interface OdpInventor {
  firstName?: string;
  lastName?: string;
  middleName?: string;
  inventorNameText?: string;
}

interface OdpApplicant {
  applicantNameText?: string;
}

interface OdpApplicationMetaData {
  inventionTitle?: string;
  filingDate?: string;
  effectiveFilingDate?: string;
  applicationStatusCode?: number;
  applicationStatusDescriptionText?: string;
  applicationStatusDate?: string;
  applicationTypeCode?: string;
  applicationTypeLabelName?: string;
  firstInventorName?: string;
  firstApplicantName?: string;
  inventorBag?: OdpInventor[];
  applicantBag?: OdpApplicant[];
  class?: string;
  subclass?: string;
  uspscSymbolText?: string;
}

interface OdpEvent {
  eventCode?: string;
  eventDescriptionText?: string;
  eventDate?: string;
}

interface OdpRecord {
  applicationNumberText?: string;
  applicationMetaData?: OdpApplicationMetaData;
  eventDataBag?: OdpEvent[];
}

interface OdpSearchResponse {
  count?: number;
  patentFileWrapperDataBag?: OdpRecord[];
}

interface OdpAssignment {
  assigneeBag?: Array<{
    assigneeNameText?: string;
    assigneeAddress?: Record<string, string>;
  }>;
  assignorBag?: Array<{
    assignorName?: string;
    executionDate?: string;
  }>;
  assignmentMailedDate?: string;
  assignmentReceivedDate?: string;
  assignmentRecordedDate?: string;
  conveyanceText?: string;
  correspondenceAddress?: Record<string, string>;
  frameNumber?: number;
  reelNumber?: number;
  reelAndFrameNumber?: string;
  imageAvailableStatusCode?: boolean;
  pageTotalQuantity?: number;
}

interface OdpAssignmentResponse {
  count?: number;
  patentFileWrapperDataBag?: Array<{
    applicationNumberText?: string;
    assignmentBag?: OdpAssignment[] | OdpAssignment;
  }>;
}

// ── Auth + fetch ─────────────────────────────────────────────────────

function resolveApiKey(args: Record<string, unknown>): string {
  // Gateway auto-injects PLATFORM_USPTO_KEY as _apiKey when configured.
  // BYO users pass _apiKey directly.
  const key = (args._apiKey as string | undefined)?.trim();
  if (key) return key;
  throw new Error(
    'USPTO ODP API key required. Get one free at https://data.uspto.gov/myodp and pass via _apiKey, or contact the operator about platform credentials.',
  );
}

async function odpFetch<T = OdpSearchResponse>(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('USPTO ODP rejected the API key. Verify the key at https://data.uspto.gov/myodp');
  }
  if (res.status === 429) {
    throw new Error('USPTO ODP rate limit hit (429). Default tier is 60 req/min — back off and retry.');
  }
  // ODP answers a search that simply matched nothing with 404 "No matching
  // records found". That is an EMPTY RESULT, not a failure — throwing on it made
  // ordinary zero-hit searches look like a broken tool (30% error rate on
  // patents_search_patents, all of it this). Return an empty result set instead.
  if (res.status === 404) {
    const text = await res.text().catch(() => '');
    if (/no matching records/i.test(text)) {
      return { count: 0, patentFileWrapperDataBag: [] } as unknown as T;
    }
    throw new Error(`USPTO ODP error 404${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`USPTO ODP error ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.json() as Promise<T>;
}

// ── Formatters ───────────────────────────────────────────────────────

function formatInventor(inv: OdpInventor): { name: string; first?: string; last?: string } {
  const name = inv.inventorNameText
    ?? [inv.firstName, inv.middleName, inv.lastName].filter(Boolean).join(' ')
    ?? '';
  return { name, first: inv.firstName, last: inv.lastName };
}

function formatRecord(r: OdpRecord) {
  const meta = r.applicationMetaData ?? {};
  // Find a grant event (broadly: anything containing "issued" / "grant" in description)
  const grantEvent = r.eventDataBag?.find((e) =>
    /(issued|granted|patent.*number)/i.test(e.eventDescriptionText ?? ''),
  );
  return {
    application_number: r.applicationNumberText ?? null,
    title: meta.inventionTitle ?? null,
    filing_date: meta.filingDate ?? null,
    effective_filing_date: meta.effectiveFilingDate ?? null,
    status: meta.applicationStatusDescriptionText ?? null,
    status_date: meta.applicationStatusDate ?? null,
    type: meta.applicationTypeLabelName ?? meta.applicationTypeCode ?? null,
    inventors: (meta.inventorBag ?? []).slice(0, 10).map(formatInventor),
    first_inventor: meta.firstInventorName ?? null,
    first_applicant: meta.firstApplicantName ?? null,
    applicants: (meta.applicantBag ?? []).map((a) => a.applicantNameText ?? null).filter(Boolean),
    classification: meta.class && meta.subclass ? `${meta.class}/${meta.subclass}` : (meta.class ?? null),
    grant_event: grantEvent
      ? { description: grantEvent.eventDescriptionText, date: grantEvent.eventDate }
      : null,
  };
}

// Compact summary for entity_profile-style "recent patents by assignee" use.
// Returns the bare minimum that matches the prior PatentsView contract so
// downstream code keeps working without changes.
function formatBackcompatSummary(r: OdpRecord) {
  const meta = r.applicationMetaData ?? {};
  return {
    // The old patent_number field is now application number — closest stable
    // identifier in ODP. Callers wanting an actual granted-patent number need
    // to inspect grant_event or call get_patent.
    patent_number: r.applicationNumberText ?? null,
    title: meta.inventionTitle ?? null,
    grant_date: meta.applicationStatusDate ?? meta.filingDate ?? null,
    filing_date: meta.filingDate ?? null,
    first_inventor: meta.firstInventorName ?? null,
  };
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_patents',
    description:
      'Search USPTO patent applications and grants. Use `query` for free-text keywords ("lithium battery", "crispr"). Optional structured filters: `applicant` (company name — use ALL CAPS like "APPLE INC." for best match), `filed_after` / `filed_before` (filing date range), `granted_after` / `granted_before` (grant date range). Results include title, application number, filing date, first applicant, all applicants, inventors, status, classification. Note: ODP filtering is approximate (weighted match, not strict equality) — counts and ordering are best-effort. Powered by the USPTO Open Data Portal (data.uspto.gov).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text search across title/abstract/inventor/etc. Examples: "lithium battery", "crispr", "neural network". Pass "*" if you only want to filter by applicant/date with no keyword constraint.',
        },
        applicant: {
          type: 'string',
          description: 'Optional. Company applicant name as it appears on the USPTO filing. **Must include the exact corporate suffix** the company uses (PBC / Inc. / LLC / Corporation / Co. / NV / AG / KK). Wrong suffix = ODP silently returns the whole unfiltered pool, not zero. Examples: "Anthropic, PBC" (not "Anthropic Inc."), "Apple Inc." (not "Apple"), "Alphabet Inc." (not "Google"), "Meta Platforms, Inc." (not "Facebook"), "Microsoft Corporation" (not "Microsoft Corp."). If you get a `warning` field back, the filter missed — retry with a different corporate form.',
        },
        filed_after: {
          type: 'string',
          description: 'Optional. Filter to patents filed on/after this date (ISO YYYY-MM-DD).',
        },
        filed_before: {
          type: 'string',
          description: 'Optional. Filter to patents filed on/before this date (ISO YYYY-MM-DD).',
        },
        granted_after: {
          type: 'string',
          description: 'Optional. Filter to patents granted on/after this date (ISO YYYY-MM-DD).',
        },
        granted_before: {
          type: 'string',
          description: 'Optional. Filter to patents granted on/before this date (ISO YYYY-MM-DD).',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1–100, default 10).',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp. Falls back to platform key if configured.',
        },
      },
    },
  },
  {
    name: 'get_patent',
    description:
      'Fetch a single USPTO patent application/grant by application number (e.g., "16/123,456" or "16123456"). Returns full metadata: title, inventors, classifications, status, prosecution events.',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'Application number (digits only or with slashes). Examples: "16123456", "16/123,456".',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.',
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'search_inventors',
    description:
      'Search USPTO patent applications by inventor last name. Returns matching applications with title, inventor list, and filing date.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Inventor last name to search for (case-insensitive). Examples: "Hinton", "Bengio".',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1–100, default 10).',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_patent_assignments',
    description:
      'Retrieve USPTO-recorded assignment/conveyance history for one patent application from the migrated Open Data Portal endpoint. Returns assignors, assignees, execution/recording dates, conveyance text, and reel/frame. A recorded assignment is notice of a submitted instrument—not a legal opinion on present title, validity, scope, liens, or chain-of-title completeness.',
    inputSchema: {
      type: 'object',
      properties: {
        application_number: {
          type: 'string',
          description: 'US patent application number, digits only or formatted, e.g. "15/000,001".',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.',
        },
      },
      required: ['application_number'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        application_number: { type: 'string' },
        count: { type: 'number' },
        assignments: { type: 'array', items: { type: 'object' } },
        interpretation: { type: 'string' },
        source: { type: 'string' },
      },
      required: ['application_number', 'count', 'assignments', 'interpretation', 'source'],
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────

async function searchPatents(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const limit = Math.min(100, Math.max(1, (args.limit as number | undefined) ?? 10));

  // ODP's `q` param accepts a Solr-style expression with `field=value AND ...`.
  // Field-prefix `field:value` (colon) returns 404; `field=value` works but is
  // approximate (weighted match) not strict equality. Compose the filter
  // clauses here so callers can pass clean structured args.
  const parts: string[] = [];
  if (typeof args.query === 'string' && args.query.trim() && args.query.trim() !== '*') {
    parts.push(args.query.trim());
  }
  if (typeof args.applicant === 'string' && args.applicant.trim()) {
    parts.push(`firstApplicantName=${args.applicant.trim()}`);
  }
  if (typeof args.filed_after === 'string' && args.filed_after.trim()) {
    parts.push(`filingDate>=${args.filed_after.trim()}`);
  }
  if (typeof args.filed_before === 'string' && args.filed_before.trim()) {
    parts.push(`filingDate<=${args.filed_before.trim()}`);
  }
  if (typeof args.granted_after === 'string' && args.granted_after.trim()) {
    parts.push(`grantedDate>=${args.granted_after.trim()}`);
  }
  if (typeof args.granted_before === 'string' && args.granted_before.trim()) {
    parts.push(`grantedDate<=${args.granted_before.trim()}`);
  }
  if (parts.length === 0) {
    throw new Error('Pass at least one of: query, applicant, filed_after/before, granted_after/before.');
  }
  const composedQ = parts.join(' AND ');

  const data = await odpFetch(apiKey, '/applications/search', {
    q: composedQ,
    size: String(limit),
  });

  const records = data.patentFileWrapperDataBag ?? [];
  const total = data.count ?? records.length;

  // ODP gotcha: when a structured filter (applicant, date range) doesn't
  // match anything, ODP silently returns the entire matching pool from the
  // remaining clauses, not zero. An "ANTHROPIC INC." applicant filter that
  // doesn't match (real name is "Anthropic, PBC") returns ~40k unrelated
  // patents. Catch the "filter missed" case so callers don't ship a
  // confidently-wrong answer to the user.
  const hasStructuredFilter = !!(args.applicant);
  const requestedApplicant =
    typeof args.applicant === 'string' ? args.applicant.trim().toUpperCase() : null;
  let appliedApplicantMatches = 0;
  if (requestedApplicant) {
    for (const rec of records) {
      const first = (rec.applicationMetaData?.firstApplicantName ?? '').toUpperCase();
      if (first.includes(requestedApplicant) || requestedApplicant.includes(first)) {
        appliedApplicantMatches++;
      }
    }
  }
  // Fire on LOW match-rate, not just zero. ODP's fuzzy fallback returns the
  // whole pool (e.g. 281,973 for "NVIDIA CORP" vs USPTO's "NVIDIA Corporation")
  // in which a few records still contain the term — appliedApplicantMatches > 0
  // but the result set is mostly unrelated. Treat <50% applicant match on a
  // huge pool as a miss so we never ship a confidently-wrong count + random
  // patents.
  const applicantMatchRate = records.length > 0 ? appliedApplicantMatches / records.length : 0;
  const filterLikelyMissed =
    hasStructuredFilter &&
    total > 5000 &&
    records.length > 0 &&
    requestedApplicant != null &&
    applicantMatchRate < 0.5;

  return {
    query: composedQ,
    filters: {
      applicant: args.applicant ?? null,
      filed_after: args.filed_after ?? null,
      filed_before: args.filed_before ?? null,
      granted_after: args.granted_after ?? null,
      granted_before: args.granted_before ?? null,
    },
    total,
    returned: records.length,
    ...(filterLikelyMissed
      ? {
          warning: `applicant filter "${args.applicant}" did not match — ODP returned ${total} unrelated results. ODP fuzzy-matches firstApplicantName, so when no record matches the exact corporate form, it falls back to the unfiltered pool. Try the exact corporate suffix (e.g., "ANTHROPIC PBC" not "ANTHROPIC INC."; "ALPHABET INC." not "GOOGLE"; "META PLATFORMS INC." not "FACEBOOK").`,
          results: [],
          patents: [],
        }
      : {
          // Dual-shape response: 'results' uses the back-compat shape so callers
          // (entity_profile, recent_changes) keep working; 'patents' is the same
          // data with full ODP fields for callers that want them.
          results: records.map(formatBackcompatSummary),
          patents: records.map(formatRecord),
        }),
  };
}

async function getPatent(args: Record<string, unknown>) {
  if (typeof args.number !== 'string' || !args.number.trim()) {
    throw new Error('Required argument "number" is missing or empty. Pass an application number like "16123456" or "16/123,456".');
  }
  const apiKey = resolveApiKey(args);
  // Normalize: strip slashes and commas
  const clean = args.number.replace(/[/, ]/g, '');

  const data = await odpFetch(apiKey, '/applications/search', {
    q: `applicationNumberText:${clean}`,
    size: '1',
  });

  const record = data.patentFileWrapperDataBag?.[0];
  if (!record) {
    return {
      found: false,
      application_number: args.number,
      hint: 'No patent application found for that number. Confirm the format (digits only, e.g. "16123456").',
    };
  }
  return { found: true, ...formatRecord(record) };
}

async function searchInventors(args: Record<string, unknown>) {
  if (typeof args.query !== 'string' || !args.query.trim()) {
    throw new Error('Required argument "query" is missing or empty. Pass an inventor last name like "Hinton".');
  }
  const apiKey = resolveApiKey(args);
  const limit = Math.min(100, Math.max(1, (args.limit as number | undefined) ?? 10));

  const data = await odpFetch(apiKey, '/applications/search', {
    q: `firstInventorName:${args.query}`,
    size: String(limit),
  });

  const records = data.patentFileWrapperDataBag ?? [];
  return {
    query: args.query,
    total: data.count ?? records.length,
    returned: records.length,
    results: records.map((r) => {
      const meta = r.applicationMetaData ?? {};
      return {
        application_number: r.applicationNumberText ?? null,
        title: meta.inventionTitle ?? null,
        first_inventor: meta.firstInventorName ?? null,
        inventors: (meta.inventorBag ?? []).slice(0, 5).map(formatInventor),
        filing_date: meta.filingDate ?? null,
        status: meta.applicationStatusDescriptionText ?? null,
      };
    }),
  };
}

async function getPatentAssignments(args: Record<string, unknown>) {
  if (typeof args.application_number !== 'string' || !args.application_number.trim()) {
    throw new Error('Required argument "application_number" is missing or empty.');
  }
  const applicationNumber = args.application_number.replace(/\D/g, '');
  if (applicationNumber.length < 6 || applicationNumber.length > 12) {
    throw new Error('application_number must contain 6-12 digits.');
  }
  const apiKey = resolveApiKey(args);
  const data = await odpFetch<OdpAssignmentResponse>(
    apiKey,
    `/applications/${applicationNumber}/assignment`,
    {},
  );
  const record = data.patentFileWrapperDataBag?.[0];
  const raw = record?.assignmentBag;
  const assignments = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((assignment) => ({
    reel_frame: assignment.reelAndFrameNumber ?? (
      assignment.reelNumber != null && assignment.frameNumber != null
        ? `${assignment.reelNumber}/${assignment.frameNumber}`
        : null
    ),
    conveyance: assignment.conveyanceText ?? null,
    executed_dates: [...new Set((assignment.assignorBag ?? [])
      .map((assignor) => assignor.executionDate).filter(Boolean))],
    recorded_date: assignment.assignmentRecordedDate ?? null,
    received_date: assignment.assignmentReceivedDate ?? null,
    mailed_date: assignment.assignmentMailedDate ?? null,
    assignors: (assignment.assignorBag ?? []).slice(0, 100).map((assignor) => ({
      name: assignor.assignorName ?? null,
      execution_date: assignor.executionDate ?? null,
    })),
    assignees: (assignment.assigneeBag ?? []).slice(0, 100).map((assignee) => ({
      name: assignee.assigneeNameText ?? null,
      address: assignee.assigneeAddress ?? null,
    })),
    correspondent: assignment.correspondenceAddress ?? null,
    pages: assignment.pageTotalQuantity ?? null,
    image_available: assignment.imageAvailableStatusCode ?? null,
  }));
  return {
    application_number: record?.applicationNumberText ?? applicationNumber,
    count: assignments.length,
    assignments,
    interpretation:
      'USPTO assignment records provide public notice of submitted conveyance instruments. They do not establish current legal title, patent validity or scope, undisclosed interests, lien priority, or a complete chain of title; inspect the recorded document and obtain legal advice for diligence.',
    source: 'USPTO Open Data Portal Patent File Wrapper assignment endpoint',
  };
}

// ── callTool router ──────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_patents':
      return searchPatents(args);
    case 'get_patent':
      return getPatent(args);
    case 'search_inventors':
      return searchInventors(args);
    case 'get_patent_assignments':
      return getPatentAssignments(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
