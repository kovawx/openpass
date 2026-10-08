/**
 * 站点域名解析与匹配 —— 全局唯一实现
 *
 * background（Badge 计数）、popup（当前站点匹配排序）、
 * content script（浮动按钮显隐）共用本模块，避免多处重复实现导致规则不一致。
 */

export interface UrlInfo {
  fullUrl: string;
  origin: string;
  fullDomain: string;
  mainDomain: string;
}

/** 需要按三段处理的二级 TLD */
const MULTI_PART_TLDS = ['co.uk', 'com.au', 'co.jp', 'com.cn'];

/** 不匹配时的优先级哨兵 */
export const NO_MATCH = Number.POSITIVE_INFINITY;

/**
 * 解析 URL，提取完整地址、协议源、完整域名与主域名。
 * 支持无协议输入（自动补 `https://`）。
 */
export function parseUrl(value: string): UrlInfo | null {
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    const hostname = url.hostname;
    const parts = hostname.split('.');
    let mainDomain = hostname;

    if (parts.length >= 2) {
      const lastTwo = parts.slice(-2).join('.');
      mainDomain = MULTI_PART_TLDS.includes(lastTwo)
        ? parts.slice(-3).join('.')
        : parts.slice(-2).join('.');
    }

    return {
      fullUrl: url.href,
      origin: url.origin,
      fullDomain: hostname,
      mainDomain
    };
  } catch {
    return null;
  }
}

/**
 * 计算站点与页面 URL 的匹配优先级。数值越小越精确，`NO_MATCH`（Infinity）表示不匹配。
 *
 * 优先级（综合各处历史实现，取并集，确保不丢匹配）：
 * 1 = fullUrl 精确匹配
 * 2 = origin 精确匹配或同源路径匹配（排序时路径越具体越靠前）
 * 3 = fullDomain 精确匹配
 * 4 = 父域匹配（排序时最近的父域优先）
 * 5 = 子域匹配
 * 6 = 同主域的其他站点
 */
export function getSiteMatchPriority(urlInfo: UrlInfo, rawSite: string): number {
  const site = (rawSite || '').trim().toLowerCase();
  if (!site) return NO_MATCH;

  const fullUrl = urlInfo.fullUrl.toLowerCase();
  const origin = urlInfo.origin.toLowerCase();
  const fullDomain = urlInfo.fullDomain.toLowerCase();
  const mainDomain = urlInfo.mainDomain.toLowerCase();

  if (fullUrl === site) return 1;
  if (origin === site) return 2;
  if (fullDomain === site) return 3;
  if (mainDomain === site) return 4;
  const parsedSite = parseUrl(site);
  if (parsedSite && parsedSite.origin.toLowerCase() === origin) {
    const target = new URL(parsedSite.fullUrl);
    const page = new URL(urlInfo.fullUrl);
    const path = target.pathname.toLowerCase();
    const pagePath = page.pathname.toLowerCase();
    const matchesPath = path === '/' || pagePath === path || pagePath.startsWith(path.endsWith('/') ? path : `${path}/`);
    const matchesQuery = !target.search || target.search.toLowerCase() === page.search.toLowerCase();
    if (matchesPath && matchesQuery) return 2;
  }

  const siteDomain = parsedSite?.fullDomain.toLowerCase() ?? site;
  if (siteDomain === fullDomain) return 3;
  if (fullDomain.endsWith(`.${siteDomain}`)) return 4;
  if (siteDomain.endsWith(`.${fullDomain}`)) return 5;
  const hasDomainBoundary = (left: string, right: string) =>
    left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);

  if (hasDomainBoundary(fullDomain, siteDomain) || hasDomainBoundary(mainDomain, siteDomain)) {
    return 6;
  }

  return NO_MATCH;
}

/** 站点是否与页面 URL 匹配（任意优先级）。 */
export function isSiteMatched(urlInfo: UrlInfo, rawSite: string): boolean {
  return getSiteMatchPriority(urlInfo, rawSite) !== NO_MATCH;
}

/**
 * 返回与目标 URL 匹配的密钥列表，按匹配度排序；相同匹配度保持原顺序。
 * 不修改密钥存储顺序，供 popup、content 和后台统一使用。
 */
export function matchSecrets<T extends { site: string }>(url: string, secrets: T[]): T[] {
  const urlInfo = parseUrl(url);
  if (!urlInfo) return [];
  return secrets.map((secret, index) => {
    const priority = getSiteMatchPriority(urlInfo, secret.site);
    const site = parseUrl(secret.site);
    const specificity = priority === 2 && site
      ? new URL(site.fullUrl).pathname.length + new URL(site.fullUrl).search.length
      : priority === 4 && site ? site.fullDomain.split('.').length : 0;
    return { secret, priority, specificity, index };
  }).filter(({ priority }) => priority !== NO_MATCH)
    .sort((left, right) => left.priority - right.priority || right.specificity - left.specificity || left.index - right.index)
    .map(({ secret }) => secret);
}
