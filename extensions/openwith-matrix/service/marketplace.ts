/**
 * Marketplace catalog aggregator.
 *
 * The official directory is server-rendered HTML, and the community side is a
 * GitHub topic search. Both are fetched here, merged by repository URL and
 * cached so opening the panel does not hit the network on every render.
 *
 * Only repositories whose package.json contains an `openchamber` manifest and a
 * semver version get an install button. Everything else keeps a repository link
 * so the catalog never turns a broken clone into a one-click action.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  MarketplaceCatalog,
  MarketplaceCategory,
  MarketplaceEntry,
} from '../shared/types.ts';
import { MARKETPLACE_ZH } from './marketplaceZh.ts';

const OFFICIAL_URL = 'https://openchamber.dev/extensions';
const GITHUB_QUERIES = [
  'https://api.github.com/search/repositories?q=topic%3Aopenchamber&per_page=100&sort=updated',
  'https://api.github.com/search/repositories?q=topic%3Aopenchamber-extension&per_page=100&sort=updated',
];
const CACHE_TTL_MS = 10 * 60_000;
const VALIDATION_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const PACKAGE_TIMEOUT_MS = 6_000;
const ICON_TIMEOUT_MS = 5_000;
const VALIDATION_CONCURRENCY = 16;
const VALIDATION_BUDGET_MS = 8_000;
const CACHE_FILE_VERSION = 1;

interface OfficialEntry {
  name: string;
  description: string;
  owner: string;
  icon?: string;
  repoUrl: string;
  sourceCategory: string;
  stars?: number;
  addedAt?: string;
  official: boolean;
}

interface GitHubRepo {
  full_name?: string;
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  html_url?: string;
  homepage?: string | null;
  topics?: string[];
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  default_branch?: string;
  owner?: { login?: string; avatar_url?: string };
}

interface GitHubSearch {
  items?: GitHubRepo[];
}

interface Validation {
  at: number;
  installable: boolean;
  icon?: string;
  glyph?: string;
}

interface DiskCache {
  version: number;
  at: number;
  catalog: MarketplaceCatalog;
  validations: Record<string, Validation>;
}

interface PackageJson {
  version?: unknown;
  openchamber?: unknown;
  [key: string]: unknown;
}

const MAX_ICON_BYTES = 96 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);


const decodeHtml = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const plainText = (html: string): string =>
  decodeHtml(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const attr = (tag: string, name: string): string => {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match ? decodeHtml(match[1]) : '';
};

const textBetween = (html: string, className: string): string => {
  const match = html.match(
    new RegExp(`class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`, 'i'),
  );
  return match ? plainText(match[1]) : '';
};

const svgDataUrl = (svg: string): string => {
  let value = svg
    .replace(/\sdata-astro-cid-[a-z0-9]+(?:="[^"]*")?/gi, '')
    .trim();
  if (!/\bxmlns=/i.test(value)) {
    value = value.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return `data:image/svg+xml;base64,${Buffer.from(value, 'utf8').toString('base64')}`;
};

const iconMime = (file: string, contentType: string): string => {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'svg' || contentType.includes('svg')) return 'image/svg+xml';
  if (ext === 'png' || contentType.includes('png')) return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg' || contentType.includes('jpeg')) return 'image/jpeg';
  if (ext === 'webp' || contentType.includes('webp')) return 'image/webp';
  if (ext === 'gif' || contentType.includes('gif')) return 'image/gif';
  return 'image/png';
};

const repoKey = (url: string): string =>
  url
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const installUrlOf = (repoUrl: string): string | undefined => {
  const value = repoUrl.trim();
  if (!value) return undefined;
  if (/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i.test(value)) {
    return `${value.replace(/\.git$/i, '').replace(/\/+$/, '')}.git`;
  }
  if (/^git@/i.test(value)) return value;
  if (/^https?:\/\/.+\.zip$/i.test(value)) return value;
  return undefined;
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'extension';

const categoryOf = (haystack: string, sourceCategory = ''): MarketplaceCategory => {
  const value = `${haystack} ${sourceCategory}`.toLowerCase();
  if (/(theme|color scheme|palette|appearance|icon pack|wallpaper|font)/.test(value)) {
    return 'themes';
  }
  if (/(\bmcp\b|model context protocol|connector|tool server)/.test(value)) {
    return 'mcp';
  }
  if (
    /(devops|workflow|monitor|usage|preview|file|agent setup|memory|provider|docker|kubernetes|terminal|prompt|search|browser|api|git|tool|integration|productivity|session|task|kanban|notes|log)/.test(
      value,
    )
  ) {
    return 'tools';
  }
  return 'other';
};

const parseOfficial = (html: string): OfficialEntry[] => {
  const entries: OfficialEntry[] = [];
  const itemRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(html))) {
    const attrs = match[1] ?? '';
    if (!/\bdata-category=/.test(attrs)) continue;
    const body = match[2] ?? '';
    const link = body.match(/<a\b[^>]*class="[^"]*\bext-tile\b[^"]*"[^>]*>/i);
    const href = link ? attr(link[0], 'href') : '';
    if (!href) continue;
    const name = textBetween(body, 'ext-name') || href.split('/').pop() || 'Extension';
    const iconSvg = body
      .match(/<span[^>]*class="[^"]*\bext-icon\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]
      ?.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0];
    const icon = iconSvg ? svgDataUrl(iconSvg) : '';
    const stars = Number(attr(attrs, 'data-stars'));
    entries.push({
      name,
      description: textBetween(body, 'ext-description'),
      owner: textBetween(body, 'ext-owner'),
      ...(icon ? { icon } : {}),
      repoUrl: href,
      sourceCategory: attr(attrs, 'data-category'),
      ...(Number.isFinite(stars) ? { stars } : {}),
      ...(attr(attrs, 'data-added') ? { addedAt: attr(attrs, 'data-added') } : {}),
      official: /class="[^"]*\bext-official\b/.test(body),
    });
  }
  return entries;
};

export class MarketplaceService {
  private cache: { at: number; catalog: MarketplaceCatalog } | null = null;
  private inflight: Promise<MarketplaceCatalog> | null = null;
  private readonly validations = new Map<string, Validation>();
  private diskLoaded = false;

  constructor(
    private readonly log: (message: string) => void,
    private readonly cacheFile?: string,
  ) {}

  async get(force = false): Promise<MarketplaceCatalog> {
    if (!this.diskLoaded) await this.loadDisk();
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.catalog;
    }
    if (this.inflight) return this.inflight;
    // A stale on-disk catalog answers immediately; the refresh lands in the
    // background so the panel never waits on a cold network build.
    if (!force && this.cache) {
      void this.refresh().catch((error: unknown) => {
        this.log(`marketplace background refresh failed: ${this.messageOf(error)}`);
      });
      return this.cache.catalog;
    }
    try {
      return await this.refresh();
    } catch (error) {
      if (this.cache) {
        this.log(`marketplace refresh failed, serving cache: ${this.messageOf(error)}`);
        return this.cache.catalog;
      }
      throw error;
    }
  }

  /** Build the catalog once at startup so the first panel request is warm. */
  async warm(): Promise<void> {
    if (!this.diskLoaded) await this.loadDisk();
    if (this.inflight) return;
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return;
    void this.refresh().catch((error: unknown) => {
      this.log(`marketplace warm failed: ${this.messageOf(error)}`);
    });
  }

  private refresh(): Promise<MarketplaceCatalog> {
    if (this.inflight) return this.inflight;
    this.inflight = this.build()
      .then((catalog) => {
        this.cache = { at: Date.now(), catalog };
        void this.persist();
        return catalog;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async loadDisk(): Promise<void> {
    this.diskLoaded = true;
    if (!this.cacheFile) return;
    try {
      const text = await fsp.readFile(this.cacheFile, 'utf8');
      const data = JSON.parse(text) as Partial<DiskCache>;
      if (
        data.version !== CACHE_FILE_VERSION ||
        !data.catalog ||
        !Array.isArray(data.catalog.entries)
      ) {
        return;
      }
      const at = Number(data.at ?? data.catalog.updatedAt ?? 0);
      this.cache = { at: Number.isFinite(at) ? at : 0, catalog: data.catalog };
      this.backfillDescriptions(data.catalog.entries);
      for (const [key, value] of Object.entries(data.validations ?? {})) {
        if (value && typeof value === 'object' && typeof value.installable === 'boolean') {
          this.validations.set(key, value);
        }
      }
      this.log(`marketplace cache loaded: ${data.catalog.entries.length} entries`);
    } catch {
      /* first run, or the cache is unreadable: build from the network */
    }
  }

  /** Apply translations added after a catalog was cached, without a network rebuild. */
  private backfillDescriptions(entries: MarketplaceEntry[]): void {
    for (const entry of entries) {
      const zh = MARKETPLACE_ZH[entry.id];
      if (zh && zh !== entry.description && !entry.descriptionZh) entry.descriptionZh = zh;
    }
  }

  private async persist(): Promise<void> {
    if (!this.cacheFile || !this.cache) return;
    const payload: DiskCache = {
      version: CACHE_FILE_VERSION,
      at: this.cache.at,
      catalog: this.cache.catalog,
      validations: Object.fromEntries(this.validations),
    };
    try {
      await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const temp = `${this.cacheFile}.${process.pid}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(payload), 'utf8');
      await fsp.rename(temp, this.cacheFile);
    } catch (error) {
      this.log(`marketplace cache write failed: ${this.messageOf(error)}`);
    }
  }

  private async build(): Promise<MarketplaceCatalog> {
    const errors: string[] = [];
    const [officialResult, githubResult] = await Promise.allSettled([
      this.official(),
      this.github(),
    ]);

    const official = officialResult.status === 'fulfilled' ? officialResult.value : [];
    if (officialResult.status === 'rejected') {
      errors.push(`official: ${this.messageOf(officialResult.reason)}`);
    }

    const github = githubResult.status === 'fulfilled' ? githubResult.value : [];
    if (githubResult.status === 'rejected') {
      errors.push(`github: ${this.messageOf(githubResult.reason)}`);
    }

    const entries = this.merge(official, github);
    const complete =
      officialResult.status === 'fulfilled' &&
      githubResult.status === 'fulfilled' &&
      official.length > 0 &&
      github.length > 0;
    if (!complete) this.appendCached(entries);
    await this.validate(entries, Date.now() + VALIDATION_BUDGET_MS);
    entries.sort(
      (a, b) =>
        (b.stars ?? 0) - (a.stars ?? 0) ||
        String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) ||
        a.name.localeCompare(b.name),
    );

    return {
      entries,
      updatedAt: Date.now(),
      sources: {
        official: official.length,
        github: github.length,
        errors,
      },
    };
  }

  private async official(): Promise<OfficialEntry[]> {
    const response = await fetch(OFFICIAL_URL, {
      headers: { 'User-Agent': 'openwith-matrix/2.0 (+https://openchamber.dev)' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${OFFICIAL_URL} -> ${response.status}`);
    return parseOfficial(await response.text());
  }

  private async github(): Promise<GitHubRepo[]> {
    const token = process.env.GITHUB_TOKEN?.trim();
    const results = await Promise.allSettled(
      GITHUB_QUERIES.map(async (url) => {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'openwith-matrix/2.0',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`${url} -> ${response.status}`);
        return (await response.json()) as GitHubSearch;
      }),
    );

    const repos = new Map<string, GitHubRepo>();
    let failures = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        failures += 1;
        this.log(`marketplace github search failed: ${this.messageOf(result.reason)}`);
        continue;
      }
      for (const repo of result.value.items ?? []) {
        if (!repo.full_name || repo.disabled || repo.fork) continue;
        repos.set(repo.full_name.toLowerCase(), repo);
      }
    }
    if (failures === results.length) throw new Error('all GitHub searches failed');
    return [...repos.values()];
  }

  /** Keep entries that fell out because one discovery source failed or rate-limited. */
  private appendCached(entries: MarketplaceEntry[]): void {
    const cached = this.cache?.catalog.entries ?? [];
    if (!cached.length) return;
    const seen = new Set(
      entries.map((entry) => repoKey(entry.installUrl ?? entry.repoUrl ?? entry.id)),
    );
    for (const entry of cached) {
      const key = repoKey(entry.installUrl ?? entry.repoUrl ?? entry.id);
      if (seen.has(key)) continue;
      entries.push(entry);
      seen.add(key);
    }
  }

  private merge(official: OfficialEntry[], github: GitHubRepo[]): MarketplaceEntry[] {
    const map = new Map<string, MarketplaceEntry>();
    const byRepo = new Map<string, GitHubRepo>();
    for (const repo of github) {
      if (!repo.full_name) continue;
      const key = repoKey(repo.html_url ?? `https://github.com/${repo.full_name}`);
      if (key) byRepo.set(key, repo);
    }

    for (const item of official) {
      const key = repoKey(item.repoUrl) || `official-${slug(item.name)}`;
      const repo = byRepo.get(key);
      const repoUrl = repo?.html_url ?? item.repoUrl;
      const installUrl = installUrlOf(repoUrl);
      const avatar = item.icon;
      const stars = Math.max(item.stars ?? 0, repo?.stargazers_count ?? 0);
      const tags = [
        ...new Set([
          ...(repo?.topics ?? []),
          ...(item.sourceCategory ? [item.sourceCategory] : []),
        ]),
      ];
      map.set(key, {
        id: slug(`official-${item.name}`),
        name: item.name,
        description: item.description || repo?.description || '',
        category: categoryOf(
          `${item.name} ${item.description} ${item.sourceCategory}`,
          item.sourceCategory,
        ),
        source: 'official',
        ...(item.sourceCategory ? { sourceCategory: item.sourceCategory } : {}),
        ...(item.official ? { official: true } : {}),
        ...(repoUrl ? { repoUrl } : {}),
        ...(repo?.homepage ? { homepageUrl: repo.homepage } : {}),
        ...(installUrl ? { installUrl } : {}),
        ...(avatar ? { avatarUrl: avatar } : {}),
        ...(item.owner || repo?.owner?.login
          ? { owner: item.owner || repo?.owner?.login }
          : {}),
        ...(stars > 0 ? { stars } : {}),
        ...(repo?.pushed_at || item.addedAt
          ? { updatedAt: repo?.pushed_at ?? item.addedAt }
          : {}),
        ...(item.addedAt ? { addedAt: item.addedAt } : {}),
        ...(tags.length ? { tags } : {}),
        ...(repo?.default_branch ? { defaultBranch: repo.default_branch } : {}),
        installable: Boolean(installUrl),
        ...(repo?.archived ? { archived: true } : {}),
      });
      byRepo.delete(key);
    }

    for (const repo of byRepo.values()) {
      const repoUrl = repo.html_url ?? `https://github.com/${repo.full_name}`;
      const key = repoKey(repoUrl);
      const name = repo.full_name?.split('/')[1] ?? repo.full_name ?? 'Extension';
      const installUrl = installUrlOf(repoUrl);
      map.set(key, {
        id: slug(repo.full_name ?? name),
        name,
        description: repo.description ?? '',
        category: categoryOf(
          `${name} ${repo.description ?? ''} ${(repo.topics ?? []).join(' ')}`,
        ),
        source: 'github',
        ...(repoUrl ? { repoUrl } : {}),
        ...(repo.homepage ? { homepageUrl: repo.homepage } : {}),
        ...(installUrl ? { installUrl } : {}),
        ...(repo.owner?.login ? { owner: repo.owner.login } : {}),
        ...(repo.stargazers_count ? { stars: repo.stargazers_count } : {}),
        ...(repo.pushed_at ? { updatedAt: repo.pushed_at } : {}),
        ...(repo.topics?.length ? { tags: repo.topics } : {}),
        ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
        installable: Boolean(installUrl),
        ...(repo.archived ? { archived: true } : {}),
      });
    }

    const seen = new Set<string>();
    for (const entry of map.values()) {
      let id = entry.id;
      let suffix = 2;
      while (seen.has(id)) {
        id = `${entry.id}-${suffix}`;
        suffix += 1;
      }
      seen.add(id);
      entry.id = id;
      const zh = MARKETPLACE_ZH[id];
      if (zh && zh !== entry.description) entry.descriptionZh = zh;
    }

    return [...map.values()];
  }

  private async validate(
    entries: MarketplaceEntry[],
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const queue = entries.filter((entry) => Boolean(entry.installUrl));
    const workers = Array.from({ length: VALIDATION_CONCURRENCY }, async () => {
      for (;;) {
        if (Date.now() > deadline) return;
        const entry = queue.shift();
        if (!entry) return;
        const info = await this.packageInfo(entry);
        entry.installable = info.installable;
        if (!entry.avatarUrl && info.icon) entry.avatarUrl = info.icon;
        if (!entry.avatarUrl && info.glyph) entry.iconGlyph = info.glyph;
      }
    });
    await Promise.all(workers);
  }

  private async packageInfo(
    entry: MarketplaceEntry,
  ): Promise<{ installable: boolean; icon?: string; glyph?: string }> {
    const match = (entry.repoUrl ?? '').match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i,
    );
    if (!match) return { installable: false };
    const key = `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    const cached = this.validations.get(key);
    if (cached && Date.now() - cached.at < VALIDATION_TTL_MS) {
      return {
        installable: cached.installable,
        ...(cached.icon ? { icon: cached.icon } : {}),
        ...(cached.glyph ? { glyph: cached.glyph } : {}),
      };
    }

    const branches = [entry.defaultBranch, 'main', 'master'].filter(
      (branch, index, all): branch is string =>
        Boolean(branch) && all.indexOf(branch) === index,
    );
    for (const branch of branches) {
      const base = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      try {
        const response = await fetch(`${base}/package.json`, {
          headers: { 'User-Agent': 'openwith-matrix/2.0' },
          signal: AbortSignal.timeout(PACKAGE_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const pkg = (await response.json()) as PackageJson;
        const installable =
          typeof pkg.version === 'string' &&
          pkg.version.trim().length > 0 &&
          Boolean(pkg.openchamber) &&
          typeof pkg.openchamber === 'object';
        const icon = installable && !entry.avatarUrl ? await this.repoIcon(pkg, base) : undefined;
        const result = {
          installable,
          ...(icon?.icon ? { icon: icon.icon } : {}),
          ...(icon?.glyph ? { glyph: icon.glyph } : {}),
        };
        this.validations.set(key, { at: Date.now(), ...result });
        return result;
      } catch {
        /* try the next branch */
      }
    }
    this.validations.set(key, { at: Date.now(), installable: false });
    return { installable: false };
  }

  private async repoIcon(
    pkg: PackageJson,
    base: string,
  ): Promise<{ icon?: string; glyph?: string }> {
    const manifest = isRecord(pkg.openchamber) ? pkg.openchamber : undefined;
    const contributes =
      manifest && isRecord(manifest.contributes) ? manifest.contributes : undefined;
    const panel = contributes && isRecord(contributes.panel) ? contributes.panel : undefined;
    const declared = typeof panel?.icon === 'string' ? panel.icon.trim() : '';

    const candidates: string[] = [];
    let glyph: string | undefined;
    if (declared) {
      if (/^data:/i.test(declared) || /^https?:\/\//i.test(declared)) return { icon: declared };
      if (/\.[a-z0-9]{2,5}$/i.test(declared)) {
        candidates.push(declared.replace(/^\.?\//, ''));
      } else if (/^[a-z0-9][a-z0-9-]*$/i.test(declared)) {
        // Built-in glyph names such as "pulse" or "bar-chart-2" have no file to fetch.
        glyph = declared;
      }
    }
    candidates.push('icon.svg');

    for (const candidate of candidates) {
      try {
        const path = candidate
          .split('/')
          .filter(Boolean)
          .map(encodeURIComponent)
          .join('/');
        const response = await fetch(`${base}/${path}`, {
          headers: { 'User-Agent': 'openwith-matrix/2.0' },
          signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_ICON_BYTES) continue;
        const mime = iconMime(candidate, response.headers.get('content-type') ?? '');
        return { icon: `data:${mime};base64,${buffer.toString('base64')}` };
      } catch {
        /* try the next candidate */
      }
    }
    return glyph ? { glyph } : {};
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
