import axios, { type AxiosInstance } from 'axios';

export const gistsBaseUrl = 'https://api.github.com/gists';

/** An HTTP client for the GitHub Gists API, authenticated with the given token. */
export function createGistClient(token: string): AxiosInstance {
  return axios.create({
    baseURL: gistsBaseUrl,
    headers: { 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` },
  });
}

/** Encode path separators and query delimiters; the router separately rejects dot segments. */
export function gistPath(...segments: string[]): string {
  return segments.map((s) => `/${encodeURIComponent(s)}`).join('');
}
