import express, { type RequestHandler } from 'express';
import type { AxiosInstance } from 'axios';
import {
  create,
  del,
  get,
  getCommits,
  update,
  getRevision,
  getRevisionsForFile,
  compare,
  type GistHandler,
} from '../controllers/gist-controller';
import { asyncHandler } from '../http/async-handler';

/** Gist ids and commit shas are alphanumeric; this also keeps `..` out of the GitHub URL. */
const GITHUB_ID = /^[A-Za-z0-9_-]+$/;
const URL_PARAMS = ['id', 'sha', 'versionA', 'versionB'];

const gistsDisabled: RequestHandler = (_req, res) => {
  res.status(503).json({ error: 'gists_disabled' });
};

/** Without a client (no GitHub token) every gist route answers 503 `gists_disabled`. */
export function gistRouter(client: AxiosInstance | undefined) {
  const router = express.Router();
  if (!client) {
    router.use(gistsDisabled);
    return router;
  }
  for (const name of URL_PARAMS) {
    router.param(name, (_req, res, next, value: string) => {
      if (GITHUB_ID.test(value)) return next();
      res.status(400).json({ error: 'invalid_input' });
    });
  }
  const withClient = (handler: GistHandler): RequestHandler =>
    asyncHandler((req, res) => handler(client, req, res));

  router.post('/', withClient(create));
  router.get('/:id', withClient(get));
  router.delete('/:id', withClient(del));
  router.patch('/:id', withClient(update));
  router.get('/:id/commits', withClient(getCommits));
  router.get('/:id/:sha', withClient(getRevision));
  router.get('/:id/file-versions/:file', withClient(getRevisionsForFile));
  router.get('/:id/file/:file/compare/:versionA/:versionB', withClient(compare));
  return router;
}
