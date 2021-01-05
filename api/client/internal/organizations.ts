//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { jsonError } from '../../../middleware/jsonError';
import { ErrorHelper, IProviders, ReposAppRequest } from '../../../transitional';

import RouteOrganization from './organization';

const router = express.Router();

router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { operations } = req.app.settings.providers as IProviders;
  try {
    const orgs = operations.getOrganizations();
    const dd = orgs.map(org => { return org.asClientJson(); });
    return res.json(dd);
  } catch (error) {
    throw jsonError(error, 400);
  }
}));

router.use('/:orgName', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { operations } = req.app.settings.providers as IProviders;
  const { orgName } = req.params;
  try {
    const org = operations.getOrganization(orgName);
    if (org) {
      req.organization = org;
      return next();
    }
    throw jsonError('managed organization not found', 404);
  } catch (orgNotFoundError) {
    if (ErrorHelper.IsNotFound(orgNotFoundError)) {
      return next(jsonError(orgNotFoundError, 404));
    } else {
      return next(jsonError(orgNotFoundError));
    }
  }
}));

router.use('/:orgName', RouteOrganization);

router.use('*', (req: ReposAppRequest, res, next) => {
  return next(jsonError('orgs API not found', 404));
});

export default router;
