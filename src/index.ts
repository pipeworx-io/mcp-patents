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
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
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
 * - get_patent:     fetch a single application/grant by application number or patent number
 * - search_inventors: search by inventor name
 * - get_patent_assignments: per-application assignment history (ODP)
 * - get_patent_transactions: full prosecution/transaction event history (ODP)
 * - get_patent_continuity: parent/child continuity chain (ODP)
 * - search_patent_assignments: assignment search by assignee/assignor/patent/application number
 *   (USPTO Assignment Search — a separate, keyless public host, not ODP)
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
  patentNumber?: string;
  earliestPublicationNumber?: string;
  earliestPublicationDate?: string;
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

interface OdpTransactionsResponse {
  count?: number;
  patentFileWrapperDataBag?: Array<{
    applicationNumberText?: string;
    eventDataBag?: OdpEvent[];
  }>;
}

interface OdpParentContinuity {
  childApplicationNumberText?: string;
  claimParentageTypeCode?: string;
  claimParentageTypeCodeDescriptionText?: string;
  parentApplicationFilingDate?: string;
  parentApplicationNumberText?: string;
  parentApplicationStatusCode?: number;
  parentApplicationStatusDescriptionText?: string;
  parentPatentNumber?: string;
}

interface OdpChildContinuity {
  childApplicationFilingDate?: string;
  childApplicationNumberText?: string;
  childApplicationStatusCode?: number;
  childApplicationStatusDescriptionText?: string;
  childPatentNumber?: string;
  claimParentageTypeCode?: string;
  claimParentageTypeCodeDescriptionText?: string;
  parentApplicationNumberText?: string;
}

interface OdpContinuityResponse {
  count?: number;
  patentFileWrapperDataBag?: Array<{
    applicationNumberText?: string;
    parentContinuityBag?: OdpParentContinuity[];
    childContinuityBag?: OdpChildContinuity[];
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

// fleet #3301: this used to guess a "grant event" by scanning eventDataBag for
// any description matching /issued|granted|patent.*number/i — which also
// matches "Request for Extension of Time - Granted" (any routine USPTO
// extension-of-time approval contains the word "Granted") and that event
// routinely sorts first, so a caller asking "what's the patent number for
// application 18926509" got told the application's status was "Patented
// Case" (true) alongside a misattributed extension-of-time date and NO
// patent number at all — a 200 that reads as an answer but isn't one.
// applicationMetaData carries patentNumber / grantDate / the earliest
// publication directly for a granted case; read those instead of guessing
// from prosecution event text.
function formatRecord(r: OdpRecord) {
  const meta = r.applicationMetaData ?? {};
  const isPatented = meta.applicationStatusDescriptionText === 'Patented Case';
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
    // The actual granted-patent identifiers, read straight off applicationMetaData
    // rather than inferred from prosecution-history text.
    patent_number: meta.patentNumber ?? null,
    grant_date: meta.grantDate ?? null,
    publication_number: meta.earliestPublicationNumber ?? null,
    publication_date: meta.earliestPublicationDate ?? null,
    // Loud rather than silent: a "Patented Case" with no patentNumber means
    // ODP itself omitted the field for this record — say so instead of
    // quietly returning null the same way a never-granted application would.
    ...(isPatented && !meta.patentNumber
      ? {
          patent_number_warning:
            'Status is "Patented Case" but USPTO ODP did not include a patentNumber field for this application. This is an upstream data gap, not an unexamined application — do not treat the missing number as "not yet granted".',
        }
      : {}),
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
    // Added fleet #2446: "who has filed patents on X" was answered with the
    // first INVENTOR (a person) because that was the only name in this
    // back-compat shape — even though `patents[].applicants` already carried
    // the filing organisation. `results` is listed first in the response and
    // is the shape entity_profile/recent_changes already consume, so the
    // organisation needs to be visible here too, not only in the fuller
    // `patents` array below.
    first_applicant: meta.firstApplicantName ?? null,
    applicants: (meta.applicantBag ?? []).map((a) => a.applicantNameText ?? null).filter(Boolean),
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
const FIELD_PATENT_NUMBER = 'applicationMetaData.patentNumber';

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
 * Known synonym / abbreviation groups for concepts whose patent-filing
 * wording varies by author (fleet #2450/#2499 — "Who has filed US patents on
 * detecting residual cancer using cell-free RNA in the last three years?"
 * measured unstable, 2 Strong/3 Weak of 5 router runs, because the class of
 * fix in #2418 — OR-ing an AND-of-phrases on a genuine zero — only fires when
 * the caller happens to QUOTE two or more phrases. Measured live 2026-09-29:
 * {query: 'cfRNA "residual cancer"'} -> composed as `"residual cancer" AND
 * "cfRNA"` -> 0 results, no broadening (only 1 QUOTED phrase in the raw
 * query, so the #2418 gate never sees a second one to OR against) — even
 * though the same two concepts phrased as {query: '"residual cancer"
 * "cell-free RNA"'} finds 23 real hits (Cornell, Stanford, BostonGene, UC
 * Regents). A fully bare {query: 'residual cancer cell-free RNA'} is worse:
 * composeFreeText ANDs 4 separate single-word clauses and also returns 0
 * silently. Neither shape has 2+ quoted phrases, so #2418's retry cannot see
 * either one.
 *
 * Each group below is OR'd together as ONE clause (ODP: whitespace between
 * bare/quoted terms is OR) and that clause is ANDed against the other
 * concepts in the query — so "cfRNA" and "cell-free RNA" and "circulating
 * RNA" become interchangeable at compose time, before any zero-result retry
 * is needed, rather than requiring the caller (in practice, the router) to
 * guess the one spelling a given patent uses. This is deliberately a short,
 * curated list of documented production misses — not a general thesaurus —
 * because an unrelated OR silently answers a different question (measured:
 * OR-broadening a whole multi-concept query, rather than just its synonyms,
 * once returned 21,937 largely off-topic matches, fleet #2450 annotation
 * 54979).
 */
const SYNONYM_GROUPS: string[][] = [
  ['cfRNA', 'cell-free RNA', 'cell free RNA', 'circulating RNA', 'circulating cell-free RNA', 'ccfRNA'],
  ['MRD', 'minimal residual disease', 'molecular residual disease', 'residual cancer', 'residual disease'],
];

/** ODP OR syntax for one synonym: bare if a single word, quoted if it has a space. */
function synonymTerm(term: string): string {
  return term.includes(' ') ? `"${term}"` : term;
}

/**
 * Rewrite every recognized synonym-group member found in `raw` to a single
 * placeholder token (one alnum word, no quotes/spaces), so that when
 * composeFreeText tokenizes the result it treats the whole matched phrase as
 * ONE atomic clause rather than splitting a bare multi-word member (e.g.
 * "cell-free RNA") into separately-AND-ed words. The placeholder -> finished
 * OR-clause swap happens AFTER composeFreeText runs (see call site below),
 * because composeFreeText itself would otherwise re-quote or re-split the
 * clause text if we substituted the parenthesized OR clause in directly.
 *
 * Each group is matched with ONE alternation regex (longest member first, so
 * e.g. "circulating cell-free RNA" is consumed whole before "circulating
 * RNA" could match part of it), case-insensitive and word-bounded (no match
 * inside a longer word). A group expands at most once per query: its FIRST
 * match becomes the placeholder and any FURTHER mention of the same group
 * elsewhere in the query — a caller who names two members of one concept is
 * not asking for two different concepts — collapses to a single space rather
 * than an empty string, so a mention that happened to be quoted leaves a
 * blank `" "` phrase that composeFreeText's own blank-phrase handling
 * already discards, instead of a stray `""` artifact.
 */
function expandSynonymGroups(raw: string): { text: string; placeholders: Map<string, string> } {
  const placeholders = new Map<string, string>();
  let text = raw;
  let n = 0;
  for (const group of SYNONYM_GROUPS) {
    const alternation = [...group]
      .sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`, 'gi');
    let placeholder: string | null = null;
    text = text.replace(re, () => {
      if (placeholder === null) {
        placeholder = `synonymgroup${n++}`;
        placeholders.set(placeholder, `(${group.map(synonymTerm).join(' ')})`);
        return placeholder;
      }
      return ' ';
    });
  }
  return { text, placeholders };
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
      'Search USPTO patent applications and grants — **without a `granted_after`/`granted_before` bound this returns the APPLICATION corpus sorted newest-FILED-first, not issued patents.** USPTO publishes an application ~18 months after filing and typically takes 2+ years to grant it, so the newest rows in an unfiltered search are always recent, unexamined filings with `grant_date: null` — that is expected, not stale data. **Pick the date field on the QUESTION\'S VERB, not on the word "recent":** a question asking who has FILED / applied for / sought patents in a window wants `filed_after`/`filed_before` — the default application corpus already includes pending AND granted patents, so no `granted_after` is needed or wanted, and adding one will silently drop recently-filed-but-not-yet-examined applications (grant lags filing by 2+ years, so "filed in the last 3 years" AND "granted in the last 3 years" are mostly DISJOINT sets). Only use `granted_after`/`granted_before` when the question explicitly says GRANTED / ISSUED / APPROVED / "has a patent" (not just "recent patents"). Use `query` for free-text keywords ("lithium battery", "crispr", "machine learning"); all terms are required (AND), and you can quote a phrase to keep it together. A curated, short list of known synonym/abbreviation pairs for concepts that patents describe inconsistently (e.g. cfRNA / cell-free RNA / circulating RNA; MRD / minimal residual disease / residual cancer) is recognized in `query` — quoted or bare — and expanded to an OR group before the search runs, so "cfRNA" and "cell-free RNA" are treated as the same concept rather than requiring the caller to guess a specific patent\'s exact wording (marked `synonyms_expanded: true` in the response; this is a fixed, documented list, not general synonym invention). A question that names several DISTINCT ways of describing the same idea (e.g. a condition plus a detection method, each expressed as its own quoted phrase) should still be passed as one query — if the literal AND-of-everything match returns zero, the tool automatically retries once with those same quoted phrases OR\'d together instead and marks the response `broadened: true`; it only ever relaxes multi-phrase AND to OR on a genuine zero, so a search that is narrow for a real reason (e.g. one specific applicant with no matching filings, or an ordinary bare-keyword AND) still correctly returns zero. Optional structured filters: `applicant` (exact corporate name as filed, e.g. "APPLE INC."), `inventor` (person name), `title` (words in the invention title), `number` (a specific application number), `filed_after` / `filed_before`, `granted_after` / `granted_before`. Common synonyms are understood — `assignee`, `company` and `owner` all reach `applicant`, and `keywords`, `q` or `text` all reach `query`. Results include title, application number, filing date, first applicant, all applicants, inventors, status, classification. `total` is the full match count but USPTO returns at most 25 records per search — narrow with applicant or a date range rather than raising `limit`. Powered by the USPTO Open Data Portal (data.uspto.gov).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text keywords. Every term must appear (they are AND-ed), so add words to narrow and remove words to widen. Wrap words in double quotes to require them adjacent: `"machine learning" model` needs the exact phrase plus the word model. Examples: "lithium battery", "crispr", "neural network". Pass "*" if you only want to filter by applicant/date with no keyword constraint. A curated set of known synonyms/abbreviations (e.g. cfRNA / cell-free RNA / circulating RNA, or MRD / minimal residual disease / residual cancer) is automatically expanded to an OR group within the query — quoted or bare, either form is recognized — so you do not need to guess which exact wording a given patent uses (see `synonyms_expanded` in the response). If several quoted phrases — or two recognized synonym-group concepts, quoted or not — ANDed together still match nothing, the tool retries once with them OR\'d instead (see `broadened` in the response) rather than returning a bare zero.',
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
          description: 'Optional. Filter to patents FILED on/after this date (ISO YYYY-MM-DD). Use this for "who has filed / applied for patents on X (recently / in the last N years)" — it covers both pending applications and already-granted patents, so it is the right bound even when the question also says "recent". Do NOT substitute `granted_after` for a filing-activity question: grant lags filing by 2+ years, so a recent filing window under `granted_after` typically returns zero even when filing activity is real.',
        },
        filed_before: {
          type: 'string',
          description: 'Optional. Filter to patents FILED on/before this date (ISO YYYY-MM-DD).',
        },
        granted_after: {
          type: 'string',
          description: 'Optional. Filter to patents GRANTED (issued) on/after this date (ISO YYYY-MM-DD) — use ONLY when the question explicitly says GRANTED / ISSUED / APPROVED, not for a plain "recent patents" or "who has filed" question (use `filed_after` for those — see its description). Accepted synonym: `issued_after`.',
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
      'Fetch a single USPTO patent application/grant by application number (`number`, e.g. "16/123,456" or "16123456") or by an already-granted patent number (`patent_number`, e.g. "11646472") — pass whichever one you actually have. Returns full metadata: title, inventors, classifications, status, and — when the application has been granted — `patent_number`, `grant_date`, `publication_number`, `publication_date`. **8-digit application numbers and 8-digit patent numbers can be the SAME digit string for a different record** (application series codes 10-12 were used ~2003-2008, and granted patent numbers entered that same 10,000,000-12,999,999 range in 2018 and are still in it) — e.g. "11646472" is BOTH application 11/646,472 (a 2006 filing) AND patent 11,646,472 (a 2023 grant), two unrelated inventions. If you only pass `number` and it is an 8-digit value in that collision range, this tool checks BOTH interpretations; if both exist, it returns `ambiguous: true` with each record summarized rather than silently guessing — re-call with `number` for the application or `patent_number` for the patent. Passing `patent_number` explicitly always skips the ambiguity check. A `status` of "Patented Case" with `patent_number: null` means USPTO ODP omitted that field for this record (check `patent_number_warning`), not that the patent was never granted; a pending application correctly has `patent_number: null`, `grant_date: null`.',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'An application number, digits only or with slashes (e.g. "16123456", "16/123,456"). If this happens to also be a valid 8-digit granted patent number (see the collision note above), the response may come back `ambiguous: true` — pass `patent_number` instead to mean the patent unambiguously.',
        },
        patent_number: {
          type: 'string',
          description: 'An already-granted US patent number, digits only (e.g. "11646472", "10000000"). Use this instead of `number` whenever you specifically mean the patent, not the application — it is never ambiguous.',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.',
        },
      },
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
  {
    name: 'get_patent_transactions',
    description:
      'Fetch the full USPTO prosecution/transaction history for one patent application — every dated event the Office recorded against the case (filings, mailings, fee payments, office actions, notices, the grant itself), newest first. This is a superset of the handful of events `get_patent` surfaces: use this tool when the question is about the PROSECUTION HISTORY itself (how many office actions, when was it mailed, when did examination start) rather than just the current status.',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'US application number, digits only or formatted. Examples: "18926509", "16/123,456".',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return, newest first (default 50). The full history is usually under 100 events; a `note` in the response says when more exist than were returned.',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.',
        },
      },
      required: ['number'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        application_number: { type: 'string' },
        total: { type: 'number' },
        returned: { type: 'number' },
        events: { type: 'array', items: { type: 'object' } },
        source: { type: 'string' },
      },
      required: ['application_number', 'total', 'returned', 'events', 'source'],
    },
  },
  {
    name: 'get_patent_continuity',
    description:
      'Fetch the parent/child continuity (priority) chain for one patent application — every earlier application this one claims priority from (continuation, divisional, CIP, provisional, etc.) and every later application that in turn claims priority from it, each with the claim type, dates, and the parent/child\'s own patent number where granted. Use this to answer "what did this patent come from" or "what later patents/applications descend from this one". An application with no continuity relationships returns an empty chain on both sides — that is a real, common answer (most applications are standalone filings), not a failure.',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'US application number, digits only or formatted. Examples: "17248024", "16/123,456".',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.',
        },
      },
      required: ['number'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        application_number: { type: 'string' },
        parent_count: { type: 'number' },
        child_count: { type: 'number' },
        parents: { type: 'array', items: { type: 'object' } },
        children: { type: 'array', items: { type: 'object' } },
        source: { type: 'string' },
      },
      required: ['application_number', 'parent_count', 'child_count', 'parents', 'children', 'source'],
    },
  },
  {
    name: 'search_patent_assignments',
    description:
      'Search USPTO-recorded patent assignment/conveyance history by assignee, assignor, a granted patent number, or an application number — one of the four is required. Unlike `get_patent_assignments` (which needs an application number you already have), this answers "what has company X been assigned" or "who assigned patent Y". An `assignee`/`assignor` search returns one row per recorded assignment (reel/frame, conveyance, dates, the other party) and additionally resolves the covered property (application/patent number, title) for each one it returns via a follow-up lookup — capped by `limit` because each one is a separate upstream call. A `patent_number`/`application_number` search returns the full assignment chain for that one property directly. An assignee/assignor with no recorded assignments returns a plain zero with the upstream total, not an error — USPTO assignment coverage is uneven for older or never-assigned properties. Individual (non-corporate) assignee addresses are omitted; company addresses are kept. Powered by the USPTO Assignment Search system (public, no account or key required).',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          description: 'Company or person the patent was assigned TO (the recipient). Partial/substring match. Example: "Amyris".',
        },
        assignor: {
          type: 'string',
          description: 'Company or person who assigned the patent AWAY (the inventor or prior owner). Partial/substring match. Example: "Musk"',
        },
        patent_number: {
          type: 'string',
          description: 'A granted US patent number, digits only. Example: "10000000".',
        },
        application_number: {
          type: 'string',
          description: 'A US application number, digits only or formatted. Example: "15000001", "15/000,001".',
        },
        limit: {
          type: 'number',
          description: 'Maximum assignment records to return (default 10, max 25). For an assignee/assignor search this also bounds the number of follow-up property lookups, so a higher limit costs more upstream calls.',
        },
        _apiKey: {
          type: 'string',
          description: 'Not used by this tool — USPTO Assignment Search is keyless. Present only for schema parity with the other tools in this pack.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'object' },
        total: { type: 'number' },
        returned: { type: 'number' },
        assignments: { type: 'array', items: { type: 'object' } },
        source: { type: 'string' },
      },
      required: ['query', 'total', 'returned', 'assignments', 'source'],
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

  // Query clauses (free text) are kept SEPARATE from structural filters
  // (title/applicant/inventor/number/date ranges) so a zero-result retry can
  // relax only the free-text side — broadening a structural filter like
  // `applicant` would answer a different question, which is why that stays
  // untouched below (see `emptyWithFilter`'s own explanation instead).
  //
  // Synonym-group expansion (fleet #2450/#2499) runs BEFORE composeFreeText,
  // on the raw text, so a bare multi-word synonym like "cell-free RNA" is
  // recognized and replaced as one unit rather than split into separately
  // AND-ed words. `synonymGroupsApplied` records which placeholder maps to
  // which finished OR-clause so it can be swapped back in once
  // composeFreeText has produced its (quoted) clause list.
  const synonymExpansion = query && query !== '*' ? expandSynonymGroups(query) : null;
  const queryClauses = synonymExpansion
    ? composeFreeText(synonymExpansion.text).map((c) => {
        const bare = c.replace(/^"|"$/g, '');
        return synonymExpansion.placeholders.get(bare) ?? c;
      })
    : [];
  const synonymGroupsExpanded = synonymExpansion ? synonymExpansion.placeholders.size : 0;
  const structuralParts: string[] = [];
  if (title) structuralParts.push(`${FIELD_TITLE}:"${title.replace(/"/g, '')}"`);
  if (applicant) structuralParts.push(`${FIELD_APPLICANT}:"${applicant.replace(/"/g, '')}"`);
  if (inventor) structuralParts.push(`${FIELD_INVENTOR}:"${inventor.replace(/"/g, '')}"`);
  if (number) structuralParts.push(`applicationNumberText:${number.replace(/\D/g, '')}`);
  const filedRange = dateRange(FIELD_FILED, pickArg(args, ALIASES.filed_after), pickArg(args, ALIASES.filed_before));
  if (filedRange) structuralParts.push(filedRange);
  const grantedRange = dateRange(FIELD_GRANTED, pickArg(args, ALIASES.granted_after), pickArg(args, ALIASES.granted_before));
  if (grantedRange) structuralParts.push(grantedRange);

  if (queryClauses.length === 0 && structuralParts.length === 0) {
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

  const composeQ = (clauses: string[]) => [...clauses, ...structuralParts].join(' AND ');

  // `size` is not ODP's page-size parameter — it is ignored, and every search
  // returns exactly 25 whatever we ask for. Send it anyway in case they honour
  // it later, but enforce the caller's limit on our side rather than handing
  // back 25 rows to someone who asked for 3.
  let composedQ = composeQ(queryClauses);
  let data = await odpFetch(apiKey, '/applications/search', {
    q: composedQ,
    size: String(limit),
  });
  let all = data.patentFileWrapperDataBag ?? [];
  let total = data.count ?? all.length;

  // Zero-result broadening retry (fleet #2418). ODP's query language ANDs
  // every clause by default — including each quoted phrase in `query` — and a
  // question that names several DISTINCT ways of describing the same finding
  // as separate phrases ("residual cancer" AND "cell-free RNA") can genuinely
  // require ALL of them to co-occur verbatim in one record, which is a much
  // narrower bar than "patents about this topic". Measured: {query: '"residual
  // cancer" "cell-free RNA"'} -> 0 (AND of two phrases, neither term alone is
  // rare). Retrying the SAME phrases OR'd (ODP's default whitespace-join
  // operator, so simply not inserting "AND" between them) turns that into a
  // real answer.
  //
  // Deliberately gated on >=2 QUOTED phrases (OR >=2 recognized synonym
  // groups, fleet #2450/#2499 — see below), not just >=2 clauses: a bare
  // multi-word keyword search like {query: "machine learning neural
  // networks"} is ALSO 4 AND-ed clauses, but that AND is doing real,
  // intentional work (274 on-topic hits vs 104 for the literal 4-word phrase,
  // per the composeFreeText comment above) and broadening it to OR would
  // trade a working narrow search for a noisy one on every ordinary
  // multi-keyword call. Phrase-vs-phrase is a different shape: each phrase is
  // already a multi-word concept in its own right, so OR-ing whole concepts
  // together is a real broadening, not a collapse into single keywords.
  //
  // `synonymGroupsExpanded >= 2` extends the same gate to a query where the
  // router named two DISTINCT concepts but only quoted one of them — measured
  // live 2026-09-29: {query: '"cell-free RNA" residual cancer'} recognizes
  // BOTH concepts (cfRNA-group + MRD-group) via synonym expansion regardless
  // of quoting, but the raw text carries only 1 literal quoted phrase, so the
  // quote-counting gate alone missed it and a real AND-of-two-concepts zero
  // went unbroadened. Two recognized concepts is the same "OR-ing whole
  // concepts together, not collapsing to single keywords" shape as two quoted
  // phrases — it is not extended to a single recognized group (that case
  // already collapses to one clause and has nothing to broaden against).
  const quotedPhraseCount = query ? (query.match(/"[^"]+"/g) ?? []).length : 0;
  let broadened = false;
  let broadenedFrom: string | null = null;
  // Set only when the rerank below actually ran, so the response can say so
  // (fleet #2446) — distinct from `broadened`, which just means the OR retry
  // matched something.
  let rankedByPhraseMatch: string[] | null = null;
  if (total === 0 && queryClauses.length > 1 && (quotedPhraseCount >= 2 || synonymGroupsExpanded >= 2)) {
    broadenedFrom = composedQ;
    const orClause = `(${queryClauses.join(' ')})`;
    composedQ = composeQ([orClause]);
    data = await odpFetch(apiKey, '/applications/search', {
      q: composedQ,
      size: String(limit),
    });
    all = data.patentFileWrapperDataBag ?? [];
    total = data.count ?? all.length;
    broadened = total > 0;

    // Rank the OR-broadened rows by how many of the ORIGINAL phrases each one
    // actually matches (fleet #2446). ODP's own relevance order doesn't know
    // which of the OR'd phrases mattered, so a broadened search can rank a row
    // that only mentions ONE of several distinct original concepts ahead of
    // one that matches several — live example: the cfRNA query above, OR'd
    // across "cell-free RNA" / "residual cancer" / "minimal residual disease",
    // pulled in unrelated kidney-injury and tuberculosis filings interleaved
    // with genuinely on-topic ones. The invention title is the only free text
    // ODP returns in a search result (no abstract/claims here), so this is a
    // cheap best-effort: count phrase hits in the title and stable-sort by
    // that count, keeping ODP's own (recency) order as the tiebreak — it
    // costs no extra API call and reliably pushes multi-phrase matches above
    // single-phrase ones.
    if (broadened) {
      const phrases = queryClauses.map((c) => c.replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
      if (phrases.length > 0) {
        const scored = all.map((r, idx) => {
          const t = (r.applicationMetaData?.inventionTitle ?? '').toLowerCase();
          const score = phrases.reduce((n, p) => n + (t.includes(p) ? 1 : 0), 0);
          return { r, idx, score };
        });
        scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
        all = scored.map((s) => s.r);
        rankedByPhraseMatch = phrases;
      }
    }
  }

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
    ...(synonymGroupsExpanded > 0
      ? {
          synonyms_expanded: true,
          synonyms_note: `${synonymGroupsExpanded} term(s) in your query were expanded to a curated group of known synonyms/abbreviations (e.g. cfRNA / cell-free RNA / circulating RNA, or MRD / minimal residual disease / residual cancer) and OR'd together within the query — see \`query\` above for the exact clause sent upstream.`,
        }
      : {}),
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
    ...(broadened
      ? {
          broadened: true,
          broadening_note: `The literal query (${broadenedFrom}) matched 0 patents, so this retried the same phrases OR'd together instead of AND'd (${composedQ}). Read these results as "mentions at least one of the phrases", not all of them — narrow again with a more specific query, applicant, or date range if this is too broad.`
            + (rankedByPhraseMatch
              ? ` Rows below are ranked by how many of the original phrases (${rankedByPhraseMatch.join(', ')}) appear in the title — most on-topic first, ties keep ODP's own order — not by ODP's own relevance ordering.`
              : ''),
        }
      : {}),
    ...(total === 0 && !broadened && grantedRange && !filedRange
      ? {
          date_field_hint: `Zero GRANTED patents matched this window (${grantedRange}). USPTO typically takes 2+ years to examine and grant a filed application, so a recent granted_after/granted_before window often has nothing yet even when filing activity is real. If the question asked about patents FILED (not necessarily granted) in this window, retry with filed_after/filed_before instead — that includes both pending applications and granted patents.`,
        }
      : {}),
    // Dual-shape response: 'results' uses the back-compat shape so callers
    // (entity_profile, recent_changes) keep working; 'patents' is the same
    // data with full ODP fields for callers that want them.
    results: records.map(formatBackcompatSummary),
    patents: records.map(formatRecord),
  };
}

async function odpLookupByApplicationNumber(apiKey: string, clean: string): Promise<OdpRecord | undefined> {
  const data = await odpFetch(apiKey, '/applications/search', {
    q: `applicationNumberText:${clean}`,
    size: '1',
  });
  return data.patentFileWrapperDataBag?.[0];
}

async function odpLookupByPatentNumber(apiKey: string, clean: string): Promise<OdpRecord | undefined> {
  const data = await odpFetch(apiKey, '/applications/search', {
    q: `${FIELD_PATENT_NUMBER}:${clean}`,
    size: '1',
  });
  return data.patentFileWrapperDataBag?.[0];
}

function summarizeForAmbiguity(r: OdpRecord) {
  const meta = r.applicationMetaData ?? {};
  return {
    application_number: r.applicationNumberText ?? null,
    patent_number: meta.patentNumber ?? null,
    title: meta.inventionTitle ?? null,
    status: meta.applicationStatusDescriptionText ?? null,
    filing_date: meta.filingDate ?? null,
    grant_date: meta.grantDate ?? null,
  };
}

// fleet #3301 follow-up: an 8-digit application number (2-digit series code +
// 6-digit serial, e.g. "11" + "646472") and an 8-digit GRANTED patent number
// occupy the exact same digit-string space once patent numbers cross
// 10,000,000 — series codes 10-12 were issued to real applications
// ~2003-2008, and patent numbers have been in the 10,000,000-12,999,999 range
// since 2018 and still are as of this writing. "11646472" is simultaneously
// application 11/646,472 (a 2006 filing) and patent 11,646,472 (a 2023
// grant) — two unrelated inventions. The old application-first-then-fallback
// logic silently returned whichever one matched FIRST (always the
// application, since that query runs first), which is a wrong answer
// delivered with full confidence rather than an error. Detect the collision
// zone and check both interpretations rather than picking one.
function isCollisionRangeNumber(clean: string): boolean {
  if (!/^\d{8}$/.test(clean)) return false;
  const n = Number(clean);
  return n >= 10_000_000 && n <= 12_999_999;
}

async function getPatent(args: Record<string, unknown>) {
  const rawNumber = typeof args.number === 'string' && args.number.trim() ? args.number.trim() : null;
  const rawPatentNumber = typeof args.patent_number === 'string' && args.patent_number.trim() ? args.patent_number.trim() : null;
  if (!rawNumber && !rawPatentNumber) {
    throw new Error('Pass either "number" (an application number like "16123456" or "16/123,456") or "patent_number" (a granted patent number like "11646472").');
  }
  const apiKey = resolveApiKey(args);

  // Explicit patent_number always means the PATENT — never ambiguous,
  // because the caller already disambiguated by which argument they used.
  if (rawPatentNumber) {
    const clean = rawPatentNumber.replace(/[/, ]/g, '');
    const record = await odpLookupByPatentNumber(apiKey, clean);
    if (!record) {
      return {
        found: false,
        patent_number: rawPatentNumber,
        hint: 'No granted patent found for that number. Confirm the format (digits only, e.g. "11646472").',
      };
    }
    return { found: true, matched_by: 'patent_number' as const, ...formatRecord(record) };
  }

  // Only `number` given. Normalize: strip slashes and commas.
  const clean = rawNumber!.replace(/[/, ]/g, '');

  if (isCollisionRangeNumber(clean)) {
    const [appRecord, patentRecord] = await Promise.all([
      odpLookupByApplicationNumber(apiKey, clean),
      odpLookupByPatentNumber(apiKey, clean),
    ]);
    const sameRecord = !!appRecord && !!patentRecord && appRecord.applicationNumberText === patentRecord.applicationNumberText;
    if (appRecord && patentRecord && !sameRecord) {
      return {
        found: true,
        ambiguous: true,
        warning: `"${rawNumber}" matches BOTH an application number and a granted patent number — these are two different records. Pass this value as \`number\` to mean the application, or as \`patent_number\` to mean the patent.`,
        application_match: summarizeForAmbiguity(appRecord),
        patent_match: summarizeForAmbiguity(patentRecord),
      };
    }
    const record = appRecord ?? patentRecord;
    const matchedBy: 'application_number' | 'patent_number' = appRecord ? 'application_number' : 'patent_number';
    if (!record) {
      return {
        found: false,
        application_number: rawNumber,
        hint: 'No patent application or granted patent found for that number. Confirm the format (digits only, e.g. "16123456" for an application or "11646472" for a granted patent).',
      };
    }
    return { found: true, matched_by: matchedBy, ...formatRecord(record) };
  }

  // Outside the collision range (the common case — current application
  // series are 18xxxxxx and well clear of the patent-number range): try
  // application number first, then retry as a patent number on a miss.
  let record = await odpLookupByApplicationNumber(apiKey, clean);
  let matchedBy: 'application_number' | 'patent_number' = 'application_number';
  if (!record) {
    record = await odpLookupByPatentNumber(apiKey, clean);
    matchedBy = 'patent_number';
  }
  if (!record) {
    return {
      found: false,
      application_number: rawNumber,
      hint: 'No patent application or granted patent found for that number. Confirm the format (digits only, e.g. "16123456" for an application or "11646472" for a granted patent).',
    };
  }
  return { found: true, matched_by: matchedBy, ...formatRecord(record) };
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

async function getPatentTransactions(args: Record<string, unknown>) {
  if (typeof args.number !== 'string' || !args.number.trim()) {
    throw new Error('Required argument "number" is missing or empty. Pass an application number like "18926509".');
  }
  const applicationNumber = args.number.replace(/\D/g, '');
  if (applicationNumber.length < 6 || applicationNumber.length > 12) {
    throw new Error('number must contain 6-12 digits.');
  }
  const apiKey = resolveApiKey(args);
  const limit = Math.min(500, Math.max(1, (args.limit as number | undefined) ?? 50));
  const data = await odpFetch<OdpTransactionsResponse>(
    apiKey,
    `/applications/${applicationNumber}/transactions`,
    {},
  );
  const record = data.patentFileWrapperDataBag?.[0];
  const all = record?.eventDataBag ?? [];
  // Newest first: ODP does not document an order guarantee for this bag, and
  // the live example observed was not reliably sorted — sort explicitly
  // rather than silently trusting upstream order, same spirit as the
  // search_patents 25-record-cap note below.
  const sorted = [...all].sort((a, b) => (b.eventDate ?? '').localeCompare(a.eventDate ?? ''));
  const events = sorted.slice(0, limit).map((e) => ({
    event_code: e.eventCode ?? null,
    description: e.eventDescriptionText ?? null,
    date: e.eventDate ?? null,
  }));
  return {
    application_number: record?.applicationNumberText ?? applicationNumber,
    total: all.length,
    returned: events.length,
    events,
    ...(all.length > events.length
      ? { note: `${all.length} transaction events exist for this application; showing the ${events.length} most recent. Raise \`limit\` to see more.` }
      : {}),
    source: 'USPTO Open Data Portal, Patent File Wrapper transaction history',
  };
}

async function getPatentContinuity(args: Record<string, unknown>) {
  if (typeof args.number !== 'string' || !args.number.trim()) {
    throw new Error('Required argument "number" is missing or empty. Pass an application number like "17248024".');
  }
  const applicationNumber = args.number.replace(/\D/g, '');
  if (applicationNumber.length < 6 || applicationNumber.length > 12) {
    throw new Error('number must contain 6-12 digits.');
  }
  const apiKey = resolveApiKey(args);
  const data = await odpFetch<OdpContinuityResponse>(
    apiKey,
    `/applications/${applicationNumber}/continuity`,
    {},
  );
  const record = data.patentFileWrapperDataBag?.[0];
  const parents = (record?.parentContinuityBag ?? []).map((p) => ({
    parent_application_number: p.parentApplicationNumberText ?? null,
    parent_patent_number: p.parentPatentNumber ?? null,
    relationship: p.claimParentageTypeCodeDescriptionText ?? p.claimParentageTypeCode ?? null,
    parent_filing_date: p.parentApplicationFilingDate ?? null,
    parent_status: p.parentApplicationStatusDescriptionText ?? null,
  }));
  const children = (record?.childContinuityBag ?? []).map((c) => ({
    child_application_number: c.childApplicationNumberText ?? null,
    child_patent_number: c.childPatentNumber ?? null,
    relationship: c.claimParentageTypeCodeDescriptionText ?? c.claimParentageTypeCode ?? null,
    child_filing_date: c.childApplicationFilingDate ?? null,
    child_status: c.childApplicationStatusDescriptionText ?? null,
  }));
  return {
    application_number: record?.applicationNumberText ?? applicationNumber,
    parent_count: parents.length,
    child_count: children.length,
    parents,
    children,
    source: 'USPTO Open Data Portal, Patent File Wrapper continuity data',
  };
}

// ── USPTO Assignment Search (keyless, public — distinct host from ODP) ──
//
// ODP's own /applications/{n}/assignment route (used by get_patent_assignments
// above) only accepts an application number you already have. "What has
// company X been assigned" / "who assigned patent Y away" needs a real search
// by name or by patent number, which ODP does not expose (confirmed: no
// /assignment/search route exists on that host — only the per-application
// one). USPTO's own public Assignment Search front end calls a separate,
// keyless JSON endpoint to answer exactly this; this wraps that endpoint
// directly rather than mirroring any dataset (fleet #2944/#2946: provenance
// here is publisher + dataset, never the route).
const ASSIGNMENT_SEARCH_BASE = 'https://assignmentcenter.uspto.gov/ipas/search/api/v3/public/search/patent';

interface AcAssignee {
  assigneeName?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  addressLine4?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
}
interface AcAssignor {
  assignorName?: string;
  executionDate?: string;
  acknowledgedDate?: string | null;
}
interface AcProperty {
  applicationNumber?: string;
  patentNumber?: string;
  publicationNumber?: string;
  inventionTitle?: string;
  fillingDate?: string; // sic — upstream's own typo'd field name
  issueDate?: string;
}
interface AcAssignmentDetail {
  reelNumber?: number | string;
  frameNumber?: number | string;
  reelFrame?: string;
  conveyance?: string;
  recordationDate?: string;
  mailDate?: string;
  receiptDate?: string;
  assignorExecutionDate?: string;
  assignees?: AcAssignee[];
  assignors?: AcAssignor[];
}
interface AcNameSearchRow {
  reelNumber?: number;
  frameNumber?: number;
  correspondentName?: string;
  assignorExecutionDate?: string;
  conveyance?: string;
  assignors?: AcAssignor[];
  assignees?: string[]; // name-search mode returns bare assignee name strings
  noOfProperties?: number;
}

async function acSearch(body: Record<string, unknown>): Promise<unknown> {
  const res = await pwFetch(ASSIGNMENT_SEARCH_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, 'USPTO Assignment Search');
  return parseJson(res, 'USPTO Assignment Search');
}

/** Individual (not corporate) assignee names are recorded "LAST, First" —
 * the same shape as assignor names, which are always natural persons.
 * Addresses are omitted for those; a company's recorded address is kept. */
const CORPORATE_SUFFIX_RE = /\b(INC|LLC|LLP|LTD|CORP|CORPORATION|CO|COMPANY|GMBH|AG|SA|SAS|SRL|NV|BV|KK|PBC|PLC|LP|L\.P\.|PARTNERS|UNIVERSITY|FOUNDATION|TRUST|HOLDINGS?|GROUP|LABORATORIES|LABS|PHARMACEUTICALS?|TECHNOLOGIES|SYSTEMS|INDUSTRIES|BIO ?PRODUCTS)\b\.?/i;
function looksIndividual(name: string | undefined): boolean {
  if (!name) return false;
  if (CORPORATE_SUFFIX_RE.test(name)) return false;
  return /^[A-Za-z'\-. ]+,\s*[A-Za-z]/.test(name.trim());
}

function formatAcAddress(a: AcAssignee): Record<string, unknown> | null {
  const parts = [a.addressLine1, a.addressLine2, a.addressLine3, a.addressLine4].filter(Boolean);
  if (parts.length === 0 && !a.city && !a.state && !a.country) return null;
  return {
    lines: parts,
    city: a.city || null,
    state: a.state || null,
    country: a.country || null,
    zip: a.zipCode || null,
  };
}

function formatAcDetail(a: AcAssignmentDetail) {
  const reel = a.reelNumber != null ? String(a.reelNumber) : null;
  const frame = a.frameNumber != null ? String(a.frameNumber) : null;
  return {
    reel_frame: a.reelFrame ?? (reel && frame ? `${reel}/${frame}` : null),
    conveyance: a.conveyance ?? null,
    recorded_date: a.recordationDate ?? null,
    received_date: a.receiptDate ?? null,
    mailed_date: a.mailDate ?? null,
    assignors: (a.assignors ?? []).map((x) => ({ name: x.assignorName ?? null, execution_date: x.executionDate ?? null })),
    assignees: (a.assignees ?? []).map((x) => ({
      name: x.assigneeName ?? null,
      address: looksIndividual(x.assigneeName) ? null : formatAcAddress(x),
    })),
  };
}

function formatAcProperty(p: AcProperty) {
  return {
    application_number: p.applicationNumber || null,
    patent_number: p.patentNumber || null,
    publication_number: p.publicationNumber || null,
    title: p.inventionTitle || null,
    filing_date: p.fillingDate || null,
    issue_date: p.issueDate || null,
  };
}

async function searchPatentAssignments(args: Record<string, unknown>) {
  const assignee = pickArg(args, ['assignee', 'assignee_name', 'owner']);
  const assignor = pickArg(args, ['assignor', 'assignor_name']);
  const patentNumber = pickArg(args, ['patent_number', 'patentNumber'])?.replace(/\D/g, '') || null;
  const applicationNumber = pickArg(args, ['application_number', 'applicationNumber'])?.replace(/\D/g, '') || null;
  const limit = Math.min(25, Math.max(1, (args.limit as number | undefined) ?? 10));

  if (!assignee && !assignor && !patentNumber && !applicationNumber) {
    return {
      found: false,
      reason: 'no_search_criteria',
      message: 'Pass one of: assignee, assignor, patent_number, application_number.',
      query: {},
      total: 0,
      returned: 0,
      assignments: [],
      source: 'USPTO Assignment Search',
    };
  }

  const query = { assignee, assignor, patent_number: patentNumber, application_number: applicationNumber };

  // Property-identified search (patent/application number): ODP's shape is
  // one assignment CHAIN for that one property, with the property details
  // attached directly — no follow-up call needed.
  if (patentNumber || applicationNumber) {
    const property = patentNumber ?? applicationNumber;
    const searchBy = patentNumber ? 'patentNumber' : 'applicationNumber';
    const raw = (await acSearch({
      property,
      searchBy,
      dataFilter: { rowsPerPage: String(limit), currentPage: '1' },
    })) as {
      successResponse?: {
        data?: { assignment?: AcAssignmentDetail[] | AcAssignmentDetail | null; properties?: AcProperty[] | AcProperty | null; noOfAssignments?: number };
        totalRows?: number;
        message?: string;
      };
    };
    const sr = raw.successResponse;
    const rawAssignment = sr?.data?.assignment;
    const assignmentList = Array.isArray(rawAssignment) ? rawAssignment : rawAssignment ? [rawAssignment] : [];
    const rawProps = sr?.data?.properties;
    const properties = (Array.isArray(rawProps) ? rawProps : rawProps ? [rawProps] : []).map(formatAcProperty);
    const total = sr?.data?.noOfAssignments ?? assignmentList.length;
    const assignments = assignmentList.slice(0, limit).map((a) => ({ ...formatAcDetail(a), properties }));
    return {
      query,
      total,
      returned: assignments.length,
      assignments,
      ...(total === 0 ? { note: sr?.message ?? 'No assignment records found for that number.' } : {}),
      source: 'USPTO Assignment Search',
    };
  }

  // Name search (assignee/assignor): the list endpoint returns assignment
  // summaries WITHOUT the covered property numbers (upstream's own
  // noOfProperties field was observed 0 on every row regardless of the real
  // count), so the property identifiers have to come from a follow-up
  // per-reel/frame lookup — one extra call per returned row, run in parallel
  // and bounded by `limit` so a caller cannot force an unbounded fan-out.
  const property = assignee ?? assignor;
  const searchBy = assignee ? 'partialAssigneeName' : 'partialAssignorName';
  const raw = (await acSearch({
    property,
    searchBy,
    dataFilter: { rowsPerPage: String(limit), currentPage: '1' },
  })) as { successResponse?: { data?: AcNameSearchRow[]; totalRows?: number; message?: string } };
  const sr = raw.successResponse;
  const allRows = sr?.data ?? [];
  const total = sr?.totalRows ?? allRows.length;
  const rows = allRows.slice(0, limit);

  const enriched = await Promise.all(
    rows.map(async (row) => {
      const base = {
        reel_frame: row.reelNumber != null && row.frameNumber != null ? `${row.reelNumber}/${row.frameNumber}` : null,
        conveyance: row.conveyance ?? null,
        executed_date: row.assignorExecutionDate ?? null,
        assignors: (row.assignors ?? []).map((x) => ({ name: x.assignorName ?? null, execution_date: x.executionDate ?? null })),
        assignees: (row.assignees ?? []).map((name) => ({ name, address: null })), // name-search mode gives bare strings, no address
      };
      if (row.reelNumber == null || row.frameNumber == null) {
        return { ...base, recorded_date: null, properties: [], properties_unavailable: 'reel/frame missing from upstream row' };
      }
      try {
        const detail = (await acSearch({
          reelNumber: String(row.reelNumber),
          frameNumber: String(row.frameNumber),
          searchBy: 'reelFrame',
          dataFilter: { rowsPerPage: '10', currentPage: '1' },
        })) as { successResponse?: { data?: { assignment?: AcAssignmentDetail; properties?: AcProperty[] | AcProperty | null } } };
        const d = detail.successResponse?.data;
        const rawProps = d?.properties;
        const properties = (Array.isArray(rawProps) ? rawProps : rawProps ? [rawProps] : []).map(formatAcProperty);
        return {
          ...base,
          recorded_date: d?.assignment?.recordationDate ?? null,
          properties,
        };
      } catch {
        // A single failed enrichment call should not fail the whole search —
        // the caller still gets the name-search row, just without the
        // property numbers for that one entry.
        return { ...base, recorded_date: null, properties: [], properties_unavailable: 'enrichment lookup failed' };
      }
    }),
  );

  return {
    query,
    total,
    returned: enriched.length,
    assignments: enriched,
    ...(total > rows.length
      ? { note: `USPTO Assignment Search matched ${total} records for this name; returning the first ${rows.length} (raise \`limit\`, max 25, to see more — the upstream search itself is not paginated server-side).` }
      : {}),
    ...(total === 0 ? { note: sr?.message ?? 'No assignment records found for that name.' } : {}),
    source: 'USPTO Assignment Search',
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
    case 'get_patent_transactions':
      return getPatentTransactions(args);
    case 'get_patent_continuity':
      return getPatentContinuity(args);
    case 'search_patent_assignments':
      return searchPatentAssignments(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;

// Exported for tests — the alias table is the whole of the fix for callers
// arriving with `assignee` or `keywords`, so it is worth pinning.
export { ALIASES, pickArg };
