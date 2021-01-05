//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { AddRepositoryPermissionsToRequest, getContextualRepository, getContextualRepositoryPermissions } from '../../../../../middleware/github/repoPermissions';
import { jsonError } from '../../../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../../../transitional';

const router = express.Router();

router.patch('/', AddRepositoryPermissionsToRequest, asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { repositoryMetadataProvider } = req.app.settings.providers as IProviders;
  const repository = getContextualRepository(req);
  if (await repository.isDeleted()) {
    return next(jsonError('repo not found', 404));
  }
  const permissions = getContextualRepositoryPermissions(req);
  if (!permissions.sudo) {
    return next(jsonError(`changing these values for ${repository.full_name} requires sudoer permissions at this time`, 403));
  }
  const metadata = await repositoryMetadataProvider.getRepositoryMetadata(String(repository.id));
  const changes = req.body;
  const log = [];
  const keys = Object.getOwnPropertyNames(changes);
  let count = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const newValue = changes[key];
    if (newValue !== metadata[key]) {
      ++count;
      const desc = `${count}. changing metadata["${key}"] to "${newValue}" from "${metadata[key]}"`;
      metadata[key] = newValue;
      log.push(desc);
      console.log(desc);
    }
  }
  if (count) {
    try {
      await repositoryMetadataProvider.updateRepositoryMetadata(metadata);
      res.status(202);
      return res.json({
        corporateMetadata: metadata,
        log,
      });
    } catch (error) {
      throw error;
    }
  }
  res.status(200);
  return res.json({
    corporateMetadata: metadata,
  });
}));

export default router;
