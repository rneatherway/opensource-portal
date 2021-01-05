


//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { IndividualContext } from '../../../../user';
import { jsonError } from '../../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../../transitional';
import { EventRecord } from '../../../../entities/events/eventRecord';
import { getCacheKeyForEmployeeOpenContributions } from '../../../../routes/contributions';
import { getOffsetMonthRange } from '../../../../utils';
import { FossFundElection } from '../../../../features/fossFundElection';

const router = express.Router();

router.post('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const providers = req.app.settings.providers as IProviders;
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const link = activeContext.link;
  if (!link) {
    return next(jsonError('Even though your contribution may not be on GitHub, a linked GitHub account is currently required to submit a one-off contribution.'));
  }
  const raw = req.body.contribution;
  if (!raw) {
    return next(jsonError('No contribution information', 400));
  }
  const { projectName, contributionDate, category, link: projectLink, description } = raw;
  if (!projectName || !contributionDate || !category || !projectLink || !description) {
    return next(jsonError('All fields are required', 400));
  }
  const contribution = new EventRecord();
  contribution.isOpenContribution = true;
  contribution.inserted = new Date();
  contribution.created = new Date(contributionDate);
  contribution.userCorporateId = link.corporateId;
  contribution.userCorporateUsername = link.corporateUsername;
  contribution.userId = link.thirdPartyId;
  contribution.userUsername = link.thirdPartyUsername;
  contribution.action = 'self-service-contribution';
  contribution.additionalData = {
    projectName,
    contributionDate,
    category,
    link: projectLink,
    description,
  };
  await providers.eventRecordProvider.insertEvent(contribution);
  // clear their contributions cache, if any, for the current election
  try {
    const { electionProvider, cacheProvider } = providers;
    const latestElection = (await electionProvider.queryActiveElections()).pop();
    // clear latest election cache
    let range = [latestElection.eligibilityStart, latestElection.eligibilityEnd];
    await cacheProvider.delete(getCacheKeyForEmployeeOpenContributions(link.thirdPartyId, range[0], range[1]));
    try {
      const system = new FossFundElection(providers);
      const activeRanges = await system.getActiveElectionsDateRange();
      if (activeRanges && activeRanges.length) {
        range = activeRanges;
      }
    } catch (ignoreError2) { /* ignore */ }
    // clear full active range cache
    const key = getCacheKeyForEmployeeOpenContributions(link.thirdPartyId, range[0], range[1]);
    await cacheProvider.delete(key);
  } catch (ignoreError) {
    console.dir(ignoreError);
  }
  return res.json({
    contribution,
  });
}));

router.use('*', (req: ReposAppRequest, res, next) => {
  return next(jsonError('Contextual API or route not found within contribution', 404));
});

export default router;

// export class EventRecord implements IEventRecordProperties {
//   eventId: string;

//   action: string;

//   additionalData: IDictionary<any>;

//   repositoryId: string;
//   repositoryName: string;

//   organizationId: string;
//   organizationName: string;

//   created: Date;
//   inserted: Date;
//   updated: Date;

//   userUsername: string;
//   userId: string;
//   userCorporateId: string;
//   userCorporateUsername: string;

//   isOpenContribution: boolean;
