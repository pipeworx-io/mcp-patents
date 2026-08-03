interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */
const MAX_DETAIL = 300;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(`${name}: ${res.status}${detailSuffix(await readDetail(res))}`);
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  return `${name}: ${res.status}${detailSuffix(await readDetail(res))}`;
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an HTML page instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. First 120 chars: ${collapse(raw).slice(0, 120)}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `First 120 chars: ${collapse(raw).slice(0, 120)}`,
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  if (!raw) return '';

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) carries no API-level explanation, only markup that would crowd out
  // the status. Recognising it is worth more than stripping it: dropping it
  // keeps the message honest instead of filling it with `<!DOCTYPE html><html>`.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')) return '';

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return collapse(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
  grantDate?: string;
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
  return parseJson<T>(res, 'USPTO ODP');
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
    // grant_date used to fall back to applicationStatusDate and then to
    // filingDate, which meant an application that was never granted still
    // reported one — and since applicationStatusDate moves with ANY status
    // change, results routinely showed a grant date years BEFORE the filing
    // date. ODP does carry a real grantDate; an ungranted application simply
    // has none, and null is the honest answer for those.
    grant_date: meta.grantDate ?? null,
    filing_date: meta.filingDate ?? null,
    first_inventor: meta.firstInventorName ?? null,
  };
}

// ODP's query language, established by probing 2026-08-01 — none of this is in
// their docs and all of it fails silently, so it is written down here.
//
//  - Whitespace between terms is OR, not AND. A bare "machine learning neural
//    networks" matches any patent containing "machine", which is how a search
//    for ML returned espresso machines and refrigeration compressors.
//  - `AND` (uppercase) is honoured, as are "quoted phrases".
//  - `field=value` and `field>=value` are NOT query syntax. They are silently
//    treated as free text, so every structured filter this pack shipped was a
//    no-op that also polluted the keyword match.
//  - Field scoping is `path:value` and the path must be FULL and dotted:
//    `inventionTitle:x` returns 0, `applicationMetaData.inventionTitle:x` works.
//  - An unknown field name returns 0 with no error. Silent zero is the failure
//    mode to watch for whenever these paths are edited.
//  - Ranges are Lucene-style `[start TO end]`, and `*` is a valid open end.
const FIELD_TITLE = 'applicationMetaData.inventionTitle';
const FIELD_APPLICANT = 'applicationMetaData.firstApplicantName';
const FIELD_INVENTOR = 'applicationMetaData.firstInventorName';
const FIELD_FILED = 'applicationMetaData.filingDate';
const FIELD_GRANTED = 'applicationMetaData.grantDate';

/**
 * Turn free text into an AND of terms, keeping any "quoted phrase" the caller
 * wrote as a single unit. Bare terms beat phrasing the whole string as a
 * default: "machine learning neural networks" AND-ed gives 274 on-topic hits,
 * whereas requiring the exact 4-word phrase gives 104 and drops the rest.
 */
function composeFreeText(raw: string): string[] {
  const clauses: string[] = [];
  const rest = raw.replace(/"([^"]+)"/g, (_m, phrase: string) => {
    const p = String(phrase).trim();
    if (p) clauses.push(`"${p}"`);
    return ' ';
  });
  for (const term of rest.split(/\s+/)) {
    const t = term.trim();
    // Drop bare boolean operators the caller may have typed themselves — we
    // are supplying the AND, and a stray "and" would otherwise be searched for.
    if (!t || /^(and|or|not)$/i.test(t)) continue;
    clauses.push(/[":[\]]/.test(t) ? t : `"${t}"`);
  }
  return clauses;
}

/** Lucene range with `*` for an open end; null when neither bound is given. */
function dateRange(field: string, after?: unknown, before?: unknown): string | null {
  const a = typeof after === 'string' && after.trim() ? after.trim() : null;
  const b = typeof before === 'string' && before.trim() ? before.trim() : null;
  if (!a && !b) return null;
  return `${field}:[${a ?? '*'} TO ${b ?? '*'}]`;
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_patents',
    description:
      'Search USPTO patent applications and grants. Use `query` for free-text keywords ("lithium battery", "crispr", "machine learning"); all terms are required (AND), and you can quote a phrase to keep it together. Optional structured filters: `applicant` (exact corporate name as filed, e.g. "APPLE INC."), `filed_after` / `filed_before`, `granted_after` / `granted_before`. Results include title, application number, filing date, first applicant, all applicants, inventors, status, classification. `total` is the full match count but USPTO returns at most 25 records per search — narrow with applicant or a date range rather than raising `limit`. Powered by the USPTO Open Data Portal (data.uspto.gov).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text keywords. Every term must appear (they are AND-ed), so add words to narrow and remove words to widen. Wrap words in double quotes to require them adjacent: `"machine learning" model` needs the exact phrase plus the word model. Examples: "lithium battery", "crispr", "neural network". Pass "*" if you only want to filter by applicant/date with no keyword constraint.',
        },
        applicant: {
          type: 'string',
          description: 'Optional. Company applicant name as it appears on the USPTO filing. **Must include the exact corporate suffix** the company uses (PBC / Inc. / LLC / Corporation / Co. / NV / AG / KK). A wrong or missing suffix matches nothing — "Apple" returns zero where "APPLE INC." returns hundreds. Examples: "Anthropic, PBC" (not "Anthropic Inc."), "Apple Inc." (not "Apple"), "Alphabet Inc." (not "Google"), "Meta Platforms, Inc." (not "Facebook"), "Microsoft Corporation" (not "Microsoft Corp."). If you get zero results plus a `warning` field, the name form is wrong rather than the company being absent — retry with a different corporate form.',
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
          description: 'Number of results to return (default 10). USPTO caps every search at 25 records, so values above 25 have no effect — use the filters to narrow instead.',
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
          description: 'Number of results to return (default 10). USPTO caps every search at 25 records, so values above 25 have no effect — use the filters to narrow instead.',
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

  // See the FIELD_* block above for the query language. Everything here was
  // previously written in a syntax ODP does not implement: the filters were
  // silently ignored AND their text leaked into the keyword match, so
  // `filed_before: 2024-12-31` cheerfully returned patents filed in 2025.
  const parts: string[] = [];
  if (typeof args.query === 'string' && args.query.trim() && args.query.trim() !== '*') {
    parts.push(...composeFreeText(args.query));
  }
  if (typeof args.applicant === 'string' && args.applicant.trim()) {
    parts.push(`${FIELD_APPLICANT}:"${args.applicant.trim().replace(/"/g, '')}"`);
  }
  const filedRange = dateRange(FIELD_FILED, args.filed_after, args.filed_before);
  if (filedRange) parts.push(filedRange);
  const grantedRange = dateRange(FIELD_GRANTED, args.granted_after, args.granted_before);
  if (grantedRange) parts.push(grantedRange);
  if (parts.length === 0) {
    throw new Error('Pass at least one of: query, applicant, filed_after/before, granted_after/before.');
  }
  const composedQ = parts.join(' AND ');

  // `size` is not ODP's page-size parameter — it is ignored, and every search
  // returns exactly 25 whatever we ask for. Send it anyway in case they honour
  // it later, but enforce the caller's limit on our side rather than handing
  // back 25 rows to someone who asked for 3.
  const data = await odpFetch(apiKey, '/applications/search', {
    q: composedQ,
    size: String(limit),
  });

  const all = data.patentFileWrapperDataBag ?? [];
  const total = data.count ?? all.length;
  const records = all.slice(0, limit);

  // The old "filter likely missed" heuristic is gone with the syntax that made
  // it necessary. It guessed at a fallback-to-whole-pool that was never ODP
  // fuzzy-matching in the first place — it was our `firstApplicantName=` clause
  // being read as free text, so the applicant name simply became more keywords
  // and the filter never applied. With real field scoping a name that does not
  // exist returns 0 rather than 300k unrelated patents.
  //
  // That flips the failure mode, so the guidance has to flip with it: the thing
  // to explain now is an empty result, not a suspiciously large one. ODP matches
  // the corporate form literally, so "Apple" finds nothing where "APPLE INC."
  // finds 207.
  const emptyWithFilter = total === 0 && !!args.applicant;

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
    ...(total > all.length
      ? {
          // ODP caps every page at 25 and ignores the page-size parameter, so
          // say what the caller actually got rather than letting `total` read
          // as the number of rows below it.
          note: `ODP returns at most 25 records per search regardless of \`limit\`; ${total} applications match. Narrow with applicant or a date range to see a different slice.`,
        }
      : {}),
    ...(emptyWithFilter
      ? {
          warning: `No applications matched applicant "${args.applicant}". ODP matches the corporate name literally, so the exact form on the filing is required — "APPLE INC." matches where "Apple" returns nothing. Try the registered suffix (PBC / Inc. / LLC / Corporation), e.g. "ANTHROPIC PBC" not "ANTHROPIC INC.", "ALPHABET INC." not "GOOGLE".`,
        }
      : {}),
    // Dual-shape response: 'results' uses the back-compat shape so callers
    // (entity_profile, recent_changes) keep working; 'patents' is the same
    // data with full ODP fields for callers that want them.
    results: records.map(formatBackcompatSummary),
    patents: records.map(formatRecord),
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

  // This tool returned zero for every inventor who has ever existed. The field
  // path was bare `firstInventorName:`, and ODP answers an unknown field with an
  // empty result set rather than an error — so "no patents by Hinton" looked
  // like a fact about Hinton instead of a bug in us. The path must be dotted.
  const data = await odpFetch(apiKey, '/applications/search', {
    q: `${FIELD_INVENTOR}:"${args.query.trim().replace(/"/g, '')}"`,
    size: String(limit),
  });

  const all = data.patentFileWrapperDataBag ?? [];
  const records = all.slice(0, limit);
  return {
    query: args.query,
    total: data.count ?? all.length,
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
