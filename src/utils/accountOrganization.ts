export interface AccountOrganization {
  group?: string;
  favorite?: boolean;
}

export function normalizeAccountOrganization(value: AccountOrganization) {
  return {
    group: typeof value.group === 'string' ? value.group.trim() : '',
    favorite: value.favorite === true
  };
}

export function getAccountGroups(accounts: AccountOrganization[]) {
  return [...new Set(accounts.map((account) => normalizeAccountOrganization(account).group).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export interface AccountFilter {
  query?: string;
  /** null 表示全部分组，空字符串表示未分组。 */
  group?: string | null;
  favoritesOnly?: boolean;
}

export function filterAccounts<T extends AccountOrganization & { site: string; name?: string; secret?: string }>(
  accounts: T[], filters: AccountFilter, includeSecret = false
): T[] {
  const query = (filters.query || '').trim().toLowerCase();
  return accounts.filter((account) => {
    const organization = normalizeAccountOrganization(account);
    return (filters.group == null || organization.group === filters.group) &&
      (!filters.favoritesOnly || organization.favorite) &&
      (!query || [account.site, account.name, organization.group, includeSecret ? account.secret : '']
        .some((text) => text?.toLowerCase().includes(query)));
  });
}

/** 分组由账户上的名称生成；删除分组只清除名称，不删除任何账户。 */
export function removeAccountGroup<T extends AccountOrganization>(accounts: T[], group: string): T[] {
  if (!group) return accounts;
  return accounts.map((account) => normalizeAccountOrganization(account).group === group
    ? { ...account, group: '' } : account);
}
