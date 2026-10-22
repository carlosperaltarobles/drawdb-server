import { config } from '../config';

export const gistsBaseUrl = 'https://api.github.com/gists';

export const headers = {
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: 'Bearer ' + config.github,
};
