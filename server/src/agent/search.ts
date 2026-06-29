// search_medical 的底层联网检索（设计文档 2.4 / 4.2：Firecrawl）。
// SearchClient 接口可注入：默认用 Firecrawl，测试注入假实现，不触网。

export interface SearchSnippet {
  title: string
  url: string
  snippet: string
}

export interface SearchOutcome {
  query: string
  snippets: SearchSnippet[]
  sources: Array<{ title: string; url: string }>
}

export interface SearchClient {
  readonly kind: string
  search(query: string): Promise<SearchOutcome>
}

/** 把 Firecrawl 的搜索结果收口为 SearchOutcome；按需懒加载 SDK，避免无 Key 时报错。 */
export function createFirecrawlSearch(): SearchClient | undefined {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim()
  if (!apiKey) return undefined

  return {
    kind: 'firecrawl',
    async search(query: string): Promise<SearchOutcome> {
      // 动态导入：仅在真正检索时加载 SDK。
      const { default: Firecrawl } = await import('@mendable/firecrawl-js')
      const client = new Firecrawl({ apiKey })
      const res = (await client.search(query, { limit: 5 })) as {
        web?: Array<{ title?: string; url?: string; description?: string }>
        data?: Array<{ title?: string; url?: string; description?: string }>
      }
      const items = res.web ?? res.data ?? []
      const snippets: SearchSnippet[] = items.map((it) => ({
        title: it.title ?? '',
        url: it.url ?? '',
        snippet: it.description ?? '',
      }))
      return {
        query,
        snippets,
        sources: snippets.map((s) => ({ title: s.title, url: s.url })),
      }
    },
  }
}
