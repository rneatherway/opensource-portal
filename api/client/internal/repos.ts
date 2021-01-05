//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { Repository } from '../../../business/repository';

import { jsonError } from '../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../transitional';

import JsonPager from './jsonPager';
import { RepositorySearchSortOrder, searchRepos } from './organization/repos';

const router = express.Router();

router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const providers = req.app.settings.providers as IProviders;
  const pager = new JsonPager<Repository>(req, res);
  const searchOptions = {
    q: (req.query.q || '') as string,
    type: (req.query.type || '') as string, // CONSIDER: TS: stronger typing
  }
  try {
    const repos = await searchRepos(providers, null, RepositorySearchSortOrder.Updated, searchOptions);
    const slice = pager.slice(repos);
    return pager.sendJson(slice.map(repo => {
      return repo.asJson();
    }));
  } catch (repoError) {
    console.dir(repoError);
    return next(jsonError(repoError));
  }
}));

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available within this cross-organization repps list', 404));
});

export default router;
