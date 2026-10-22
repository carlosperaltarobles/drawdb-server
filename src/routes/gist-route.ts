import express, { type RequestHandler } from 'express';
import { createGistClient } from '../constants/gist-constants';
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

const gistsDisabled: RequestHandler = (_req, res) => {
  res.status(503).json({ error: 'gists_disabled' });
};

/** Without a GitHub token every gist route answers 503 `gists_disabled`. */
export function gistRouter(githubToken: string | undefined) {
  const router = express.Router();
  if (!githubToken) {
    router.use(gistsDisabled);
    return router;
  }
  const client = createGistClient(githubToken);
  const withClient =
    (handler: GistHandler): RequestHandler =>
    (req, res) =>
      handler(client, req, res);

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
