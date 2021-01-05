//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { AddRepositoryPermissionsToRequest, getContextualRepository, getContextualRepositoryPermissions, setContextualRepository } from '../../../../../middleware/github/repoPermissions';
import { jsonError } from '../../../../../middleware/jsonError';
import { ReposAppRequest } from '../../../../../transitional';

import RouteMicrosoftMetadata from './msftMetadata';
import RouteCorporateMetadata from './corporateMetadata';

const router = express.Router();

router.use('/microsoftMetadata', RouteMicrosoftMetadata);
router.use('/corporateMetadata', RouteCorporateMetadata);

router.get('/permissions', AddRepositoryPermissionsToRequest, asyncHandler(async (req: ReposAppRequest, res, next) => {
  const permissions = getContextualRepositoryPermissions(req);
  return res.json(permissions);
}));

router.use('*', (req, res, next) => {
  return next(jsonError(`no API or ${req.method} function available for repo`, 404));
});

export default router;
