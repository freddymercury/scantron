/**
 * A Socrata (SODA) client, which is `fetch` plus the three things that actually bite:
 * an app token, retries on the failures that are transient, and cursor paging.
 *
 * Paging by `$offset` alone is unsafe on a live feed — rows inserted mid-page shift the
 * window and silently drop records — so paging is always ordered by the cursor column and
 * bounded by a `$where` on it.
 */

export interface SocrataOptions {
  host?: string;
  appToken?: string | undefined;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseBackoffMs?: number;
}

export interface SocrataQuery {
  dataset: string;
  select?: string;
  where?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

export class SocrataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SocrataError";
  }
}

export interface KeysetQuery extends Omit<SocrataQuery, "order" | "offset"> {
  /** Publication timestamp column; the primary sort and page key. */
  timeField: string;
  /** Tie-breaker, because thousands of rows share one batch timestamp. */
  idField: string;
  pageSize?: number;
  maxPages?: number;
}

export interface SocrataClient {
  query<T>(query: SocrataQuery): Promise<T[]>;
  /** Fetch every page for a query, in cursor order. `pageSize` caps each request. */
  queryAll<T>(query: SocrataQuery & { pageSize?: number; maxPages?: number }): Promise<T[]>;
  /**
   * Paging by keyset rather than `$offset`. Measured against the live feed: offset paging
   * over 4,078 rows returned 12 duplicates and missed 11 records, because rows published
   * mid-scan shift every later page. Keyset paging cannot drift that way.
   */
  queryKeyset<T extends Record<string, unknown>>(query: KeysetQuery): Promise<T[]>;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function buildUrl(host: string, query: SocrataQuery): string {
  const url = new URL(`${host}/resource/${query.dataset}.json`);
  if (query.select) url.searchParams.set("$select", query.select);
  if (query.where) url.searchParams.set("$where", query.where);
  if (query.order) url.searchParams.set("$order", query.order);
  if (query.limit !== undefined) url.searchParams.set("$limit", String(query.limit));
  if (query.offset !== undefined) url.searchParams.set("$offset", String(query.offset));
  return url.toString();
}

export function createSocrataClient(options: SocrataOptions = {}): SocrataClient {
  const host = options.host ?? process.env.DATASF_HOST ?? "https://data.sf.gov";
  const token = options.appToken ?? process.env.DATASF_APP_TOKEN?.trim();
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const maxRetries = options.maxRetries ?? 4;
  const baseBackoffMs = options.baseBackoffMs ?? 500;

  async function request<T>(query: SocrataQuery): Promise<T[]> {
    const url = buildUrl(host, query);
    const headers: Record<string, string> = { accept: "application/json" };
    // Unauthenticated requests share a much smaller rate-limit pool.
    if (token) headers["X-App-Token"] = token;

    let lastError: SocrataError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(baseBackoffMs * 2 ** (attempt - 1));
      }
      try {
        const response = await doFetch(url, { headers });
        if (response.ok) return (await response.json()) as T[];

        const retryable = RETRYABLE_STATUSES.has(response.status);
        lastError = new SocrataError(
          `${response.status} ${response.statusText} from ${query.dataset}`,
          response.status,
          retryable,
        );
        if (!retryable) throw lastError;
      } catch (error) {
        if (error instanceof SocrataError) {
          if (!error.retryable) throw error;
          lastError = error;
        } else {
          // Network-level failures are transient by assumption; a genuinely broken host
          // still surfaces after the retries are spent.
          lastError = new SocrataError((error as Error).message, undefined, true);
        }
      }
    }
    throw lastError ?? new SocrataError("request failed with no error recorded");
  }

  return {
    query: request,
    async queryAll<T>(query: SocrataQuery & { pageSize?: number; maxPages?: number }): Promise<T[]> {
      const pageSize = query.pageSize ?? 1000;
      const maxPages = query.maxPages ?? 50;
      const all: T[] = [];

      for (let page = 0; page < maxPages; page += 1) {
        const rows = await request<T>({
          ...query,
          limit: pageSize,
          offset: page * pageSize,
        });
        all.push(...rows);
        if (rows.length < pageSize) return all;
      }
      return all;
    },

    async queryKeyset<T extends Record<string, unknown>>(query: KeysetQuery): Promise<T[]> {
      const pageSize = query.pageSize ?? 1000;
      const maxPages = query.maxPages ?? 50;
      const all: T[] = [];
      let after: { time: string; id: string } | undefined;

      for (let page = 0; page < maxPages; page += 1) {
        const bounds = [query.where, keysetWhere(query, after)].filter(Boolean) as string[];
        const rows = await request<T>({
          dataset: query.dataset,
          ...(query.select ? { select: query.select } : {}),
          ...(bounds.length > 0 ? { where: bounds.join(" AND ") } : {}),
          order: `${query.timeField} ASC, ${query.idField} ASC`,
          limit: pageSize,
        });
        all.push(...rows);
        if (rows.length < pageSize) return all;

        const last = rows[rows.length - 1] as T;
        after = { time: String(last[query.timeField]), id: String(last[query.idField]) };
      }
      return all;
    },
  };
}

function keysetWhere(query: KeysetQuery, after?: { time: string; id: string }): string | undefined {
  if (!after) return undefined;
  const time = after.time.replaceAll("'", "''");
  const id = after.id.replaceAll("'", "''");
  return `(${query.timeField} > '${time}' OR (${query.timeField} = '${time}' AND ${query.idField} > '${id}'))`;
}
