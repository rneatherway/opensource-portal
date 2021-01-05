//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { RepositoryMetadataEntity } from '../../../entities/repositoryMetadata/repositoryMetadata';
import { IMicrosoftMetadataProvider, MicrosoftEngineeringSystem, MicrosoftMetadata, MicrosoftMetadataProvider } from '../../../microsoft/entities/msftMetadata';

import { jsonError } from '../../../middleware/jsonError';
import { ErrorHelper, IProviders, ReposAppRequest } from '../../../transitional';
import { ParseReleaseReviewWorkItemId } from '../../../utils';
import { getReviewService } from '../reviewService';

const router = express.Router();

router.get('/:repoId', asyncHandler(async (req: ReposAppRequest, res, next) => {
  // const { organization } = req;
  const { config, repositoryMetadataProvider, microsoftMetadataProvider } = req.app.settings.providers as IProviders;
  const { repoId } = req.params;
  if (repoId === 'undefined') {
    return { notFound: true };
  }
  let corporateMetadata: RepositoryMetadataEntity = null;
  let releaseReviewObject: any = null;
  let microsoftMetadata: MicrosoftMetadata = null;
  let notFound: boolean = undefined;
  try {
    microsoftMetadata = await tryGetOrCreateMicrosoftMetadata(microsoftMetadataProvider, repoId);
  } catch (noMicrosoftMetadata) {
    // ignore any issues
    console.log();
  }
  try {
    corporateMetadata = await repositoryMetadataProvider.getRepositoryMetadata(repoId);
    if (corporateMetadata?.releaseReviewUrl) {
      try {
        const releaseReviewWorkItemId = ParseReleaseReviewWorkItemId(corporateMetadata.releaseReviewUrl);
        if (releaseReviewWorkItemId) {
          const reviewService = getReviewService(config);
          // TODO: consider caching
          releaseReviewObject = await reviewService.getReviewByUri(`wit:${releaseReviewWorkItemId}`);
        }
      } catch (ignoredError) {
        console.dir(ignoredError);
      }
    }
  } catch (error) {
    if (ErrorHelper.IsNotFound(error)) {
      // CONSIDER: this returns a 200 and lets the client cache this current "no metadata" state better than an error
      notFound = true;
      (corporateMetadata as any) = {};
    } else {
      return next(jsonError(error));
    }
  }
  return res.json({corporateMetadata, releaseReviewObject, microsoftMetadata, notFound});
}));

async function tryGetOrCreateMicrosoftMetadata(provider: IMicrosoftMetadataProvider, repoId: string | number) {
  let md: MicrosoftMetadata = undefined;
  try {
    md = await provider.getMetadata(String(repoId));
  } catch (error) {
    if (ErrorHelper.IsNotFound(error)) {
      md = MicrosoftMetadata.CreateForGitHubRepository(MicrosoftEngineeringSystem.GitHub, String(repoId));
      try {
        await provider.insertMetadata(md);
      } catch (createError) {
        console.dir(createError);
        md = null;
      }
    } else {
      throw error;
    }
  }
  return md;
}

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available within this corporate repos metadata route', 404));
});

export default router;
