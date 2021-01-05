//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { jsonError } from '../../../../middleware/jsonError';
import { ErrorHelper, IProviders, ReposAppRequest } from '../../../../transitional';
import { Repository } from '../../../../business/repository';
import { IndividualContext } from '../../../../user';
import NewRepositoryLockdownSystem from '../../../../features/newRepositoryLockdown';
import { AddRepositoryPermissionsToRequest, getContextualRepositoryPermissions } from '../../../../middleware/github/repoPermissions';
import { calculateGroupedPermissionsViewForRepository, findRepoCollaboratorsExcludingOwners, renameRepositoryDefaultBranchEndToEnd } from '../../../../routes/org/repos';

import RouteRepoPermissions from './repoPermissions';

type RequestWithRepo = ReposAppRequest & {
  repository: Repository;
};

const router = express.Router();

router.get('/', asyncHandler(async (req: RequestWithRepo, res, next) => {
  const { repository } = req;
  try {
    await repository.getDetails();

    const clone = Object.assign({}, repository.getEntity());
    delete clone.temp_clone_token; // never share this back
    delete clone.cost;

    return res.json(repository.getEntity());
  } catch (repoError) {
    if (ErrorHelper.IsNotFound(repoError)) {
      // // Attempt fallback by ID
      // const { repoName } = req.params;
      // if (!isNaN()) {

      // }
    }
    return next(jsonError(repoError));
  }
}));

router.get('/exists', asyncHandler(async (req: RequestWithRepo, res, next) => {
  let exists = false;
  let name: string = undefined;
  const { repository } = req;
  try {
    const originalName = repository.name;
    await repository.getDetails();
    if (repository && repository.name) {
      name = repository.getEntity().name as string;
      if (name.toLowerCase() !== originalName.toLowerCase()) {
        // A renamed repository will return the new name here
        exists = false;
      } else {
        exists = true;
      }
    }
  } catch (repoError) {
  }
  return res.json({ exists, name });
}));

router.use('/permissions', RouteRepoPermissions);

router.patch('/renameDefaultBranch', asyncHandler(AddRepositoryPermissionsToRequest), asyncHandler(async function (req: RequestWithRepo, res, next) {
  const providers = req.app.settings.providers as IProviders;
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const repoPermissions = getContextualRepositoryPermissions(req);
  const targetBranchName = req.body.default_branch;
  const { repository } = req;
  try {
    const result = await renameRepositoryDefaultBranchEndToEnd(providers, activeContext, repoPermissions, repository, targetBranchName, true /* wait for refresh before sending response */);
    return res.json(result);
  } catch (error) {
    return next(jsonError(error));
  }
}));

router.delete('/', asyncHandler(async function (req: RequestWithRepo, res, next) {
  // NOTE: duplicated code from /routes/org/repos.ts
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const { organization, repository } = req;
  if (!organization.isNewRepositoryLockdownSystemEnabled) {
    return next(jsonError('This endpoint is not available as configured in this app.', 400));
  }
  const daysAfterCreateToAllowSelfDelete = 21; // could be a config setting if anyone cares
  try {
    // make sure ID is known
    if (await repository.isDeleted()) {
      return next(jsonError('The repository has already been deleted', 404));
    }
    const metadata = await repository.getRepositoryMetadata();
    await NewRepositoryLockdownSystem.ValidateUserCanSelfDeleteRepository(repository, metadata, activeContext, daysAfterCreateToAllowSelfDelete);
  } catch (noExistingMetadata) {
    if (noExistingMetadata.status === 404) {
      return next(jsonError('This repository does not have any metadata available regarding who can setup it up. No further actions available.', 400));
    }
    return next(jsonError(noExistingMetadata, 404));
  }
  const { operations, repositoryMetadataProvider } = req.app.settings.providers as IProviders;
  const lockdownSystem = new NewRepositoryLockdownSystem({ operations, organization, repository, repositoryMetadataProvider });
  await lockdownSystem.deleteLockedRepository(false /* delete for any reason */, true /* deleted by the original user instead of ops */);
  return res.json({
    message: `You deleted your repo, ${repository.full_name}.`,
  });
}));

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available within this specific repo', 404));
});

export default router;
