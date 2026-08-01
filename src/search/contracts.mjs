const COUNTRIES = /^[A-Z]{2}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

function exact(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} contains an unknown field`);
}

function bounded(value, name, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

export function searchRequestContract(input) {
  exact(input, ["query", "count", "country", "searchLanguage"], "search request");
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 20) throw new TypeError("search count is invalid");
  if (!COUNTRIES.test(input.country)) throw new TypeError("search country is invalid");
  if (!LANGUAGE.test(input.searchLanguage)) throw new TypeError("search language is invalid");
  return Object.freeze({ query: bounded(input.query, "search query", 512), count: input.count,
    country: input.country, searchLanguage: input.searchLanguage });
}

export function searchResultContract(input) {
  exact(input, ["rank", "url", "title", "description"], "search result");
  if (!Number.isInteger(input.rank) || input.rank < 1 || input.rank > 20) throw new TypeError("search result rank is invalid");
  let url;
  try { url = new URL(input.url); } catch { throw new TypeError("search result URL is invalid"); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || input.url.length > 4096) throw new TypeError("search result URL is invalid");
  if (typeof input.description !== "string" || input.description.length > 8192) throw new TypeError("search result description is invalid");
  return Object.freeze({ rank: input.rank, url: url.href, title: bounded(input.title, "search result title", 2048), description: input.description });
}

export function searchResponseContract(input, requestInput) {
  const request = searchRequestContract(requestInput);
  exact(input, ["adapterId", "adapterVersion", "results"], "search response");
  if (input.adapterId !== "brave-search" || typeof input.adapterVersion !== "string" || input.adapterVersion.length > 128
    || !Array.isArray(input.results) || input.results.length > request.count) throw new TypeError("search response is invalid");
  const results = input.results.map(searchResultContract);
  if (results.some((item, index) => item.rank !== index + 1) || new Set(results.map((item) => item.url)).size !== results.length) {
    throw new TypeError("search response results are invalid");
  }
  return Object.freeze({ adapterId: input.adapterId, adapterVersion: input.adapterVersion, results: Object.freeze(results) });
}
