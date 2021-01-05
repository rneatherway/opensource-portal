//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { ICrossOrganizationMembershipByOrganization, Operations } from '../../../business/operations';
import { Repository } from '../../../business/repository';
import { Team, TeamJsonFormat } from '../../../business/team';

import { jsonError } from '../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../transitional';

import JsonPager from './jsonPager';
import { RepositorySearchSortOrder, searchRepos } from './organization/repos';

const router = express.Router();

async function getCrossOrganizationTeams(operations: Operations): Promise<Team[]> {
  const options = {
    backgroundRefresh: true,
    maxAgeSeconds: 60 * 10 /* 10 minutes */,
    individualMaxAgeSeconds: 60 * 30 /* 30 minutes */,
  };
  let list: Team[] = null;
  list = [];
  const crossOrgTeams = await operations.getCrossOrganizationTeams(options);
  const allReducedTeams = Array.from(crossOrgTeams.values());
  allReducedTeams.forEach((reducedTeam: ICrossOrganizationMembershipByOrganization) => {
    const orgs = Object.getOwnPropertyNames(reducedTeam.orgs);
    const firstOrg = orgs[0];
    const organization = operations.getOrganization(firstOrg);
    const entry = organization.teamFromEntity(reducedTeam.orgs[firstOrg]);
    list.push(entry);
  });
  return list;
}

router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { operations } = req.app.settings.providers as IProviders;
  const pager = new JsonPager<Team>(req, res);
  const q: string = (req.query.q ? req.query.q as string : null) || '';
  try {
    // TODO: need to do lots of caching to make this awesome!
    let teams = await getCrossOrganizationTeams(operations);
    if (q) {
      teams = teams.filter(team => {
        let string = ((team.name || '') + (team.description || '') + (team.id || '') + (team.slug || '')).toLowerCase();
        return string.includes(q.toLowerCase());
      });
    }
    const slice = pager.slice(teams);
    return pager.sendJson(slice.map(team => {
      return team.asJson(TeamJsonFormat.Detailed);
    }));
  } catch (repoError) {
    console.dir(repoError);
    return next(jsonError(repoError));
  }
}));

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available within this cross-organization teams list', 404));
});

export default router;
