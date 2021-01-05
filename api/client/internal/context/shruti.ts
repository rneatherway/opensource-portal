


//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { IndividualContext } from '../../../../user';
import { jsonError } from '../../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../../transitional';
import { ICorporateLink } from '../../../../business/corporateLink';
import { Repository } from '../../../../business/repository';

const router = express.Router();

// Temporary route only for the GitHub AE migrations team for Nov 2020 -> Dec 2020

router.get('/data.csv', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const un = activeContext.corporateIdentity.username.toLowerCase();
  if (un !== 'jwilcox@microsoft.com' && un !== 'shmundra@microsoft.com' && un !== 'kapiteir@microsoft.com') {
    return next(jsonError('NO ACCESS for ' + un, 403));
  }
  const { microsoftMetadataProvider, linkProvider, operations } = req.app.settings.providers as IProviders;
  const enterpriseAnswers = await microsoftMetadataProvider.getAllEnterpriseAnswers();
  const allLinks = await linkProvider.getAll();
  const byId = new Map<string, ICorporateLink>();
  allLinks.forEach(link => {
    if (link && link.corporateId) {
      byId.set(link.corporateId, link);
    }
  });
  const allRepos = await operations.getRepos();
  const byRepo = new Map<string, Repository>();
  allRepos.forEach(repo => {
    if (repo.id) {
      byRepo.set(repo.id.toString(), repo);
    }
  });
  const first = 'repoid,org,reponame,updatedbyid,updatedbyusername,updatedbydisplayname,updateddate,maintainersById,maintainersByUsername,enterpriseoptin,optoutapps,optoutappsdetails,optoutcollaboration,optoutcollaborationdetails,optoutstaging,optoutstagingdetails,optoutother,optoutotherdetails';
  const rows = [first];
  enterpriseAnswers.forEach(row => {
    const repo = byRepo.get(row.repositoryId);
    const link = byId.get(row.enterpriseUpdatedBy);
    const ids = row.maintainerCorporateIds;
    let uns = '';
    if (ids) {
      const ai = ids.replace(/;/g, ',').split(',');
      uns = ai.filter(id => byId.get(id)).map(id => byId.get(id).corporateUsername).join(',');
    }
    rows.push([
      wrap(row.repositoryId),
      wrap(repo ? repo.organization.name : ''),
      wrap(repo ? repo.name : ''),
      wrap(row.enterpriseUpdatedBy || ''),
      wrap(link ? link.corporateUsername : ''),
      wrap(link ? link.corporateDisplayName : ''),
      wrap((new Date(row.enterpriseUpdated)).toDateString()),
      // wrap(row.maintainerSecurityGroup || ''),
      wrap(row.maintainerCorporateIds || ''),
      wrap(uns || ''),
      wrap(row.enterpriseOptIn ? '1' : '0'),
      wrap(row.enterpriseOptOutApps ? '1' : '0'),
      wrap(row.enterpriseOptOutAppsDetails || ''),
      wrap(row.enterpriseOptOutCollaboration ? '1' : '0'),
      wrap(row.enterpriseOptOutCollaborationDetails || ''),
      wrap(row.enterpriseOptOutStaging ? '1' : '0'),
      wrap(row.enterpriseOptOutStagingDetails || ''),
      wrap(row.enterpriseOptOutOther ? '1' : '0'),
      wrap(row.enterpriseOptOutOtherDetails || ''),
    ].join(','));
  });
  res.contentType('text/csv');
  return res.send(rows.join('\r\n'));
}));

function wrap(s: string) {
  const x = s.replace(/\n/g, ' ');
  return `"${x}"`;
}

router.use('*', (req: ReposAppRequest, res, next) => {
  return next(jsonError('Contextual API or route not found within this temporary GHAE route', 404));
});

export default router;
