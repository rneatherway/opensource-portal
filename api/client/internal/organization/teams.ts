//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { Organization } from '../../../../business/organization';
import { Team, TeamJsonFormat } from '../../../../business/team';
import { setContextualTeam } from '../../../../middleware/github/teamPermissions';

import { jsonError } from '../../../../middleware/jsonError';
import { ReposAppRequest } from '../../../../transitional';
import JsonPager from '../jsonPager';
import LeakyLocalCache from '../leakyLocalCache';

import RouteTeam from './team';

const router = express.Router();

// BAD PRACTICE: leaky local cache
// CONSIDER: use a better approach
const leakyLocalCache = new LeakyLocalCache<number, Team[]>();

router.use('/:teamSlug', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { organization } = req;
  const { teamSlug } = req.params;
  let team: Team = null;
  try {
    team = await organization.getTeamFromSlug(teamSlug);
    setContextualTeam(req, team);
    return next();
  } catch (teamError) {
    return next(jsonError(teamError));
  }
}));

router.use('/:teamSlug', RouteTeam);

async function getTeamsForOrganization(organization: Organization): Promise<Team[]> {
  const cached = leakyLocalCache.get(organization.id);
  if (cached) {
    return cached;
  }
  const options = {
    backgroundRefresh: true,
    maxAgeSeconds: 60 * 10 /* 10 minutes */,
    individualMaxAgeSeconds: 60 * 30 /* 30 minutes */,
  };
  let list: Team[] = null;
  list = await organization.getTeams(options);
  leakyLocalCache.set(organization.id, list);
  return list;
}

router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { organization } = req;
  const pager = new JsonPager<Team>(req, res);
  const q: string = (req.query.q ? req.query.q as string : null) || '';
  try {
    // TODO: need to do lots of caching to make this awesome!
    // const repos = await organization.getRepositories();
    let teams = await getTeamsForOrganization(organization);
    if (q) {
      teams = teams.filter(team => {
        let string = ((team.name || '') + (team.description || '') + (team.id || '') + (team.slug || '')).toLowerCase();
        return string.includes(q.toLowerCase());
      });
    }
    const slice = pager.slice(teams);
    return pager.sendJson(slice.map(team => {
      return team.asJson(TeamJsonFormat.Augmented);
    }));
  } catch (repoError) {
    console.dir(repoError);
    return next(jsonError(repoError));
  }
}));

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available within this team', 404));
});

export default router;
