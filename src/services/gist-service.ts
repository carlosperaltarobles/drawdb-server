import type { AxiosInstance } from 'axios';

export const GistService = {
  deleteGist: async (client: AxiosInstance, gistId: string) => {
    await client.delete(`/${gistId}`);
  },

  getCommits: async (client: AxiosInstance, gistId: string, perPage?: number, page?: number) => {
    const { data } = await client.get(`/${gistId}/commits`, {
      params: {
        per_page: perPage,
        page,
      },
    });

    return data;
  },

  getCommit: async (client: AxiosInstance, gistId: string, sha: string) => {
    const { data } = await client.get(`/${gistId}/${sha}`);

    return data;
  },
};
