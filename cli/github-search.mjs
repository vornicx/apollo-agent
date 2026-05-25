const GITHUB_API = "https://api.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org/-/v1/search";

export async function searchGitHub(query, { maxResults = 5 } = {}) {
  try {
    const q = encodeURIComponent(`${query} language:javascript`);
    const url = `${GITHUB_API}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${maxResults}`;
    const headers = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "apollo-agent/1.0",
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const body = await resp.json();
    return (body.items ?? []).map((r) => ({
      source: "github",
      name: r.name,
      fullName: r.full_name,
      description: r.description ?? "",
      stars: r.stargazers_count,
      url: r.html_url,
      topics: r.topics ?? [],
    }));
  } catch {
    return [];
  }
}

export async function searchNpm(query, { maxResults = 5 } = {}) {
  try {
    const url = `${NPM_REGISTRY}?text=${encodeURIComponent(query)}&size=${maxResults}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const body = await resp.json();
    return (body.objects ?? []).map((o) => ({
      source: "npm",
      name: o.package.name,
      description: o.package.description ?? "",
      version: o.package.version,
      score: o.score?.final ?? 0,
      keywords: o.package.keywords ?? [],
      url: `https://www.npmjs.com/package/${o.package.name}`,
    }));
  } catch {
    return [];
  }
}

export async function searchAll(skill) {
  const [github, npm] = await Promise.all([
    searchGitHub(skill.githubQuery ?? skill.name),
    searchNpm(skill.npmQuery ?? skill.name),
  ]);
  return [...github, ...npm];
}
