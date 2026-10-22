import type { AxiosInstance } from 'axios';
import { gistPath } from '../constants/gist-constants';

export const GistService = {
  deleteGist: async (client: AxiosInstance, gistId: string) => {
    await client.delete(gistPath(gistId));
  },

  getCommits: async (client: AxiosInstance, gistId: string, perPage?: number, page?: number) => {
    const { data } = await client.get(gistPath(gistId, 'commits'), {
      params: {
        per_page: perPage,
        page,
      },
    });

    return data;
  },

  getCommit: async (client: AxiosInstance, gistId: string, sha: string) => {
    const { data } = await client.get(gistPath(gistId, sha));

    return data;
  },
};
