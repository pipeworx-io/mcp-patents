interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
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
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
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
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

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
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
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
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
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
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Patents');
}


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

  const res = await pwFetch(url.toString(), {
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

/**
 * Argument synonyms.
 *
 * An agent reaches for the word its question used — "assignee" for a company,
 * "keywords" for text, "inventor" for a person — and a tool that only answers to
 * one spelling of each turns a well-formed question into an error. Every name
 * here maps onto a field ODP actually supports; the canonical name is first.
 */
const ALIASES = {
  query: ['query', 'q', 'keywords', 'keyword', 'text', 'search', 'search_term', 'terms', 'term', 'topic', 'subject', 'description'],
  title: ['title', 'invention_title', 'patent_title'],
  applicant: ['applicant', 'assignee', 'company', 'organization', 'organisation', 'org', 'owner', 'applicant_name', 'assignee_name', 'company_name', 'firm', 'corporation'],
  inventor: ['inventor', 'inventor_name', 'inventor_last_name', 'author', 'person'],
  number: ['number', 'patent_number', 'application_number', 'publication_number', 'appl_id'],
  filed_after: ['filed_after', 'filed_from', 'filing_date_from', 'filed_since', 'from_date', 'start_date', 'date_from'],
  filed_before: ['filed_before', 'filed_to', 'filing_date_to', 'filed_until', 'to_date', 'end_date', 'date_to'],
  granted_after: ['granted_after', 'granted_from', 'grant_date_from', 'granted_since', 'issued_after'],
  granted_before: ['granted_before', 'granted_to', 'grant_date_to', 'granted_until', 'issued_before'],
} as const;

/** First alias present as a non-empty string, trimmed. */
function pickArg(args: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const v = args[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
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
      'Search USPTO patent applications and grants — **without a `granted_after`/`granted_before` bound this returns the APPLICATION corpus sorted newest-FILED-first, not issued patents.** USPTO publishes an application ~18 months after filing and typically takes 2+ years to grant it, so the newest rows in an unfiltered search are always recent, unexamined filings with `grant_date: null` — that is expected, not stale data. If the caller wants "latest patents" meaning issued/granted patents, pass `granted_after` (e.g. "2024-01-01") — it filters to issued patents and every returned row carries a real `grant_date`. Use `query` for free-text keywords ("lithium battery", "crispr", "machine learning"); all terms are required (AND), and you can quote a phrase to keep it together. Optional structured filters: `applicant` (exact corporate name as filed, e.g. "APPLE INC."), `inventor` (person name), `title` (words in the invention title), `number` (a specific application number), `filed_after` / `filed_before`, `granted_after` / `granted_before`. Common synonyms are understood — `assignee`, `company` and `owner` all reach `applicant`, and `keywords`, `q` or `text` all reach `query`. Results include title, application number, filing date, first applicant, all applicants, inventors, status, classification. `total` is the full match count but USPTO returns at most 25 records per search — narrow with applicant or a date range rather than raising `limit`. Powered by the USPTO Open Data Portal (data.uspto.gov).',
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
        inventor: {
          type: 'string',
          description: 'Optional. Inventor name as recorded on the filing; a last name matches most reliably. Examples: "Hinton", "Bengio". Accepted synonyms: `inventor_name`, `author`.',
        },
        title: {
          type: 'string',
          description: 'Optional. Words that must appear in the invention title, which narrows far harder than `query` does since `query` searches the whole record. Example: "solid state battery".',
        },
        number: {
          type: 'string',
          description: 'Optional. A specific US application number, digits only or formatted — "16123456" or "16/123,456". Accepted synonyms: `application_number`, `patent_number`.',
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
          description: 'Optional. Filter to patents GRANTED (issued) on/after this date (ISO YYYY-MM-DD). This is the argument that answers "recent/latest patents" — without it, results are unexamined applications, not issued patents. Accepted synonym: `issued_after`.',
        },
        granted_before: {
          type: 'string',
          description: 'Optional. Filter to patents GRANTED (issued) on/before this date (ISO YYYY-MM-DD). Accepted synonym: `issued_before`.',
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
      'Fetch a single USPTO patent application/grant by application number (e.g., "16/123,456" or "16123456"). Returns full metadata: title, inventors, classifications, status, prosecution events. A returned record with no grant event and no grant date is not stale — it means that specific application has not yet been examined/granted; check `status` and `grant_event` rather than assuming the record is out of date.',
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
      'Search USPTO patent applications by inventor last name. Returns matching applications with title, inventor list, and filing date — sorted newest-filed-first, so this is the APPLICATION corpus (same as search_patents with no `granted_after`), and the newest rows will be unexamined filings with no grant date by construction (USPTO publishes ~18 months after filing). That is expected, not stale data. For a specific inventor\'s ISSUED patents, use search_patents with `inventor` + `granted_after` instead.',
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
  const query = pickArg(args, ALIASES.query);
  const applicant = pickArg(args, ALIASES.applicant);
  const inventor = pickArg(args, ALIASES.inventor);
  const title = pickArg(args, ALIASES.title);
  const number = pickArg(args, ALIASES.number);

  const parts: string[] = [];
  if (query && query !== '*') parts.push(...composeFreeText(query));
  if (title) parts.push(`${FIELD_TITLE}:"${title.replace(/"/g, '')}"`);
  if (applicant) parts.push(`${FIELD_APPLICANT}:"${applicant.replace(/"/g, '')}"`);
  if (inventor) parts.push(`${FIELD_INVENTOR}:"${inventor.replace(/"/g, '')}"`);
  if (number) parts.push(`applicationNumberText:${number.replace(/\D/g, '')}`);
  const filedRange = dateRange(FIELD_FILED, pickArg(args, ALIASES.filed_after), pickArg(args, ALIASES.filed_before));
  if (filedRange) parts.push(filedRange);
  const grantedRange = dateRange(FIELD_GRANTED, pickArg(args, ALIASES.granted_after), pickArg(args, ALIASES.granted_before));
  if (grantedRange) parts.push(grantedRange);

  if (parts.length === 0) {
    // This threw for 82 calls in 4 days, every one of them the same sentence,
    // which means callers were not arriving empty-handed — they were arriving
    // with `assignee`, `inventor`, `keywords` and other reasonable synonyms this
    // tool did not read. The aliases above absorb those; what is left is a call
    // with genuinely nothing to search on, and naming the arguments we did
    // receive lets the caller fix it in one step instead of guessing.
    const supplied = Object.keys(args).filter((k) => !k.startsWith('_'));
    return {
      found: false,
      reason: 'no_search_criteria',
      message: 'No searchable criteria were supplied, so there is nothing to match against.',
      arguments_received: supplied,
      accepted_arguments: ['query', 'title', 'applicant', 'inventor', 'number', 'filed_after', 'filed_before', 'granted_after', 'granted_before'],
      hint: 'Pass free-text keywords as `query` (e.g. {"query": "lithium battery"}), a company as `applicant` in its exact filed form (e.g. "APPLE INC."), or a person as `inventor`.',
    };
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
  const emptyWithFilter = total === 0 && !!applicant;
  // Did the caller actually ask for GRANTED patents? Only a granted_* bound
  // filters ODP down to issued patents; everything else returns the application
  // corpus. Drives record_type and the noun in `note` below.
  const grantFiltered =
    !!pickArg(args, ALIASES.granted_after) || !!pickArg(args, ALIASES.granted_before);

  return {
    query: composedQ,
    filters: {
      applicant: applicant ?? null,
      inventor: inventor ?? null,
      title: title ?? null,
      filed_after: pickArg(args, ALIASES.filed_after),
      filed_before: pickArg(args, ALIASES.filed_before),
      granted_after: pickArg(args, ALIASES.granted_after),
      granted_before: pickArg(args, ALIASES.granted_before),
    },

    total,
    returned: records.length,
    // WHAT THESE RECORDS ARE, stated because the tool is called `search_patents`
    // and "patent" reads as "granted patent" to every caller who asks what a
    // company has been GRANTED. ODP is an APPLICATION corpus sorted newest-filed
    // first, so an unfiltered search answers a grants question with ten recent
    // unexamined applications and a large total — a real-looking number that is
    // not the answer. Measured 2026-09-03 (fleet #1216): `{query:"Palantir"}`
    // returned total 2,640 with grant_date null on 10 of 10 rows, while the same
    // query with `granted_after` returned 1,213 with a grant_date on 10 of 10.
    // The grants are there; the default just does not show them.
    record_type: grantFiltered ? 'granted patents' : 'applications (granted and pending)',
    ...(grantFiltered
      ? {}
      : {
          grants_hint:
            'These are APPLICATIONS, newest-filed first, so recent rows are typically ungranted (grant_date null). ' +
            'For patents actually GRANTED, pass granted_after (e.g. granted_after: "2020-01-01") — that filters to issued patents and every row carries a grant_date.',
        }),
    ...(total > all.length
      ? {
          // ODP caps every page at 25 and ignores the page-size parameter, so
          // say what the caller actually got rather than letting `total` read
          // as the number of rows below it.
          // The noun tracks the filter: calling 1,213 granted patents
          // "applications" is the same wrong answer in the note that the rows
          // above were already giving.
          note: `ODP returns at most 25 records per search regardless of \`limit\`; ${total} ${grantFiltered ? 'granted patents' : 'applications'} match. Narrow with applicant or a date range to see a different slice.`,
        }
      : {}),
    ...(emptyWithFilter
      ? {
          warning: `No applications matched applicant "${applicant}". ODP matches the corporate name literally, so the exact form on the filing is required — "APPLE INC." matches where "Apple" returns nothing. Try the registered suffix (PBC / Inc. / LLC / Corporation), e.g. "ANTHROPIC PBC" not "ANTHROPIC INC.", "ALPHABET INC." not "GOOGLE".`,
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

// Exported for tests — the alias table is the whole of the fix for callers
// arriving with `assignee` or `keywords`, so it is worth pinning.
export { ALIASES, pickArg };
