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
 * 2 = origin 精确匹配
 * 3 = fullDomain 精确匹配
 * 4 = mainDomain 精确匹配
 * 5 = fullUrl 双向包含
 * 6 = fullDomain / mainDomain 双向包含
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
  if (fullUrl.includes(site) || site.includes(fullUrl)) return 5;
  if (
    fullDomain.includes(site) ||
    site.includes(fullDomain) ||
    mainDomain.includes(site) ||
    site.includes(mainDomain)
  ) {
    return 6;
  }

  return NO_MATCH;
}

/** 站点是否与页面 URL 匹配（任意优先级）。 */
export function isSiteMatched(urlInfo: UrlInfo, rawSite: string): boolean {
  return getSiteMatchPriority(urlInfo, rawSite) !== NO_MATCH;
}

/**
 * 返回与目标 URL 匹配的密钥列表（保持入参顺序）。
 * 便利封装，供需要"筛选匹配项"的调用方使用。
 */
export function matchSecrets<T extends { site: string }>(url: string, secrets: T[]): T[] {
  const urlInfo = parseUrl(url);
  if (!urlInfo) return [];
  return secrets.filter((secret) => isSiteMatched(urlInfo, secret.site));
}
